// Draft autosave (0.5.3). Nothing a member types may be lost:
//   - the whole form is mirrored to localStorage (backupKey) until the server
//     holds the same data (RequestForm owns that part);
//   - DraftSaver creates the draft once the minimum is valid, then debounces
//     and saves: PATCH details, PUT playlist, both with the loaded version.
//     Saves are serialised (never two in flight) and coalesced; transient
//     failures retry with backoff; flushKeepalive() sends the last changes
//     with fetch keepalive when the page is hidden or left (one combined
//     request, so it lands whole or not at all).
//   - `view` is the form's base: the server copy the form last loaded, saved
//     or merged. Every field of the form that this tab did not change equals
//     it, so `plan(view)` (a plain diff) sends only this tab's changes.
//   - A newer server copy (a 409 version_conflict, or refresh() when the tab
//     comes back into view / another tab saved) is never written over: the
//     form merges it (`adopt`, merge.ts: three-way against the old base) and
//     only then becomes the new base, so the next plan sends only what this
//     tab changed, on top of the other tab's work.
//   - Every save carries expectStatus 'draft' (the server refuses it with
//     409 status_changed once the request was submitted/approved/withdrawn
//     elsewhere: status changes do not bump the version) and a fresh saveId
//     (the server lists the latest ones on the event, so a reopened page can
//     tell whether a keepalive save arrived). A copy of the event that is no
//     longer a draft, or status_changed, stops the saver for good.
//   - The ledger: every save sent whose answer has not come back (the
//     keepalive, whose answer is never read; a PATCH/PUT whose answer was
//     lost) is kept with what it sent. A newer server copy that lists its
//     saveId has it: the merge base moves onto what it sent first
//     (sortSaves + restore.ts rebaseForm, the same rule a reopened page
//     uses), so this tab's changes that already reached the server are never
//     merged again over newer work from elsewhere. When that cannot be told
//     (the list is full) and the merge would overwrite work done elsewhere,
//     the form asks instead (adopt answers 'held'). Every entry is also
//     written into the tab's device copy (onLedger), so a page killed before
//     an answer arrived is sorted the same way when it is reopened. A save
//     whose answer was lost (or a keepalive) is checked against a fresh
//     server copy before anything else is planned, and until that check
//     succeeds the saver never reports "all saved" (nor writes: a failed
//     check only schedules the retry): the server may hold something the
//     form no longer shows (an edit undone meanwhile). A save the check
//     finds not arrived yet (the server not past its version: a keepalive
//     still on its way) stays undecided. It is never settled by waiting:
//     the next write at that base decides it (a save lands only on the
//     version it was made against), and with nothing else to send the saver
//     sends one that changes nothing (POST /draft `seal`: the version moves
//     on). Either the seal lands first (that save can never land after it)
//     or it gets 409 because the save did (caught up and rebased onto it
//     like any landed save, so the form's undo is then written on top).
// The form supplies `plan(view)`: what the server is missing, computed from
// its latest state every time (so a retry always sends the newest data).

import { RECENT_SAVE_IDS } from '@/events/contract/rules'
import { api, ApiError, evMessage } from './ev-api'
import type { EventAnnouncement, EventStatus, EventTrack, FullView, PlaylistOrder } from './types'

export type PlaylistPayload = { tracks: EventTrack[]; announcements: EventAnnouncement[]; playlistOrder: PlaylistOrder }

export type SavePlan = {
  /** Content key of the whole form (same key = same data). */
  key: string
  /** No draft yet: the POST body once the minimum is valid, else null. */
  create: Record<string, unknown> | null
  /** No draft yet: what is still missing ("a title", …). */
  missing: string[]
  /** Changed, valid detail fields (empty = nothing to PATCH). */
  patch: Record<string, unknown>
  /** The playlist when it differs from the saved one, else null. */
  playlist: PlaylistPayload | null
  /** Changes that cannot be saved yet (invalid fields), kept on the device. */
  blocked: string[]
}

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'new'; missing: string[] }
  | { kind: 'saving' }
  | { kind: 'saved'; at: number; /** this round sent a write (not only a check that all is saved) */ wrote?: boolean }
  | { kind: 'partial'; reason: string }
  | { kind: 'error'; reason: string; retrying: boolean; /** an upload that failed its check */ audioId?: number }
  | { kind: 'offline' }
  | { kind: 'stopped'; reason: string; /** reload link (the event page) */ reloadHref?: string; /** the request left the draft state elsewhere (its status, or '' when unknown) */ moved?: string }
  | { kind: 'held' }

type Outcome = 'synced' | 'blocked' | 'retry' | 'failed' | 'stopped'

const TRANSIENT = (e: unknown) =>
  e instanceof ApiError && e.code !== 'daily_cap' && (e.status === 0 || e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500)
/** The event can no longer be edited here (submitted/withdrawn elsewhere, frozen, gone). */
const TERMINAL = new Set(['not_editable', 'frozen', 'not_found', 'forbidden', 'unauthorized', 'changed_elsewhere', 'status_changed'])
/** The request left the draft state elsewhere (another tab or device). */
const MOVED = new Set(['changed_elsewhere', 'status_changed'])

const STATUS_WORDS: Partial<Record<EventStatus, string>> = {
  pending: 'submitted',
  approved: 'submitted and approved',
  built: 'submitted and approved',
  live: 'submitted and approved',
  withdrawn: 'withdrawn or discarded',
  denied: 'submitted and declined',
  cancelled: 'cancelled',
  expired: 'submitted and has expired',
}

/**
 * The request is no longer a draft (submitted, approved, withdrawn … in
 * another tab or on another device). `unsaved`: this page had changes the
 * server does not have, and they were NOT sent.
 */
export function movedMessage(status: string | undefined, unsaved: boolean): string {
  const what = (status && STATUS_WORDS[status as EventStatus]) || 'changed'
  return `This request was ${what} in another tab or on another device, so this page no longer saves. ${
    unsaved ? 'Your latest changes on this page were NOT saved.' : 'Nothing on this page was lost.'
  }`
}

/** A random id for one save request (the server records it with the edit). */
export function newSaveId(): string {
  try {
    const c = globalThis.crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  } catch {
    // no crypto: fall through
  }
  let out = ''
  while (out.length < 32) out += Math.random().toString(36).slice(2)
  return out.slice(0, 32)
}

/** What a save sent (a keepalive is also recorded in the tab's device copy). */
export type KeepaliveSent = {
  /** The saveId of the save (POST /draft, PATCH or PUT). */
  saveId: string
  /** What it carried: the details, the playlist. */
  details: boolean
  playlist: boolean
  sentAt: number
  /** The server version it was made against (it lands only on that version). */
  baseVersion: number
}
/** A save and the form the server holds once it lands (`sent`). */
export type SentSave<T> = KeepaliveSent & { sent: T }

/** What became of saves sent from a base (sortSaves). */
export type SaveFates<R> = {
  /** Arrived (their saveId is listed), in order: rebase onto what they sent. */
  landed: R[]
  /** Cannot be told (arrived on a base this side does not describe, or may have scrolled out of the list). */
  unknown: R[]
  /** Did not arrive and never will (or are already part of the base): their changes count as unsaved. */
  lost: R[]
  /** Not arrived yet, but still may (the server is not past their version). */
  pending: R[]
  /** The base version once the landed saves are applied. */
  version: number
}

/**
 * Sort saves sent from the base at `version` (oldest first) by what the
 * server copy `server` says about them. The ONE rule used by a reopened page
 * (restore.ts planRestore) and by the live saver (DraftSaver.catchUp). A save
 * lands only on the version it was made against, whole or not at all; each
 * part that changed something is one audit row (one version bump) listing
 * its saveId among the event's recentSaveIds (newest RECENT_SAVE_IDS).
 */
export function sortSaves<R extends Pick<KeepaliveSent, 'saveId' | 'baseVersion'>>(records: readonly R[], version: number, server: Pick<FullView, 'version' | 'recentSaveIds'>): SaveFates<R> {
  const recent = server.recentSaveIds ?? []
  // A saveId missing from a list that is not full was never recorded. From a
  // full list (or none) it may have scrolled out: unknown.
  const listComplete = !!server.recentSaveIds && server.recentSaveIds.length < RECENT_SAVE_IDS
  const out: SaveFates<R> = { landed: [], unknown: [], lost: [], pending: [], version }
  for (const r of records) {
    const n = recent.filter((id) => id === r.saveId).length
    if (r.baseVersion < out.version) out.lost.push(r) // the base already has it, or it can no longer land
    else if (n && r.baseVersion === out.version) {
      out.landed.push(r)
      out.version += n
    } else if (n) out.unknown.push(r)
    else if (server.version <= r.baseVersion) out.pending.push(r)
    else if (listComplete) out.lost.push(r)
    else out.unknown.push(r)
  }
  return out
}
/** A save waiting for an upload that is still being checked (it becomes usable by itself). */
const MAX_UPLOAD_WAITS = 20
export const WAITING_FOR_UPLOAD = "One of your uploads is still being checked. It's added to the draft by itself once it's ready."

export type SaverOptions<T = unknown> = {
  initial: FullView | null
  plan: (view: FullView | null) => SavePlan
  onView: (v: FullView) => void
  /**
   * A newer server copy than `base` (the current view): merge it into the
   * form (this tab's changes against `base` stay) and resolve once the form
   * shows the merge, so the next plan() diffs the merged form against it.
   * `saves`: this tab's saves that reached the server (landed: rebase `base`
   * onto what they sent before merging) or may have (unknown). Resolves
   * 'held' when the form asks the member first (the saver then holds).
   */
  adopt: (base: FullView, fresh: FullView, saves: { landed: SentSave<T>[]; unknown: SentSave<T>[] }) => Promise<void | 'held'>
  /** The form the server holds once plan(view) is saved (the ledger's `sent`). */
  snapshot?: (view: FullView) => T
  /**
   * The ledger changed (`sent`: the save just sent, if that is why): the
   * form records it in the tab's device copy, made against `view`.
   */
  onLedger?: (ledger: readonly SentSave<T>[], view: FullView, sent?: SentSave<T>) => void
  onStatus: (s: SaveStatus) => void
  /** The server now holds exactly the form with this key. */
  onSynced: (key: string) => void
  /** The name of an upload in the form (for "<name> failed its check"). */
  audioName?: (audioId: number) => string | null
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

/** Saves kept in the ledger at most (older ones are dropped first). */
const MAX_LEDGER = 20
/** A save answered like this may still have been written (the answer was lost). */
const MAYBE_WRITTEN = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 408 || e.status >= 500

export class DraftSaver<T = unknown> {
  view: FullView | null
  /** Saves sent whose answer has not come back (see the top of the file). */
  private ledger: SentSave<T>[] = []
  /** Ledger saveIds not yet checked against a server copy fetched after they were sent. */
  private unchecked = new Set<string>()
  /** Server copies fetched (started) and merged, in order (catchUpNow). */
  private checksStarted = 0
  private checksMerged = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<Outcome> | null = null
  private again = false
  private refreshWanted = false
  private failures = 0
  private stopped = false
  /** Stopped because the event can no longer be edited (never revived). */
  private terminal = false
  /** Waiting for the member's choice about a device copy: no saves at all. */
  private held = false
  private heldWanted = false
  private readonly debounceMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(private readonly o: SaverOptions<T>) {
    this.view = o.initial
    this.debounceMs = o.debounceMs ?? 1500
    this.retryBaseMs = o.retryBaseMs ?? 2000
    this.retryMaxMs = o.retryMaxMs ?? 30_000
  }

  /** The form changed: save ~debounceMs after the last change. */
  touch(): void {
    if (this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.kick()
    }, this.debounceMs)
  }

  /** Save now (or right after the save in flight). Resolves with the outcome. */
  kick(): Promise<Outcome> {
    if (this.stopped) return Promise.resolve('stopped')
    if (this.held) {
      this.heldWanted = true
      return Promise.resolve('blocked')
    }
    if (this.running) {
      this.again = true
      return this.running
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    const p = this.loop().finally(() => {
      this.running = null
    })
    this.running = p
    return p
  }

  /** Before submit: send everything now. True when the server holds the form. */
  async flush(): Promise<boolean> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.running) await this.running.catch(() => undefined)
    return (await this.kick()) === 'synced'
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.timer = null
    this.retryTimer = null
  }

  /**
   * Catch up with the server (the tab is visible again, another tab saved):
   * fetch the event and merge it when it is newer. Nothing is sent unless
   * this tab has changes of its own. Serialised with the saves.
   */
  refresh(): Promise<Outcome> {
    if (this.stopped || !this.view) return Promise.resolve('stopped')
    this.refreshWanted = true
    return this.kick()
  }

  /**
   * Fetch the server copy NOW and merge it into the form (serialised with
   * the saves, which also send this tab's own changes). True once a copy
   * fetched after this call has been merged and the saver is not holding
   * for a question; false when it could not be fetched.
   */
  async catchUpNow(): Promise<boolean> {
    if (this.stopped || !this.view) return false
    const want = this.checksStarted + 1
    for (let i = 0; i < 2 && this.checksMerged < want && !this.stopped; i++) await this.refresh().catch(() => undefined)
    return this.checksMerged >= want && !this.held && !this.stopped
  }

  /** A retry is waiting (an upload being checked, a network blip): try now. */
  nudge(): void {
    if (this.retryTimer && !this.stopped) void this.kick()
  }

  /** Send nothing (not even refreshes or keepalives) until release(). */
  hold(): void {
    this.held = true
    this.o.onStatus({ kind: 'held' })
  }

  /** The choice is made: save (and catch up) as usual again. */
  release(): void {
    if (!this.held) return
    this.held = false
    this.o.onStatus({ kind: 'idle' })
    if (this.heldWanted) {
      this.heldWanted = false
      void this.kick()
    }
  }

  get isHeld(): boolean {
    return this.held
  }

  /** Undo stop() (a remount, a failed discard) unless the event is no longer editable. */
  revive(): void {
    if (!this.terminal) this.stopped = false
  }

  /**
   * The page is being hidden or left: send what the server is missing with
   * fetch keepalive (it outlives the page). Best effort — the local backup
   * still holds everything if it does not arrive. Returns what was sent (the
   * form records it in its device copy: a reopened page checks the saveIds
   * against the event's recentSaveIds), or null when nothing was sent.
   */
  flushKeepalive(): SentSave<T> | null {
    if (this.stopped || this.held || !this.view) return null
    const plan = this.o.plan(this.view)
    const details = Object.keys(plan.patch).length ? plan.patch : undefined
    const playlist = plan.playlist ?? undefined
    if (!details && !playlist) return null
    // ONE request (POST /draft: details + playlist in one transaction, both
    // against this base version). Two keepalive requests arrive in any
    // order, and a playlist PUT at a guessed version+1 could land on top of
    // another device's save; this one lands whole or not at all.
    const saveId = newSaveId()
    try {
      void fetch(`/api/ev/events/${this.view.id}/draft`, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ version: this.view.version, expectStatus: 'draft', saveId, ...(details ? { details } : {}), ...(playlist ? { playlist } : {}) }),
      }).catch(() => undefined)
    } catch {
      // keepalive quota or no fetch: the local backup still has it
    }
    const rec: SentSave<T> = { saveId, details: !!details, playlist: !!playlist, sentAt: Date.now(), baseVersion: this.view.version, sent: this.o.snapshot?.(this.view) as T }
    this.record(rec)
    return rec
  }

  /** Saves sent whose answer has not come back (tests). */
  get unanswered(): readonly SentSave<T>[] {
    return this.ledger
  }

  private record(r: SentSave<T>) {
    if (!this.o.snapshot) return
    this.unchecked.add(r.saveId)
    this.setLedger([...this.ledger, r].slice(-MAX_LEDGER), r)
  }

  private setLedger(l: SentSave<T>[], sent?: SentSave<T>) {
    this.ledger = l
    for (const id of this.unchecked) if (!l.some((r) => r.saveId === id)) this.unchecked.delete(id)
    if (this.view) this.o.onLedger?.(l, this.view, sent)
  }

  /** A save may have reached the server without this tab knowing: check before trusting the base. */
  private hasUnchecked(): boolean {
    return this.unchecked.size > 0
  }

  private setView(v: FullView) {
    this.view = v
    this.o.onView(v)
    // saves made against an older version can no longer land (or are in it)
    this.setLedger(this.ledger.filter((r) => r.baseVersion >= v.version))
  }

  /** Send one save (PATCH, PUT, or the seal) with a ledger entry until its answer comes back. */
  private async send(url: string, method: 'PATCH' | 'PUT' | 'POST', json: Record<string, unknown>, part: 'details' | 'playlist' | 'seal', snap: T, base: number): Promise<FullView> {
    const saveId = newSaveId()
    const rec: SentSave<T> = { saveId, details: part === 'details', playlist: part === 'playlist', sentAt: Date.now(), baseVersion: base, sent: snap }
    this.record(rec)
    try {
      const r = await api<{ event: FullView }>(url, { method, json: { ...json, version: base, expectStatus: 'draft', saveId } })
      this.setLedger(this.ledger.filter((x) => x !== rec))
      return r.event
    } catch (e) {
      // Refused: it was not written. Otherwise it may have been (kept, and
      // checked against a fresh server copy before the next plan).
      if (!MAYBE_WRITTEN(e)) this.setLedger(this.ledger.filter((x) => x !== rec))
      else this.refreshWanted = true
      throw e
    }
  }

  /** Fetch the event and merge it (catchUp); the saves sent before the fetch are checked by it. */
  private async check(id: number): Promise<void> {
    const sentBefore = [...this.unchecked]
    const seq = ++this.checksStarted
    await this.catchUp(await api<FullView>(`/api/ev/events/${id}`), sentBefore)
    this.checksMerged = Math.max(this.checksMerged, seq)
  }

  /**
   * The saves in `sentBefore` (sent before `fresh` was fetched) are sorted
   * by it: each is decided, except one the server is not past yet (it may
   * still arrive): that one stays unchecked (the next write decides it:
   * saveOnce's seal).
   */
  private settle(sentBefore: readonly string[], baseVersion: number, fresh: FullView) {
    const recs = this.ledger.filter((r) => sentBefore.includes(r.saveId))
    const pending = new Set(sortSaves(recs, baseVersion, fresh).pending.map((r) => r.saveId))
    for (const id of sentBefore) if (!pending.has(id)) this.unchecked.delete(id)
  }

  /** Merge a server copy into the form when it is newer than the base. */
  private async catchUp(fresh: FullView, sentBefore: readonly string[]): Promise<void> {
    const base = this.view
    if (!base || fresh.id !== base.id) return
    // The status first, whatever the version: submit / approve / withdraw do
    // not bump it, so an equal (or even older-looking) version may still be
    // a request that is no longer a draft. No more autosaves then.
    if (fresh.status !== 'draft') throw new ApiError(409, 'status_changed', [], { status: fresh.status })
    // Every save sent before this copy was fetched is now sorted by it,
    // except one that has not arrived yet with the server not past its base.
    if (fresh.version <= base.version) {
      this.settle(sentBefore, base.version, fresh)
      return
    }
    // This tab's saves the fresh copy already holds move the merge base
    // first: their changes are the server's now, not this tab's to re-apply.
    // (The device copy keeps every record until setView moves its base too.)
    const fates = sortSaves(this.ledger, base.version, fresh)
    this.ledger = fates.pending
    const r = await this.o.adopt(base, fresh, { landed: fates.landed, unknown: fates.unknown })
    this.settle(sentBefore, base.version, fresh)
    this.setView(fresh)
    if (r === 'held') this.hold()
  }

  /** catchUp left the saver on hold (the form asks first): save nothing now. */
  private heldNow(): boolean {
    if (!this.held) return false
    this.heldWanted = true
    return true
  }

  private async loop(): Promise<Outcome> {
    let out: Outcome
    let conflicts = 0
    for (;;) {
      this.again = false
      // A save may have landed unseen (its answer was lost, a keepalive):
      // catch up first, so the plan diffs against what the server holds.
      if ((this.refreshWanted || this.hasUnchecked()) && this.view) {
        this.refreshWanted = false
        try {
          await this.check(this.view.id)
        } catch (e) {
          // A terminal answer stops the saver. A save whose fate is still
          // unknown: nothing is written on an unchecked base, only the retry
          // is scheduled (offline / network status). Otherwise a blip is
          // retried by the next save or focus.
          if ((e instanceof ApiError && TERMINAL.has(e.code)) || this.hasUnchecked()) {
            if (!(e instanceof ApiError && TERMINAL.has(e.code))) this.refreshWanted = true
            out = this.fail(e)
            break
          }
        }
        if (this.heldNow()) {
          out = 'blocked'
          break
        }
      }
      try {
        out = await this.saveOnce()
        this.failures = 0
      } catch (e) {
        if (e instanceof ApiError && e.code === 'version_conflict' && this.view && conflicts < 3) {
          // Another tab saved first: merge theirs into the form (this tab's
          // changes stay), then send only this tab's changes on top.
          conflicts++
          try {
            await this.check(this.view.id)
          } catch (e2) {
            out = this.fail(e2)
            break
          }
          if (this.heldNow()) {
            out = 'blocked'
            break
          }
          this.again = true
          continue
        }
        out = this.fail(e)
      }
      if (!this.again || this.stopped || out === 'retry' || out === 'stopped') break
    }
    return out
  }

  /** This page has changes the server does not have (they are not sent any more). */
  private unsaved(): boolean {
    try {
      const p = this.o.plan(this.view)
      return !!(p.create || Object.keys(p.patch).length || p.playlist || p.blocked.length)
    } catch {
      return true
    }
  }

  private fail(e: unknown): Outcome {
    if (e instanceof ApiError && TERMINAL.has(e.code)) {
      this.terminal = true
      this.stop()
      const moved = MOVED.has(e.code)
      const status = typeof e.body?.status === 'string' ? e.body.status : undefined
      this.o.onStatus({
        kind: 'stopped',
        reason: moved ? movedMessage(status, this.unsaved()) : evMessage(e),
        ...(moved ? { moved: status ?? '' } : {}),
        ...(this.view && (moved || e.code === 'not_editable') ? { reloadHref: `/my/events/${this.view.id}` } : {}),
      })
      return 'stopped'
    }
    if (e instanceof ApiError && e.code === 'audio_failed') {
      // Never becomes usable: no retry loop. The details were saved before
      // the playlist (saveOnce); the rest saves once the upload is removed.
      const id = typeof e.body?.audioId === 'number' ? e.body.audioId : undefined
      const name = id !== undefined ? this.o.audioName?.(id) : null
      this.o.onStatus({ kind: 'error', reason: `${name ? `"${name}"` : 'One of your uploads'} failed its check. Remove it to save the rest.`, retrying: false, ...(id !== undefined ? { audioId: id } : {}) })
      return 'failed'
    }
    // (bounded: an upload that failed its check never becomes usable, and
    // then the refusal below asks for it to be removed)
    const waiting = e instanceof ApiError && e.code === 'audio_not_ready' && this.failures < MAX_UPLOAD_WAITS
    if (TRANSIENT(e) || waiting || !(e instanceof ApiError)) {
      // An upload still being checked becomes usable by itself: keep the
      // pick (the form and the device backup hold it) and try again, sooner
      // when the upload list shows it ready (nudge()).
      this.failures++
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      this.o.onStatus(offline ? { kind: 'offline' } : { kind: 'error', reason: waiting ? WAITING_FOR_UPLOAD : evMessage(e), retrying: true })
      const wait = Math.min(this.retryBaseMs * 2 ** (this.failures - 1), this.retryMaxMs)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        void this.kick()
      }, wait)
      return 'retry'
    }
    // A refusal of this content (a clash, a reserved title, a song that is
    // gone): kept on the device; the next change tries again.
    this.o.onStatus({ kind: 'error', reason: evMessage(e), retrying: false })
    return 'failed'
  }

  private async saveOnce(): Promise<Outcome> {
    let plan = this.o.plan(this.view)
    if (!this.view) {
      if (!plan.create) {
        this.o.onStatus({ kind: 'new', missing: plan.missing })
        return 'blocked'
      }
      this.o.onStatus({ kind: 'saving' })
      this.setView((await api<{ event: FullView }>('/api/ev/events', { json: plan.create })).event)
      plan = this.o.plan(this.view)
    }
    const v0 = this.view!
    const wrote = !!(plan.create || Object.keys(plan.patch).length || plan.playlist)
    if (Object.keys(plan.patch).length || plan.playlist) this.o.onStatus({ kind: 'saving' })
    // What the server holds once this plan is saved (taken with the plan).
    const snap = this.o.snapshot?.(v0) as T
    // Details first: a playlist the server refuses (an upload that failed
    // its check) never holds back the details.
    if (Object.keys(plan.patch).length) {
      this.setView(await this.send(`/api/ev/events/${v0.id}`, 'PATCH', plan.patch, 'details', snap, v0.version))
    }
    if (plan.playlist) {
      const v = this.view!
      this.setView(await this.send(`/api/ev/events/${v.id}/playlist`, 'PUT', plan.playlist, 'playlist', snap, v.version))
    }
    if (this.hasUnchecked()) {
      // A save that may still land (the check just found the server not
      // past its version: a keepalive on its way) and nothing else to send:
      // the member undid what it sent (or it sent what the server holds).
      // Never settled by waiting: a write that changes nothing moves the
      // version on, so it can no longer land (or this gets 409 because it
      // already did: caught up and rebased onto it, then the undo is sent).
      const v = this.view!
      this.o.onStatus({ kind: 'saving' })
      this.setView(await this.send(`/api/ev/events/${v.id}/draft`, 'POST', { seal: true }, 'seal', snap, v.version))
    }
    if (plan.blocked.length) {
      this.o.onStatus({ kind: 'partial', reason: plan.blocked.join(' ') })
      return 'blocked'
    }
    this.o.onSynced(plan.key)
    this.o.onStatus({ kind: 'saved', at: Date.now(), wrote })
    return 'synced'
  }
}

// ------------------------------------------------------------ backup ----

/**
 * The device copy of a form with unsaved changes. `base` is the server copy
 * those changes were made against: a restore merges them (three-way) into
 * the server copy of that moment, so it never writes over newer work.
 * A new request (no draft yet) has one copy per user; a draft has one per
 * tab (`tabBackupKey`), so two tabs never overwrite or clear each other's.
 */
export type Backup<T> = {
  v: 2
  savedAt: number
  eventId: number | null
  baseVersion: number | null
  base: FullView | null
  data: T
  /**
   * Saves sent from this copy's base whose answer had not come back (a
   * keepalive as the page was hidden or left, a PATCH/PUT in flight or whose
   * answer was lost), oldest first, each with the form it sent. A reopened
   * page whose event lists a record's saveId knows it arrived, and restores
   * only what changed after it (restore.ts). The name is historical.
   */
  keepalive?: SentSave<T>[]
}

export const backupKey = (user: string, id: number | 'new') => `efm_ev_form:${user}:${id}`
export const tabBackupKey = (user: string, id: number, tab: string) => `${backupKey(user, id)}~${tab}`
/** Is `key` a tab copy of this draft (any tab)? */
export const isDraftBackupKey = (key: string | null, user: string, id: number) => !!key && key.startsWith(`${backupKey(user, id)}~`)

/** Every tab's copy of a draft, oldest first. */
export function readDraftBackups<T>(user: string, id: number): { key: string; backup: Backup<T> }[] {
  const out: { key: string; backup: Backup<T> }[] = []
  try {
    const ls = window.localStorage
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i)
      if (!key || !isDraftBackupKey(key, user, id)) continue
      const b = readBackup<T>(key)
      if (b && b.eventId === id && b.base) out.push({ key, backup: b })
    }
  } catch {
    // storage blocked
  }
  return out.sort((a, b) => a.backup.savedAt - b.backup.savedAt)
}

export function readBackup<T>(key: string): Backup<T> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const b = JSON.parse(raw) as Backup<T>
    return b && b.v === 2 && b.data ? b : null
  } catch {
    return null
  }
}

/** False when storage is blocked or full (the status then cannot promise "saved on this device"). */
export function writeBackup<T>(key: string, b: Backup<T>): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(b))
    return true
  } catch {
    return false
  }
}

export function clearBackup(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch {
    // storage blocked
  }
}

// ---------------------------------------------------------- playlist key

/** Order-stable key of a playlist (announcement order does not matter to the server). */
export function payloadKey(p: { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[]; playlistOrder: PlaylistOrder }): string {
  const ms = (s: string | null) => (s ? Date.parse(s) : null)
  const tracks = [...p.tracks].sort((a, b) => a.position - b.position).map((t) => [t.source, t.mediaId, t.audioId, ms(t.pinAt)])
  const anns = p.announcements.map((a) => JSON.stringify([a.source, a.mediaId, a.audioId, a.mode, ms(a.at), a.everyMin, ms(a.from), ms(a.until)])).sort()
  return JSON.stringify({ o: p.playlistOrder, t: tracks, a: anns })
}
