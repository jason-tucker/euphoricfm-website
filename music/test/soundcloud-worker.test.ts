// v0.4.0 SoundCloud links at the DB level: the web's admission (shape, kill
// switch, burst / daily / in-flight limits, staging quota), and the worker's
// side of the music-fetch spool (request, result checks, probe_fetch request,
// probe result, release marker, timeouts, restarts). The test plays
// music-fetch and the probe with temp spool dirs; no network anywhere.
//
// The harness's real worker shares this database: items here get no job row
// (the handlers are called directly), so it never runs them.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Viewer } from '@/server/authz/predicates'
import { closeDb, getDb } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { DEFAULT_CAPS } from '@/server/settings-defaults'
import { addSoundCloudToBatch } from '@/server/soundcloud'
import { clipTag } from '@/probe/tags'
import { collectProbeResults, RetryLater } from '@/worker/handlers'
import { collectFetchResults, FETCH_RELEASE_WINDOW_S, reissueFetchReleases, runSoundcloudFetch, type FetchCtx } from '@/worker/soundcloud'
import { ownerSql } from './helpers/db'
import { DBENV } from './helpers/env'
import { mkBatch, mkUser } from './helpers/p3'

const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
const MiB = 1024 * 1024
let base: string
let ctx: FetchCtx & { alerts: string[] }
const created: number[] = []

const viewer = (u: { id: string; discordId: string }): Viewer => ({ userId: u.id, discordId: u.discordId, name: null, perms: new Set(['submit', 'request']) })

async function httpError(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  try {
    await p
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code }
    throw e
  }
  throw new Error('expected an HttpError')
}

// A SoundCloud item as the web records it (no job row: see the header).
async function mkScItem(o: { stage?: string; url?: string; requestedAgoS?: number | null; status?: string; createdAgoS?: number } = {}) {
  const u = await mkUser()
  const b = await mkBatch(u.id, { status: 'draft' })
  const upload = randomUUID().replace(/-/g, '')
  const fetchId = randomUUID()
  await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status) VALUES (${upload}, ${u.id}, ${60 * MiB}, 'attached')`
  const req = o.requestedAgoS === undefined || o.requestedAgoS === null ? null : new Date(Date.now() - o.requestedAgoS * 1000).toISOString()
  const [it] = await ownerSql()`
    INSERT INTO items (batch_id, owner_user_id, status, source, upload_id, fetch_request_id, fetch_stage, source_url, fetch_requested_at, created_at)
    VALUES (${b}, ${u.id}, ${o.status ?? 'probing'}::item_status, 'soundcloud', ${upload}, ${fetchId}, ${o.stage ?? 'queued'},
            ${o.url ?? 'https://soundcloud.com/e2e-user/a-track'}, ${req}::timestamptz, now() - make_interval(secs => ${o.createdAgoS ?? 0}))
    RETURNING id`
  created.push(it!.id as number)
  return { id: it!.id as number, upload, fetchId, user: u, batch: b }
}

const item = async (id: number) => (await ownerSql()`SELECT * FROM items WHERE id = ${id}`)[0]!
const upload = async (id: string) => (await ownerSql()`SELECT * FROM uploads WHERE id = ${id}`)[0]!

function okResult(uuid: string, o: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) {
  return {
    v: 1,
    uuid,
    status: 'ok',
    errorCode: null,
    files: { audio: `/staging/fetch/${uuid}/audio.m4a`, artwork: `/staging/fetch/${uuid}/artwork.raw` },
    meta: { title: 'SC Title', uploader: 'SC Artist', duration: 141.379, genre: 'House', description: 'x', artworkSourceHost: 'i1.sndcdn.com', license: 'cc-by', trackId: '675426677', ...meta },
    rawSha256: 'a'.repeat(64),
    audioBytes: 2855902,
    container: 'mp4',
    ffmpegFormat: 'mp4',
    artworkSha256: 'b'.repeat(64),
    canonicalUrl: 'https://soundcloud.com/e2e-user/a-track',
    warnings: [],
    ...o,
  }
}
const writeFetchOut = (uuid: string, doc: unknown) => writeFileSync(join(ctx.fetchOutDir, `${uuid}.json`), JSON.stringify(doc))

describe.skipIf(!DBENV())('SoundCloud links: web admission (v0.4.0)', () => {
  afterAll(async () => {
    await ownerSql()`UPDATE items SET status = 'rejected', fetch_stage = NULL WHERE source = 'soundcloud' AND status = 'probing' AND id = ANY(${created})`
  })

  it('refuses a bad link / a playlist / someone else’s or a submitted batch; records a probing item, an upload reservation and one job', async () => {
    const u = await mkUser()
    const v = viewer(u)
    const b = await mkBatch(u.id, { status: 'draft' })
    expect(await httpError(addSoundCloudToBatch(db(), v, b, 'http://soundcloud.com/a/b'))).toEqual({ status: 400, code: 'sc_bad_url' })
    expect(await httpError(addSoundCloudToBatch(db(), v, b, 'https://soundcloud.com.evil.example/a/b'))).toEqual({ status: 400, code: 'sc_bad_url' })
    expect(await httpError(addSoundCloudToBatch(db(), v, b, 'https://soundcloud.com/artist/sets/an-album'))).toEqual({ status: 400, code: 'sc_not_a_track' })
    expect(await httpError(addSoundCloudToBatch(db(), v, b, { url: 'x' }))).toEqual({ status: 400, code: 'sc_bad_url' })
    const other = await mkUser()
    expect(await httpError(addSoundCloudToBatch(db(), viewer(other), b, 'https://soundcloud.com/a/b'))).toEqual({ status: 404, code: 'not_found' })
    const sub = await mkBatch(u.id, { status: 'submitted' })
    expect(await httpError(addSoundCloudToBatch(db(), v, sub, 'https://soundcloud.com/a/b'))).toEqual({ status: 409, code: 'batch_not_draft' })

    const r = await addSoundCloudToBatch(db(), v, b, '  https://m.soundcloud.com/Some-Artist/Some-Track?si=abc123&utm_source=clipboard  ')
    expect(r).toMatchObject({ status: 'probing', source: 'soundcloud', url: 'https://soundcloud.com/some-artist/some-track' })
    created.push(r.id)
    const it = await item(r.id)
    expect(it).toMatchObject({ source: 'soundcloud', status: 'probing', source_url: 'https://soundcloud.com/some-artist/some-track', probe_request_id: null })
    expect(['queued', 'fetching']).toContain(it.fetch_stage) // the harness's worker may already have taken it
    expect(await upload(it.upload_id as string)).toMatchObject({ status: 'attached', length: 60 * MiB, owner_user_id: u.id })
    const jobs = await ownerSql()`SELECT kind FROM jobs WHERE dedupe_key = ${`soundcloud_fetch:item:${r.id}`}`
    expect(jobs).toEqual([{ kind: 'soundcloud_fetch' }])
    const audit = await ownerSql()`SELECT detail FROM audit_log WHERE action = 'item.add_soundcloud' AND target_id = ${String(r.id)}`
    expect(audit[0]!.detail).toMatchObject({ url: 'https://soundcloud.com/some-artist/some-track' })
  })

  it('the kill switch refuses new links', async () => {
    const u = await mkUser()
    const b = await mkBatch(u.id, { status: 'draft' })
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('soundcloud_fetch_enabled', 'false'::jsonb) ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`
    try {
      expect(await httpError(addSoundCloudToBatch(db(), viewer(u), b, 'https://soundcloud.com/a/b'))).toEqual({ status: 503, code: 'sc_disabled' })
    } finally {
      await ownerSql()`DELETE FROM settings WHERE key = 'soundcloud_fetch_enabled'`
    }
  })

  it('per member: daily cap (every link counts), in-flight cap, burst limit, staging quota', async () => {
    // daily: 20 links in the last 24 h (whatever became of them) → refused
    const u = await mkUser()
    const b = await mkBatch(u.id, { status: 'draft' })
    for (let i = 0; i < 20; i++) await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, source) VALUES (${b}, ${u.id}, 'rejected', 'soundcloud')`
    expect(await httpError(addSoundCloudToBatch(db(), viewer(u), b, 'https://soundcloud.com/a/b'))).toEqual({ status: 429, code: 'sc_daily_cap' })
    // older than 24 h no longer counts; an admin-lowered cap applies
    await ownerSql()`UPDATE items SET created_at = now() - interval '25 hours' WHERE owner_user_id = ${u.id}`
    await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, source) VALUES (${b}, ${u.id}, 'rejected', 'soundcloud')`
    expect(await httpError(addSoundCloudToBatch(db(), viewer(u), b, 'https://soundcloud.com/a/b', { caps: { ...DEFAULT_CAPS, fetchesPerUserPerDay: 1 } }))).toEqual({
      status: 429,
      code: 'sc_daily_cap',
    })

    // in flight: 3 still being fetched / converted → refused
    const w = await mkUser()
    const wb = await mkBatch(w.id, { status: 'draft' })
    for (let i = 0; i < 3; i++) {
      const [x] = await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, source, fetch_stage) VALUES (${wb}, ${w.id}, 'probing', 'soundcloud', 'queued') RETURNING id`
      created.push(x!.id as number)
    }
    expect(await httpError(addSoundCloudToBatch(db(), viewer(w), wb, 'https://soundcloud.com/a/b'))).toEqual({ status: 429, code: 'sc_busy' })

    // burst: 10 attempts a minute per member, whatever their outcome (bad
    // links and refusals count too)
    const z = await mkUser()
    const zb = await mkBatch(z.id, { status: 'submitted' })
    const t0 = Date.now() + 10 * 60_000
    for (let i = 0; i < 5; i++) expect((await httpError(addSoundCloudToBatch(db(), viewer(z), zb, 'https://soundcloud.com/a/b', { now: t0 }))).code).toBe('batch_not_draft')
    for (let i = 0; i < 5; i++) expect((await httpError(addSoundCloudToBatch(db(), viewer(z), zb, 'https://example.com/x', { now: t0 }))).code).toBe('sc_bad_url')
    const zd = await mkBatch(z.id, { status: 'draft' })
    expect(await httpError(addSoundCloudToBatch(db(), viewer(z), zd, 'https://soundcloud.com/a/b', { now: t0 + 1000 }))).toEqual({ status: 429, code: 'sc_rate_limited' })
    // a new window
    const ok = await addSoundCloudToBatch(db(), viewer(z), zd, 'https://soundcloud.com/a/b', { now: t0 + 61_000 })
    created.push(ok.id)

    // staging: the link is charged music-fetch's 60 MiB cap up front
    const s = await mkUser()
    const sb = await mkBatch(s.id, { status: 'draft' })
    expect(await httpError(addSoundCloudToBatch(db(), viewer(s), sb, 'https://soundcloud.com/a/b', { caps: { ...DEFAULT_CAPS, maxInflightBytesPerUser: 59 * MiB } }))).toEqual({
      status: 429,
      code: 'inflight_quota',
    })
  })
})

describe.skipIf(!DBENV())('SoundCloud links: worker ↔ music-fetch spool (v0.4.0)', () => {
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'scw-'))
    const d = (n: string) => {
      const p = join(base, n)
      mkdirSync(p, { recursive: true })
      return p
    }
    const alerts: string[] = []
    ctx = {
      db: db(),
      spoolOutDir: d('probe-out'),
      spoolInDir: d('probe-in'),
      fetchInDir: d('fetch-in'),
      fetchOutDir: d('fetch-out'),
      finalDir: d('final'),
      root: 'Portal-Test/',
      now: Date.now,
      alert: async (t: string) => {
        alerts.push(t)
      },
      alerts,
    } as unknown as FetchCtx & { alerts: string[] }
  })
  afterEach(async () => {
    // never leave a 'fetching' item behind: the harness worker's queue waits on it
    await ownerSql()`UPDATE items SET status = 'rejected', fetch_stage = NULL WHERE source = 'soundcloud' AND status = 'probing' AND id = ANY(${created})`
  })
  afterAll(async () => {
    await closeDb()
  })

  it('job: writes exactly the request music-fetch accepts, once; a repeated job (restart) writes nothing', async () => {
    const x = await mkScItem({ url: 'https://soundcloud.com/e2e-user/a-track' })
    await runSoundcloudFetch(ctx, { itemId: x.id })
    const file = join(ctx.fetchInDir, `${x.fetchId}.json`)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 1, uuid: x.fetchId, url: 'https://soundcloud.com/e2e-user/a-track', requestedBy: `item:${x.id}` })
    expect(await item(x.id)).toMatchObject({ fetch_stage: 'fetching' })
    expect((await item(x.id)).fetch_requested_at).not.toBeNull()
    // music-fetch claims it; the worker restarts and the job runs again: nothing new
    const { rmSync } = await import('node:fs')
    rmSync(file)
    await runSoundcloudFetch(ctx, { itemId: x.id })
    expect(existsSync(file)).toBe(false)
  })

  it('job: a result already present (restart after the write, before the UPDATE) → no second request', async () => {
    const x = await mkScItem()
    writeFetchOut(x.fetchId, okResult(x.fetchId))
    await runSoundcloudFetch(ctx, { itemId: x.id })
    expect(existsSync(join(ctx.fetchInDir, `${x.fetchId}.json`))).toBe(false)
    expect(await item(x.id)).toMatchObject({ fetch_stage: 'fetching' })
  })

  it('job: one link at a time (RetryLater while another is fetching); the kill switch rejects queued links', async () => {
    const a = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    const b = await mkScItem()
    await expect(runSoundcloudFetch(ctx, { itemId: b.id })).rejects.toBeInstanceOf(RetryLater)
    expect(existsSync(join(ctx.fetchInDir, `${b.fetchId}.json`))).toBe(false)
    await ownerSql()`UPDATE items SET status = 'rejected', fetch_stage = NULL WHERE id = ${a.id}`
    // a link that waited past FETCH_QUEUE_MAX_S is rejected instead of waiting on
    const a2 = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    const old = await mkScItem({ createdAgoS: 4 * 3600 })
    await runSoundcloudFetch(ctx, { itemId: old.id })
    expect(await item(old.id)).toMatchObject({ status: 'rejected', probe_error: 'sc_queue_timeout' })
    await ownerSql()`UPDATE items SET status = 'rejected', fetch_stage = NULL WHERE id = ${a2.id}`

    await ownerSql()`INSERT INTO settings (key, value) VALUES ('soundcloud_fetch_enabled', 'false'::jsonb) ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb`
    try {
      await runSoundcloudFetch(ctx, { itemId: b.id })
    } finally {
      await ownerSql()`DELETE FROM settings WHERE key = 'soundcloud_fetch_enabled'`
    }
    expect(await item(b.id)).toMatchObject({ status: 'rejected', probe_error: 'sc_disabled', fetch_stage: null })
    expect(await upload(b.upload)).toMatchObject({ status: 'expired' })
    expect(existsSync(join(ctx.fetchInDir, `${b.fetchId}.json`))).toBe(false)
  })

  it('result ok → strict checks → probe_fetch request (id = the fetch id), sanitized pre-fill, license, canonical URL; idempotent', async () => {
    const x = await mkScItem({ stage: 'fetching', requestedAgoS: 5, url: 'https://soundcloud.com/e2e-user/a-track' })
    writeFetchOut(
      x.fetchId,
      okResult(x.fetchId, { canonicalUrl: 'https://soundcloud.com/e2e-user/the-real-one' }, { title: 'Bad‮Title\u0007  ' + 'y'.repeat(300), uploader: 'Up​loader', genre: 'Deep\tHouse' }),
    )
    await collectFetchResults(ctx)
    const it = await item(x.id)
    expect(it).toMatchObject({ status: 'probing', fetch_stage: 'converting', probe_request_id: x.fetchId, fetch_license: 'cc-by', source_url: 'https://soundcloud.com/e2e-user/the-real-one', input_format: 'aac' })
    expect(it.title).toBe(clipTag('Bad\u202eTitle\u0007  ' + 'y'.repeat(300)))
    expect(it.title).toMatch(/^BadTitle {3}y+$/)
    expect((it.title as string).length).toBe(200)
    expect(it.artist).toBe('Uploader')
    expect(it.genre).toBe('Deep House')
    expect(it.prefill).toMatchObject({ title: it.title, artist: 'Uploader', genre: 'Deep House', album: null })
    const reqFile = join(ctx.spoolInDir, `${x.fetchId}.json`)
    expect(JSON.parse(readFileSync(reqFile, 'utf8'))).toEqual({
      v: 1,
      id: x.fetchId,
      type: 'probe_fetch',
      fetchId: x.fetchId,
      upload: x.upload,
      ext: 'm4a',
      format: 'mp4',
      sha256: 'a'.repeat(64),
      size: 2855902,
      artworkSha256: 'b'.repeat(64),
      declaredDurationS: 141.379,
    })
    // a second pass (or a restart) changes nothing
    await collectFetchResults(ctx)
    expect(readdirSync(ctx.spoolInDir).filter((n) => n.startsWith(x.fetchId))).toEqual([`${x.fetchId}.json`])
  })

  it('a restart between the probe request and the DB update rewrites the SAME request, never a second one', async () => {
    const x = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    writeFetchOut(x.fetchId, okResult(x.fetchId))
    await collectFetchResults(ctx)
    // simulate: the UPDATE never happened
    await ownerSql()`UPDATE items SET fetch_stage = 'fetching', probe_request_id = NULL WHERE id = ${x.id}`
    await collectFetchResults(ctx)
    expect(await item(x.id)).toMatchObject({ fetch_stage: 'converting', probe_request_id: x.fetchId })
    expect(readdirSync(ctx.spoolInDir).filter((n) => n.includes(x.fetchId))).toEqual([`${x.fetchId}.json`])
    // and once the probe has answered, it is not written again at all
    await ownerSql()`UPDATE items SET fetch_stage = 'fetching', probe_request_id = NULL WHERE id = ${x.id}`
    const { rmSync } = await import('node:fs')
    rmSync(join(ctx.spoolInDir, `${x.fetchId}.json`))
    writeFileSync(join(ctx.spoolOutDir, `${x.fetchId}.json`), JSON.stringify({ v: 1, id: x.fetchId, source: 'in-worker', type: 'probe_fetch', ok: false, error: 'sc_decode_failed' }))
    await collectFetchResults(ctx)
    expect(existsSync(join(ctx.spoolInDir, `${x.fetchId}.json`))).toBe(false)
  })

  it('music-fetch error codes reject the item as sc_<code> and release the staging charge', async () => {
    for (const code of ['not_a_track', 'extractor_failed', 'too_long', 'timeout', 'too_large', 'interrupted']) {
      const x = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
      writeFetchOut(x.fetchId, { v: 1, uuid: x.fetchId, status: 'error', errorCode: code, files: null, meta: null, rawSha256: null })
      await collectFetchResults(ctx)
      expect(await item(x.id)).toMatchObject({ status: 'rejected', probe_error: `sc_${code}`, fetch_stage: null })
      expect(await upload(x.upload)).toMatchObject({ status: 'expired' })
    }
  })

  it('an ok result that is not what the portal accepts is rejected, and music-fetch is asked to drop the download', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{ files: { audio: `/staging/fetch/${randomUUID()}/audio.m4a` } }, {}, 'sc_bad_result'], // another job's file
      [{ files: { audio: '/etc/passwd' } }, {}, 'sc_bad_result'],
      [{ files: { audio: 'PLACEHOLDER/audio.wav' }, container: 'wav', ffmpegFormat: 'wav' }, {}, 'sc_bad_result'],
      [{ files: { audio: 'PLACEHOLDER/audio.ogg' }, container: 'ogg', ffmpegFormat: 'ogg' }, {}, 'sc_codec_unsupported'], // Vorbis
      [{ container: 'mp3' }, {}, 'sc_codec_unsupported'], // container / extension disagree
      [{ canonicalUrl: 'https://evil.example/a/b' }, {}, 'sc_bad_result'],
      [{ canonicalUrl: 'javascript:alert(1)' }, {}, 'sc_bad_result'],
      [{}, { duration: 1500 }, 'sc_too_long'],
      [{ extra: 1 }, {}, 'sc_bad_result'], // strict schema
      [{}, { title: 5 }, 'sc_bad_result'],
    ]
    for (const [o, meta, code] of cases) {
      const x = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
      const doc = JSON.parse(JSON.stringify(okResult(x.fetchId, o, meta)).replaceAll('PLACEHOLDER', `/staging/fetch/${x.fetchId}`))
      writeFetchOut(x.fetchId, doc)
      await collectFetchResults(ctx)
      expect(await item(x.id), JSON.stringify(o)).toMatchObject({ status: 'rejected', probe_error: code })
      expect(existsSync(join(ctx.fetchInDir, `${x.fetchId}.release`))).toBe(true)
      expect(existsSync(join(ctx.spoolInDir, `${x.fetchId}.json`))).toBe(false)
    }
    // a result that is a symlink is not followed
    const s = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    const decoy = join(base, 'decoy.json')
    writeFileSync(decoy, JSON.stringify(okResult(s.fetchId)))
    symlinkSync(decoy, join(ctx.fetchOutDir, `${s.fetchId}.json`))
    await collectFetchResults(ctx)
    expect(await item(s.id)).toMatchObject({ status: 'rejected', probe_error: 'sc_bad_result' })
    // artwork outside the job's own path is ignored (the song is kept)
    const a = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    writeFetchOut(a.fetchId, okResult(a.fetchId, { files: { audio: `/staging/fetch/${a.fetchId}/audio.m4a`, artwork: '/staging/art-in/x' } }))
    await collectFetchResults(ctx)
    expect(JSON.parse(readFileSync(join(ctx.spoolInDir, `${a.fetchId}.json`), 'utf8'))).toMatchObject({ artworkSha256: null })
  })

  it('no answer within FETCH_RESULT_TIMEOUT_S → sc_fetch_unanswered (alerted); a fresh request keeps waiting', async () => {
    const fresh = await mkScItem({ stage: 'fetching', requestedAgoS: 60 })
    const late = await mkScItem({ stage: 'fetching', requestedAgoS: 16 * 60 })
    await collectFetchResults(ctx)
    expect(await item(fresh.id)).toMatchObject({ status: 'probing', fetch_stage: 'fetching' })
    expect(await item(late.id)).toMatchObject({ status: 'rejected', probe_error: 'sc_fetch_unanswered' })
    expect(await upload(late.upload)).toMatchObject({ status: 'expired' })
    expect(existsSync(join(ctx.fetchInDir, `${late.fetchId}.release`))).toBe(true)
  })

  it('probe result: probe_fetch ok → pending with music-fetch’s tags, the MP3’s size charged, raw released; anything else rejected', async () => {
    const x = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    writeFetchOut(x.fetchId, okResult(x.fetchId))
    await collectFetchResults(ctx)
    const cover = `cover-${x.fetchId}.jpg`
    writeFileSync(
      join(ctx.spoolOutDir, `${x.fetchId}.json`),
      JSON.stringify({ v: 1, id: x.fetchId, source: 'in-worker', type: 'probe_fetch', ok: true, sha256: 'c'.repeat(64), size: 5_000_000, durationS: 141.4, bitrate: 320000, cover: { file: cover, sha256: 'd'.repeat(64), width: 500, height: 500 }, flags: ['converted_from_aac'], inputFormat: 'aac', transcodeKbps: 320 }),
    )
    await collectProbeResults(ctx)
    expect(await item(x.id)).toMatchObject({ status: 'pending', fetch_stage: null, probe_sha256: 'c'.repeat(64), title: 'SC Title', artist: 'SC Artist', genre: 'House', input_format: 'aac', transcode_kbps: 320, cover_file: cover, duration_s: 141 })
    expect(await upload(x.upload)).toMatchObject({ status: 'attached', length: 5_000_000 })
    expect(existsSync(join(ctx.fetchInDir, `${x.fetchId}.release`))).toBe(true)

    // a web-inbox 'probe' result can never complete a SoundCloud item
    const y = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    writeFetchOut(y.fetchId, okResult(y.fetchId))
    await collectFetchResults(ctx)
    writeFileSync(
      join(ctx.spoolOutDir, `${y.fetchId}.json`),
      JSON.stringify({ v: 1, id: y.fetchId, source: 'in-web', type: 'probe', ok: true, sha256: 'c'.repeat(64), size: 1, durationS: 40, bitrate: 320000, tags: { title: 'x', artist: 'y', album: null, genre: null }, cover: null, flags: [] }),
    )
    await collectProbeResults(ctx)
    expect(await item(y.id)).toMatchObject({ status: 'rejected', probe_error: 'wrong_result_source' })
    expect(await upload(y.upload)).toMatchObject({ status: 'expired' })

    // a failed conversion
    const z = await mkScItem({ stage: 'fetching', requestedAgoS: 5 })
    writeFetchOut(z.fetchId, okResult(z.fetchId))
    await collectFetchResults(ctx)
    writeFileSync(join(ctx.spoolOutDir, `${z.fetchId}.json`), JSON.stringify({ v: 1, id: z.fetchId, source: 'in-worker', type: 'probe_fetch', ok: false, error: 'sc_codec_unsupported' }))
    await collectProbeResults(ctx)
    expect(await item(z.id)).toMatchObject({ status: 'rejected', probe_error: 'sc_codec_unsupported' })
    expect(await upload(z.upload)).toMatchObject({ status: 'expired' })
    expect(existsSync(join(ctx.fetchInDir, `${z.fetchId}.release`))).toBe(true)
  })
  it('lost release markers are re-issued for recent items that left probing (m2), never for one still probing', async () => {
    // a worker restart between the item's final transition and the marker
    const done = await mkScItem({ status: 'pending', stage: 'converting' })
    const gaveUp = await mkScItem({ status: 'rejected', stage: 'fetching' })
    const busy = await mkScItem({ stage: 'converting', requestedAgoS: 5 })
    const old = await mkScItem({ status: 'rejected', createdAgoS: FETCH_RELEASE_WINDOW_S + 3600 })
    await ownerSql()`UPDATE items SET fetch_stage = NULL WHERE id = ANY(${[done.id, gaveUp.id, old.id]})`
    const marker = (id: string) => existsSync(join(ctx.fetchInDir, `${id}.release`))
    for (const x of [done, gaveUp, busy, old]) expect(marker(x.fetchId)).toBe(false)
    expect(await reissueFetchReleases(ctx, 100_000)).toBeGreaterThanOrEqual(2)
    expect(marker(done.fetchId)).toBe(true)
    expect(marker(gaveUp.fetchId)).toBe(true)
    expect(marker(busy.fetchId)).toBe(false) // the probe may still need its raw download
    expect(marker(old.fetchId)).toBe(false) // music-fetch's own 24 h sweep has it
    // idempotent: the same marker again, never an error
    expect(await reissueFetchReleases(ctx, 100_000)).toBeGreaterThanOrEqual(2)
    expect(readdirSync(ctx.fetchInDir).filter((n) => n.startsWith(done.fetchId))).toEqual([`${done.fetchId}.release`])
  })
})
