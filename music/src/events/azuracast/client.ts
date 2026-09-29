// The events AzuraCast client (plan §4 "Events wrapper"). Separate from the
// music client on purpose: its own key (EVENTS_AZURACAST_API_KEY, station 14
// only), its own default-deny allowlist (allowlist.ts), its own private
// transport. The raw transport (#send) is PRIVATE: every request is built by
// one of the typed methods below and passes through validate() before any
// I/O. validate() enforces:
//
//  * the (method, route, query) allowlist, station id == 14 on every
//    station route (the canary GETs of the self-check are the one exception,
//    and must answer 403), the now-playing route pinned to station 14;
//  * a strict body per route, and the scope the caller must pass for every
//    write (which event, which registry ids, which exact file);
//  * the id floor (never ≤ 80, never 74–78) on every playlist write;
//  * fresh reads right before the write: a playlist PUT/DELETE/order re-reads
//    the playlist on station 14 and requires the registry's recorded name; a
//    membership batch re-reads the file (exact path) and station 14's
//    playlist list and applies the preserve-only + removal-limited rule; an
//    order PUT re-reads the playlist's order entries (permutation only); a
//    metadata PUT or file DELETE re-reads the file (exact Events/Uploads
//    path of that owner and audio id); a queue DELETE re-reads the queue;
//  * the write gate (settings.queues_paused) right before a write leaves.
//
// Tests reach the transport only through TEST_SEND, which runs the same
// validate() and refuses outside vitest.

import { z } from 'zod'
import { base64JsonStream } from '../../server/azuracast/client'
import {
  AllowlistError,
  ARCHIVED_FILE_RE,
  assertRowsInsideEvent,
  assertWritablePlaylistId,
  checkMembershipWrite,
  checkOrderPermutation,
  DisableBody,
  dirOf,
  EVENT_UPLOAD_RE,
  EventMetadataBody,
  eventUploadPathFor,
  EVENTS_STATION_ID,
  isMainName,
  LIBRARY_FILE_RE,
  markedNameEventId,
  matchRoute,
  MembershipBody,
  OrderBody,
  orderMapOf,
  PlaylistBody,
  safePath,
  STINGER_DIR,
  STINGER_FILE_RE,
  type EventMetadata,
  type EventWindow,
  type PlaylistBodyT,
  type RouteMatch,
} from './allowlist'

export class EventsAzuraCastError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code)
    this.name = 'EventsAzuraCastError'
  }
}

export const TEST_SEND = Symbol('events.azuracast.testSend')

// ------------------------------------------------------------- scopes ----

// A playlist write (create / update / disable / delete / order) of ONE event.
export type PlaylistScope = {
  eventId: number
  window: EventWindow
  // this event's registry rows with a playlist id: id → recorded intent name
  registry: ReadonlyMap<number, string>
  // this event's intent names (a create must use one)
  intentNames: ReadonlySet<string>
}

// A do=playlist batch on ONE file for ONE event.
export type MembershipScope = {
  mediaId: number
  path: string
  // this event's registry ids that may be dropped from the file
  removable: ReadonlySet<number>
  // this event's registry ids that may be added to the file
  addable: ReadonlySet<number>
  // recheck of an archived song: may only drop ids
  removalOnly?: boolean
}

export type UploadScope = { ownerDiscordId: string; audioId: number }
export type MetadataScope = { mediaId: number; ownerDiscordId: string; audioId: number }
export type FileDeleteScope = {
  mediaId: number
  ownerDiscordId: string
  audioId: number
  // the worker read event_audio.deleted_at IS NOT NULL
  audioDeleted: boolean
  // registry playlist ids of approved/built/live events
  activeRegistryIds: ReadonlySet<number>
  // registry playlist ids of every other event (ended, cancelled, …)
  inactiveRegistryIds: ReadonlySet<number>
}

type SendOpts = {
  body?: unknown
  uploadBytes?: Buffer
  uploadPath?: string
  canary?: boolean
  playlist?: PlaylistScope
  membership?: MembershipScope
  upload?: UploadScope
  metadata?: MetadataScope
  fileDelete?: FileDeleteScope
  timeoutMs?: number
  maxResponseBytes?: number
}

type SendResult = { status: number; text: string }

// ----------------------------------------------------------- responses ----

const scheduleRead = z
  .object({
    id: z.number().int().optional(),
    start_time: z.number().int(),
    end_time: z.number().int(),
    start_date: z.string().nullable().optional(),
    end_date: z.string().nullable().optional(),
    days: z.union([z.array(z.number().int()), z.string(), z.null()]).optional(),
    loop_once: z.boolean().optional(),
  })
  .passthrough()

// AzuraCast stores backend_options as one comma-joined string and answers
// explode(',', …): a playlist with none reads back as [""] (seen on station
// 14's real GET /playlist), never []. Normalised once, at the boundary, to
// the sorted list of non-empty options, so every comparison (verify's diff,
// any re-read check) sees [] for "none".
export function normalizeBackendOptions(v: unknown): string[] {
  const parts = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []
  return [...new Set(parts.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter((s) => s.length > 0))].sort()
}

export const playlistRead = z
  .object({
    id: z.number().int().positive(),
    name: z.string(),
    is_enabled: z.boolean().optional(),
    source: z.string().optional(),
    order: z.string().optional(),
    weight: z.number().int().optional(),
    is_jingle: z.boolean().optional(),
    include_in_requests: z.boolean().optional(),
    include_in_on_demand: z.boolean().optional(),
    remote_url: z.string().nullable().optional(),
    backend_options: z
      .union([z.array(z.string()), z.string(), z.null()])
      .optional()
      .transform((v) => normalizeBackendOptions(v)),
    schedule_items: z.array(scheduleRead).optional().default([]),
  })
  .passthrough()
export type PlaylistRead = z.infer<typeof playlistRead>

export const mediaRead = z
  .object({
    id: z.number().int().positive(),
    unique_id: z.string(),
    path: z.string(),
    title: z.string().nullable().optional(),
    artist: z.string().nullable().optional(),
    // A number on GET /file (165) and GET /order (165.198…); files/list
    // builds its rows from a scalar DB result, so a numeric string is taken
    // too.
    length: z
      .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number)])
      .nullable()
      .optional(),
    playlists: z
      .array(z.object({ id: z.number().int() }).passthrough())
      .optional()
      .default([]),
  })
  .passthrough()
export type MediaRead = z.infer<typeof mediaRead>

const listEntry = z
  .object({ path: z.string(), type: z.string(), media: mediaRead.nullable().optional() })
  .passthrough()
export type ListEntryRead = z.infer<typeof listEntry>

// GET /playlist/{id}/order (GetOrderAction): a JSON ARRAY of
// station_playlist_media rows sorted by weight — {playlist_id, media_id,
// weight, is_queued, last_played, id, media: {id, …}}. `id` is the entry id
// the PUT order map is keyed by.
const orderEntry = z
  .object({
    id: z.number().int().positive(),
    playlist_id: z.number().int().positive().optional(),
    media_id: z.number().int().positive().optional(),
    weight: z.number().int().optional(),
    media: z.object({ id: z.number().int().positive() }).passthrough().nullable().optional(),
  })
  .passthrough()
export type OrderEntry = z.infer<typeof orderEntry>

// PUT /playlist/{id}/order answers `withJson($order)`: the map it was sent
// (PHP re-encodes the entry-id keys as a JSON object).
const orderEcho = z.record(z.string(), z.number())

// GET /queue: AzuraCast's StationQueueDetailed rows carry no `id` field —
// the row is addressed by its links.self (…/api/station/14/queue/{id}),
// which is what the AzuraCast UI deletes. An explicit `id`, if a version
// sends one, must agree with the link.
const QUEUE_SELF_RE = new RegExp(`^/api/station/${EVENTS_STATION_ID}/queue/([1-9]\\d{0,9})$`)
function queueIdFromSelf(self: string): number | null {
  let u: URL
  try {
    u = new URL(self, 'http://x')
  } catch {
    return null
  }
  const m = QUEUE_SELF_RE.exec(u.pathname)
  return m ? Number(m[1]) : null
}
const queueEntry = z
  .object({ id: z.number().int().positive().optional(), links: z.object({ self: z.string() }).passthrough().optional() })
  .passthrough()
  .transform((q, ctx) => {
    const fromLink = q.links ? queueIdFromSelf(q.links.self) : null
    if (q.links && fromLink === null) {
      ctx.addIssue({ code: 'custom', message: 'queue links.self is not a station-14 queue row' })
      return z.NEVER
    }
    if (q.id !== undefined && fromLink !== null && q.id !== fromLink) {
      ctx.addIssue({ code: 'custom', message: 'queue id disagrees with links.self' })
      return z.NEVER
    }
    const id = q.id ?? fromLink
    if (id === null || id === undefined) {
      ctx.addIssue({ code: 'custom', message: 'queue row without id or links.self' })
      return z.NEVER
    }
    return { ...q, id }
  })
const statusRead = z.object({ backend_running: z.boolean(), frontend_running: z.boolean() }).passthrough()
const successRead = z.object({ success: z.boolean() }).passthrough()
const batchRead = z.object({ success: z.boolean(), errors: z.array(z.string()).default([]) }).passthrough()

export const nowPlayingRead = z
  .object({
    is_online: z.boolean().optional(),
    now_playing: z
      .object({
        played_at: z.number().nullable().optional(),
        duration: z.number().nullable().optional(),
        elapsed: z.number().nullable().optional(),
        remaining: z.number().nullable().optional(),
        playlist: z.string().nullable().optional(),
        song: z.object({ id: z.string().optional(), text: z.string().nullable().optional() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough()
export type NowPlaying = z.infer<typeof nowPlayingRead>

export function backendOptionsOf(p: Pick<PlaylistRead, 'backend_options'>): string[] {
  return normalizeBackendOptions(p.backend_options)
}

// -------------------------------------------------------------- client ----

export type EventsClientDeps = {
  baseUrl: string
  apiKey: string
  stationId: number
  canaryStationIds: readonly number[]
  fetchImpl?: typeof fetch
  writeGate?: () => Promise<void>
}

export class EventsAzuraCastClient {
  private readonly f: typeof fetch
  private writeGate: (() => Promise<void>) | undefined
  private readonly canaries: number[]

  constructor(private readonly deps: EventsClientDeps) {
    if (deps.stationId !== EVENTS_STATION_ID) throw new EventsAzuraCastError('refused_station_config', { stationId: deps.stationId })
    const base = new URL(deps.baseUrl)
    if (base.origin !== deps.baseUrl || base.username || base.password) throw new EventsAzuraCastError('refused_base_url')
    if (typeof deps.apiKey !== 'string' || deps.apiKey.length < 16) throw new EventsAzuraCastError('refused_api_key')
    this.canaries = [...new Set(deps.canaryStationIds)].filter((s) => Number.isSafeInteger(s) && s > 0 && s !== EVENTS_STATION_ID)
    if (this.canaries.length === 0) throw new EventsAzuraCastError('refused_no_canary')
    this.f = deps.fetchImpl ?? fetch
    this.writeGate = deps.writeGate
  }

  setWriteGate(gate: () => Promise<void>): void {
    this.writeGate = gate
  }

  get canaryStationIds(): readonly number[] {
    return this.canaries
  }

  async [TEST_SEND](method: string, pathAndQuery: string, opts: SendOpts = {}): Promise<SendResult> {
    if (process.env.VITEST !== 'true') throw new EventsAzuraCastError('test_seam_disabled')
    return this.#send(method, pathAndQuery, opts)
  }

  async #send(method: string, pathAndQuery: string, opts: SendOpts = {}): Promise<SendResult> {
    // Serialize once; validate the parsed copy of exactly those bytes.
    const serialized = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const checked: SendOpts = serialized === undefined ? opts : { ...opts, body: JSON.parse(serialized) as unknown }
    await this.validate(method, pathAndQuery, checked)
    const u = new URL(pathAndQuery, 'http://x')
    const url = `${this.deps.baseUrl}${u.pathname}${u.search}`
    const headers: Record<string, string> = { 'X-API-Key': this.deps.apiKey, Accept: 'application/json' }
    let body: BodyInit | undefined
    if (opts.uploadBytes) {
      const stream = base64JsonStream(opts.uploadPath!, opts.uploadBytes)
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(stream.length)
      body = stream.body
    } else if (serialized !== undefined) {
      headers['content-type'] = 'application/json'
      body = serialized
    }
    const res = await this.f(url, {
      method,
      headers,
      body,
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      ...(opts.uploadBytes ? { duplex: 'half' } : {}),
    } as RequestInit)
    const raw = await readLimited(res, opts.maxResponseBytes ?? 8 * 1024 * 1024)
    return { status: res.status, text: raw.toString('utf8') }
  }

  // ------------------------------------------------------- validation ---

  private async validate(method: string, pathAndQuery: string, opts: SendOpts): Promise<RouteMatch> {
    let m: RouteMatch
    try {
      m = matchRoute(method, pathAndQuery)
    } catch (e) {
      throw asRefusal(e)
    }
    const kind = m.route.kind
    // Station pin.
    if (m.path.startsWith('/api/nowplaying/')) {
      if (m.stationId !== EVENTS_STATION_ID) throw new EventsAzuraCastError('refused_station', { sid: m.stationId })
    } else {
      const sid = m.stationId
      const canaryOk = opts.canary === true && method === 'GET' && m.route.canary === true && sid !== null && this.canaries.includes(sid)
      if (sid !== EVENTS_STATION_ID && !canaryOk) throw new EventsAzuraCastError('refused_station', { sid })
      if (opts.canary === true && !canaryOk) throw new EventsAzuraCastError('refused_canary')
    }
    // A scope may only ride on the route it belongs to.
    const scopes: [keyof SendOpts, string][] = [
      ['playlist', 'playlist_'],
      ['membership', 'membership'],
      ['upload', 'upload'],
      ['metadata', 'metadata'],
      ['fileDelete', 'file_delete'],
    ]
    for (const [k, prefix] of scopes) if (opts[k] !== undefined && !kind.startsWith(prefix)) throw new EventsAzuraCastError('refused_scope_misuse', { scope: k, kind })
    if (opts.uploadBytes !== undefined && kind !== 'upload') throw new EventsAzuraCastError('refused_upload_shape')

    if (kind === 'read') {
      if (opts.body !== undefined) throw new EventsAzuraCastError('refused_body_on_read')
      return m
    }
    try {
      switch (kind) {
        case 'playlist_create':
          await this.checkPlaylistCreate(opts)
          break
        case 'playlist_update':
          await this.checkPlaylistUpdate(m.id!, opts)
          break
        case 'playlist_delete':
          if (opts.body !== undefined) throw new EventsAzuraCastError('refused_body_on_delete')
          await this.checkRegistryPlaylist(m.id!, opts.playlist)
          break
        case 'playlist_order':
          await this.checkOrder(m.id!, opts)
          break
        case 'membership':
          await this.checkMembership(opts)
          break
        case 'upload':
          this.checkUpload(opts)
          break
        case 'metadata':
          await this.checkMetadata(m.id!, opts)
          break
        case 'file_delete':
          await this.checkFileDelete(m.id!, opts)
          break
        case 'queue_delete':
          if (opts.body !== undefined) throw new EventsAzuraCastError('refused_body_on_delete')
          if (!(await this.getQueue()).some((q) => q.id === m.id)) throw new EventsAzuraCastError('refused_queue_id', { id: m.id })
          break
        case 'restart':
          if (opts.body !== undefined) throw new EventsAzuraCastError('refused_body_on_restart')
          break
        default:
          throw new EventsAzuraCastError('refused_not_allowlisted')
      }
    } catch (e) {
      throw asRefusal(e)
    }
    if (this.writeGate) {
      try {
        await this.writeGate()
      } catch (e) {
        throw new EventsAzuraCastError('refused_queues_paused', e instanceof Error ? e.message : undefined)
      }
    }
    return m
  }

  private checkPlaylistBody(body: unknown, scope: PlaylistScope, expectedName: string | null): PlaylistBodyT {
    const r = PlaylistBody.safeParse(body)
    if (!r.success) throw new EventsAzuraCastError('refused_playlist_body', r.error.issues.slice(0, 5).map((i) => i.message))
    const b = r.data
    // Names: a main name (sanitized title) or this event's marker name.
    const marked = markedNameEventId(b.name)
    if (marked !== null && marked !== scope.eventId) throw new EventsAzuraCastError('refused_playlist_name_event', { name: b.name })
    if (marked === null && (!isMainName(b.name) || b.name.includes('~'))) throw new EventsAzuraCastError('refused_playlist_name', { name: b.name })
    if (expectedName !== null && b.name !== expectedName) throw new EventsAzuraCastError('refused_playlist_name_mismatch', { name: b.name })
    assertRowsInsideEvent(b.schedule_items, scope.window)
    return b
  }

  private requirePlaylistScope(s: PlaylistScope | undefined): PlaylistScope {
    if (!s || !Number.isSafeInteger(s.eventId) || s.eventId <= 0) throw new EventsAzuraCastError('refused_scope_missing')
    return s
  }

  private async checkPlaylistCreate(opts: SendOpts): Promise<void> {
    const scope = this.requirePlaylistScope(opts.playlist)
    const b = this.checkPlaylistBody(opts.body, scope, null)
    if (!scope.intentNames.has(b.name)) throw new EventsAzuraCastError('refused_create_without_intent', { name: b.name })
  }

  // Registry id, above the floor, and a fresh station-14 read shows the
  // recorded name.
  private async checkRegistryPlaylist(id: number, s: PlaylistScope | undefined): Promise<PlaylistRead> {
    const scope = this.requirePlaylistScope(s)
    assertWritablePlaylistId(id)
    const recorded = scope.registry.get(id)
    if (recorded === undefined) throw new EventsAzuraCastError('refused_not_registry', { id })
    const fresh = await this.getPlaylist(id)
    if (fresh.id !== id || fresh.name !== recorded) throw new EventsAzuraCastError('refused_registry_name_mismatch', { id, name: fresh.name })
    return fresh
  }

  private async checkPlaylistUpdate(id: number, opts: SendOpts): Promise<void> {
    const scope = this.requirePlaylistScope(opts.playlist)
    await this.checkRegistryPlaylist(id, scope)
    if (DisableBody.safeParse(opts.body).success) return
    this.checkPlaylistBody(opts.body, scope, scope.registry.get(id)!)
  }

  private async checkOrder(id: number, opts: SendOpts): Promise<void> {
    await this.checkRegistryPlaylist(id, opts.playlist)
    const r = OrderBody.safeParse(opts.body)
    if (!r.success) throw new EventsAzuraCastError('refused_order_body')
    const fresh = await this.playlistMediaOrder(id)
    checkOrderPermutation(r.data.order, fresh.map((e) => e.entryId))
  }

  private async checkMembership(opts: SendOpts): Promise<void> {
    const s = opts.membership
    if (!s) throw new EventsAzuraCastError('refused_scope_missing')
    const raw = opts.body as Record<string, unknown> | undefined
    if (raw && typeof raw === 'object' && typeof raw.do === 'string' && raw.do !== 'playlist') throw new EventsAzuraCastError('refused_batch_action', { do: raw.do })
    const r = MembershipBody.safeParse(opts.body)
    if (!r.success) throw new EventsAzuraCastError('refused_batch_body', r.error.issues.slice(0, 5).map((i) => i.message))
    const b = r.data
    const path = b.files[0]
    if (!safePath(path) || path !== s.path || b.currentDirectory !== dirOf(path)) throw new EventsAzuraCastError('refused_batch_path', { path })
    const surface = LIBRARY_FILE_RE.test(path) || STINGER_FILE_RE.test(path) || EVENT_UPLOAD_RE.test(path)
    const archived = ARCHIVED_FILE_RE.test(path)
    if (!surface && !(archived && s.removalOnly === true)) throw new EventsAzuraCastError('refused_batch_surface', { path })
    const fresh = await this.getFile(s.mediaId)
    if (fresh.path !== path) throw new EventsAzuraCastError('refused_batch_stale_path', { expected: path, actual: fresh.path })
    const station14 = new Set((await this.listPlaylists()).map((p) => p.id))
    checkMembershipWrite({ freshIds: fresh.playlists.map((p) => p.id), station14Ids: station14, sent: b.playlists, addable: s.addable, removable: s.removable, removalOnly: s.removalOnly === true })
  }

  private checkUpload(opts: SendOpts): void {
    const s = opts.upload
    if (!s) throw new EventsAzuraCastError('refused_scope_missing')
    if (opts.body !== undefined || !Buffer.isBuffer(opts.uploadBytes) || typeof opts.uploadPath !== 'string') throw new EventsAzuraCastError('refused_upload_shape')
    const expected = eventUploadPathFor(s.ownerDiscordId, s.audioId)
    if (opts.uploadPath !== expected || !EVENT_UPLOAD_RE.test(opts.uploadPath) || !safePath(opts.uploadPath)) throw new EventsAzuraCastError('refused_upload_path', { path: opts.uploadPath })
  }

  private async checkMetadata(id: number, opts: SendOpts): Promise<void> {
    const s = opts.metadata
    if (!s || s.mediaId !== id) throw new EventsAzuraCastError('refused_scope_missing')
    const r = EventMetadataBody.safeParse(opts.body)
    if (!r.success) throw new EventsAzuraCastError('refused_metadata_body', r.error.issues.slice(0, 5).map((i) => i.message))
    const fresh = await this.getFile(id)
    if (fresh.path !== eventUploadPathFor(s.ownerDiscordId, s.audioId)) throw new EventsAzuraCastError('refused_metadata_target', { path: fresh.path })
  }

  private async checkFileDelete(id: number, opts: SendOpts): Promise<void> {
    const s = opts.fileDelete
    if (!s || s.mediaId !== id) throw new EventsAzuraCastError('refused_scope_missing')
    if (opts.body !== undefined) throw new EventsAzuraCastError('refused_body_on_delete')
    if (s.audioDeleted !== true) throw new EventsAzuraCastError('refused_audio_not_deleted')
    const fresh = await this.getFile(id)
    const expected = eventUploadPathFor(s.ownerDiscordId, s.audioId)
    if (fresh.path !== expected || !EVENT_UPLOAD_RE.test(fresh.path)) throw new EventsAzuraCastError('refused_delete_target', { path: fresh.path })
    for (const p of fresh.playlists) {
      if (s.activeRegistryIds.has(p.id)) throw new EventsAzuraCastError('refused_delete_in_use', { playlist: p.id })
      // Any other membership (legacy, a playlist nobody registered, another
      // station) keeps the file: only leftovers in ended events' playlists
      // (deleted with the file) are tolerated.
      if (!s.inactiveRegistryIds.has(p.id)) throw new EventsAzuraCastError('refused_delete_foreign_membership', { playlist: p.id })
    }
  }

  // ----------------------------------------------------------- helpers ---

  private sid(rest: string): string {
    return `/api/station/${EVENTS_STATION_ID}${rest}`
  }

  private parse<T>(status: number, text: string, schema: z.ZodType<T>, what: string): T {
    if (status === 403) throw new EventsAzuraCastError('forbidden', { what })
    if (status === 404) throw new EventsAzuraCastError('not_found', { what })
    if (status !== 200) throw new EventsAzuraCastError('http_error', { what, status })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new EventsAzuraCastError('bad_json', { what })
    }
    const r = schema.safeParse(parsed)
    if (!r.success) throw new EventsAzuraCastError('unexpected_shape', { what, issues: r.error.issues.slice(0, 5).map((i) => i.message) })
    return r.data
  }

  // -------------------------------------------------------------- reads ---

  async listPlaylists(): Promise<PlaylistRead[]> {
    const { status, text } = await this.#send('GET', this.sid('/playlists'))
    return this.parse(status, text, z.array(playlistRead), 'playlists')
  }

  async getPlaylist(id: number): Promise<PlaylistRead> {
    positive(id)
    const { status, text } = await this.#send('GET', this.sid(`/playlist/${id}`))
    return this.parse(status, text, playlistRead, 'playlist')
  }

  async getPlaylistOrNull(id: number): Promise<PlaylistRead | null> {
    try {
      return await this.getPlaylist(id)
    } catch (e) {
      if (e instanceof EventsAzuraCastError && e.code === 'not_found') return null
      throw e
    }
  }

  async getPlaylistOrder(id: number): Promise<OrderEntry[]> {
    positive(id)
    const { status, text } = await this.#send('GET', this.sid(`/playlist/${id}/order`))
    return this.parse(status, text, z.array(orderEntry), 'order')
  }

  async getFile(id: number): Promise<MediaRead> {
    positive(id)
    const { status, text } = await this.#send('GET', this.sid(`/file/${id}`))
    return this.parse(status, text, mediaRead, 'file')
  }

  async getFileOrNull(id: number): Promise<MediaRead | null> {
    try {
      return await this.getFile(id)
    } catch (e) {
      if (e instanceof EventsAzuraCastError && e.code === 'not_found') return null
      throw e
    }
  }

  async listDirectory(dir: string): Promise<ListEntryRead[]> {
    const q = new URLSearchParams({ currentDirectory: dir, flushCache: 'true' })
    const { status, text } = await this.#send('GET', `${this.sid('/files/list')}?${q}`)
    return this.parse(status, text, z.array(listEntry), 'files/list')
  }

  async listStingers(): Promise<ListEntryRead[]> {
    return this.listDirectory(STINGER_DIR)
  }

  async getQueue(): Promise<{ id: number }[]> {
    const { status, text } = await this.#send('GET', this.sid('/queue'))
    return this.parse(status, text, z.array(queueEntry), 'queue')
  }

  // `timeoutMs`: the restart confirmation reads with a short timeout, so a
  // hanging status endpoint cannot hold the kick (kicks.ts).
  async getStatus(timeoutMs?: number): Promise<z.infer<typeof statusRead>> {
    const { status, text } = await this.#send('GET', this.sid('/status'), timeoutMs ? { timeoutMs } : {})
    return this.parse(status, text, statusRead, 'status')
  }

  async nowPlaying(): Promise<NowPlaying> {
    const { status, text } = await this.#send('GET', `/api/nowplaying/${EVENTS_STATION_ID}`)
    return this.parse(status, text, nowPlayingRead, 'nowplaying')
  }

  async listLogs(): Promise<{ key: string }[]> {
    const { status, text } = await this.#send('GET', this.sid('/logs'))
    return this.parse(status, text, z.array(z.object({ key: z.string() }).passthrough()), 'logs')
  }

  async getLog(key: string): Promise<{ contents: string }> {
    if (!/^[a-z0-9_]{1,64}$/.test(key)) throw new EventsAzuraCastError('bad_log_key')
    const { status, text } = await this.#send('GET', this.sid(`/log/${key}`), { maxResponseBytes: 4 * 1024 * 1024 })
    return this.parse(status, text, z.object({ contents: z.string() }).passthrough(), 'log')
  }

  // Self-check reads (selfcheck.ts): the raw status of the own-station read
  // and of each canary read.
  async ownStationReadStatus(): Promise<number> {
    return (await this.#send('GET', this.sid('/playlists'))).status
  }

  async canaryReadStatus(stationId: number): Promise<number> {
    return (await this.#send('GET', `/api/station/${stationId}/playlists`, { canary: true })).status
  }

  // ------------------------------------------------------------- writes ---

  async createPlaylist(body: PlaylistBodyT, scope: PlaylistScope): Promise<PlaylistRead> {
    const { status, text } = await this.#send('POST', this.sid('/playlists'), { body, playlist: scope })
    const created = this.parse(status, text, playlistRead, 'create playlist')
    if (created.name !== body.name) throw new EventsAzuraCastError('create_name_mismatch', { id: created.id })
    return created
  }

  async updatePlaylist(id: number, body: PlaylistBodyT, scope: PlaylistScope): Promise<void> {
    const { status, text } = await this.#send('PUT', this.sid(`/playlist/${id}`), { body, playlist: scope })
    const r = this.parse(status, text, successRead, 'update playlist')
    if (!r.success) throw new EventsAzuraCastError('update_failed', { id })
  }

  async disablePlaylist(id: number, scope: PlaylistScope): Promise<void> {
    const { status, text } = await this.#send('PUT', this.sid(`/playlist/${id}`), { body: { is_enabled: false }, playlist: scope })
    const r = this.parse(status, text, successRead, 'disable playlist')
    if (!r.success) throw new EventsAzuraCastError('update_failed', { id })
  }

  async deletePlaylist(id: number, scope: PlaylistScope): Promise<void> {
    const { status, text } = await this.#send('DELETE', this.sid(`/playlist/${id}`), { playlist: scope })
    const r = this.parse(status, text, successRead, 'delete playlist')
    if (!r.success) throw new EventsAzuraCastError('delete_failed', { id })
  }

  // The media ids of a sequential playlist in play order (GET /order is
  // sorted by weight). Each row must name one media, belong to `id`, and
  // no media may appear twice.
  async playlistMediaOrder(id: number): Promise<{ mediaId: number; entryId: number }[]> {
    const out: { mediaId: number; entryId: number }[] = []
    const seen = new Set<number>()
    for (const e of await this.getPlaylistOrder(id)) {
      if (e.playlist_id !== undefined && e.playlist_id !== id) throw new EventsAzuraCastError('order_foreign_entry', { id, entry: e.id })
      const mid = e.media?.id ?? e.media_id
      if (!mid) throw new EventsAzuraCastError('order_shape_unknown', { id })
      if (e.media_id !== undefined && e.media?.id !== undefined && e.media_id !== e.media.id) throw new EventsAzuraCastError('order_shape_unknown', { id, entry: e.id })
      if (seen.has(mid)) throw new EventsAzuraCastError('order_duplicate_media', { id, mediaId: mid })
      seen.add(mid)
      out.push({ mediaId: mid, entryId: e.id })
    }
    return out
  }

  // Sets a sequential playlist's order to `mediaIds` (the playlist must hold
  // exactly those media). The order entries are read fresh and mapped; the
  // PUT carries that read's own entry ids as the {entry id: weight 1..n}
  // map AzuraCast's setMediaOrder takes (allowlist.ts OrderBody). The echo
  // must be that map, and a fresh read must then show the order: AzuraCast
  // answers 200 even when no row was updated.
  async setOrder(id: number, mediaIds: readonly number[], scope: PlaylistScope): Promise<void> {
    const entries = await this.playlistMediaOrder(id)
    const byMedia = new Map(entries.map((e) => [e.mediaId, e.entryId]))
    if (byMedia.size !== mediaIds.length || new Set(mediaIds).size !== mediaIds.length || mediaIds.some((m) => !byMedia.has(m))) throw new EventsAzuraCastError('order_membership_mismatch', { id })
    const order = orderMapOf(mediaIds.map((m) => byMedia.get(m)!))
    const { status, text } = await this.#send('PUT', this.sid(`/playlist/${id}/order`), { body: { order }, playlist: scope })
    const echo = this.parse(status, text, orderEcho, 'order put')
    const sentKeys = Object.keys(order)
    if (Object.keys(echo).length !== sentKeys.length || sentKeys.some((k) => echo[k] !== order[k])) throw new EventsAzuraCastError('order_failed', { id })
    const after = (await this.playlistMediaOrder(id)).map((e) => e.mediaId)
    if (after.length !== mediaIds.length || after.some((m, i) => m !== mediaIds[i])) throw new EventsAzuraCastError('order_not_applied', { id })
  }

  // REPLACES the file's station-14 playlist set (validate() applies the
  // preserve-only + removal-limited rule against a fresh read).
  async setMembership(path: string, playlistIds: readonly number[], scope: MembershipScope): Promise<void> {
    const body = { do: 'playlist' as const, files: [path], dirs: [], currentDirectory: dirOf(path), playlists: [...playlistIds] }
    const { status, text } = await this.#send('PUT', this.sid('/files/batch'), { body, membership: scope })
    const r = this.parse(status, text, batchRead, 'batch')
    if (!r.success || r.errors.length > 0) throw new EventsAzuraCastError('batch_errors', r.errors.slice(0, 10))
  }

  async uploadFile(bytes: Buffer, scope: UploadScope): Promise<MediaRead> {
    const path = eventUploadPathFor(scope.ownerDiscordId, scope.audioId)
    const { status, text } = await this.#send('POST', this.sid('/files'), { uploadBytes: bytes, uploadPath: path, upload: scope, timeoutMs: 120_000 })
    const media = this.parse(status, text, mediaRead, 'upload')
    if (media.path !== path) throw new EventsAzuraCastError('upload_path_mismatch', { expected: path, actual: media.path })
    return media
  }

  async updateMetadata(id: number, m: EventMetadata, scope: MetadataScope): Promise<void> {
    const body: EventMetadata = { title: m.title, artist: m.artist, album: m.album, genre: m.genre }
    const { status, text } = await this.#send('PUT', this.sid(`/file/${id}`), { body, metadata: scope })
    const r = this.parse(status, text, successRead, 'metadata')
    if (!r.success) throw new EventsAzuraCastError('metadata_failed')
  }

  async deleteFile(id: number, scope: FileDeleteScope): Promise<void> {
    const { status, text } = await this.#send('DELETE', this.sid(`/file/${id}`), { fileDelete: scope })
    const r = this.parse(status, text, successRead, 'delete file')
    if (!r.success) throw new EventsAzuraCastError('delete_failed', { id })
  }

  // The queue-clear route: AzuraCast has no bulk clear on the station API
  // (only the admin debug route), so each queued row is deleted by id, each
  // re-checked against a fresh queue read. EVERY row is tried: one that
  // fails does not keep the others in the queue; the failures are thrown
  // together at the end (queue_delete_failed). A row that left the queue
  // meanwhile (404, or gone from the fresh read) counts as cleared. The
  // write gate (queues paused) still stops it at once.
  async clearQueue(): Promise<number> {
    const q = await this.getQueue()
    let n = 0
    const failed: { id: number; error: string }[] = []
    for (const item of q) {
      try {
        const { status } = await this.#send('DELETE', this.sid(`/queue/${item.id}`))
        if (status === 200 || status === 404) n++
        else failed.push({ id: item.id, error: `http ${status}` })
      } catch (e) {
        if (e instanceof EventsAzuraCastError && e.code === 'refused_queues_paused') throw e
        if (e instanceof EventsAzuraCastError && e.code === 'refused_queue_id') {
          n++
          continue
        }
        failed.push({ id: item.id, error: e instanceof EventsAzuraCastError ? e.code : e instanceof Error ? e.message : 'error' })
      }
    }
    if (failed.length > 0) throw new EventsAzuraCastError('queue_delete_failed', { failed: failed.slice(0, 20), cleared: n })
    return n
  }

  async restartBackend(): Promise<void> {
    const { status, text } = await this.#send('POST', this.sid('/backend/restart'), { timeoutMs: 60_000 })
    const r = this.parse(status, text, successRead, 'restart')
    if (!r.success) throw new EventsAzuraCastError('restart_failed')
  }
}

function positive(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) throw new EventsAzuraCastError('bad_id')
}

function asRefusal(e: unknown): unknown {
  if (e instanceof AllowlistError) return new EventsAzuraCastError(e.code, e.detail)
  return e
}

async function readLimited(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new EventsAzuraCastError('response_too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
