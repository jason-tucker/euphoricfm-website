// The ONLY AzuraCast HTTP client (plan §3.7). The raw transport (#send) is
// PRIVATE: every request is built by one of the typed methods below, and
// each one passes through the async validate() before any I/O. validate()
// enforces:
//
//  * the allowlist of (method, path template, query keys, body schema);
//  * sid == STATION_ID on every station route (the one exception is the
//    startup self-check's GET on the canary station, which must 403);
//  * the profile pairing (re-asserted per call against the live env);
//  * PORTAL_TEST_PREFIX: when set, every path a write names must start with
//    it;
//  * a metadata PUT names only an id, so validate() GETs that id first and
//    requires its path to pass the prefix guard AND the Music/Artists file
//    pattern: every metadata PUT gets this, whichever method built it;
//  * a do=playlist batch: every playlist id must be in the caller's allowed
//    set (passed in the request options; a batch without one is refused);
//  * forbidden shapes: do ∈ {delete, queue, immediate, reprocess, …}, a
//    non-empty `dirs`, `path`/`playlists` in a file PUT, string playlist ids
//    ("new" creates a playlist, P0d-B (d)).
//
// Batch requests are reachable only through setPlaylists(),
// setPlaylistsReply() and moveFile(). Album art (POST /art/{id}) only through
// uploadArt(), which gets the same media-id target checks as a metadata PUT;
// its read-only counterpart (GET /art/{id}, the public art route) only
// through getArt(), which never follows a redirect.
// moveFile() adds its own live checks, because AzuraCast's doMove does NOT:
// the source must be an exact media entry and the destination path must be
// free (any entry type), both read with flushCache=true, and the moved id is
// re-read afterwards (a batch 200 proves nothing: upstream silently skips a
// source with no DB record and rename()s over an occupied destination).
//
// Tests reach the transport only through the TEST_SEND seam, which runs the
// same validate() and refuses outside vitest.
//
// P0d-B contracts built in: files/list is cached 300 s per directory, so every
// listing sends flushCache=true; unscanned files are listed as
// {type:'other', text:'File Processing', media:null} and count as taken; a
// batch returns HTTP 200 with per-file failures in `errors[]`, which is
// treated as failure; the full list is paginated (per_page/page).

import { createHash, randomBytes } from 'node:crypto'
import { constants as FS } from 'node:fs'
import { open as openFile } from 'node:fs/promises'
import { z } from 'zod'
import { assertSafePath, basename, dirname, patterns, PathError } from '../paths/builder'
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
// The probe's re-encoded art is ≤1000 px; anything bigger is not ours.
const MAX_ART_JPEG_BYTES = 2 * 1024 * 1024
// AzuraCast re-encodes stored art (≤1500 px): a read may be a bit larger.
const MAX_ART_READ_BYTES = 4 * 1024 * 1024
const ART_READ_ROUTE = /^\/api\/station\/(\d+)\/art\/([1-9]\d{0,9})$/

// Test-only transport seam (see header).
export const TEST_SEND = Symbol('azuracast.testSend')

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
  kind: 'read' | 'upload' | 'metadata' | 'batch' | 'art'
}

const dirParam = (v: string) =>
  v.length <= 1024 && !/[\p{Cc}\\]/u.test(v) && !v.split('/').some((s) => s === '..' || s === '.') && !v.startsWith('/')

export const ALLOWLIST: readonly Entry[] = [
  { method: 'GET', re: /^\/api\/station\/(\d+)\/files$/, query: { per_page: (v) => /^[1-9]\d{0,2}$/.test(v), page: (v) => /^[1-9]\d{0,4}$/.test(v) }, requiredQuery: ['per_page', 'page'], kind: 'read' },
  { method: 'GET', re: /^\/api\/station\/(\d+)\/files\/list$/, query: { currentDirectory: dirParam, flushCache: (v) => v === 'true' }, requiredQuery: ['currentDirectory', 'flushCache'], kind: 'read' },
  { method: 'GET', re: /^\/api\/station\/(\d+)\/file\/([1-9]\d{0,9})$/, kind: 'read' },
  { method: 'GET', re: /^\/api\/nowplaying\/([a-z0-9_]{1,64})$/, kind: 'read' },
  { method: 'GET', re: /^\/api\/openapi\.yml$/, kind: 'read' },
  // Current album art of a media id (Stations\Art\GetArtAction, public: 200
  // with the stored JPEG, or a 302 to the generic image when there is none).
  // Read-only, numeric media id, same station check as every route.
  { method: 'GET', re: ART_READ_ROUTE, kind: 'read' },
  { method: 'POST', re: /^\/api\/station\/(\d+)\/files$/, kind: 'upload' },
  { method: 'PUT', re: /^\/api\/station\/(\d+)\/file\/([1-9]\d{0,9})$/, kind: 'metadata' },
  // Album art (verified on the live 0.21.0 build: Stations\Art\PostArtAction,
  // permission StationPermissions::Media, Flow standard upload = the first
  // multipart file part, OpenAPI field `file`). Numeric media id only.
  { method: 'POST', re: /^\/api\/station\/(\d+)\/art\/([1-9]\d{0,9})$/, kind: 'art' },
  { method: 'PUT', re: /^\/api\/station\/(\d+)\/files\/batch$/, kind: 'batch' },
]

export type ClientDeps = {
  baseUrl: string
  apiKey: string
  profile: Profile
  canaryStationId: number
  // More stations the key must NOT reach (e.g. 14, Events, which shares
  // storage 2). Every canary must answer 403 in the self-check.
  extraCanaryStationIds?: readonly number[]
  fetchImpl?: typeof fetch
  env?: EnvLike
  // Where the probe's album-art JPEGs live (read-only for the worker).
  // uploadArt reads ONLY <artDir>/<uuid>/cover.jpg.
  artDir?: string
  // Runs immediately before every WRITE leaves the process (after all other
  // checks). The worker wires it to assertQueuesNotPaused (server/pause.ts).
  writeGate?: () => Promise<void>
}

type SendOpts = {
  body?: unknown // validated JSON body
  uploadBytes?: Buffer // POST /files: streamed as {"path":…,"file":"<base64>"}
  uploadPath?: string
  artBytes?: Buffer // POST /art/{id}: sent as multipart, one `file` part (JPEG)
  canary?: boolean // self-check only
  allowedPlaylistIds?: ReadonlySet<number> // required for a do=playlist batch
  timeoutMs?: number
  maxResponseBytes?: number
}

type SendResult = { status: number; text: string; bytes?: Buffer; location?: string | null }

export class AzuraCastClient {
  private readonly root: string
  private readonly f: typeof fetch

  constructor(private readonly deps: ClientDeps) {
    reassertProfile(deps.profile, deps.env ?? process.env)
    this.root = deps.profile.testPrefix
    this.f = deps.fetchImpl ?? fetch
    this.writeGate = deps.writeGate
  }

  private writeGate: (() => Promise<void>) | undefined

  // The worker sets this once its DB exists (startupChecks builds the client
  // before the DB connection).
  setWriteGate(gate: () => Promise<void>): void {
    this.writeGate = gate
  }

  get stationId(): number {
    return this.deps.profile.stationId
  }

  // ------------------------------------------------------------ core ---

  // Test-only seam: the same validate() + transport as every typed method,
  // so tests can prove a hand-built forbidden request is refused before any
  // I/O. Refuses outside vitest.
  async [TEST_SEND](method: string, pathAndQuery: string, opts: SendOpts = {}): Promise<SendResult> {
    if (process.env.VITEST !== 'true') throw new AzuraCastError('test_seam_disabled')
    return this.#send(method, pathAndQuery, opts)
  }

  // Validates everything, then performs the request. Private: only the typed
  // methods of this class can build a request.
  async #send(method: string, pathAndQuery: string, opts: SendOpts = {}): Promise<SendResult> {
    // Serialize ONCE and validate the parsed copy of exactly those bytes, so
    // getters / toJSON cannot make what is sent differ from what was checked.
    const serialized = opts.body === undefined ? undefined : JSON.stringify(opts.body)
    const checked: SendOpts = serialized === undefined ? opts : { ...opts, body: JSON.parse(serialized) as unknown }
    await this.validate(method, pathAndQuery, checked)
    // Send to the validated path on the configured origin only.
    const u = new URL(pathAndQuery, 'http://x')
    const url = `${this.deps.baseUrl}${u.pathname}${u.search}`
    const headers: Record<string, string> = { 'X-API-Key': this.deps.apiKey, Accept: 'application/json' }
    let body: BodyInit | undefined
    if (opts.artBytes) {
      const boundary = `efm${randomBytes(16).toString('hex')}`
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`
      body = new Uint8Array(
        Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="cover.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`, 'latin1'),
          opts.artBytes,
          Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
        ]),
      )
    } else if (opts.uploadBytes) {
      const stream = base64JsonStream(opts.uploadPath!, opts.uploadBytes)
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(stream.length)
      body = stream.body
    } else if (serialized !== undefined) {
      headers['content-type'] = 'application/json'
      body = serialized
    }
    // The art read is binary and answers "no custom art" with a redirect,
    // which is reported, never followed. Everything else refuses redirects.
    const artRead = method === 'GET' && ART_READ_ROUTE.test(u.pathname)
    const res = await this.f(url, {
      method,
      headers,
      body,
      redirect: artRead ? 'manual' : 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      ...(opts.uploadBytes ? { duplex: 'half' } : {}),
    } as RequestInit)
    const raw = await readLimited(res, opts.maxResponseBytes ?? 8 * 1024 * 1024)
    if (artRead) return { status: res.status, text: '', bytes: raw, location: res.headers.get('location') }
    return { status: res.status, text: raw.toString('utf8') }
  }

  private async validate(method: string, pathAndQuery: string, opts: SendOpts): Promise<void> {
    await this.validateShape(method, pathAndQuery, opts)
    const entry = ALLOWLIST.find((e) => e.method === method && e.re.test(new URL(pathAndQuery, 'http://x').pathname))!
    if (entry.kind !== 'read' && this.writeGate) {
      try {
        await this.writeGate()
      } catch (e) {
        throw new AzuraCastError('refused_queues_paused', e instanceof Error ? e.message : undefined)
      }
    }
  }

  private async validateShape(method: string, pathAndQuery: string, opts: SendOpts): Promise<void> {
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
      const canaryOk = opts.canary === true && method === 'GET' && /\/files\/list$/.test(path) && this.canaries().includes(sid)
      if (sid !== this.deps.profile.stationId && !canaryOk) throw new AzuraCastError('refused_station', { sid })
    }
    if (opts.canary && !sidMatch) throw new AzuraCastError('refused_canary')
    if (opts.allowedPlaylistIds && entry.kind !== 'batch') throw new AzuraCastError('refused_playlist_set_misuse')

    // Bodies.
    if (entry.kind === 'read') {
      if (opts.body !== undefined || opts.uploadBytes || opts.artBytes) throw new AzuraCastError('refused_body_on_read')
      return
    }
    if (entry.kind === 'art') {
      const b = opts.artBytes
      if (opts.body !== undefined || opts.uploadBytes || !Buffer.isBuffer(b) || b.length < 4 || b.length > MAX_ART_JPEG_BYTES) throw new AzuraCastError('refused_art_shape')
      if (!(b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)) throw new AzuraCastError('refused_art_not_jpeg')
      // Names only an id, like the metadata PUT: same target checks.
      await this.assertMediaTarget(Number(entry.re.exec(path)![2]))
      return
    }
    if (opts.artBytes) throw new AzuraCastError('refused_art_shape')
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
      // The PUT names only an id: resolve it through the (validated) read
      // path and require the file to sit on the Music/Artists/** surface,
      // under the test prefix when set. Runs for EVERY metadata PUT.
      await this.assertMediaTarget(Number(entry.re.exec(path)![2]))
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
    if (b.do === 'playlist') {
      const allowed = opts.allowedPlaylistIds
      if (!allowed) throw new AzuraCastError('refused_playlist_set_missing')
      for (const id of b.playlists) if (!allowed.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
    }
  }

  // A write that names only a media id (metadata PUT, art POST): resolve the
  // id through the validated read path; the file must be on the
  // Music/Artists/<folder>/<file> surface and under the test prefix when set.
  private async assertMediaTarget(id: number): Promise<void> {
    const current = await this.getFile(id)
    this.assertWritePath(current.path)
    if (!patterns(this.root).artistFile.test(current.path)) throw new AzuraCastError('refused_metadata_target', { path: current.path })
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
    const { status, text } = await this.#send('GET', `${this.sidPath('/files')}?per_page=${perPage}&page=${page}`, { timeoutMs: 60_000 })
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
    const { status, text } = await this.#send('GET', `${this.sidPath('/files/list')}?${q}`)
    return this.json(status, text, z.array(listEntrySchema), 'files/list')
  }

  // Collision rule: ANY entry at the path, of any type. Compared case- and
  // accent-insensitively (NFC, Intl.Collator 'base'): if station_media.path
  // uses a *_ci MariaDB collation, 'GRIM - Touch.mp3' and 'Grim - touch.mp3'
  // are the same row to AzuraCast. Erring towards "taken" only ever picks the
  // next ` (n)` name or refuses a move.
  async pathTaken(dir: string, path: string): Promise<boolean> {
    const entries = await this.listDirectory(dir)
    return entries.some((e) => samePathLoose(e.path, path))
  }

  async getFile(id: number): Promise<StationMedia> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AzuraCastError('bad_id')
    const { status, text } = await this.#send('GET', this.sidPath(`/file/${id}`))
    return this.json(status, text, mediaSchema, 'file')
  }

  async nowPlaying(shortcode: string): Promise<unknown> {
    const { status, text } = await this.#send('GET', `/api/nowplaying/${shortcode}`)
    return this.json(status, text, z.unknown(), 'nowplaying')
  }

  // The media's current album art as AzuraCast serves it (apply_art: old-art
  // hash for the snapshot, and the post-upload verify). 'none' = the generic
  // image redirect (no custom art). Station check as always; read-only, so
  // no write gate and no prefix rule (it names no path).
  async getArt(mediaId: number): Promise<{ kind: 'art'; bytes: Buffer; sha256: string } | { kind: 'none' }> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new AzuraCastError('bad_id')
    const { status, bytes } = await this.#send('GET', this.sidPath(`/art/${mediaId}`), { maxResponseBytes: MAX_ART_READ_BYTES })
    if (status >= 300 && status < 400) return { kind: 'none' }
    if (status === 403) throw new AzuraCastError('forbidden', { what: 'art' })
    if (status === 404) throw new AzuraCastError('not_found', { what: 'art' })
    if (status !== 200 || !bytes) throw new AzuraCastError('http_error', { what: 'art', status })
    return { kind: 'art', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
  }

  async openapi(): Promise<string> {
    const { status, text } = await this.#send('GET', '/api/openapi.yml', { maxResponseBytes: 4 * 1024 * 1024 })
    if (status !== 200) throw new AzuraCastError('http_error', { what: 'openapi', status })
    return text
  }

  // ----------------------------------------------------------- writes ---

  async uploadFile(path: string, bytes: Buffer, expectedSha256: string): Promise<StationMedia> {
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha256) throw new AzuraCastError('sha_mismatch')
    const { status, text } = await this.#send('POST', this.sidPath('/files'), { uploadBytes: bytes, uploadPath: path, timeoutMs: 120_000 })
    const media = this.json(status, text, mediaSchema, 'upload')
    if (media.path !== path) throw new AzuraCastError('upload_path_mismatch', { expected: path, actual: media.path })
    return media
  }

  // Body is built field by field — never by spreading user input.
  async updateMetadata(id: number, m: Metadata): Promise<void> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new AzuraCastError('bad_id')
    const body: Metadata = { title: m.title, artist: m.artist, album: m.album, genre: m.genre }
    // validate() resolves the id and applies the prefix + Music/Artists
    // target checks before this PUT leaves the process.
    const { status, text } = await this.#send('PUT', this.sidPath(`/file/${id}`), { body })
    const r = this.json(status, text, statusResponseSchema, 'metadata')
    if (!r.success) throw new AzuraCastError('metadata_failed')
  }

  // Sets a track's album art (art contract 2026-09-27) from a probe-made
  // JPEG. The path must be <artDir>/<uuid>/cover.jpg, read without following
  // links; the bytes must hash to expectedSha256 (the probe's recorded sha)
  // and be a JPEG. The request goes through validate() like every write:
  // the media id is resolved and must be a Music/Artists file under the
  // prefix, the station must match, and the write gate runs.
  // AzuraCast side effects (verified in source): it stores a resized copy
  // (album_art/<unique_id>.jpg), sets art_updated_at, and REWRITES the audio
  // file's tags on disk (writeToFile), like a metadata PUT.
  async uploadArt(mediaId: number, jpegPath: string, expectedSha256: string): Promise<void> {
    if (!Number.isSafeInteger(mediaId) || mediaId <= 0) throw new AzuraCastError('bad_id')
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new AzuraCastError('bad_sha256')
    const artDir = (this.deps.artDir ?? '/staging/art').replace(/\/+$/, '')
    const m = /^(.*)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/cover\.jpg$/.exec(jpegPath)
    if (!m || m[1] !== artDir) throw new AzuraCastError('refused_art_path', { path: jpegPath })
    let fh
    try {
      fh = await openFile(jpegPath, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK)
    } catch {
      throw new AzuraCastError('art_missing')
    }
    let bytes: Buffer
    try {
      const st = await fh.stat()
      if (!st.isFile() || st.size < 4 || st.size > MAX_ART_JPEG_BYTES) throw new AzuraCastError('refused_art_shape')
      bytes = await fh.readFile()
    } finally {
      await fh.close()
    }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw new AzuraCastError('sha_mismatch')
    const { status, text } = await this.#send('POST', this.sidPath(`/art/${mediaId}`), { artBytes: bytes, timeoutMs: 60_000 })
    const r = this.json(status, text, statusResponseSchema, 'art')
    if (!r.success) throw new AzuraCastError('art_failed')
  }

  // REPLACES the file's station playlist set (P0d-B (d)). `allowedIds` is the
  // assignable set ∪ the snapshot's existing station ids; anything else is
  // refused before any I/O. [] clears every membership (archive).
  async setPlaylists(filePath: string, playlistIds: readonly number[], allowedIds: ReadonlySet<number>): Promise<void> {
    for (const id of playlistIds) {
      if (!Number.isSafeInteger(id) || id <= 0 || !allowedIds.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
    }
    const body = { do: 'playlist' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), playlists: [...playlistIds] }
    await this.batch(body, allowedIds)
  }

  // The SAME do=playlist request as setPlaylists (same validate(), same
  // allowed-set check), returning the raw reply instead of throwing on
  // errors[] — for P3's behavioural contract check.
  async setPlaylistsReply(filePath: string, playlistIds: readonly number[], allowedIds: ReadonlySet<number>): Promise<{ status: number; reply: unknown }> {
    for (const id of playlistIds) {
      if (!Number.isSafeInteger(id) || id <= 0 || !allowedIds.has(id)) throw new AzuraCastError('refused_playlist_id', { id })
    }
    const body = { do: 'playlist' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), playlists: [...playlistIds] }
    const { status, text } = await this.#send('PUT', this.sidPath('/files/batch'), { body, allowedPlaylistIds: allowedIds })
    let reply: unknown = null
    try {
      reply = JSON.parse(text)
    } catch {
      reply = null
    }
    return { status, reply }
  }

  // AzuraCast's BatchAction::doMove does NOT check the destination: it
  // rename()s over an occupied path (Flysystem local adapter), and it silently
  // skips a source that has no DB record (success:true, errors:[]). So the
  // wrapper is the barrier (plan §3.5 "move, archive and restore fail on any
  // collision"):
  //   1. validate the batch body (patterns, prefix) before any I/O;
  //   2. list the source dir (flushCache=true): the source must be an exact
  //      media entry with an id;
  //   3. list the destination dir (flushCache=true): NO entry of any type may
  //      sit at <directory>/<basename>;
  //   4. move, then GET the id and require the exact new path.
  // Callers run this inside the scan-safe window to keep 2–4 close together.
  async moveFile(filePath: string, directory: string): Promise<void> {
    const body = { do: 'move' as const, files: [filePath], dirs: [], currentDirectory: dirname(filePath), directory }
    await this.validate('PUT', this.sidPath('/files/batch'), { body })
    const dest = `${directory}/${basename(filePath)}`
    const src = (await this.listDirectory(dirname(filePath))).find((e) => e.path === filePath)
    const mediaId = src?.media?.id
    if (!src || !mediaId) throw new AzuraCastError('move_source_missing', { path: filePath })
    if (await this.pathTaken(directory, dest)) throw new AzuraCastError('refused_move_collision', { path: dest })
    await this.batch(body)
    const moved = await this.getFile(mediaId)
    if (moved.path !== dest) throw new AzuraCastError('move_verify_failed', { expected: dest, actual: moved.path })
  }

  private async batch(body: Record<string, unknown>, allowedPlaylistIds?: ReadonlySet<number>): Promise<void> {
    const { status, text } = await this.#send('PUT', this.sidPath('/files/batch'), { body, ...(allowedPlaylistIds ? { allowedPlaylistIds } : {}) })
    const r = this.json(status, text, batchResponseSchema, 'batch')
    // HTTP 200 does not mean every file succeeded (P0d-B (e)).
    if (!r.success || r.errors.length > 0) throw new AzuraCastError('batch_errors', r.errors.slice(0, 10))
  }

  // ------------------------------------------------------- self-check ---

  // Startup: the station list must be readable (200) and the canary
  // station must be refused (403), proving the key is not a super-admin key.
  async selfCheck(): Promise<void> {
    const q = new URLSearchParams({ currentDirectory: '', flushCache: 'true' })
    const own = await this.#send('GET', `${this.sidPath('/files/list')}?${q}`)
    if (own.status !== 200) throw new AzuraCastError('self_check_own_station', { status: own.status })
    for (const sid of this.canaries()) {
      const canary = await this.#send('GET', `/api/station/${sid}/files/list?${q}`, { canary: true })
      if (canary.status !== 403) throw new AzuraCastError('self_check_canary_not_403', { station: sid, status: canary.status })
    }
  }

  private canaries(): number[] {
    const all = [this.deps.canaryStationId, ...(this.deps.extraCanaryStationIds ?? [])]
    return [...new Set(all)].filter((sid) => Number.isSafeInteger(sid) && sid > 0 && sid !== this.deps.profile.stationId)
  }
}

const looseCollator = new Intl.Collator('en', { sensitivity: 'base', usage: 'search' })
export function samePathLoose(a: string, b: string): boolean {
  return a === b || looseCollator.compare(a.normalize('NFC'), b.normalize('NFC')) === 0
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
      throw new AzuraCastError('response_too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
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
