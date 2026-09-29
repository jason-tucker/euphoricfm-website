// The events wrapper's DEFAULT-DENY allowlist (plan §4 "Events wrapper"):
// every request the events worker may send to AzuraCast is one of the
// (method, route) pairs below, on station 14 only, with a strict zod body.
// Everything else is refused before any I/O, including DELETE /file (except
// the narrow audio delete), rename, move, queue/immediate/reprocess batch
// actions, /fallback, /sftp-users, playlist toggle/clone/import/empty/
// apply-to, and any other station.
//
// This module is PURE (no I/O). The checks that need a fresh read (the
// playlist's recorded name, a file's live path and memberships, the queue
// ids, a playlist's order entries) live in client.ts validate(), which calls
// these helpers.

import { z } from 'zod'
import { assertSafePath } from '../../server/paths/builder'
import { eventUploadPath, INTERNAL_NAME_RE } from '../contract/paths'
import { LEGACY_EVENT_PLAYLIST_IDS, MAIN_NAME_MAX, PLAYLIST_ID_FLOOR as FLOOR } from '../contract/rules'
import { etWallToUtc, hhmmToMinutes, isHhmm, isValidDate } from './time'

// ------------------------------------------------------------- constants --

// Fixed by the contract (rules.ts / paths.ts); re-exported here so the
// wrapper's refusal rules read in one place.
export { EVENTS_STATION_ID, PLAYLIST_ID_FLOOR } from '../contract/rules'
export { LIBRARY_FILE_RE, STINGER_FILE_RE, EVENT_UPLOAD_RE } from '../contract/paths'
export const LEGACY_PLAYLIST_IDS: readonly number[] = LEGACY_EVENT_PLAYLIST_IDS

export const SNOWFLAKE_RE = /^\d{17,20}$/
// A library song the music portal archived (moved to Removed/<id>/). Only a
// removal-only membership write may name it (the T−60 recheck drops it from
// the event's playlists; the music archive clears station 1 only).
export const ARCHIVED_FILE_RE = /^Removed\/\d+\/[^/]+$/
export const EVENTS_UPLOAD_DIR = 'Events/Uploads'
export const STINGER_DIR = 'EFM Stingers'

// The one upload path of (owner, audio): contract eventUploadPath, with its
// errors mapped to wrapper refusals.
export function eventUploadPathFor(ownerDiscordId: string, audioId: number): string {
  try {
    return eventUploadPath(ownerDiscordId, audioId)
  } catch {
    throw new AllowlistError('refused_upload_identity', { audioId })
  }
}

export class AllowlistError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code)
    this.name = 'AllowlistError'
  }
}

// Hard floor, independent of the registry (which lives in a DB both webs
// can write): the wrapper never edits, orders or deletes a playlist at or
// below the floor or in the legacy set.
export function assertWritablePlaylistId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new AllowlistError('refused_playlist_id', { id })
  if (id <= FLOOR || LEGACY_PLAYLIST_IDS.includes(id)) throw new AllowlistError('refused_playlist_floor', { id })
}

export function safePath(p: string): boolean {
  try {
    assertSafePath(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- names --

// Main playlist names are the public title, sanitized (plan §4): letters,
// digits, spaces and basic punctuation, ≤ 60 chars, never a leading `~`
// (the info card hides `~` names). Pins and announcements use the opaque
// `~EVT<id> s<n>` / `~EVT<id> a<n>`.
// Same charset as contract paths.sanitizePlaylistName (no '/', no '~').
export const MAIN_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .,'!?&()\-:#+]*$/u
export const MARKED_NAME_RE = INTERNAL_NAME_RE

export function isMainName(name: string): boolean {
  return MAIN_NAME_RE.test(name) && Array.from(name).length <= MAIN_NAME_MAX && name === name.trim() && !/\s{2}/.test(name)
}

export function markedNameEventId(name: string): number | null {
  const m = MARKED_NAME_RE.exec(name)
  return m ? Number(m[1]) : null
}

// ----------------------------------------------------------- body shapes --

export const BACKEND_OPTIONS = ['interrupt', 'single_track'] as const
export type BackendOption = (typeof BACKEND_OPTIONS)[number]

const isoDate = z.string().refine(isValidDate, 'bad date')

export const ScheduleItemBody = z
  .object({
    start_time: z.number().int().refine(isHhmm, 'bad HHMM'),
    end_time: z.number().int().refine(isHhmm, 'bad HHMM'),
    start_date: isoDate,
    end_date: isoDate,
    days: z.array(z.number().int().min(1).max(7)).max(7),
    loop_once: z.boolean(),
  })
  .strict()
  .superRefine((s, ctx) => {
    // Plan §4 "Rows": every row is dated, same-day, forward (a start equal
    // to the end is AzuraCast's "play once" form, which we never send).
    if (s.start_date !== s.end_date) ctx.addIssue({ code: 'custom', message: 'row must be same-date' })
    if (!(s.start_time < s.end_time)) ctx.addIssue({ code: 'custom', message: 'row must end after it starts' })
    if (new Set(s.days).size !== s.days.length) ctx.addIssue({ code: 'custom', message: 'duplicate days' })
  })
export type ScheduleItem = z.infer<typeof ScheduleItemBody>

export const PlaylistBody = z
  .object({
    name: z.string().max(4 * MAIN_NAME_MAX),
    type: z.literal('default'),
    source: z.literal('songs'),
    order: z.enum(['shuffle', 'sequential']),
    is_enabled: z.boolean(),
    is_jingle: z.literal(false),
    weight: z.number().int().min(1).max(25),
    include_in_requests: z.literal(false),
    include_in_on_demand: z.literal(false),
    avoid_duplicates: z.boolean(),
    backend_options: z.array(z.enum(BACKEND_OPTIONS)).max(2),
    schedule_items: z.array(ScheduleItemBody).min(1).max(1000),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (!isMainName(b.name) && !MARKED_NAME_RE.test(b.name)) ctx.addIssue({ code: 'custom', message: 'bad playlist name' })
    if (new Set(b.backend_options).size !== b.backend_options.length) ctx.addIssue({ code: 'custom', message: 'duplicate backend option' })
  })
export type PlaylistBodyT = z.infer<typeof PlaylistBody>

// The only partial PUT: disabling (end kick). Enabling always sends the
// whole pinned body.
export const DisableBody = z.object({ is_enabled: z.literal(false) }).strict()

// PUT /playlist/{id}/order: AzuraCast's PutOrderAction hands `order` to
// StationPlaylistMediaRepository::setMediaOrder, which runs
// `UPDATE station_playlist_media SET weight = :weight WHERE playlist_id = :p
// AND id = :id` for each `id => weight` pair — a MAP of order-entry id (the
// `id` of each GET /order row, a station_playlist_media id) to its new
// weight (1..n, GET /order sorts by weight ascending), exactly as the
// AzuraCast UI's reorder dialog sends it. A JSON LIST would reach PHP as
// 0 => id, 1 => id…, update no row and still answer 200 (the 0.5.1 live
// build hit this), so a list is refused here.
export const ORDER_ENTRY_ID_RE = /^[1-9]\d{0,9}$/
export const OrderBody = z
  .object({
    order: z
      .record(z.string().regex(ORDER_ENTRY_ID_RE, 'order key must be an entry id'), z.number().int().min(1).max(2000))
      .refine((o) => Object.keys(o).length >= 1 && Object.keys(o).length <= 2000, 'order must name 1–2000 entries'),
  })
  .strict()
export type OrderBodyT = z.infer<typeof OrderBody>

// The map setOrder sends: entry ids in the wanted order → weights 1..n.
export function orderMapOf(entryIds: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {}
  entryIds.forEach((id, i) => {
    out[String(id)] = i + 1
  })
  return out
}

const filePathStr = z.string().min(1).max(1024)
export const MembershipBody = z
  .object({
    do: z.literal('playlist'),
    files: z.tuple([filePathStr]),
    dirs: z.array(z.never()).max(0),
    currentDirectory: z.string().max(1024),
    playlists: z.array(z.number().int().positive().max(2_147_483_647)).max(64),
  })
  .strict()
export type MembershipBodyT = z.infer<typeof MembershipBody>

const metaString = z
  .string()
  .max(255)
  .refine((s) => !/[\p{Cc}]/u.test(s), 'control characters')
// Same shape as the music MetadataBody: never `path` or `playlists`.
export const EventMetadataBody = z.object({ title: metaString, artist: metaString, album: metaString, genre: metaString }).strict()
export type EventMetadata = z.infer<typeof EventMetadataBody>

// ------------------------------------------------------------- routes ----

export type RouteKind =
  | 'read'
  | 'playlist_create'
  | 'playlist_update'
  | 'playlist_delete'
  | 'playlist_order'
  | 'membership'
  | 'upload'
  | 'metadata'
  | 'file_delete'
  | 'queue_delete'
  | 'restart'

export type Route = {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  re: RegExp
  kind: RouteKind
  query?: Record<string, (v: string) => boolean>
  requiredQuery?: readonly string[]
  // GET routes the startup self-check may send to a canary station.
  canary?: boolean
}

const ID = '([1-9]\\d{0,9})'
const S = '/api/station/(\\d+)'
// files/list: only the folders the events worker reads.
export const LISTABLE_DIRS_RE = /^(?:|Events|Events\/Uploads|Events\/Uploads\/\d{17,20}|EFM Stingers)$/

export const ROUTES: readonly Route[] = [
  // reads (station 14 only)
  { method: 'GET', re: new RegExp(`^${S}/playlists$`), kind: 'read', canary: true },
  { method: 'GET', re: new RegExp(`^${S}/playlist/${ID}$`), kind: 'read' },
  { method: 'GET', re: new RegExp(`^${S}/playlist/${ID}/order$`), kind: 'read' },
  { method: 'GET', re: new RegExp(`^${S}/file/${ID}$`), kind: 'read' },
  {
    method: 'GET',
    re: new RegExp(`^${S}/files/list$`),
    kind: 'read',
    query: { currentDirectory: (v) => LISTABLE_DIRS_RE.test(v), flushCache: (v) => v === 'true' },
    requiredQuery: ['currentDirectory', 'flushCache'],
    canary: true,
  },
  { method: 'GET', re: new RegExp(`^${S}/queue$`), kind: 'read' },
  { method: 'GET', re: new RegExp(`^${S}/status$`), kind: 'read' },
  { method: 'GET', re: new RegExp(`^${S}/logs$`), kind: 'read' },
  { method: 'GET', re: new RegExp(`^${S}/log/([a-z0-9_]{1,64})$`), kind: 'read' },
  // Now playing by station id (public route; pinned to the events station).
  { method: 'GET', re: /^\/api\/nowplaying\/(\d+)$/, kind: 'read' },
  // writes
  { method: 'POST', re: new RegExp(`^${S}/playlists$`), kind: 'playlist_create' },
  { method: 'PUT', re: new RegExp(`^${S}/playlist/${ID}$`), kind: 'playlist_update' },
  { method: 'DELETE', re: new RegExp(`^${S}/playlist/${ID}$`), kind: 'playlist_delete' },
  { method: 'PUT', re: new RegExp(`^${S}/playlist/${ID}/order$`), kind: 'playlist_order' },
  { method: 'PUT', re: new RegExp(`^${S}/files/batch$`), kind: 'membership' },
  { method: 'POST', re: new RegExp(`^${S}/files$`), kind: 'upload' },
  { method: 'PUT', re: new RegExp(`^${S}/file/${ID}$`), kind: 'metadata' },
  { method: 'DELETE', re: new RegExp(`^${S}/file/${ID}$`), kind: 'file_delete' },
  { method: 'DELETE', re: new RegExp(`^${S}/queue/${ID}$`), kind: 'queue_delete' },
  { method: 'POST', re: new RegExp(`^${S}/backend/restart$`), kind: 'restart' },
]

export type RouteMatch = { route: Route; path: string; stationId: number | null; id: number | null; key: string | null; query: URLSearchParams }

// Structural match: origin-relative /api/ path, no encoding tricks, a listed
// (method, route), only listed query keys (each validated, required ones
// present, no duplicates), and the station id.
export function matchRoute(method: string, pathAndQuery: string): RouteMatch {
  if (typeof pathAndQuery !== 'string' || !pathAndQuery.startsWith('/api/')) throw new AllowlistError('refused_path')
  let u: URL
  try {
    u = new URL(pathAndQuery, 'http://x')
  } catch {
    throw new AllowlistError('refused_path')
  }
  if (u.origin !== 'http://x' || u.hash !== '') throw new AllowlistError('refused_path')
  const path = u.pathname
  if (decodeURIComponent(path) !== path || path.includes('//')) throw new AllowlistError('refused_encoded_path')
  const route = ROUTES.find((r) => r.method === method && r.re.test(path))
  if (!route) throw new AllowlistError('refused_not_allowlisted', { method, path })
  const keys = [...u.searchParams.keys()]
  if (new Set(keys).size !== keys.length) throw new AllowlistError('refused_duplicate_query')
  for (const k of keys) {
    const check = route.query?.[k]
    if (!check || !check(u.searchParams.get(k)!)) throw new AllowlistError('refused_query', { key: k })
  }
  for (const k of route.requiredQuery ?? []) if (!u.searchParams.has(k)) throw new AllowlistError('refused_query_missing', { key: k })
  const m = route.re.exec(path)!
  const stationId = m[1] !== undefined ? Number(m[1]) : null
  const second = m[2]
  const id = second !== undefined && /^\d+$/.test(second) ? Number(second) : null
  const key = second !== undefined && !/^\d+$/.test(second) ? second : null
  return { route, path, stationId, id, key, query: u.searchParams }
}

// --------------------------------------------------------- pure checks ----

export type EventWindow = { startsAt: number; endsAt: number }

// Every schedule row lies inside the event: its date and HHMM, converted
// back through America/New_York, start at or after the event's start minute
// and end at or before its end minute. An ambiguous wall time (fall-back
// hour) must be inside for EVERY instant it can mean; a non-existent one
// (spring gap) is refused.
export function assertRowsInsideEvent(items: readonly ScheduleItem[], window: EventWindow): void {
  const lo = Math.floor(window.startsAt / 60_000) * 60_000
  const hi = Math.ceil(window.endsAt / 60_000) * 60_000
  if (!(hi > lo)) throw new AllowlistError('refused_event_window')
  for (const it of items) {
    const starts = etWallToUtc(it.start_date, hhmmToMinutes(it.start_time))
    const ends = etWallToUtc(it.end_date, hhmmToMinutes(it.end_time))
    if (starts.length === 0 || ends.length === 0) throw new AllowlistError('refused_row_nonexistent_time', it)
    for (const s of starts) if (s < lo || s >= hi) throw new AllowlistError('refused_row_outside_event', it)
    for (const e of ends) if (e > hi || e <= lo) throw new AllowlistError('refused_row_outside_event', it)
  }
}

export type MembershipDecision = { current14: number[]; next: number[]; added: number[]; removed: number[] }

// The preserve-only + removal-limited rule for a do=playlist write (plan §4
// "Membership writes"), given the file's FRESH memberships:
//   * `current14` = the fresh read's playlist ids that are station-14 ids
//     (per a fresh GET /station/14/playlists): the batch replaces exactly
//     that set, station 1's memberships are untouched by AzuraCast;
//   * every id sent must be in current14 (preserved) or in `addable` (this
//     event's registry ids), and an added id must clear the floor;
//   * every id dropped must be one of this event's registry ids
//     (`removable`), never the floor/legacy set.
export function checkMembershipWrite(opts: {
  freshIds: readonly number[]
  station14Ids: ReadonlySet<number>
  sent: readonly number[]
  addable: ReadonlySet<number>
  removable: ReadonlySet<number>
  removalOnly?: boolean
}): MembershipDecision {
  const current14 = [...new Set(opts.freshIds.filter((id) => opts.station14Ids.has(id)))].sort((a, b) => a - b)
  const sent = [...opts.sent]
  if (new Set(sent).size !== sent.length) throw new AllowlistError('refused_duplicate_playlist_ids')
  const cur = new Set(current14)
  const next = new Set(sent)
  const added = sent.filter((id) => !cur.has(id)).sort((a, b) => a - b)
  const removed = current14.filter((id) => !next.has(id))
  for (const id of sent) {
    if (!opts.station14Ids.has(id)) throw new AllowlistError('refused_not_station14_playlist', { id })
  }
  for (const id of added) {
    if (opts.removalOnly) throw new AllowlistError('refused_add_on_removal_only', { id })
    if (!opts.addable.has(id)) throw new AllowlistError('refused_add_not_registry', { id })
    assertWritablePlaylistId(id)
  }
  for (const id of removed) {
    if (id <= FLOOR || LEGACY_PLAYLIST_IDS.includes(id)) throw new AllowlistError('refused_remove_legacy', { id })
    if (!opts.removable.has(id)) throw new AllowlistError('refused_remove_foreign', { id })
  }
  return { current14, next: [...next].sort((a, b) => a - b), added, removed }
}

// PUT /playlist/{id}/order: the map's keys are exactly the entry ids a fresh
// GET of that playlist's order returned (each once), and its weights are
// exactly 1..n (each once) — a pure reordering of the playlist's own rows.
export function checkOrderPermutation(sent: Readonly<Record<string, number>>, fresh: readonly number[]): void {
  const keys = Object.keys(sent)
  if (keys.some((k) => !ORDER_ENTRY_ID_RE.test(k))) throw new AllowlistError('refused_order_not_permutation')
  const ids = keys.map(Number)
  const weights = keys.map((k) => sent[k]!)
  if (new Set(ids).size !== ids.length || new Set(weights).size !== weights.length) throw new AllowlistError('refused_order_duplicates')
  const f = new Set(fresh)
  if (f.size !== fresh.length || ids.length !== f.size || ids.some((id) => !f.has(id))) throw new AllowlistError('refused_order_not_permutation')
  if (weights.some((w) => !Number.isInteger(w) || w < 1 || w > ids.length)) throw new AllowlistError('refused_order_weights')
}

export function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}
