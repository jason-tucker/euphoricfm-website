// Draft autosave (0.5.3). Nothing a member types may be lost:
//   - the whole form is mirrored to localStorage (backupKey) until the server
//     holds the same data (RequestForm owns that part);
//   - DraftSaver creates the draft once the minimum is valid, then debounces
//     and saves: PATCH details, PUT playlist, both with the loaded version.
//     Saves are serialised (never two in flight) and coalesced; a 409
//     version_conflict re-fetches the event and re-applies the local form on
//     top; transient failures retry with backoff; flushKeepalive() sends the
//     last changes with fetch keepalive when the page is hidden or left.
// The form supplies `plan(view)`: what the server is missing, computed from
// its latest state every time (so a retry always sends the newest data).

import { api, ApiError, evMessage } from './ev-api'
import type { EventAnnouncement, EventTrack, FullView, PlaylistOrder } from './types'

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
  | { kind: 'error'; reason: string; retrying: boolean }
  | { kind: 'offline' }
  | { kind: 'stopped'; reason: string }

type Outcome = 'synced' | 'blocked' | 'retry' | 'failed' | 'stopped'

const TRANSIENT = (e: unknown) =>
  e instanceof ApiError && e.code !== 'daily_cap' && (e.status === 0 || e.status === 408 || e.status === 425 || e.status === 429 || e.status >= 500)
/** The event can no longer be edited here (submitted/withdrawn elsewhere, frozen, gone). */
const TERMINAL = new Set(['not_editable', 'frozen', 'not_found', 'forbidden', 'unauthorized'])

export type SaverOptions = {
  initial: FullView | null
  plan: (view: FullView | null) => SavePlan
  onView: (v: FullView) => void
  onStatus: (s: SaveStatus) => void
  /** The server now holds exactly the form with this key. */
  onSynced: (key: string) => void
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
  private failures = 0
  private stopped = false
  /** Stopped because the event can no longer be edited (never revived). */
  private terminal = false
  private readonly debounceMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number

  constructor(private readonly o: SaverOptions) {
    this.view = o.initial
    this.debounceMs = o.debounceMs ?? 1200
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

  /** Undo stop() (a remount, a failed discard) unless the event is no longer editable. */
  revive(): void {
    if (!this.terminal) this.stopped = false
  }

  /**
   * The page is being hidden or left: send what the server is missing with
   * fetch keepalive (it outlives the page). Best effort — the local backup
   * still holds everything if it does not arrive.
   */
  flushKeepalive(): void {
    if (this.stopped || !this.view) return
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
    let version = this.view.version
    if (Object.keys(plan.patch).length) {
      send(`/api/ev/events/${this.view.id}`, 'PATCH', { ...plan.patch, version })
      version += 1 // each accepted edit bumps the version by one
    }
    if (plan.playlist) send(`/api/ev/events/${this.view.id}/playlist`, 'PUT', { ...plan.playlist, version })
  }

  private setView(v: FullView) {
    this.view = v
    this.o.onView(v)
  }

  private async loop(): Promise<Outcome> {
    let out: Outcome
    let conflicts = 0
    for (;;) {
      this.again = false
      try {
        out = await this.saveOnce()
        this.failures = 0
      } catch (e) {
        if (e instanceof ApiError && e.code === 'version_conflict' && this.view && conflicts < 3) {
          // Someone (another tab) saved first: load theirs, re-apply ours.
          conflicts++
          try {
            this.setView(await api<FullView>(`/api/ev/events/${this.view.id}`))
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

  private fail(e: unknown): Outcome {
    if (e instanceof ApiError && TERMINAL.has(e.code)) {
      this.terminal = true
      this.stop()
      this.o.onStatus({ kind: 'stopped', reason: evMessage(e) })
      return 'stopped'
    }
    if (TRANSIENT(e) || !(e instanceof ApiError)) {
      this.failures++
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      this.o.onStatus(offline ? { kind: 'offline' } : { kind: 'error', reason: evMessage(e), retrying: true })
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
    if (Object.keys(plan.patch).length) {
      this.setView((await api<{ event: FullView }>(`/api/ev/events/${v0.id}`, { method: 'PATCH', json: { ...plan.patch, version: v0.version } })).event)
    }
    if (plan.playlist) {
      const v = this.view!
      this.setView((await api<{ event: FullView }>(`/api/ev/events/${v.id}/playlist`, { method: 'PUT', json: { ...plan.playlist, version: v.version } })).event)
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

export type Backup<T> = { v: 1; savedAt: number; eventId: number | null; baseVersion: number | null; data: T }

export const backupKey = (user: string, id: number | 'new') => `efm_ev_form:${user}:${id}`

export function readBackup<T>(key: string): Backup<T> | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const b = JSON.parse(raw) as Backup<T>
    return b && b.v === 1 && b.data ? b : null
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
