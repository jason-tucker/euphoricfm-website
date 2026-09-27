// The ONLY AzuraCast HTTP client (plan §3.7). Every request, whatever public
// method built it, passes through send(), which enforces:
//
//  * the allowlist of (method, path template, query keys, body schema);
//  * sid == STATION_ID on every station route (the one exception is the
//    startup self-check's GET on the canary station, which must 403);
//  * the profile pairing (re-asserted per call against the live env);
//  * PORTAL_TEST_PREFIX: when set, every path a write names must start with
//    it (a metadata PUT, which names an id, first GETs the id and checks its
//    path);
//  * forbidden shapes: do ∈ {delete, queue, immediate, reprocess, …}, a
//    non-empty `dirs`, `path`/`playlists` in a file PUT, string playlist ids
//    ("new" creates a playlist, P0d-B (d)).
//
// P0d-B contracts built in: files/list is cached 300 s per directory, so every
// listing sends flushCache=true; unscanned files are listed as
// {type:'other', text:'File Processing', media:null} and count as taken; a
// batch returns HTTP 200 with per-file failures in `errors[]`, which is
// treated as failure; the full list is paginated (per_page/page).

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { assertSafePath, dirname, patterns, PathError } from '../paths/builder'
import { reassertProfile, type EnvLike, type Profile } from './guard'

export class AzuraCastError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(code)
    this.name = 'AzuraCastError'
  }
}

const SID_ROUTE = /^\/api\/station\/(\d+)\//

// --------------------------------------------------------------- schemas ---

const metaString = z
  .string()
  .max(255)
  .refine((s) => !/[\p{Cc}]/u.test(s), 'control characters')

export const MetadataBody = z.object({ title: metaString, artist: metaString, album: metaString, genre: metaString }).strict()
export type Metadata = z.infer<typeof MetadataBody>

const dirsEmpty = z.array(z.never()).max(0).optional()

function batchSchemas(root: string) {
  const pat = patterns(root)
  const filePath = z.string().max(1024)
  const playlist = z
    .object({
      do: z.literal('playlist'),
      files: z.tuple([filePath]),
      dirs: dirsEmpty,
      currentDirectory: z.string().max(1024),
      playlists: z.array(z.number().int().positive().max(2_147_483_647)).max(64),
    })
    .strict()
    .superRefine((b, ctx) => {
      const f = b.files[0]
      try {
        assertSafePath(f)
      } catch {
        ctx.addIssue({ code: 'custom', message: 'unsafe file path' })
        return
      }
      if (!pat.artistFile.test(f)) ctx.addIssue({ code: 'custom', message: 'playlist file outside Music/Artists' })
      if (b.currentDirectory !== dirname(f)) ctx.addIssue({ code: 'custom', message: 'currentDirectory mismatch' })
      if (new Set(b.playlists).size !== b.playlists.length) ctx.addIssue({ code: 'custom', message: 'duplicate playlist ids' })
    })
  const move = z
    .object({
      do: z.literal('move'),
      files: z.tuple([filePath]),
      dirs: dirsEmpty,
      currentDirectory: z.string().max(1024),
      directory: z.string().max(1024),
    })
    .strict()
    .superRefine((b, ctx) => {
      const f = b.files[0]
      try {
        assertSafePath(f)
        assertSafePath(b.directory)
      } catch {
        ctx.addIssue({ code: 'custom', message: 'unsafe path' })
        return
      }
      if (b.currentDirectory !== dirname(f)) ctx.addIssue({ code: 'custom', message: 'currentDirectory mismatch' })
      const fromArtist = pat.artistFile.test(f)
      const fromArchive = pat.restoreSource.test(f)
      const toArtist = pat.artistDir.test(b.directory)
      const toArchive = pat.archiveDir.test(b.directory)
      // archive: artist file → Removed/<id>; artist move: artist file → artist dir;
      // restore: Removed/<id>/<file> → artist dir. Nothing else.
      if (!((fromArtist && (toArchive || toArtist)) || (fromArchive && toArtist))) {
        ctx.addIssue({ code: 'custom', message: 'move source/destination not allowed' })
      }
      if (b.directory === b.currentDirectory) ctx.addIssue({ code: 'custom', message: 'no-op move' })
    })
  return z.discriminatedUnion('do', [playlist, move])
}

const mediaSchema = z
  .object({
    id: z.number().int().positive(),
    unique_id: z.string(),
    path: z.string(),
    title: z.string().nullable().optional(),
    artist: z.string().nullable().optional(),
    album: z.string().nullable().optional(),
    genre: z.string().nullable().optional(),
    mtime: z.number().nullable().optional(),
    length: z.number().nullable().optional(),
    playlists: z
      .array(z.object({ id: z.number().int(), name: z.string().optional() }).passthrough())
      .optional()
      .default([]),
  })
  .passthrough()
export type StationMedia = z.infer<typeof mediaSchema>

const listEntrySchema = z
  .object({
    path: z.string(),
    type: z.string(),
    text: z.string().nullable().optional(),
    media: mediaSchema.nullable().optional(),
  })
  .passthrough()
export type ListEntry = z.infer<typeof listEntrySchema>

const pageSchema = z.object({
  page: z.number().int(),
  per_page: z.number().int(),
  total: z.number().int(),
  total_pages: z.number().int(),
  rows: z.array(mediaSchema),
})

const batchResponseSchema = z
  .object({
    success: z.boolean(),
    errors: z.array(z.string()).default([]),
    files: z.array(z.string()).optional(),
    directories: z.array(z.string()).optional(),
  })
  .passthrough()

const statusResponseSchema = z.object({ success: z.boolean() }).passthrough()

// ------------------------------------------------------------ allowlist ---

type Method = 'GET' | 'POST' | 'PUT'
type Entry = {
  method: Method
  re: RegExp
  // allowed query keys → value validator; any other key is refused
  query?: Record<string, (v: string) => boolean>
  requiredQuery?: string[]
  kind: 'read' | 'upload' | 'metadata' | 'batch'
}

const dirParam = (v: string) =>
  v.length <= 1024 && !/[\p{Cc}\\]/u.test(v) && !v.split('/').some((s) => s === '..' || s === '.') && !v.startsWith('/')

export const ALLOWLIST: readonly Entry[] = [
  { method: 'GET', re: /^\/api\/station\/(\d+)\/files$/, query: { per_page: (v) => /^[1-9]\d{0,2}$/.test(v), page: (v) => /^[1-9]\d{0,4}$/.test(v) }, requiredQuery: ['per_page', 'page'], kind: 'read' },
  { method: 'GET', re: /^\/api\/station\/(\d+)\/files\/list$/, query: { currentDirectory: dirParam, flushCache: (v) => v === 'true' }, requiredQuery: ['currentDirectory', 'flushCache'], kind: 'read' },
  { method: 'GET', re: /^\/api\/station\/(\d+)\/file\/([1-9]\d{0,9})$/, kind: 'read' },
  { method: 'GET', re: /^\/api\/nowplaying\/([a-z0-9_]{1,64})$/, kind: 'read' },
  { method: 'GET', re: /^\/api\/openapi\.yml$/, kind: 'read' },
  { method: 'POST', re: /^\/api\/station\/(\d+)\/files$/, kind: 'upload' },
  { method: 'PUT', re: /^\/api\/station\/(\d+)\/file\/([1-9]\d{0,9})$/, kind: 'metadata' },
  { method: 'PUT', re: /^\/api\/station\/(\d+)\/files\/batch$/, kind: 'batch' },
]

export type ClientDeps = {
  baseUrl: string
  apiKey: string
  profile: Profile
  canaryStationId: number
  fetchImpl?: typeof fetch
  env?: EnvLike
}

type SendOpts = {
  body?: unknown // validated JSON body
  uploadBytes?: Buffer // POST /files: streamed as {"path":…,"file":"<base64>"}
  uploadPath?: string
  canary?: boolean // self-check only
  timeoutMs?: number
  maxResponseBytes?: number
}

export class AzuraCastClient {
  private readonly root: string
  private readonly f: typeof fetch

  constructor(private readonly deps: ClientDeps) {
    reassertProfile(deps.profile, deps.env ?? process.env)
    this.root = deps.profile.testPrefix
    this.f = deps.fetchImpl ?? fetch
  }

  get stationId(): number {
    return this.deps.profile.stationId
  }

  // ------------------------------------------------------------ core ---

  // Validates everything, then performs the request. Public so tests can
  // prove that a hand-built forbidden request is refused before any I/O.
  async send(method: string, pathAndQuery: string, opts: SendOpts = {}): Promise<{ status: number; text: string }> {
    this.validate(method, pathAndQuery, opts)
    const url = `${this.deps.baseUrl}${pathAndQuery}`
    const headers: Record<string, string> = { 'X-API-Key': this.deps.apiKey, Accept: 'application/json' }
    let body: BodyInit | undefined
    if (opts.uploadBytes) {
      const stream = base64JsonStream(opts.uploadPath!, opts.uploadBytes)
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(stream.length)
      body = stream.body
    } else if (opts.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(opts.body)
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
    const text = await readLimited(res, opts.maxResponseBytes ?? 8 * 1024 * 1024)
    return { status: res.status, text }
  }

  private validate(method: string, pathAndQuery: string, opts: SendOpts): void {
    reassertProfile(this.deps.profile, this.deps.env ?? process.env)
    const u = new URL(pathAndQuery, 'http://x')
    if (u.origin !== 'http://x' || !pathAndQuery.startsWith('/api/')) throw new AzuraCastError('refused_path')
    const path = u.pathname
    if (decodeURIComponent(path) !== path) throw new AzuraCastError('refused_encoded_path')
    const entry = ALLOWLIST.find((e) => e.method === method && e.re.test(path))
    if (!entry) throw new AzuraCastError('refused_not_allowlisted', { method, path })

    // Query keys: only the allowlisted ones, each validated, required ones present.
    const keys = [...u.searchParams.keys()]
    if (new Set(keys).size !== keys.length) throw new AzuraCastError('refused_duplicate_query')
    for (const k of keys) {
      const check = entry.query?.[k]
      if (!check || !check(u.searchParams.get(k)!)) throw new AzuraCastError('refused_query', { key: k })
    }
    for (const k of entry.requiredQuery ?? []) if (!u.searchParams.has(k)) throw new AzuraCastError('refused_query_missing', { key: k })

    // Station id.
    const sidMatch = SID_ROUTE.exec(path)
    if (sidMatch) {
      const sid = Number(sidMatch[1])
      const canaryOk = opts.canary === true && method === 'GET' && /\/files\/list$/.test(path) && sid === this.deps.canaryStationId
      if (sid !== this.deps.profile.stationId && !canaryOk) throw new AzuraCastError('refused_station', { sid })
    }
    if (opts.canary && !sidMatch) throw new AzuraCastError('refused_canary')

    // Bodies.
    if (entry.kind === 'read') {
      if (opts.body !== undefined || opts.uploadBytes) throw new AzuraCastError('refused_body_on_read')
      return
    }
    if (entry.kind === 'upload') {
      if (opts.body !== undefined || !opts.uploadBytes || typeof opts.uploadPath !== 'string') throw new AzuraCastError('refused_upload_shape')
      this.assertWritePath(opts.uploadPath)
      try {
        if (!patterns(this.root).ingest.test(opts.uploadPath)) throw new PathError('ingest_pattern')
      } catch {
        throw new AzuraCastError('refused_ingest_path', { path: opts.uploadPath })
      }
      return
    }
    if (opts.uploadBytes) throw new AzuraCastError('refused_upload_shape')
    if (entry.kind === 'metadata') {
      const r = MetadataBody.safeParse(opts.body)
      if (!r.success) throw new AzuraCastError('refused_metadata_body', r.error.issues.map((i) => i.message))
      return
    }
    // batch
    const raw = opts.body as Record<string, unknown> | undefined
    if (raw && typeof raw === 'object' && typeof raw.do === 'string' && raw.do !== 'playlist' && raw.do !== 'move') {
      throw new AzuraCastError('refused_batch_action', { do: raw.do })
    }
    if (raw && Array.isArray(raw.dirs) && raw.dirs.length > 0) throw new AzuraCastError('refused_batch_dirs')
    const r = batchSchemas(this.root).safeParse(opts.body)
    if (!r.success) throw new AzuraCastError('refused_batch_body', r.error.issues.map((i) => i.message))
    const b = r.data
    this.assertWritePath(b.files[0])
    this.assertWritePath(b.currentDirectory)
    if (b.do === 'move') this.assertWritePath(b.directory)
  }

  // Prefix guard: when PORTAL_TEST_PREFIX is set, every path a write names
  // must start with it (and be structurally safe).
  private assertWritePath(p: string): void {
    try {
      assertSafePath(p)
    } catch {
      throw new AzuraCastError('refused_unsafe_path', { path: p })
    }
    if (this.root !== '' && !p.startsWith(this.root)) throw new AzuraCastError('refused_test_prefix', { path: p })
  }

  private sidPath(rest: string): string {
    return `/api/station/${this.deps.profile.stationId}${rest}`
  }

  private json<T>(status: number, text: string, schema: z.ZodType<T>, what: string): T {
    if (status === 403) throw new AzuraCastError('forbidden', { what })
    if (status === 404) throw new AzuraCastError('not_found', { what })
    if (status !== 200) throw new AzuraCastError('http_error', { what, status })
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new AzuraCastError('bad_json', { what })
    }
    const r = schema.safeParse(parsed)
    if (!r.success) throw new AzuraCastError('unexpected_shape', { what, issues: r.error.issues.slice(0, 5).map((i) => i.message) })
    return r.data
  }

  // ------------------------------------------------------------ reads ---

  async listFilesPage(page: number, perPage = 100): Promise<z.infer<typeof pageSchema>> {
    const { status, text } = await this.send('GET', `${this.sidPath('/files')}?per_page=${perPage}&page=${page}`, { timeoutMs: 60_000 })
    return this.json(status, text, pageSchema, 'files')
  }

  // Every storage row (incl. Events + UNRELEASED): callers MUST filter to the
  // Music/Artists/** surface (paths/builder.isLibrarySurface).
  async listAllFiles(perPage = 100): Promise<StationMedia[]> {
    const out: StationMedia[] = []
    for (let page = 1; page <= 1000; page++) {
      const p = await this.listFilesPage(page, perPage)
      out.push(...p.rows)
      if (page >= p.total_pages) break
    }
    return out
  }

  async listDirectory(dir: string): Promise<ListEntry[]> {
    const q = new URLSearchParams({ currentDirectory: dir, flushCache: 'true' })
    const { status, text } = await this.send('GET', `${this.sidPath('/files/list')}?${q}`)
    return this.json(status, text, z.array(listEntrySchema), 'files/list')
  }

  // Collision rule: ANY entry at the exact path, of any type.
  async pathTaken(dir: string, path: string): Promise<boolean> {
    const entries = await this.listDirectory(dir)
    return entries.some((e) => e.path === path)
  }

  async getFile(id: number): Promise<StationMedia> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AzuraCastError('bad_id')
    const { status, text } = await this.send('GET', this.sidPath(`/file/${id}`))
    return this.json(status, text, mediaSchema, 'file')
  }

  async nowPlaying(shortcode: string): Promise<unknown> {
    const { status, text } = await this.send('GET', `/api/nowplaying/${shortcode}`)
    return this.json(status, text, z.unknown(), 'nowplaying')
  }

  async openapi(): Promise<string> {
    const { status, text } = await this.send('GET', '/api/openapi.yml', { maxResponseBytes: 4 * 1024 * 1024 })
    if (status !== 200) throw new AzuraCastError('http_error', { what: 'openapi', status })
    return text
  }

  // ----------------------------------------------------------- writes ---

  async uploadFile(path: string, bytes: Buffer, expectedSha256: string): Promise<StationMedia> {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha256) throw new AzuraCastError('sha_mismatch')
    const { status, text } = await this.send('POST', this.sidPath('/files'), { uploadBytes: bytes, uploadPath: path, timeoutMs: 120_000 })
    const media = this.json(status, text, mediaSchema, 'upload')
    if (media.path !== path) throw new AzuraCastError('upload_path_mismatch', { expected: path, actual: media.path })
    return media
  }

  // Body is built field by field — never by spreading user input.
  async updateMetadata(id: number, m: Metadata): Promise<void> {
    const body: Metadata = { title: m.title, artist: m.artist, album: m.album, genre: m.genre }
    // The PUT names only an id, so resolve it first: the file must sit on the
    // Music/Artists/** surface (and under the test prefix when set).
    const current = await this.getFile(id)
    this.assertWritePath(current.path)
    if (!patterns(this.root).artistFile.test(current.path)) throw new AzuraCastError('refused_metadata_target', { path: current.path })
    const { status, text } = await this.send('PUT', this.sidPath(`/file/${id}`), { body })
    const r = this.json(status, text, statusResponseSchema, 'metadata')
    if (!r.success) throw new AzuraCastError('metadata_failed')
  }

  // REPLACES the file's station playlist set (P0d-B (d)). `allowedIds` is the
  // assignable set ∪ the snapshot's existing station ids; anything else is
  // refused before any I/O. [] clears every membership (archive).
  async setPlaylists(filePath: string, playlistIds: readonly number[], allowedIds: ReadonlySet<number>): Promise<void> {
    for (const id of playlistIds) {
      if (!Number.isSafeInteger(id) || id <= 0 || !allowedIds.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
    }
    const body = { do: 'playlist' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), playlists: [...playlistIds] }
    await this.batch(body)
  }

  // P3 behavioural contract check for PUT /files/batch (no requestBody schema
  // in the spec, P0d-A): the SAME do=playlist request as setPlaylists,
  // through the same send()/validate(), but the raw reply is returned
  // (parsed JSON or null) so a changed reply shape can be reported as drift.
  async setPlaylistsReply(filePath: string, playlistIds: readonly number[], allowedIds: ReadonlySet<number>): Promise<{ status: number; reply: unknown }> {
    for (const id of playlistIds) {
      if (!Number.isSafeInteger(id) || id <= 0 || !allowedIds.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
    }
    const body = { do: 'playlist' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), playlists: [...playlistIds] }
    const { status, text } = await this.send('PUT', this.sidPath('/files/batch'), { body })
    let reply: unknown = null
    try {
      reply = JSON.parse(text)
    } catch {
      reply = null
    }
    return { status, reply }
  }

  async moveFile(filePath: string, directory: string): Promise<void> {
    const body = { do: 'move' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), directory }
    await this.batch(body)
  }

  private async batch(body: Record<string, unknown>): Promise<void> {
    const { status, text } = await this.send('PUT', this.sidPath('/files/batch'), { body })
    const r = this.json(status, text, batchResponseSchema, 'batch')
    // HTTP 200 does not mean every file succeeded (P0d-B (e)).
    if (!r.success || r.errors.length > 0) throw new AzuraCastError('batch_errors', r.errors.slice(0, 10))
  }

  // ------------------------------------------------------- self-check ---

  // Startup: the station list must be readable (200) and the canary
  // station must be refused (403), proving the key is not a super-admin key.
  async selfCheck(): Promise<void> {
    const q = new URLSearchParams({ currentDirectory: '', flushCache: 'true' })
    const own = await this.send('GET', `${this.sidPath('/files/list')}?${q}`)
    if (own.status !== 200) throw new AzuraCastError('self_check_own_station', { status: own.status })
    const canary = await this.send('GET', `/api/station/${this.deps.canaryStationId}/files/list?${q}`, { canary: true })
    if (canary.status !== 403) throw new AzuraCastError('self_check_canary_not_403', { status: canary.status })
  }
}

// Streams `{"path":<json>,"file":"<base64 of bytes>"}` without building the
// ~47 MB base64 string in the (96 MB) worker heap.
export function base64JsonStream(path: string, bytes: Buffer): { body: ReadableStream<Uint8Array>; length: number } {
  const head = Buffer.from(`{"path":${JSON.stringify(path)},"file":"`, 'utf8')
  const tail = Buffer.from('"}', 'utf8')
  const b64Len = 4 * Math.ceil(bytes.length / 3)
  const CHUNK = 3 * 64 * 1024
  let offset = 0
  let sentHead = false
  let sentTail = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentHead) {
        sentHead = true
        controller.enqueue(head)
        return
      }
      if (offset < bytes.length) {
        const end = Math.min(offset + CHUNK, bytes.length)
        controller.enqueue(Buffer.from(bytes.subarray(offset, end).toString('base64'), 'ascii'))
        offset = end
        return
      }
      if (!sentTail) {
        sentTail = true
        controller.enqueue(tail)
        return
      }
      controller.close()
    },
  })
  return { body, length: head.length + b64Len + tail.length }
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      throw new AzuraCastError('response_too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// Playlist merge for manager edits (plan §3.7 "Playlist edits … merge"):
// memberships outside the assignable set are preserved, foreign-station ids
// (listings aggregate all stations on the storage) are dropped.
export function mergePlaylists(opts: {
  current: readonly number[]
  stationPlaylistIds: ReadonlySet<number>
  assignable: ReadonlySet<number>
  chosen: readonly number[]
}): number[] {
  for (const id of opts.chosen) if (!opts.assignable.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
  const keep = opts.current.filter((id) => opts.stationPlaylistIds.has(id) && !opts.assignable.has(id))
  return [...new Set([...keep, ...opts.chosen])].sort((a, b) => a - b)
}
