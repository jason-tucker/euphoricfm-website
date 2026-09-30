// Draft autosave (0.5.3). Nothing a member types may be lost:
//   - the whole form is mirrored to localStorage (backupKey) until the server
//     holds the same data (RequestForm owns that part);
//   - DraftSaver creates the draft once the minimum is valid, then debounces
//     and saves: PATCH details, PUT playlist, both with the loaded version.
//     Saves are serialised (never two in flight) and coalesced; transient
//     failures retry with backoff; flushKeepalive() sends the last changes
//     with fetch keepalive when the page is hidden or left.
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
// The form supplies `plan(view)`: what the server is missing, computed from
// its latest state every time (so a retry always sends the newest data).

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
  | { kind: 'saved'; at: number }
  | { kind: 'partial'; reason: string }
  | { kind: 'error'; reason: string; retrying: boolean; /** an upload that failed its check */ audioId?: number }
  | { kind: 'offline' }
  | { kind: 'stopped'; reason: string; /** reload link (the event page) */ reloadHref?: string }
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

/** What a keepalive save sent (recorded in the tab's device copy). */
export type KeepaliveSent = {
  /** The saveId of the PATCH / the PUT, when sent. */
  patch?: string
  playlist?: string
  sentAt: number
  /** The server version the requests were made against. */
  baseVersion: number
}
/** A save waiting for an upload that is still being checked (it becomes usable by itself). */
const MAX_UPLOAD_WAITS = 20
export const WAITING_FOR_UPLOAD = "One of your uploads is still being checked. It's added to the draft by itself once it's ready."

export type SaverOptions = {
  initial: FullView | null
  plan: (view: FullView | null) => SavePlan
  onView: (v: FullView) => void
  /**
   * A newer server copy than `base` (the current view): merge it into the
   * form (this tab's changes against `base` stay) and resolve once the form
   * shows the merge, so the next plan() diffs the merged form against it.
   */
  adopt: (base: FullView, fresh: FullView) => Promise<void>
  onStatus: (s: SaveStatus) => void
  /** The server now holds exactly the form with this key. */
  onSynced: (key: string) => void
  /** The name of an upload in the form (for "<name> failed its check"). */
  audioName?: (audioId: number) => string | null
  debounceMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
}

export class DraftSaver {
  view: FullView | null
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

  constructor(private readonly o: SaverOptions) {
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
  flushKeepalive(): KeepaliveSent | null {
    if (this.stopped || this.held || !this.view) return null
    const plan = this.o.plan(this.view)
    const send = (url: string, method: string, body: unknown) => {
      try {
        void fetch(url, {
          method,
          keepalive: true,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
        }).catch(() => undefined)
      } catch {
        // keepalive quota or no fetch: the local backup still has it
      }
    }
    const out: KeepaliveSent = { sentAt: Date.now(), baseVersion: this.view.version }
    let version = this.view.version
    if (Object.keys(plan.patch).length) {
      out.patch = newSaveId()
      send(`/api/ev/events/${this.view.id}`, 'PATCH', { ...plan.patch, version, expectStatus: 'draft', saveId: out.patch })
      version += 1 // each accepted edit bumps the version by one
    }
    if (plan.playlist) {
      out.playlist = newSaveId()
      send(`/api/ev/events/${this.view.id}/playlist`, 'PUT', { ...plan.playlist, version, expectStatus: 'draft', saveId: out.playlist })
    }
    return out.patch || out.playlist ? out : null
  }

  private setView(v: FullView) {
    this.view = v
    this.o.onView(v)
  }

  /** Merge a server copy into the form when it is newer than the base. */
  private async catchUp(fresh: FullView): Promise<void> {
    const base = this.view
    if (!base || fresh.id !== base.id) return
    // The status first, whatever the version: submit / approve / withdraw do
    // not bump it, so an equal (or even older-looking) version may still be
    // a request that is no longer a draft. No more autosaves then.
    if (fresh.status !== 'draft') throw new ApiError(409, 'status_changed', [], { status: fresh.status })
    if (fresh.version <= base.version) return
    await this.o.adopt(base, fresh)
    this.setView(fresh)
  }

  private async loop(): Promise<Outcome> {
    let out: Outcome
    let conflicts = 0
    for (;;) {
      this.again = false
      if (this.refreshWanted && this.view) {
        this.refreshWanted = false
        try {
          await this.catchUp(await api<FullView>(`/api/ev/events/${this.view.id}`))
        } catch (e) {
          // only a terminal answer matters here; a blip is retried by the next save or focus
          if (e instanceof ApiError && TERMINAL.has(e.code)) {
            out = this.fail(e)
            break
          }
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
            await this.catchUp(await api<FullView>(`/api/ev/events/${this.view.id}`))
          } catch (e2) {
            out = this.fail(e2)
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
    if (Object.keys(plan.patch).length || plan.playlist) this.o.onStatus({ kind: 'saving' })
    // Details first: a playlist the server refuses (an upload that failed
    // its check) never holds back the details.
    if (Object.keys(plan.patch).length) {
      const json = { ...plan.patch, version: v0.version, expectStatus: 'draft', saveId: newSaveId() }
      this.setView((await api<{ event: FullView }>(`/api/ev/events/${v0.id}`, { method: 'PATCH', json })).event)
    }
    if (plan.playlist) {
      const v = this.view!
      const json = { ...plan.playlist, version: v.version, expectStatus: 'draft', saveId: newSaveId() }
      this.setView((await api<{ event: FullView }>(`/api/ev/events/${v.id}/playlist`, { method: 'PUT', json })).event)
    }
    if (plan.blocked.length) {
      this.o.onStatus({ kind: 'partial', reason: plan.blocked.join(' ') })
      return 'blocked'
    }
    this.o.onSynced(plan.key)
    this.o.onStatus({ kind: 'saved', at: Date.now() })
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
   * Keepalive saves sent from this copy's base as the page was hidden or
   * left, oldest first, each with the form it sent. A reopened page whose
   * event lists a record's saveIds knows it arrived, and restores only what
   * changed after it (restore.ts).
   */
  keepalive?: (KeepaliveSent & { sent: T })[]
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
