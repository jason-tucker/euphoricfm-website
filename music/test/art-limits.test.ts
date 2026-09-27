// v0.2.1 album-art limits (review SEC-1 / SEC-2): the single-buffer body
// reader and multipart part, the in-flight gate, the quota pre-check that
// runs before any body byte is read, and the art caps under the staging
// advisory lock. The e2e block repeats the gate against the real container.
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { acceptArtUpload, admitArtUpload, ArtGate, artQuotaRefusal, ART_BODY_LIMIT, MAX_PROCESSING_ART_PER_USER, readArtUpload } from '@/server/art/uploads'
import { SETTING_SCHEMAS } from '@/server/admin/settings'
import { multipartBoundary, parseDisposition, singlePart } from '@/server/art/multipart'
import type { Viewer } from '@/server/authz/predicates'
import { closeDb, getDb, schema } from '@/server/db/client'
import { readBodyExact } from '@/server/http/body'
import { HttpError } from '@/server/http/errors'
import { DEFAULT_CAPS, MB, type Caps } from '@/server/settings-defaults'
import { admitUpload, stagedBytes } from '@/server/uploads/caps'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { DBENV, E2E } from './helpers/env'
import { fxBuf } from './helpers/fixtures'
import { freshIp, ORIGIN, WEB, type Jar } from './helpers/http'
import { mkUser } from './helpers/p3'

const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p)
    return 'ok'
  } catch (e) {
    if (e instanceof HttpError) return `${e.status} ${e.code}`
    throw e
  }
}

// A multipart body exactly as undici (and browsers) encode it.
async function encode(fields: [string, Buffer | string, string?][]): Promise<{ body: Buffer; ct: string }> {
  const f = new FormData()
  for (const [name, value, filename] of fields) {
    if (typeof value === 'string') f.append(name, value)
    else f.append(name, new Blob([new Uint8Array(value)], { type: 'image/png' }), filename ?? 'a.png')
  }
  const r = new Response(f)
  return { body: Buffer.from(await r.arrayBuffer()), ct: r.headers.get('content-type')! }
}

// A request-like object for the server functions. `touched` records any
// access to .body: a refusal "without reading the body" never touches it.
function fakeReq(headers: Record<string, string>, body: ReadableStream<Uint8Array> | null) {
  const state = { touched: false }
  const req = {
    headers: new Headers(headers),
    get body() {
      state.touched = true
      return body
    },
  } as unknown as Request
  return { req, state }
}
// Caps are literal-typed (as const); tests lower them.
const withCaps = (o: Partial<Record<keyof Caps, number>>) => ({ ...DEFAULT_CAPS, ...o }) as unknown as Caps
const never = () => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }, { highWaterMark: 0 })
const bytesStream = (b: Buffer) => new Blob([new Uint8Array(b)]).stream()

describe('multipart: one file part, as a view into the body', () => {
  it('parses what undici / browsers send, without copying the bytes', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\n--not-a-boundary\r\n', 'latin1')
    const { body, ct } = await encode([['art', png, 'my "cover"; v2.png']])
    const b = multipartBoundary(ct)!
    const p = singlePart(body, b)
    expect(p).toMatchObject({ name: 'art', isFile: true })
    expect(p.data.equals(png)).toBe(true)
    expect(p.data.buffer).toBe(body.buffer) // a subarray, not a copy
  })

  it('refuses a second part, a string field, no parts, a preamble, a missing close, oversized part headers', async () => {
    const png = fxLike()
    const two = await encode([['art', png], ['note', 'x']])
    expect(await code(() => singlePart(two.body, multipartBoundary(two.ct)!))).toBe('400 exactly_one_art_field')
    const str = await encode([['art', 'just text']])
    expect(singlePart(str.body, multipartBoundary(str.ct)!)).toMatchObject({ name: 'art', isFile: false })
    const B = 'b0undary'
    expect(await code(() => singlePart(Buffer.from(`--${B}--\r\n`), B))).toBe('400 exactly_one_art_field')
    expect(await code(() => singlePart(Buffer.from(`preamble\r\n--${B}\r\nContent-Disposition: form-data; name="art"; filename="a"\r\n\r\nx\r\n--${B}--`), B))).toBe('400 bad_multipart')
    expect(await code(() => singlePart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="art"; filename="a"\r\n\r\nxyz`), B))).toBe('400 bad_multipart')
    expect(await code(() => singlePart(Buffer.from(`--${B}\r\nX-Pad: ${'a'.repeat(9000)}\r\nContent-Disposition: form-data; name="art"; filename="a"\r\n\r\nx\r\n--${B}--`), B))).toBe('400 bad_multipart')
    expect(await code(() => singlePart(Buffer.from(`--${B}\r\nContent-Type: image/png\r\n\r\nx\r\n--${B}--`), B))).toBe('400 bad_multipart')
    const ok = singlePart(Buffer.from(`--${B}\r\nContent-Disposition: form-data; name="art"; filename="a"\r\n\r\nxyz\r\n--${B}--\r\nepilogue`), B)
    expect(ok.data.toString()).toBe('xyz')
  })

  it('Content-Disposition: duplicates and non-form-data are refused', () => {
    expect(parseDisposition(' form-data; name="art"; filename="a;b.png"')).toEqual({ name: 'art', filename: 'a;b.png' })
    expect(parseDisposition('form-data; name=art; filename*=UTF-8\'\'x.png')).toEqual({ name: 'art', filename: "UTF-8''x.png" })
    expect(parseDisposition('form-data; name="art"')).toEqual({ name: 'art', filename: null })
    expect(parseDisposition('form-data; name="art"; name="other"')).toBeNull()
    expect(parseDisposition('form-data; name="art"; filename="a"; filename*=x')).toBeNull()
    expect(parseDisposition('attachment; name="art"')).toBeNull()
    expect(parseDisposition('form-data; name="unterminated')).toBeNull()
  })

  it('boundary: RFC 2046 characters, 1-70 long', () => {
    expect(multipartBoundary('multipart/form-data; boundary=----formdata-undici-012345')).toBe('----formdata-undici-012345')
    expect(multipartBoundary('multipart/form-data; boundary="a b"')).toBe('a b')
    expect(multipartBoundary('multipart/form-data; boundary=')).toBeNull()
    expect(multipartBoundary(`multipart/form-data; boundary=${'x'.repeat(71)}`)).toBeNull()
    expect(multipartBoundary('multipart/form-data; boundary="bad\\"q"')).toBeNull()
    expect(multipartBoundary('text/plain; boundary=x')).toBeNull()
  })
})

// PNG-ish bytes (only the multipart layer looks at them here).
function fxLike() {
  return Buffer.from('\x89PNG\r\n\x1a\nIHDR', 'latin1')
}

describe('readBodyExact: one preallocated buffer', () => {
  it('411 without Content-Length and 413 over the limit, both before touching the body', async () => {
    const a = fakeReq({}, never())
    expect(await code(readBodyExact(a.req, 100))).toBe('411 content_length_required')
    expect(a.state.touched).toBe(false)
    const b = fakeReq({ 'content-length': '101' }, never())
    expect(await code(readBodyExact(b.req, 100))).toBe('413 payload_too_large')
    expect(b.state.touched).toBe(false)
  })

  it('reads exactly Content-Length; short or long bodies are 400; a stalled one is 408 at the deadline', async () => {
    const data = Buffer.from('0123456789')
    expect((await readBodyExact(fakeReq({ 'content-length': '10' }, bytesStream(data)).req, 100)).equals(data)).toBe(true)
    expect(await code(readBodyExact(fakeReq({ 'content-length': '11' }, bytesStream(data)).req, 100))).toBe('400 bad_body')
    expect(await code(readBodyExact(fakeReq({ 'content-length': '9' }, bytesStream(data)).req, 100))).toBe('400 bad_body')
    const t0 = Date.now()
    expect(await code(readBodyExact(fakeReq({ 'content-length': '10' }, never()).req, 100, 200))).toBe('408 body_timeout')
    expect(Date.now() - t0).toBeLessThan(5_000)
  })
})

describe('ArtGate: in-flight slots', () => {
  it('1 per user and 3 in total; refusals are 429 / 503; release is idempotent', async () => {
    const g = new ArtGate()
    const r1 = g.acquire('u1')
    expect(await code(() => g.acquire('u1'))).toBe('429 art_upload_in_progress')
    const r2 = g.acquire('u2')
    const r3 = g.acquire('u3')
    expect(await code(() => g.acquire('u4'))).toBe('503 art_uploads_busy')
    r1()
    r1()
    expect(g.inFlight).toBe(2)
    const r4 = g.acquire('u4')
    expect(await code(() => g.acquire('u1'))).toBe('503 art_uploads_busy')
    for (const r of [r2, r3, r4]) r()
    expect(g.inFlight).toBe(0)
    g.acquire('u1')()
  })
})

describe('art caps settings', () => {
  it('admins may lower the art caps, never raise them; a caps object saved before v0.2.1 stays valid', async () => {
    const schema = SETTING_SCHEMAS.caps!
    const { artUploadsPerUserPerDay, artBytesPerUserPerDay, maxArtBytes, ...before } = DEFAULT_CAPS
    expect(schema.safeParse(before).success).toBe(true)
    expect(schema.safeParse(DEFAULT_CAPS).success).toBe(true)
    expect(schema.safeParse({ ...DEFAULT_CAPS, artUploadsPerUserPerDay: 5, artBytesPerUserPerDay: MB, maxArtBytes: 64 * MB }).success).toBe(true)
    expect(schema.safeParse({ ...DEFAULT_CAPS, artUploadsPerUserPerDay: artUploadsPerUserPerDay + 1 }).success).toBe(false)
    expect(schema.safeParse({ ...DEFAULT_CAPS, artBytesPerUserPerDay: artBytesPerUserPerDay + 1 }).success).toBe(false)
    expect(schema.safeParse({ ...DEFAULT_CAPS, maxArtBytes: maxArtBytes + 1 }).success).toBe(false)
    expect(schema.safeParse({ ...DEFAULT_CAPS, maxArtBytes: 0 }).success).toBe(false)
  })
})

describe.skipIf(!DBENV())('art admission (Postgres)', () => {
  const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
  let root: string
  let dirs: { artIn: string; art: string; spoolIn: string; spoolOut: string }
  const viewer = (u: { id: string; discordId: string }): Viewer => ({ userId: u.id, discordId: u.discordId, name: null, perms: new Set(['submit']) as Viewer['perms'] })
  const rows = async (owner: string) => ownerSql()`SELECT status, raw_size, reason FROM art_uploads WHERE owner = ${owner} ORDER BY created_at`
  const artRow = (owner: string, size: number, status = 'processing', ageH = 0) =>
    ownerSql()`INSERT INTO art_uploads (id, owner, status, raw_size, created_at) VALUES (${randomUUID()}, ${owner}, ${status}::art_status, ${size}, now() - make_interval(hours => ${ageH}))`

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'art-limits-'))
    dirs = { artIn: join(root, 'art-in'), art: join(root, 'art'), spoolIn: join(root, 'in-web'), spoolOut: join(root, 'out') }
    for (const d of Object.values(dirs)) mkdirSync(d)
  })
  afterAll(async () => closeDb())

  it('a busy slot or an exhausted quota refuses BEFORE the body is touched (Connection: close)', async () => {
    const u = await mkUser()
    const g = new ArtGate()
    const hold = g.acquire(u.id)
    const busy = fakeReq({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100' }, never())
    const e = await acceptArtUpload(db(), viewer(u), busy.req, dirs, DEFAULT_CAPS, g).catch((x) => x)
    expect(e).toMatchObject({ status: 429, code: 'art_upload_in_progress', headers: { Connection: 'close' } })
    expect(busy.state.touched).toBe(false)
    hold()

    for (let i = 0; i < MAX_PROCESSING_ART_PER_USER; i++) await artRow(u.id, 1000)
    const quota = fakeReq({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': '100' }, never())
    const q = await acceptArtUpload(db(), viewer(u), quota.req, dirs, DEFAULT_CAPS, g).catch((x) => x)
    expect(q).toMatchObject({ status: 429, code: 'too_many_art_uploads_processing', headers: { Connection: 'close', 'Retry-After': '30' } })
    expect(quota.state.touched).toBe(false)
    expect(g.inFlight).toBe(0) // released in finally
  })

  it('accepts a real upload: one row, the raw file, one spool request; the slot is released', async () => {
    const u = await mkUser()
    const g = new ArtGate()
    const { body, ct } = await encode([['art', fxBuf('art.png'), 'a.png']])
    const { req } = fakeReq({ 'content-type': ct, 'content-length': String(body.length) }, bytesStream(body))
    const r = await acceptArtUpload(db(), viewer(u), req, dirs, DEFAULT_CAPS, g)
    expect(r.status).toBe('processing')
    expect(g.inFlight).toBe(0)
    expect(readFileSync(join(dirs.artIn, r.artId)).equals(fxBuf('art.png'))).toBe(true)
    expect(readdirSync(dirs.spoolIn).some((f) => f.startsWith(r.artId))).toBe(true)
    expect(await rows(u.id)).toEqual([{ status: 'processing', raw_size: fxBuf('art.png').length, reason: null }])
  })

  it('readArtUpload keeps the old refusals (field name, string field, empty, >5 MB in the part, no Content-Length)', async () => {
    const run = async (fields: [string, Buffer | string, string?][], extra: Record<string, string> = {}) => {
      const { body, ct } = await encode(fields)
      return code(readArtUpload(fakeReq({ 'content-type': ct, 'content-length': String(body.length), ...extra }, bytesStream(body)).req))
    }
    expect(await run([['picture', fxBuf('art.png')]])).toBe('400 exactly_one_art_field')
    expect(await run([['art', 'text']])).toBe('400 art_must_be_a_file')
    expect(await run([['art', Buffer.alloc(0)]])).toBe('400 empty_file')
    expect(await run([['art', Buffer.alloc(5 * MB + 1)]])).toBe('413 art_too_large')
    const { body, ct } = await encode([['art', fxBuf('art.png')]])
    expect(await code(readArtUpload(fakeReq({ 'content-type': ct }, bytesStream(body)).req))).toBe('411 content_length_required')
    expect(await code(readArtUpload(fakeReq({ 'content-type': ct, 'content-length': String(ART_BODY_LIMIT + 1) }, never()).req))).toBe('413 payload_too_large')
  })

  it('per-user daily count and bytes (rolling 24 h), global art bytes and shared staging bytes', async () => {
    const u = await mkUser()
    const caps = withCaps({ artUploadsPerUserPerDay: 3, artBytesPerUserPerDay: 10_000 })
    await artRow(u.id, 1000, 'ready')
    await artRow(u.id, 1000, 'rejected')
    await artRow(u.id, 1000, 'expired', 25) // outside the window
    expect(await artQuotaRefusal(db(), u.id, 8000, caps)).toBeNull()
    expect(await artQuotaRefusal(db(), u.id, 8001, caps)).toMatchObject({ status: 429, code: 'art_daily_quota' })
    await artRow(u.id, 1000, 'ready')
    expect(await artQuotaRefusal(db(), u.id, 1, caps)).toMatchObject({ status: 429, code: 'art_daily_quota', retryAfterS: 3600 })

    const v = await mkUser()
    const staged = await stagedBytes(db())
    const tight = withCaps({ maxArtBytes: staged.art + 5000 })
    expect(await artQuotaRefusal(db(), v.id, 5000, tight)).toBeNull()
    expect(await artQuotaRefusal(db(), v.id, 5001, tight)).toMatchObject({ status: 503, code: 'art_storage_full' })
    const staging = withCaps({ maxStagingBytes: staged.uploads + staged.art + 5000 })
    expect(await artQuotaRefusal(db(), v.id, 5001, staging)).toMatchObject({ status: 503, code: 'staging_full' })

    // ready + processing art counts toward the tus staging cap too
    await artRow(v.id, 4000, 'ready')
    await artRow(v.id, 1000, 'processing')
    const after = await stagedBytes(db())
    expect(after.art - staged.art).toBe(5000)
    const tus = withCaps({ maxStagingBytes: after.uploads + after.art + 100 })
    expect(await admitUpload(db(), v.id, randomUUID().replace(/-/g, ''), 101, tus)).toMatchObject({ status: 503, code: 'staging_full' })
    await artRow(v.id, 0, 'rejected') // rejected / expired rows hold no bytes
    expect((await stagedBytes(db())).art).toBe(after.art)
  })

  it('concurrent admissions cannot overshoot the byte caps (staging advisory lock)', async () => {
    const users = await Promise.all(Array.from({ length: 8 }, () => mkUser()))
    const staged = await stagedBytes(db())
    const caps = withCaps({ maxArtBytes: staged.art + 3 * 1000 })
    // Its own pool of 4, so the admissions really run side by side.
    const pool = postgres(process.env.TEST_APP_DATABASE_URL!, { max: 4, onnotice: () => {} })
    const res = await Promise.all(users.map((u) => admitArtUpload(drizzle(pool, { schema }), u.id, randomUUID(), '/nonexistent', 1000, caps))).finally(() => pool.end({ timeout: 5 }))
    expect(res.filter((r) => r === null)).toHaveLength(3)
    expect(res.filter((r) => r?.code === 'art_storage_full')).toHaveLength(5)
    expect((await stagedBytes(db())).art - staged.art).toBe(3000)
  })
})

// ------------------------------------------------------------------- e2e --

// One multipart POST on its own connection: headers and `firstBytes` of the
// body are sent at once, the rest only when finish() is called, so the
// request can be held open mid-body. `response` settles as soon as the
// server answers (possibly before the body is complete).
function openUpload(jar: Jar, body: Buffer, ct: string, firstBytes: number) {
  const url = new URL(`${WEB()}/api/uploads/art`)
  let rq: ReturnType<typeof httpRequest>
  const response = new Promise<{ status: number; text: string; at: number }>((resolve, reject) => {
    rq = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        agent: false,
        headers: { 'cf-connecting-ip': freshIp(), origin: ORIGIN, 'sec-fetch-site': 'same-origin', connection: 'close', cookie: jar.header(), 'content-type': ct, 'content-length': String(body.length) },
      },
      (res) => {
        const parts: Buffer[] = []
        const done = () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf8'), at: Date.now() })
        res.on('data', (c: Buffer) => parts.push(c))
        res.on('end', done)
        res.on('error', done)
        res.on('close', done)
      },
    )
    rq.on('error', reject)
    rq.write(body.subarray(0, firstBytes))
  })
  response.catch(() => {})
  return {
    response,
    finish: () => rq.end(body.subarray(firstBytes)),
    abort: () => rq.destroy(),
  }
}

describe.skipIf(!E2E())('album-art in-flight gate (real container)', () => {
  const seqId = (() => {
    let n = 0
    return () => `7${String(Date.now()).slice(-9)}${String(++n).padStart(8, '0')}`
  })()

  it('a second upload by the same member is 429 while the first body is still arriving; the first then succeeds', async () => {
    const jar = await loginOk({ id: seqId() })
    const { body, ct } = await encode([['art', fxBuf('art.png'), 'a.png']])
    const first = openUpload(jar, body, ct, 1024)
    await new Promise((r) => setTimeout(r, 1500)) // the first request is inside the handler, reading
    const second = openUpload(jar, body, ct, 1024) // never finished: the refusal must not wait for its body
    const r2 = await Promise.race([second.response, new Promise<null>((r) => setTimeout(() => r(null), 10_000))])
    expect(r2?.status).toBe(429)
    expect(r2?.text).toContain('art_upload_in_progress')
    second.abort()
    first.finish()
    const r1 = await first.response
    expect(r1.status).toBe(202)
  })

  it('a fourth member is 503 while three uploads are in flight; the gate frees up afterwards', async () => {
    const jars = await Promise.all([0, 1, 2, 3].map(() => loginOk({ id: seqId() })))
    const { body, ct } = await encode([['art', fxBuf('art.jpg'), 'a.jpg']])
    const held = jars.slice(0, 3).map((j) => openUpload(j, body, ct, 512))
    await new Promise((r) => setTimeout(r, 1500))
    const fourth = openUpload(jars[3]!, body, ct, 512)
    const r4 = await Promise.race([fourth.response, new Promise<null>((r) => setTimeout(() => r(null), 10_000))])
    expect(r4?.status).toBe(503)
    expect(r4?.text).toContain('art_uploads_busy')
    fourth.abort()
    for (const h of held) h.abort() // aborted mid-body: each slot is released in finally
    await new Promise((r) => setTimeout(r, 1500))
    const again = openUpload(jars[3]!, body, ct, body.length)
    again.finish()
    expect((await again.response).status).toBe(202)
  })
})
