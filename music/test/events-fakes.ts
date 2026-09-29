// Test doubles for the events worker unit tests (never a network call):
//   FakeAz    an in-process AzuraCast for station 14 (+ a station-1 playlist
//             id that only shows up in file memberships), wired in as the
//             events client's fetchImpl;
//   MemStore  an in-memory EventsStore (same job semantics as store-pg.ts);
//   fakeTickets a TicketsClient over a recording fetch.

import { TicketsClient } from '@/server/tickets/client'
import { EventsAzuraCastClient } from '@/events/azuracast/client'
import { eventJobDedupeKey, parseEventJobPayload, PERIODIC_EVENT_JOB_KINDS, type EventJobKind, type EventJobPayload } from '@/events/contract/jobs'
import { EVENTS_SETTING_DEFAULTS, resolveEventsSettings, type EventsSettings } from '@/events/contract/settings'
import type { AudioStatus, BuildStatus, EventStatus, RegistryRole } from '@/events/contract/types'
import type { EventsCtx } from '@/events/worker/ctx'
import type { AnnouncementRow, AudioPatch, AudioRow, BuildRow, ClaimedJob, CreateAttemptMarker, EnqueueOpts, EventRow, EventsStore, JobOutcome, RegistryRow, StingerRow, TrackRow } from '@/events/worker/store'

export const OWNER = '700000000000000001'
export const OTHER = '700000000000000002'
export const ORIGIN = 'https://events.euphoric.fm'

// ------------------------------------------------------------- FakeAz ---

type FPlaylist = {
  id: number
  name: string
  is_enabled: boolean
  source: string
  order: string
  weight: number
  is_jingle: boolean
  include_in_requests: boolean
  include_in_on_demand: boolean
  avoid_duplicates: boolean
  backend_options: string[]
  remote_url: string | null
  schedule_items: Record<string, unknown>[]
}
type FFile = { id: number; unique_id: string; path: string; title: string; artist: string; length: number; size: number; playlists: number[] }
export type Call = { method: string; path: string; body: unknown }

export class FakeAz {
  playlists = new Map<number, FPlaylist>()
  files = new Map<number, FFile>()
  order = new Map<number, number[]>()
  queue: number[] = []
  dirLinks = new Map<string, number[]>()
  calls: Call[] = []
  restarts = 0
  failRestarts = 0
  np: unknown = { is_online: true, now_playing: null }
  // station 14's liquidsoap log (GET /logs, /log/liquidsoap_log)
  liquidsoapLog = ''
  nextPlaylistId = 101
  nextScheduleId = 1000
  nextMediaId = 9000
  onCreate?: (name: string) => void

  constructor() {
    for (const [id, name] of [
      [74, 'Stinger'],
      [75, 'ForeverStinger'],
      [76, 'default'],
      [77, 'Fasion Show (Test)'],
      [78, 'Renfair'],
    ] as const) {
      this.playlists.set(id, this.pl(id, name))
    }
  }

  private pl(id: number, name: string): FPlaylist {
    return { id, name, is_enabled: false, source: 'songs', order: 'shuffle', weight: 3, is_jingle: false, include_in_requests: false, include_in_on_demand: false, avoid_duplicates: true, backend_options: [], remote_url: null, schedule_items: [] }
  }

  addFile(path: string, opts: Partial<FFile> = {}): FFile {
    const f: FFile = { id: opts.id ?? this.nextMediaId++, unique_id: `u${Math.random().toString(16).slice(2)}`, path, title: opts.title ?? 'T', artist: opts.artist ?? 'A', length: opts.length ?? 200, size: opts.size ?? 1000, playlists: opts.playlists ?? [] }
    this.files.set(f.id, f)
    return f
  }

  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }

  station14Of(f: FFile): number[] {
    return f.playlists.filter((id) => this.playlists.has(id))
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  private dirs(): Set<string> {
    const out = new Set<string>()
    for (const f of this.files.values()) {
      const parts = f.path.split('/')
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'))
    }
    for (const d of this.dirLinks.keys()) out.add(d)
    return out
  }

  private mediaOut(f: FFile) {
    return { id: f.id, unique_id: f.unique_id, path: f.path, title: f.title, artist: f.artist, length: f.length, playlists: f.playlists.map((id) => ({ id })) }
  }

  fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input))
    const method = String(init.method ?? 'GET')
    let body: unknown = undefined
    if (init.body !== undefined && init.body !== null) {
      const text = typeof init.body === 'string' ? init.body : await new Response(init.body as BodyInit).text()
      body = JSON.parse(text)
    }
    this.calls.push({ method, path: u.pathname + u.search, body })
    const p = u.pathname
    const np = /^\/api\/nowplaying\/(\d+)$/.exec(p)
    if (np) return this.json(200, this.np)
    const m = /^\/api\/station\/(\d+)(\/.*)$/.exec(p)
    if (!m) return this.json(404, {})
    if (Number(m[1]) !== 14) return this.json(403, { message: 'denied' })
    const rest = m[2]!
    let x: RegExpExecArray | null
    if (rest === '/playlists' && method === 'GET') return this.json(200, [...this.playlists.values()])
    if (rest === '/playlists' && method === 'POST') {
      const b = body as FPlaylist
      this.onCreate?.(b.name)
      const id = this.nextPlaylistId++
      const items = (b.schedule_items ?? []).map((s) => ({ ...s, id: this.nextScheduleId++ }))
      const pl = { ...this.pl(id, b.name), ...b, id, schedule_items: items }
      this.playlists.set(id, pl)
      return this.json(200, pl)
    }
    if ((x = /^\/playlist\/(\d+)$/.exec(rest))) {
      const id = Number(x[1])
      const pl = this.playlists.get(id)
      if (!pl) return this.json(404, {})
      if (method === 'GET') return this.json(200, pl)
      if (method === 'PUT') {
        const b = body as Partial<FPlaylist>
        Object.assign(pl, b)
        if (b.schedule_items) pl.schedule_items = b.schedule_items.map((s) => ({ ...s, id: this.nextScheduleId++ }))
        return this.json(200, { success: true })
      }
      if (method === 'DELETE') {
        this.playlists.delete(id)
        for (const f of this.files.values()) f.playlists = f.playlists.filter((q) => q !== id)
        return this.json(200, { success: true })
      }
    }
    if ((x = /^\/playlist\/(\d+)\/order$/.exec(rest))) {
      const id = Number(x[1])
      if (!this.playlists.has(id)) return this.json(404, {})
      const members = [...this.files.values()].filter((f) => f.playlists.includes(id)).map((f) => f.id)
      const cur = (this.order.get(id) ?? []).filter((mid) => members.includes(mid))
      const ordered = [...cur, ...members.filter((mid) => !cur.includes(mid))]
      if (method === 'GET') return this.json(200, ordered.map((mid) => ({ id: id * 100000 + mid, media: { id: mid } })))
      if (method === 'PUT') {
        this.order.set(id, (body as { order: number[] }).order.map((spm) => spm % 100000))
        return this.json(200, { success: true })
      }
    }
    if ((x = /^\/file\/(\d+)$/.exec(rest))) {
      const f = this.files.get(Number(x[1]))
      if (!f) return this.json(404, {})
      if (method === 'GET') return this.json(200, this.mediaOut(f))
      if (method === 'PUT') {
        const b = body as { title: string; artist: string }
        f.title = b.title
        f.artist = b.artist
        return this.json(200, { success: true })
      }
      if (method === 'DELETE') {
        this.files.delete(f.id)
        return this.json(200, { success: true })
      }
    }
    if (rest === '/files/list') {
      const dir = u.searchParams.get('currentDirectory') ?? ''
      const out: unknown[] = []
      for (const d of this.dirs()) {
        const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : ''
        if (parent === dir) out.push({ path: d, type: 'directory', dir: { playlists: this.dirLinks.get(d) ?? [] } })
      }
      for (const f of this.files.values()) {
        const parent = f.path.slice(0, f.path.lastIndexOf('/'))
        if (parent === dir) out.push({ path: f.path, type: 'file', size: f.size, media: this.mediaOut(f) })
      }
      return this.json(200, out)
    }
    if (rest === '/files/batch' && method === 'PUT') {
      const b = body as { do: string; files: string[]; playlists: number[] }
      const f = [...this.files.values()].find((q) => q.path === b.files[0])
      if (!f) return this.json(200, { success: false, errors: ['not found'] })
      if (b.playlists.some((id) => !this.playlists.has(id))) return this.json(200, { success: false, errors: ['bad playlist'] })
      f.playlists = [...f.playlists.filter((id) => !this.playlists.has(id)), ...b.playlists]
      for (const id of b.playlists) {
        const o = this.order.get(id) ?? []
        if (!o.includes(f.id)) this.order.set(id, [...o, f.id])
      }
      return this.json(200, { success: true, errors: [] })
    }
    if (rest === '/files' && method === 'POST') {
      const b = body as { path: string; file: string }
      const size = Buffer.from(b.file, 'base64').length
      const f = this.addFile(b.path, { size, title: '', artist: '' })
      return this.json(200, this.mediaOut(f))
    }
    if (rest === '/queue' && method === 'GET') return this.json(200, this.queue.map((id) => ({ id })))
    if ((x = /^\/queue\/(\d+)$/.exec(rest)) && method === 'DELETE') {
      this.queue = this.queue.filter((q) => q !== Number(x![1]))
      return this.json(200, { success: true })
    }
    if (rest === '/status') return this.json(200, { backend_running: true, frontend_running: true })
    if (rest === '/logs' && method === 'GET') return this.json(200, [{ key: 'liquidsoap_log', name: 'Liquidsoap Log' }, { key: 'liquidsoap_liq', name: 'Liquidsoap Configuration' }])
    if (rest === '/log/liquidsoap_log' && method === 'GET') return this.json(200, { contents: this.liquidsoapLog, eof: true })
    if (rest === '/backend/restart' && method === 'POST') {
      if (this.failRestarts > 0) {
        this.failRestarts--
        return this.json(500, { success: false })
      }
      this.restarts++
      return this.json(200, { success: true })
    }
    return this.json(404, {})
  }) as unknown as typeof fetch

  client(canaries: number[] = [7]): EventsAzuraCastClient {
    return new EventsAzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(24), stationId: 14, canaryStationIds: canaries, fetchImpl: this.fetch })
  }
}

// ------------------------------------------------------------ tickets ---

export function fakeTickets() {
  const calls: { method: string; url: string; body: unknown; idem: string | null }[] = []
  let nextTicket = 500
  const f = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : null
    const headers = init.headers as Record<string, string>
    calls.push({ method: String(init.method), url, body, idem: headers['Idempotency-Key'] ?? null })
    if (init.method === 'POST' && url.endsWith('/api/v1/tickets')) return new Response(JSON.stringify({ ticketId: nextTicket++, number: 42, webUrl: 'https://tickets.invalid/t/1', discordChannelUrl: 'https://discord.invalid/c', created: true }), { status: 201 })
    if (init.method === 'POST') return new Response(JSON.stringify({ messageId: 'm', discordMessageId: '1', created: true }), { status: 201 })
    return new Response(JSON.stringify({ status: 'closed' }), { status: 200 })
  }) as unknown as typeof fetch
  return { calls, client: new TicketsClient({ baseUrl: 'http://tickets.invalid', key: 'k', portalOrigin: ORIGIN, fetchImpl: f }) }
}

// ----------------------------------------------------------- MemStore ---

type MJob = { id: number; kind: string; payload: unknown; status: 'queued' | 'running' | 'done' | 'dead'; runAfter: number; attempts: number; maxAttempts: number; dedupeKey: string | null; createdAt: number; lastError: string | null }

export class MemStore implements EventsStore {
  events: EventRow[] = []
  trackRows = new Map<number, TrackRow[]>()
  annRows = new Map<number, AnnouncementRow[]>()
  audio: AudioRow[] = []
  buildRows: BuildRow[] = []
  reg: RegistryRow[] = []
  stingers: StingerRow[] = []
  jobs: MJob[] = []
  audits: { action: string; targetId: number; detail: Record<string, unknown>; at: number }[] = []
  settingRows: Record<string, unknown> = {}
  paused = false
  scanOffset = 10
  library: { artist: string; title: string }[] = []
  musicLastUpload: number | null = null
  uploadAttempts: number[] = []
  uploadLengths = new Map<string, number>()
  expiredUploads: string[] = []
  lockDepth = 0
  maxLockDepth = 0
  seq = 1

  constructor(readonly now: () => number) {}

  // ---- jobs
  async claimJob(mutating: readonly string[]): Promise<ClaimedJob | null> {
    const j = this.jobs
      .filter((q) => q.status === 'queued' && q.runAfter <= this.now() && !(mutating.includes(q.kind) && this.paused))
      .sort((a, b) => a.runAfter - b.runAfter || a.id - b.id)[0]
    if (!j) return null
    j.status = 'running'
    j.attempts++
    return { id: j.id, kind: j.kind, payload: structuredClone(j.payload), attempts: j.attempts, maxAttempts: j.maxAttempts, ageS: Math.floor((this.now() - j.createdAt) / 1000) }
  }
  async finishJob(id: number, o: JobOutcome): Promise<void> {
    const j = this.jobs.find((q) => q.id === id)!
    if (o.status === 'done') Object.assign(j, { status: 'done', lastError: null })
    else if (o.status === 'dead') Object.assign(j, { status: 'dead', lastError: o.error })
    else Object.assign(j, { status: 'queued', lastError: o.error, runAfter: this.now() + Math.max(1, Math.min(86_400, Math.ceil(o.delayS))) * 1000, attempts: o.refund ? Math.max(0, j.attempts - 1) : j.attempts })
  }
  async enqueue<K extends EventJobKind>(kind: K, payload: EventJobPayload<K>, opts: EnqueueOpts = {}): Promise<void> {
    const p = parseEventJobPayload(kind, payload)
    const periodic = (PERIODIC_EVENT_JOB_KINDS as readonly string[]).includes(kind)
    const key = opts.dedupeKey !== undefined ? opts.dedupeKey : periodic && opts.dedupeExtra === undefined ? null : eventJobDedupeKey(kind, p, opts.dedupeExtra)
    if (key !== null && this.jobs.some((j) => j.dedupeKey === key)) return
    this.jobs.push({ id: this.seq++, kind, payload: p, status: 'queued', runAfter: opts.runAfter?.getTime() ?? this.now(), attempts: 0, maxAttempts: opts.maxAttempts ?? 8, dedupeKey: key, createdAt: this.now(), lastError: null })
  }
  async wakeEventJobs(eventId: number, kinds: readonly EventJobKind[]): Promise<void> {
    for (const j of this.jobs) if (j.status === 'queued' && kinds.includes(j.kind as EventJobKind) && (j.payload as { eventId?: number }).eventId === eventId) j.runAfter = this.now()
  }
  async hasEventJob(kind: EventJobKind, eventId: number): Promise<boolean> {
    return this.jobs.some((j) => j.kind === kind && (j.payload as { eventId?: number }).eventId === eventId)
  }

  // ---- settings
  async settings(): Promise<EventsSettings> {
    return resolveEventsSettings(this.settingRows)
  }
  async queuesPaused(): Promise<boolean> {
    return this.paused
  }
  async scanOffsetS(): Promise<number> {
    return this.scanOffset
  }

  // ---- events
  async getEvent(id: number) {
    const e = this.events.find((x) => x.id === id)
    return e ? { ...e } : null
  }
  async setEventStatus(id: number, from: readonly EventStatus[], to: EventStatus) {
    const e = this.events.find((x) => x.id === id)
    if (!e || !from.includes(e.status)) return false
    e.status = to
    return true
  }
  async setTicket(id: number, t: { ticketId: number; ticketNumber: number; ticketUrl: string }) {
    const e = this.events.find((x) => x.id === id)
    if (e && e.ticketId === null) Object.assign(e, t)
  }
  async tracks(eventId: number) {
    return (this.trackRows.get(eventId) ?? []).map((t) => ({ ...t }))
  }
  async announcements(eventId: number) {
    return (this.annRows.get(eventId) ?? []).map((a) => ({ ...a }))
  }
  async eventStartingBetween(eventId: number, fromMs: number, toMs: number) {
    const e = this.events.filter((x) => x.id !== eventId && ['built', 'live'].includes(x.status) && x.startsAt.getTime() >= fromMs && x.startsAt.getTime() < toMs).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0]
    return e ? { ...e } : null
  }
  async eventsByStatus(status: EventStatus, limit: number) {
    return this.events.filter((e) => e.status === status).slice(0, limit).map((e) => ({ ...e }))
  }

  // ---- audio
  async getAudio(id: number) {
    const a = this.audio.find((x) => x.id === id)
    return a ? { ...a } : null
  }
  async audioByStatus(status: AudioStatus, limit: number) {
    return this.audio.filter((a) => a.status === status && !a.deletedAt).slice(0, limit).map((a) => ({ ...a }))
  }
  async updateAudio(id: number, patch: AudioPatch, whereStatus?: readonly AudioStatus[]) {
    const a = this.audio.find((x) => x.id === id)
    if (!a || (whereStatus && !whereStatus.includes(a.status))) return false
    Object.assign(a, patch, { updatedAt: new Date(this.now()) })
    return true
  }
  async setUploadLength(uploadId: string, bytes: number) {
    this.uploadLengths.set(uploadId, bytes)
  }
  async expireUpload(uploadId: string) {
    this.expiredUploads.push(uploadId)
  }
  async audioInActiveEvent(audioId: number) {
    return this.events.some(
      (e) => ['approved', 'built', 'live'].includes(e.status) && ((this.trackRows.get(e.id) ?? []).some((t) => t.audioId === audioId) || (this.annRows.get(e.id) ?? []).some((a) => a.audioId === audioId)),
    )
  }
  async unusedAudio(createdBefore: Date, limit: number) {
    return this.audio.filter((a) => !a.deletedAt && !a.usedAt && a.createdAt < createdBefore).slice(0, limit)
  }
  async markAudioDeletedIfUnused(id: number, at: Date, reason: string) {
    const a = this.audio.find((x) => x.id === id)
    if (!a || a.deletedAt || a.usedAt) return false
    a.deletedAt = at
    a.lastError = reason
    return true
  }
  async libraryTagCollision(artist: string, title: string) {
    return this.library.some((l) => l.artist.toLowerCase() === artist.toLowerCase() && l.title.toLowerCase() === title.toLowerCase())
  }
  async musicLastUploadAttemptMs() {
    return this.musicLastUpload
  }
  async eventsUploadAttemptsSince(sinceMs: number) {
    return this.uploadAttempts.filter((t) => t > sinceMs)
  }
  async recordUploadAttempt() {
    this.uploadAttempts.push(this.now())
  }

  // ---- stingers
  async stinger(mediaId: number) {
    return this.stingers.find((s) => s.mediaId === mediaId) ?? null
  }
  async replaceStingers(rows: readonly StingerRow[]) {
    this.stingers = [...rows]
  }

  // ---- builds / registry
  async buildFor(eventId: number, version: number) {
    return [...this.buildRows].reverse().find((b) => b.eventId === eventId && b.version === version) ?? null
  }
  async getBuild(id: number) {
    return this.buildRows.find((b) => b.id === id) ?? null
  }
  async latestAppliedBuild(eventId: number) {
    return [...this.buildRows].reverse().find((b) => b.eventId === eventId && b.status === 'applied') ?? null
  }
  async builds(eventId: number) {
    return this.buildRows.filter((b) => b.eventId === eventId)
  }
  async createBuild(eventId: number, version: number, plan: unknown) {
    const b: BuildRow = { id: this.seq++, eventId, version, plan: structuredClone(plan), status: 'applying', lastError: null, createdAt: new Date(this.now()), updatedAt: new Date(this.now()) }
    this.buildRows.push(b)
    return b
  }
  async setBuild(id: number, patch: { status?: BuildStatus; lastError?: string | null; plan?: unknown }) {
    const b = this.buildRows.find((x) => x.id === id)!
    b.updatedAt = new Date(this.now())
    if (patch.status) b.status = patch.status
    if (patch.lastError !== undefined) b.lastError = patch.lastError
    if (patch.plan !== undefined) b.plan = structuredClone(patch.plan)
  }
  async setBuildsStatus(eventId: number, from: readonly BuildStatus[], to: BuildStatus) {
    for (const b of this.buildRows) if (b.eventId === eventId && from.includes(b.status)) b.status = to
  }
  async registry(eventId: number) {
    return this.reg.filter((r) => r.eventId === eventId && r.deletedAt === null).map((r) => ({ ...r }))
  }
  async insertIntent(eventId: number, buildId: number, role: RegistryRole, intentName: string) {
    const r: RegistryRow = { id: this.seq++, eventId, buildId, role, intentName, playlistId: null, scheduleIds: [], deletedAt: null }
    this.reg.push(r)
    return { ...r }
  }
  async setRegistryPlaylist(rowId: number, playlistId: number, scheduleIds: number[]) {
    const r = this.reg.find((x) => x.id === rowId)!
    if (this.reg.some((x) => x.id !== rowId && x.playlistId === playlistId)) throw new Error('unique violation')
    r.playlistId = playlistId
    r.scheduleIds = scheduleIds
  }
  async markRegistryDeleted(rowId: number) {
    const r = this.reg.find((x) => x.id === rowId)!
    r.deletedAt ??= new Date(this.now())
  }
  async everRegisteredPlaylistIds() {
    return new Set(this.reg.map((r) => r.playlistId).filter((x): x is number => x !== null))
  }
  async registryIdsByActivity() {
    const active = new Set<number>()
    const inactive = new Set<number>()
    for (const r of this.reg) {
      if (r.playlistId === null || r.deletedAt) continue
      const e = this.events.find((x) => x.id === r.eventId)
      ;(e && ['approved', 'built', 'live'].includes(e.status) ? active : inactive).add(r.playlistId)
    }
    return { active, inactive }
  }
  async withMembershipLock<T>(fn: () => Promise<T>): Promise<T> {
    this.lockDepth++
    this.maxLockDepth = Math.max(this.maxLockDepth, this.lockDepth)
    try {
      return await fn()
    } finally {
      this.lockDepth--
    }
  }
  async audit(action: string, _t: string, targetId: number, detail: Record<string, unknown> = {}) {
    this.audits.push({ action, targetId, detail, at: this.now() })
  }
  async markCreateAttempt(rowId: number, m: CreateAttemptMarker) {
    this.audits.push({ action: 'events.registry.create_attempt', targetId: rowId, detail: { ...m }, at: this.now() })
  }
  async createAttempt(rowId: number) {
    const a = this.audits.filter((x) => x.action === 'events.registry.create_attempt' && x.targetId === rowId).at(-1)
    return a ? (a.detail as CreateAttemptMarker) : null
  }
  async lastStartKickMs(eventId: number) {
    const t = this.audits.filter((a) => a.action === 'events.kick.start' && a.targetId === eventId).map((a) => a.at)
    return t.length ? Math.max(...t) : null
  }

  // ---- helpers for tests
  addEvent(e: Partial<EventRow> & { id: number }): EventRow {
    const row: EventRow = {
      ownerUserId: 'user-1',
      ownerDiscordId: OWNER,
      title: 'Grand Opening',
      eventType: 'club_night',
      visibility: 'public',
      status: 'approved',
      startsAt: new Date('2026-10-10T20:00:00-04:00'),
      endsAt: new Date('2026-10-10T22:00:00-04:00'),
      playlistOrder: 'shuffle',
      shortNotice: false,
      createdByStaff: false,
      submittedAt: new Date('2026-10-01T00:00:00Z'),
      ticketId: null,
      ticketNumber: null,
      ticketUrl: null,
      version: 1,
      ...e,
    }
    this.events.push(row)
    return row
  }
  addAudio(a: Partial<AudioRow> & { id: number }): AudioRow {
    const row: AudioRow = {
      ownerUserId: 'user-1',
      ownerDiscordId: OWNER,
      uploadId: 'ab'.repeat(16),
      kind: 'announcement',
      title: 'Welcome',
      artist: null,
      durationS: 30,
      status: 'probing',
      probeSha256: null,
      transcodeKbps: null,
      inputFormat: null,
      mediaId: null,
      uniqueId: null,
      path: null,
      lastError: null,
      deletedAt: null,
      usedAt: null,
      createdAt: new Date(this.now()),
      updatedAt: new Date(this.now()),
      ...a,
    }
    this.audio.push(row)
    return row
  }
  job(kind: string, pred: (p: Record<string, unknown>) => boolean = () => true) {
    return this.jobs.filter((j) => j.kind === kind && pred(j.payload as Record<string, unknown>))
  }
}

export function settingsWith(over: Partial<EventsSettings>): Record<string, unknown> {
  return { ...EVENTS_SETTING_DEFAULTS, ...over }
}

// --------------------------------------------------------------- ctx ----

export type Harness = { ctx: EventsCtx; store: MemStore; az: FakeAz; tickets: ReturnType<typeof fakeTickets>; alerts: string[]; clock: { t: number } }

export function harness(startIso: string, dirs: { spoolIn: string; spoolOut: string; final: string }): Harness {
  const clock = { t: new Date(startIso).getTime() }
  const now = () => clock.t
  const store = new MemStore(now)
  const az = new FakeAz()
  const tickets = fakeTickets()
  const alerts: string[] = []
  const ctx: EventsCtx = {
    store,
    az: az.client(),
    tickets: tickets.client,
    origin: ORIGIN,
    spoolInDir: dirs.spoolIn,
    spoolOutDir: dirs.spoolOut,
    finalDir: dirs.final,
    now,
    alert: async (title) => {
      alerts.push(title)
    },
    ingestBlocked: null,
  }
  ctx.az.setWriteGate(async () => {
    if (store.paused) throw new Error('queues paused')
  })
  return { ctx, store, az, tickets, alerts, clock }
}
