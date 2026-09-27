// P4 worker jobs against the P0d/P0d-B AzuraCast mock and the real music-db
// (plan §6 P4). Handlers run in-process with an injected clock; follow-up
// jobs are captured instead of queued, so the running music-worker never
// races these tests.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AzuraCastClient, type StationMedia } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { closeDb, getDb } from '@/server/db/client'
import { QueuesPausedError } from '@/server/pause'
import { TicketsClient } from '@/server/tickets/client'
import { RetryLater } from '@/worker/handlers'
import { runJob } from '@/worker/main'
import {
  applyArt,
  applyEdit,
  archiveMedia,
  move,
  requestFailureText,
  restoreMedia,
  reverify,
  runRequestJob,
  setPlaylistsJob,
  sweepParkedRequests,
  type RequestsCtx,
} from '@/worker/requests/jobs'
import { OpFailed } from '@/worker/requests/media'
import { DBENV, MOCKS } from './helpers/env'
import { insertArt, ownerSql } from './helpers/db'
import { control } from './helpers/http'

const ORIGIN = 'https://music.euphoric.fm'
const PREFIX = 'Portal-Test/'
const ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: PREFIX }
const RUN = Date.now().toString(36)
const IN_WINDOW = Date.UTC(2026, 8, 27, 12, 2, 0) // :x2:00, phase 60 s
const EARLY = Date.UTC(2026, 8, 27, 12, 1, 5) // :x1:05, scan just started
const LATE = Date.UTC(2026, 8, 27, 12, 5, 45) // :x5:45, next scan in 15 s

type Scheduled = { kind: string; payload: Record<string, unknown>; opts: { dedupeKey?: string; runAfter?: Date } }

const ready = () => DBENV() && MOCKS()

describe.skipIf(!ready())('P4 worker jobs (mock AzuraCast, Portal-Test/ root)', () => {
  let ctx: RequestsCtx
  let scheduled: Scheduled[]
  let alerts: string[]
  let ticketCalls: string[]
  let ownerId: string
  let clock = IN_WINDOW
  // The probe's art dir as the wrapper sees it (uploadArt reads only
  // <artDir>/<uuid>/cover.jpg); insertArt writes real JPEG bytes there.
  const artDir = join(mkdtempSync(join(tmpdir(), 'p4-art-')), 'art')

  const art = (folder: string) => `${PREFIX}Music/Artists/${folder}`

  async function seed(path: string, f: Partial<{ title: string; artist: string; album: string; genre: string; playlists: number[] }> = {}): Promise<StationMedia> {
    await control('/__mock/az/seed', { files: [{ path, title: 'T', artist: 'A', album: 'Al', genre: 'G', playlists: [], ...f }] })
    return file(path)
  }
  async function file(path: string): Promise<StationMedia> {
    const all = (await control('/__mock/az/files')) as StationMedia[]
    const f = all.find((x) => x.path === path)
    if (!f) throw new Error(`mock has no ${path}`)
    return f
  }
  async function fileById(id: number): Promise<StationMedia | undefined> {
    return ((await control('/__mock/az/files')) as StationMedia[]).find((x) => x.id === id)
  }
  const ids = (m: StationMedia | undefined) => (m?.playlists ?? []).map((p) => p.id).sort((a, b) => a - b)
  async function artist(name: string, folder: string, status = 'active') {
    const [r] = await ownerSql()`INSERT INTO artists (name, folder, status) VALUES (${name}, ${folder}, ${status}::artist_status) RETURNING id`
    return r!.id as number
  }
  async function request(kind: 'edit' | 'removal', m: StationMedia, proposed: Record<string, string> | null, status = 'approved') {
    const snapshot = { path: m.path, title: m.title ?? '', artist: m.artist ?? '', album: m.album ?? '', genre: m.genre ?? '', playlistIds: ids(m) }
    const [r] = await ownerSql()`
      INSERT INTO requests (owner_user_id, kind, media_id, target_path, proposed, snapshot, status, reason)
      VALUES (${ownerId}, ${kind}::request_kind, ${m.id}, ${m.path}, ${proposed ? ownerSql().json(proposed) : null}, ${ownerSql().json(snapshot)}, ${status}::request_status, 'test')
      RETURNING id`
    return r!.id as number
  }
  const reqRow = async (id: number) => (await ownerSql()`SELECT * FROM requests WHERE id = ${id}`)[0]!
  const azCalls = async () => (await control('/__mock/az/calls')) as { method: string; path: string; body?: Record<string, unknown> }[]
  const writes = async () => (await azCalls()).filter((c) => c.method !== 'GET').length
  const take = (kind: string) => {
    const i = scheduled.findIndex((s) => s.kind === kind)
    if (i < 0) throw new Error(`nothing scheduled of kind ${kind}: ${scheduled.map((s) => s.kind).join(',')}`)
    return scheduled.splice(i, 1)[0]!
  }

  // A context whose AzuraCast transport goes through `f` (which forwards to
  // the mock with the real fetch): lost replies, network errors, a server
  // that answers without doing the work.
  function ctxWith(f: (url: string, init: RequestInit) => Promise<Response>): RequestsCtx {
    const az = new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(ENV), canaryStationId: 7, env: ENV, artDir, fetchImpl: f as unknown as typeof fetch })
    return { ...ctx, azuracast: az }
  }
  const batchOf = (url: string, init: RequestInit): string | null =>
    init.method === 'PUT' && url.endsWith('/api/station/1/files/batch') ? ((JSON.parse(String(init.body)) as { do?: string }).do ?? null) : null
  const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  const archiveRow = async (mediaId: number) => (await ownerSql()`SELECT * FROM archive WHERE media_id = ${mediaId} ORDER BY id DESC LIMIT 1`)[0]

  beforeAll(async () => {
    const recFetch = (async (url: string, init: RequestInit) => {
      ticketCalls.push(`${init.method} ${url}`)
      return new Response(JSON.stringify({ messageId: 'm', discordMessageId: '1', created: true }), { status: 201 })
    }) as unknown as typeof fetch
    ctx = {
      db: getDb(process.env.TEST_APP_DATABASE_URL, 2),
      azuracast: new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(ENV), canaryStationId: 7, env: ENV, artDir }),
      tickets: new TicketsClient({ baseUrl: 'http://tickets.invalid', key: 'k', portalOrigin: ORIGIN, fetchImpl: recFetch }),
      portalOrigin: ORIGIN,
      spoolOutDir: '/nonexistent',
      alert: async (title) => {
        alerts.push(title)
      },
      root: PREFIX,
      now: () => clock,
      schedule: async (kind, payload, opts = {}) => {
        scheduled.push({ kind, payload, opts })
      },
    }
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('station_playlist_ids', '[2,3,5]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${'5' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    ownerId = u!.id as string
  })
  beforeEach(() => {
    scheduled = []
    alerts = []
    ticketCalls = []
    clock = IN_WINDOW
  })
  afterAll(async () => {
    await ownerSql()`UPDATE settings SET value = '[2]'::jsonb WHERE key = 'assignable_playlist_ids'`
    await control('/__mock/az/nowplaying', {})
    await closeDb()
  })

  it('edits on a TXXX-mp3-like and an m4a-like row keep the DB values and playlists across scans', async () => {
    const folder = `GRIM-${RUN}`
    await artist(`Grim ${RUN}`, folder)
    const mp3 = await seed(`${art(folder)}/luvusm.mp3`, { title: 'Luv U SM', artist: `Grim ${RUN}`, album: 'Identity Shift', genre: 'Dance', playlists: [2, 74] })
    const m4a = await seed(`${art(folder)}/kokoro_-_kokoro_-_touch.m4a`, { title: 'Touch', artist: `Grim ${RUN}`, album: 'KOKORO', playlists: [3] })
    for (const m of [mp3, m4a]) {
      const id = await request('edit', m, { title: `PT Edited ${m.id}`, album: 'PT Edited Album', genre: 'PT Edited Genre' })
      await applyEdit(ctx, { requestId: id })
      const put = (await azCalls()).filter((c) => c.method === 'PUT' && c.path === `/api/station/1/file/${m.id}`).at(-1)!
      expect(Object.keys(put.body!).sort()).toEqual(['album', 'artist', 'genre', 'title']) // strict body, no path/playlists
      expect(await reqRow(id)).toMatchObject({ status: 'verifying', error: null })
      expect(scheduled.map((s) => s.kind).sort()).toEqual(['request_ticket_post', 'reverify'])
      expect(take('request_ticket_post').payload).toMatchObject({ requestId: id, event: 'applied' })
      const rv = take('reverify')
      expect(rv.opts.runAfter!.getTime()).toBe(Date.UTC(2026, 8, 27, 12, 11, 30)) // after the next two scans
      // the mock (like AzuraCast) reported success; the DB is the truth
      await reverify(ctx, rv.payload as never)
      await reverify(ctx, rv.payload as never)
      const after = await fileById(m.id)
      expect(after).toMatchObject({ title: `PT Edited ${m.id}`, album: 'PT Edited Album', genre: 'PT Edited Genre', path: m.path })
      expect(ids(after)).toEqual(ids(m))
      expect(await reqRow(id)).toMatchObject({ status: 'done' })
      const lib = (await ownerSql()`SELECT title, path FROM library_cache WHERE media_id = ${m.id}`)[0]
      expect(lib).toMatchObject({ title: `PT Edited ${m.id}`, path: m.path })
    }
  })

  it('an artist change moves the file into the active artist folder and keeps its playlists', async () => {
    const from = `MOVEFROM-${RUN}`
    const to = `MOVETO-${RUN}`
    await artist(`Move From ${RUN}`, from)
    await artist(`Move To ${RUN}`, to)
    const m = await seed(`${art(from)}/song.mp3`, { title: 'Song', artist: `Move From ${RUN}`, playlists: [2, 3, 74] })
    const id = await request('edit', m, { artist: `move to ${RUN} feat. Guest` })
    await applyEdit(ctx, { requestId: id })
    expect(await reqRow(id)).toMatchObject({ status: 'applying' })
    const mv = take('move')
    expect(mv.payload).toMatchObject({ mediaId: m.id, toDir: art(to), requestId: id })
    expect((await fileById(m.id))!.artist).toBe(`move to ${RUN} feat. Guest`)
    await move(ctx, mv.payload as never)
    const after = await fileById(m.id)
    expect(after!.path).toBe(`${art(to)}/song.mp3`)
    expect(after!.id).toBe(m.id)
    expect(ids(after)).toEqual([2, 3, 74])
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
    const batch = (await azCalls()).filter((c) => c.path === '/api/station/1/files/batch').at(-1)!
    expect(batch.body).toMatchObject({ do: 'move', files: [m.path], dirs: [], directory: art(to) })
    await reverify(ctx, take('reverify').payload as never)
    expect(await reqRow(id)).toMatchObject({ status: 'done' })
    const snaps = await ownerSql()`SELECT reason, path, playlist_ids FROM media_snapshots WHERE media_id = ${m.id} ORDER BY id`
    expect(snaps.map((s) => s.reason)).toEqual(['before_edit', 'before_move', 'after_move'])
    expect(snaps[1]!.playlist_ids).toEqual([2, 3]) // station ids only (74 is the Events station's)
  })

  it('a featured-artist-only change neither moves the file nor creates an artist', async () => {
    const folder = `FEAT-${RUN}`
    await artist(`Feat ${RUN}`, folder)
    const m = await seed(`${art(folder)}/f.mp3`, { artist: `Feat ${RUN}` })
    const id = await request('edit', m, { artist: `Feat ${RUN} ft. Someone` })
    await applyEdit(ctx, { requestId: id })
    expect(scheduled.some((s) => s.kind === 'move')).toBe(false)
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
  })

  it('an unknown main artist creates a pending new-artist approval, writes nothing, and a denial fails the request', async () => {
    const folder = `KNOWN-${RUN}`
    await artist(`Known ${RUN}`, folder)
    const m = await seed(`${art(folder)}/x.mp3`, { artist: `Known ${RUN}` })
    const id = await request('edit', m, { artist: `Brand New ${RUN}`, title: 'Renamed' })
    const before = await writes()
    await applyEdit(ctx, { requestId: id })
    expect(await writes()).toBe(before)
    const a = (await ownerSql()`SELECT id, name, folder, status FROM artists WHERE name = ${`Brand New ${RUN}`}`)[0]!
    expect(a).toMatchObject({ status: 'pending', folder: `Brand New ${RUN}` })
    expect(await reqRow(id)).toMatchObject({ status: 'approved', pending_artist_id: a.id })
    expect(scheduled).toHaveLength(0)
    // re-running while the artist is pending stays parked
    await applyEdit(ctx, { requestId: id })
    expect(await writes()).toBe(before)
    await ownerSql()`UPDATE artists SET status = 'denied' WHERE id = ${a.id}`
    await sweepParkedRequests(ctx)
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'artist_denied' })
  })

  it('lost-row recovery: metadata first, then playlists, then every id is remapped', async () => {
    const folder = `LOST-${RUN}`
    await artist(`Lost ${RUN}`, folder)
    const m = await seed(`${art(folder)}/lost.mp3`, { title: 'Before', artist: `Lost ${RUN}`, playlists: [2, 3] })
    const id = await request('edit', m, { title: 'After Edit' })
    await applyEdit(ctx, { requestId: id })
    const rv = take('reverify')
    // A manager job queued for the old id (REMAP-1): it must follow the row.
    const [queued] = await ownerSql()`INSERT INTO jobs (kind, payload, status, run_after) VALUES ('set_playlists', ${ownerSql().json({ mediaId: m.id, chosen: [2] })}, 'queued', now() + interval '30 days') RETURNING id`
    const fresh = (await control('/__mock/az/lose-row', { path: m.path })) as StationMedia
    expect(fresh.id).not.toBe(m.id)
    expect(fresh.title).toBe('Scanned Title')
    await reverify(ctx, rv.payload as never)
    const now = await fileById(fresh.id)
    expect(now).toMatchObject({ path: m.path, title: 'After Edit', artist: `Lost ${RUN}` })
    expect(ids(now)).toEqual([2, 3])
    const calls = (await azCalls()).filter((c) => c.method === 'PUT' && (c.path === `/api/station/1/file/${fresh.id}` || c.path.endsWith('/files/batch')))
    const iMeta = calls.findIndex((c) => c.path.endsWith(`/file/${fresh.id}`))
    const iPl = calls.findIndex((c, i) => i > iMeta && c.body?.do === 'playlist')
    expect(iMeta).toBeGreaterThanOrEqual(0)
    expect(iPl).toBeGreaterThan(iMeta) // metadata before playlists
    expect(await reqRow(id)).toMatchObject({ status: 'done', media_id: fresh.id })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM media_snapshots WHERE media_id = ${m.id}`)[0]!.n).toBe(0)
    expect((await ownerSql()`SELECT media_id FROM library_cache WHERE path = ${m.path}`)[0]!.media_id).toBe(fresh.id)
    expect(alerts.some((a) => a.includes('recovered'))).toBe(true)
    expect((await ownerSql()`SELECT payload FROM jobs WHERE id = ${queued!.id}`)[0]!.payload).toEqual({ mediaId: fresh.id, chosen: [2] })
    await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${queued!.id}`
  })

  it('a row that stays lost is re-polled, then fails after 3 cycles and 20 minutes', async () => {
    const path = `${art(`GONE-${RUN}`)}/gone.mp3`
    const [s] = await ownerSql()`INSERT INTO media_snapshots (media_id, path, title, artist, album, genre, playlist_ids, reason) VALUES (999999, ${path}, 't', 'a', '', '', '{2}', 'test') RETURNING id`
    await reverify(ctx, { mediaId: 999999, snapshotId: s!.id as number, attempt: 0 })
    const again = take('reverify')
    expect(again.payload).toMatchObject({ attempt: 1, lostSince: IN_WINDOW })
    await expect(reverify(ctx, { mediaId: 999999, snapshotId: s!.id as number, attempt: 2, lostSince: IN_WINDOW - 21 * 60_000 })).rejects.toMatchObject({ code: 'recovery_failed' })
    expect(alerts.some((a) => a.includes('recovery failed'))).toBe(true)
  })

  it('archive then restore gives back the exact path, metadata and playlists', async () => {
    const folder = `ARCH-${RUN}`
    await artist(`Arch ${RUN}`, folder)
    const m = await seed(`${art(folder)}/keep me.mp3`, { title: 'Keep', artist: `Arch ${RUN}`, playlists: [2, 3] })
    const id = await request('removal', m, null)
    await archiveMedia(ctx, { requestId: id })
    const archived = await fileById(m.id)
    expect(archived!.path).toBe(`${PREFIX}Removed/${m.id}/keep me.mp3`)
    expect(ids(archived)).toEqual([])
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
    const a = (await ownerSql()`SELECT * FROM archive WHERE media_id = ${m.id}`)[0]!
    expect(a).toMatchObject({ original_path: m.path, archived_path: archived!.path, status: 'archived', request_id: id })
    // no longer on the request surface
    expect((await ownerSql()`SELECT path FROM library_cache WHERE media_id = ${m.id}`)[0]!.path).toBe(archived!.path)
    await reverify(ctx, take('reverify').payload as never)
    expect(await reqRow(id)).toMatchObject({ status: 'done' })

    await restoreMedia(ctx, { archiveId: a.id as number })
    const back = await fileById(m.id)
    expect(back).toMatchObject({ path: m.path, title: 'Keep', artist: `Arch ${RUN}` })
    expect(ids(back)).toEqual([2, 3])
    expect((await ownerSql()`SELECT status FROM archive WHERE id = ${a.id}`)[0]!.status).toBe('restored')
  })

  it('two archives with the same file name both survive (per-id folders)', async () => {
    const f1 = `DUP1-${RUN}`
    const f2 = `DUP2-${RUN}`
    await artist(`Dup One ${RUN}`, f1)
    await artist(`Dup Two ${RUN}`, f2)
    const a = await seed(`${art(f1)}/same.mp3`, { playlists: [2] })
    const b = await seed(`${art(f2)}/same.mp3`, { playlists: [3] })
    await archiveMedia(ctx, { mediaId: a.id })
    await archiveMedia(ctx, { mediaId: b.id })
    expect((await fileById(a.id))!.path).toBe(`${PREFIX}Removed/${a.id}/same.mp3`)
    expect((await fileById(b.id))!.path).toBe(`${PREFIX}Removed/${b.id}/same.mp3`)
  })

  it('archive: a failed move re-applies the snapshot playlists and fails the request', async () => {
    const folder = `AFAIL-${RUN}`
    await artist(`AFail ${RUN}`, folder)
    const m = await seed(`${art(folder)}/stay.mp3`, { playlists: [2, 3] })
    const id = await request('removal', m, null)
    await control('/__mock/az/fail-next-move', { error: 'Filesystem error.' })
    await runRequestJob(ctx, { id: 1, kind: 'archive', payload: { requestId: id }, attempts: 1, max_attempts: 8 })
    const after = await fileById(m.id)
    expect(after!.path).toBe(m.path)
    expect(ids(after)).toEqual([2, 3])
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'archive_move_failed' })
    expect(take('request_ticket_post').payload).toMatchObject({ requestId: id, event: 'failed' })
    // The row recorded before the first write is closed: nothing is open.
    expect((await ownerSql()`SELECT status FROM archive WHERE media_id = ${m.id}`).map((r) => r.status)).toEqual(['failed'])
  })

  it('archive refuses BEFORE any change when the song is also in an Events playlist, and the ticket names the playlists', async () => {
    const folder = `EVT-${RUN}`
    await artist(`Evt ${RUN}`, folder)
    const m = await seed(`${art(folder)}/ev.mp3`, { playlists: [2, 74, 78] })
    const id = await request('removal', m, null)
    const before = await writes()
    await runRequestJob(ctx, { id: 1, kind: 'archive', payload: { requestId: id }, attempts: 1, max_attempts: 8 })
    expect(await writes()).toBe(before) // nothing cleared, nothing moved, nothing re-added
    const after = await fileById(m.id)
    expect(after!.path).toBe(m.path)
    expect(ids(after)).toEqual([2, 74, 78])
    const r = await reqRow(id)
    expect(r).toMatchObject({ status: 'failed', error: 'in_events_playlists: 74, 78' })
    expect(await archiveRow(m.id)).toBeUndefined()
    expect(take('request_ticket_post').payload).toMatchObject({ requestId: id, event: 'failed' })
    expect(requestFailureText({ error: r.error as string }, 'Removal', 'A - T')).toMatch(/Events playlist\(s\) 74, 78 \(station 14\).*take it out of those playlists/)
    expect(alerts).toContain('archive failed (in_events_playlists)')
    // A manager's direct archive is refused the same way.
    await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toMatchObject({ code: 'in_events_playlists', detail: { playlistIds: [74, 78] } })
  })

  it('archive resumes after a failure between the clear and the move with the ORIGINAL snapshot, so restore brings the playlists back', async () => {
    const folder = `ARC1-${RUN}`
    await artist(`Arc One ${RUN}`, folder)
    const m = await seed(`${art(folder)}/resume.mp3`, { playlists: [2, 3] })
    const id = await request('removal', m, null)
    let cleared = false
    let failed = false
    const flaky = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'playlist') {
        const r = await fetch(url, init)
        cleared = true
        return r
      }
      if (cleared && !failed && init.method === 'GET' && url.endsWith(`/api/station/1/file/${m.id}`)) {
        failed = true
        throw new TypeError('fetch failed')
      }
      return fetch(url, init)
    })
    await expect(archiveMedia(flaky, { requestId: id })).rejects.toBeInstanceOf(TypeError)
    expect(await fileById(m.id)).toMatchObject({ path: m.path, playlists: [] }) // cleared, not moved
    expect(await archiveRow(m.id)).toMatchObject({ status: 'archiving', original_path: m.path })
    // The retry must not snapshot the cleared state.
    await archiveMedia(ctx, { requestId: id })
    expect((await fileById(m.id))!.path).toBe(`${PREFIX}Removed/${m.id}/resume.mp3`)
    const a = (await archiveRow(m.id))!
    expect(a.status).toBe('archived')
    expect((await ownerSql()`SELECT playlist_ids FROM media_snapshots WHERE id = ${a.snapshot_id}`)[0]!.playlist_ids).toEqual([2, 3])
    expect((await ownerSql()`SELECT count(*)::int AS n FROM media_snapshots WHERE media_id = ${m.id} AND reason = 'before_archive'`)[0]!.n).toBe(1)
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
    await restoreMedia(ctx, { archiveId: a.id as number })
    expect(await fileById(m.id)).toMatchObject({ path: m.path })
    expect(ids(await fileById(m.id))).toEqual([2, 3])
  })

  it('archive: a move whose reply is lost finishes (the file is where it is), and a half-done archive completes on re-run', async () => {
    const folder = `ARC2-${RUN}`
    await artist(`Arc Two ${RUN}`, folder)
    // (a) AzuraCast moved the file, the reply timed out.
    const m1 = await seed(`${art(folder)}/lost reply.mp3`, { playlists: [2] })
    const r1 = await request('removal', m1, null)
    const lost = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'move') {
        await fetch(url, init)
        throw timeout()
      }
      return fetch(url, init)
    })
    await archiveMedia(lost, { requestId: r1 })
    expect((await fileById(m1.id))!.path).toBe(`${PREFIX}Removed/${m1.id}/lost reply.mp3`)
    expect(await archiveRow(m1.id)).toMatchObject({ status: 'archived', archived_path: `${PREFIX}Removed/${m1.id}/lost reply.mp3` })
    expect(await reqRow(r1)).toMatchObject({ status: 'verifying' })
    expect(alerts.filter((a) => a.includes('rollback'))).toEqual([])
    await restoreMedia(ctx, { archiveId: (await archiveRow(m1.id))!.id as number })
    expect(await fileById(m1.id)).toMatchObject({ path: m1.path })
    expect(ids(await fileById(m1.id))).toEqual([2])
    // (b) moved, then the worker lost the next read too (as good as a crash).
    const m2 = await seed(`${art(folder)}/crash.mp3`, { playlists: [3] })
    const r2 = await request('removal', m2, null)
    let moved = false
    let readFailed = false
    const crash = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'move') {
        await fetch(url, init)
        moved = true
        throw timeout()
      }
      if (moved && !readFailed && init.method === 'GET' && url.endsWith(`/api/station/1/file/${m2.id}`)) {
        readFailed = true
        throw new TypeError('fetch failed')
      }
      return fetch(url, init)
    })
    await expect(archiveMedia(crash, { requestId: r2 })).rejects.toBeInstanceOf(TypeError)
    expect((await fileById(m2.id))!.path).toBe(`${PREFIX}Removed/${m2.id}/crash.mp3`)
    expect(await archiveRow(m2.id)).toMatchObject({ status: 'archiving' })
    await archiveMedia(ctx, { requestId: r2 })
    expect(await archiveRow(m2.id)).toMatchObject({ status: 'archived' })
    expect(await reqRow(r2)).toMatchObject({ status: 'verifying' })
    const a2 = (await archiveRow(m2.id))!
    expect((await ownerSql()`SELECT playlist_ids FROM media_snapshots WHERE id = ${a2.snapshot_id}`)[0]!.playlist_ids).toEqual([3])
  })

  it('restore resumes after a failure following the move: the retry completes with the snapshot playlists', async () => {
    const folder = `RES1-${RUN}`
    await artist(`Res One ${RUN}`, folder)
    const m = await seed(`${art(folder)}/back.mp3`, { title: 'Back', artist: `Res One ${RUN}`, playlists: [2, 3] })
    await archiveMedia(ctx, { mediaId: m.id })
    const a = (await archiveRow(m.id))!
    let failed = false
    const flaky = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'playlist' && !failed) {
        failed = true
        throw new TypeError('fetch failed')
      }
      return fetch(url, init)
    })
    await expect(restoreMedia(flaky, { archiveId: a.id as number })).rejects.toBeInstanceOf(TypeError)
    expect(await fileById(m.id)).toMatchObject({ path: m.path, playlists: [] }) // moved back, memberships not yet
    expect((await archiveRow(m.id))!.status).toBe('restoring')
    await restoreMedia(ctx, { archiveId: a.id as number })
    expect(await fileById(m.id)).toMatchObject({ path: m.path, title: 'Back' })
    expect(ids(await fileById(m.id))).toEqual([2, 3])
    expect((await archiveRow(m.id))!.status).toBe('restored')
  })

  it('re-verify never reverts a later change: set_playlists after an edit keeps its new id; overlapping edits do not ping-pong', async () => {
    await ownerSql()`UPDATE settings SET value = '[2,5,9]'::jsonb WHERE key = 'assignable_playlist_ids'`
    await ownerSql()`UPDATE settings SET value = '[2,3,5,9]'::jsonb WHERE key = 'station_playlist_ids'`
    try {
      const folder = `VER1-${RUN}`
      await artist(`Ver One ${RUN}`, folder)
      const m = await seed(`${art(folder)}/v.mp3`, { title: 'Orig', artist: `Ver One ${RUN}`, playlists: [2] })
      const e0 = await request('edit', m, { title: 'Edited' })
      await applyEdit(ctx, { requestId: e0 })
      const rv0 = take('reverify')
      take('request_ticket_post')
      // a manager adds playlist 9 before the edit's re-verify runs
      await setPlaylistsJob(ctx, { mediaId: m.id, chosen: [2, 9] })
      const rvPl = take('reverify') // set_playlists has its own chain
      let before = await writes()
      await reverify(ctx, rv0.payload as never)
      expect(await writes()).toBe(before) // superseded: nothing re-applied
      expect(ids(await fileById(m.id))).toEqual([2, 9])
      expect(await reqRow(e0)).toMatchObject({ status: 'done' })
      await reverify(ctx, rvPl.payload as never)
      expect(ids(await fileById(m.id))).toEqual([2, 9])
      // two edits whose re-verify chains overlap
      const e1 = await request('edit', (await fileById(m.id)) as StationMedia, { title: 'First' })
      await applyEdit(ctx, { requestId: e1 })
      const rv1 = take('reverify')
      const e2 = await request('edit', (await fileById(m.id)) as StationMedia, { title: 'Second' })
      await applyEdit(ctx, { requestId: e2 })
      const rv2 = take('reverify')
      before = await writes()
      await reverify(ctx, rv1.payload as never)
      await reverify(ctx, rv2.payload as never)
      expect(await writes()).toBe(before)
      expect((await fileById(m.id))!.title).toBe('Second')
      expect(await reqRow(e1)).toMatchObject({ status: 'done' })
      expect(await reqRow(e2)).toMatchObject({ status: 'done' })
      // a real loss on the latest chain is still repaired, by MERGE: the lost
      // id comes back, a membership added since (3) stays
      const e3 = await request('edit', (await fileById(m.id)) as StationMedia, { genre: 'Third' })
      await applyEdit(ctx, { requestId: e3 })
      const rv3 = take('reverify')
      await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/batch`, {
        method: 'PUT',
        headers: { 'X-API-Key': process.env.AZURACAST_API_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({ do: 'playlist', files: [m.path], playlists: [3, 9] }),
      })
      await reverify(ctx, rv3.payload as never)
      expect(ids(await fileById(m.id))).toEqual([2, 3, 9])
      const batch = (await azCalls()).filter((c) => c.path.endsWith('/files/batch')).at(-1)!
      expect(batch.body).toMatchObject({ do: 'playlist', playlists: [2, 3, 9] })
    } finally {
      await ownerSql()`UPDATE settings SET value = '[2]'::jsonb WHERE key = 'assignable_playlist_ids'`
      await ownerSql()`UPDATE settings SET value = '[2,3,5]'::jsonb WHERE key = 'station_playlist_ids'`
    }
  })

  it('refuses targets outside Music/Artists/<folder>/: ADS/, Events/, UNRELEASED*, Removed/, nested', async () => {
    const paths = [`${PREFIX}ADS/ad-${RUN}.mp3`, `${PREFIX}Events/Fri/e-${RUN}.mp3`, `${PREFIX}UNRELEASED-${RUN}/u.mp3`, `${PREFIX}Removed/424242/r-${RUN}.mp3`, `${PREFIX}Music/Artists/X-${RUN}/deep/d.mp3`]
    const before = await writes()
    for (const p of paths) {
      const m = await seed(p)
      await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toMatchObject({ code: 'target_not_allowed' })
      await expect(applyEdit(ctx, { mediaId: m.id, proposed: { title: 'x' } })).rejects.toMatchObject({ code: 'target_not_allowed' })
      await expect(setPlaylistsJob(ctx, { mediaId: m.id, chosen: [2] })).rejects.toMatchObject({ code: 'target_not_allowed' })
    }
    expect(await writes()).toBe(before)
  })

  it('manager playlist change MERGES: keeps non-assignable station memberships and other stations’ ids', async () => {
    await ownerSql()`UPDATE settings SET value = '[2,5]'::jsonb WHERE key = 'assignable_playlist_ids'`
    const folder = `MERGE-${RUN}`
    await artist(`Merge ${RUN}`, folder)
    const m = await seed(`${art(folder)}/m.mp3`, { playlists: [2, 3, 74] })
    await setPlaylistsJob(ctx, { mediaId: m.id, chosen: [5] })
    const batch = (await azCalls()).filter((c) => c.path.endsWith('/files/batch')).at(-1)!
    expect(batch.body).toMatchObject({ do: 'playlist', playlists: [3, 5] }) // 74 never sent back, 3 kept, 2 → 5
    expect(ids(await fileById(m.id))).toEqual([3, 5, 74])
    await expect(setPlaylistsJob(ctx, { mediaId: m.id, chosen: [3] })).rejects.toMatchObject({ code: 'playlist_not_assignable' })
  })

  it('defers a move while the song is now playing or playing next', async () => {
    const f1 = `NP1-${RUN}`
    const f2 = `NP2-${RUN}`
    await artist(`Np One ${RUN}`, f1)
    await artist(`Np Two ${RUN}`, f2)
    const m = await seed(`${art(f1)}/np.mp3`, { title: 'On Air', artist: `Np One ${RUN}` })
    const songId = (m as unknown as { song_id: string }).song_id
    const before = await writes()
    for (const np of [{ now_playing: { song: { id: songId } } }, { now_playing: { song: { id: 'other' } }, playing_next: { song: { id: songId } } }, { now_playing: { song: { id: 'x', text: `Np One ${RUN} - On Air` } } }]) {
      await control('/__mock/az/nowplaying', np)
      const e = await move(ctx, { mediaId: m.id, toDir: art(f2) }).catch((x) => x)
      expect(e).toBeInstanceOf(RetryLater)
      expect(e).toMatchObject({ message: 'now playing' })
    }
    for (const np of [{ now_playing: { song: { id: songId } } }]) {
      await control('/__mock/az/nowplaying', np)
      await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toBeInstanceOf(RetryLater)
    }
    expect(await writes()).toBe(before)
    await control('/__mock/az/nowplaying', {})
    await move(ctx, { mediaId: m.id, toDir: art(f2) })
    expect((await fileById(m.id))!.path).toBe(`${art(f2)}/np.mp3`)
  })

  it('refuses moves, archives and restores outside the scan window (nothing is sent)', async () => {
    const f1 = `WIN1-${RUN}`
    const f2 = `WIN2-${RUN}`
    await artist(`Win One ${RUN}`, f1)
    await artist(`Win Two ${RUN}`, f2)
    const m = await seed(`${art(f1)}/w.mp3`)
    const [arow] = await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, status) VALUES (${m.id}, ${m.path}, ${`${PREFIX}Removed/${m.id}/w.mp3`}, 'archived') RETURNING id`
    const calls = (await azCalls()).length
    for (const t of [EARLY, LATE]) {
      clock = t
      for (const run of [() => move(ctx, { mediaId: m.id, toDir: art(f2) }), () => archiveMedia(ctx, { mediaId: m.id }), () => restoreMedia(ctx, { archiveId: arow!.id as number })]) {
        const e = await run().catch((x) => x)
        expect(e).toBeInstanceOf(RetryLater)
        expect(e).toMatchObject({ message: 'outside scan window', delayS: t === EARLY ? 25 : 45 })
      }
    }
    expect((await azCalls()).length).toBe(calls)
    await ownerSql()`UPDATE archive SET status = 'failed' WHERE id = ${arow!.id}`
  })

  it('paused queues (contract drift) stop edits, moves, archives and playlist changes before any write', async () => {
    const f1 = `PAUSE1-${RUN}`
    const f2 = `PAUSE2-${RUN}`
    await artist(`Pause One ${RUN}`, f1)
    await artist(`Pause Two ${RUN}`, f2)
    const m = await seed(`${art(f1)}/p.mp3`, { playlists: [2] })
    const before = await writes()
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"contract_drift"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      for (const run of [
        () => applyEdit(ctx, { mediaId: m.id, proposed: { title: 'Paused' } }),
        () => move(ctx, { mediaId: m.id, toDir: art(f2) }),
        () => archiveMedia(ctx, { mediaId: m.id }),
        () => setPlaylistsJob(ctx, { mediaId: m.id, chosen: [2] }),
      ]) {
        const e = await run().catch((x) => x)
        // The foundation's pause: runJob parks QueuesPausedError without an attempt.
        expect(e).toBeInstanceOf(QueuesPausedError)
      }
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
    expect(await writes()).toBe(before)
  })

  it('a deferred job is requeued without spending an attempt', async () => {
    clock = EARLY
    const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, status, attempts) VALUES ('move', ${ownerSql().json({ mediaId: 999998, toDir: art('none') })}, 'running', 3) RETURNING id`
    await runJob(ctx, { id: Number(j!.id), kind: 'move', payload: { mediaId: 999998, toDir: art('none') }, attempts: 3, max_attempts: 3 })
    const row = (await ownerSql()`SELECT status, attempts, run_after > now() AS later, last_error FROM jobs WHERE id = ${j!.id}`)[0]!
    expect(row).toMatchObject({ status: 'queued', attempts: 2, later: true })
    expect(row.last_error).toMatch(/outside scan window/)
    await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${j!.id}`
  })

  it('a retried manager edit still queues the folder move (the payload carries the artist the manager saw)', async () => {
    const f1 = `EDIT1A-${RUN}`
    const f2 = `EDIT1B-${RUN}`
    await artist(`Edit One ${RUN}`, f1)
    await artist(`Edit Two ${RUN}`, f2)
    // The first run's PUT landed, then it died before queueing the move: the
    // row already carries the new artist.
    const m = await seed(`${art(f1)}/e.mp3`, { artist: `Edit Two ${RUN}` })
    await applyEdit(ctx, { mediaId: m.id, proposed: { artist: `Edit Two ${RUN}` }, beforeArtist: `Edit One ${RUN}` })
    expect(take('move').payload).toMatchObject({ mediaId: m.id, toDir: art(f2) })
  })

  it('an edit whose new artist sanitizes to ANOTHER artist’s folder fails with artist_folder_taken (active or denied owner); nothing is written', async () => {
    const src = `SEC5-${RUN}`
    await artist(`Sec Five ${RUN}`, src)
    const ownerId = await artist(`Other Band ${RUN}`, `AC DC ${RUN}`)
    const m1 = await seed(`${art(src)}/one.mp3`, { artist: `Sec Five ${RUN}` })
    const m2 = await seed(`${art(src)}/two.mp3`, { artist: `Sec Five ${RUN}` })
    const r1 = await request('edit', m1, { artist: `AC/DC ${RUN}` })
    const before = await writes()
    await runRequestJob(ctx, { id: 1, kind: 'apply_edit', payload: { requestId: r1 }, attempts: 1, max_attempts: 8 })
    expect(await reqRow(r1)).toMatchObject({ status: 'failed', error: `artist_folder_taken: AC DC ${RUN}` })
    expect(scheduled.map((x) => x.kind)).toEqual(['request_ticket_post'])
    take('request_ticket_post')
    await ownerSql()`UPDATE artists SET status = 'denied' WHERE id = ${ownerId}`
    const r2 = await request('edit', m2, { artist: `AC/DC ${RUN}` })
    await runRequestJob(ctx, { id: 1, kind: 'apply_edit', payload: { requestId: r2 }, attempts: 1, max_attempts: 8 })
    expect(await reqRow(r2)).toMatchObject({ status: 'failed', error: `artist_folder_taken: AC DC ${RUN}` })
    expect(requestFailureText({ error: `artist_folder_taken: AC DC ${RUN}` }, 'Edit', 'x')).toMatch(/already belongs to a different artist/)
    expect(await writes()).toBe(before)
    expect((await fileById(m1.id))!.artist).toBe(`Sec Five ${RUN}`)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM artists WHERE folder = ${`AC DC ${RUN}`}`)[0]!.n).toBe(1)
  })

  it('a metadata PUT that reports success but stores nothing fails the edit (metadata_verify_failed)', async () => {
    const folder = `F2-${RUN}`
    await artist(`F Two ${RUN}`, folder)
    const m = await seed(`${art(folder)}/silent.mp3`, { title: 'Before' })
    const id = await request('edit', m, { title: 'After' })
    await control('/__mock/az/ignore-next-put', {})
    await runRequestJob(ctx, { id: 1, kind: 'apply_edit', payload: { requestId: id }, attempts: 1, max_attempts: 8 })
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'metadata_verify_failed' })
    expect((await fileById(m.id))!.title).toBe('Before')
    expect(scheduled.some((x) => x.kind === 'reverify')).toBe(false)
  })

  it('an old job waiting for the scan window comes back when the window opens, not on the 30-minute age floor', async () => {
    clock = LATE // :x5:45, the window opens again at :x6:30
    const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, status, attempts) VALUES ('move', ${ownerSql().json({ mediaId: 999997, toDir: art('none') })}, 'running', 1) RETURNING id`
    await runJob(ctx, { id: Number(j!.id), kind: 'move', payload: { mediaId: 999997, toDir: art('none') }, attempts: 1, max_attempts: 8, age_s: 40_000 } as never)
    const row = (await ownerSql()`SELECT status, EXTRACT(EPOCH FROM run_after - now())::int AS in_s FROM jobs WHERE id = ${j!.id}`)[0]!
    expect(row.status).toBe('queued')
    expect(row.in_s).toBeGreaterThanOrEqual(40)
    expect(row.in_s).toBeLessThanOrEqual(46)
    await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${j!.id}`
  })

  it('a wait that ages out fails the request (status, ticket post), and a window wait gets more than the 7-day default', async () => {
    clock = EARLY
    const folder = `F1-${RUN}`
    await artist(`F One ${RUN}`, folder)
    const m = await seed(`${art(folder)}/old.mp3`, { playlists: [2] })
    const id = await request('removal', m, null)
    const job = async (ageS: number) => {
      const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, status, attempts, created_at) VALUES ('archive', ${ownerSql().json({ requestId: id })}, 'running', 1, now() - make_interval(secs => ${ageS})) RETURNING id`
      await runJob(ctx, { id: Number(j!.id), kind: 'archive', payload: { requestId: id }, attempts: 1, max_attempts: 8, age_s: ageS } as never)
      const st = (await ownerSql()`SELECT status FROM jobs WHERE id = ${j!.id}`)[0]!.status as string
      await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${j!.id} AND status = 'queued'` // keep it from the live worker
      return st
    }
    // 8 days waiting for the window: still waiting (a song may have waited
    // for its artist or a pause before), the request untouched.
    expect(await job(8 * 86_400)).toBe('queued')
    expect(await reqRow(id)).toMatchObject({ status: 'approved' })
    // past the window wait's age bound: the job dies AND the request fails
    expect(await job(41 * 86_400)).toBe('dead')
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'wait_expired' })
    expect(take('request_ticket_post').payload).toMatchObject({ requestId: id, event: 'failed' })
    expect(alerts.some((a) => a.includes('gave up'))).toBe(true)
  })

  // ------------------------------------------------------------ art ---
  // The foundation's uploadArt, end to end against the mock's POST
  // /api/station/1/art/{id} (multipart field `file`, verified upstream):
  // the wrapper reads <artDir>/<uuid>/cover.jpg, re-hashes it against the
  // recorded sha, resolves the media id and runs the write gate.
  const artUploads = async () => (await control('/__mock/az/art-uploads')) as { mediaId: number; field: string; sha256: string; size: number }[]
  const artUploadsFor = async (mediaId: number) => (await artUploads()).filter((u) => u.mediaId === mediaId)
  // A context whose art POST answers success without storing anything (so
  // art_updated_at does not move): the verify must fail the request.
  function silentArt(): RequestsCtx {
    return ctxWith(async (url, init) => {
      if (init.method === 'POST' && /\/api\/station\/1\/art\/\d+$/.test(url)) return new Response(JSON.stringify({ success: true }), { status: 200 })
      return fetch(url, init)
    })
  }
  // A JPEG with a real header (SOF with the given dimensions): the mock, like
  // AzuraCast, stores a re-encoded copy of it (the bytes differ).
  function jpeg(w: number, h: number, tag: string): Buffer {
    const app0 = [0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]
    const sof = [0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]
    const sos = [0xff, 0xda, 0, 12, 3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]
    return Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(app0), Buffer.from(sof), Buffer.from(sos), Buffer.from(`scan ${tag}`), Buffer.from([0xff, 0xd9])])
  }
  async function readyArt(bytes: Buffer, w: number, h: number) {
    const id = randomUUID()
    const jpegPath = `${artDir}/${id}/cover.jpg`
    mkdirSync(`${artDir}/${id}`, { recursive: true })
    writeFileSync(jpegPath, bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    await ownerSql()`INSERT INTO art_uploads (id, owner, status, jpeg_path, jpeg_sha256, width, height) VALUES (${id}, ${ownerId}, 'ready', ${jpegPath}, ${sha}, ${w}, ${h})`
    return { id, sha }
  }
  const servedArt = async (mediaId: number) => {
    const r = await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/art/${mediaId}`, { redirect: 'manual' })
    return r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null
  }
  const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  const pause1s = () => new Promise((r) => setTimeout(r, 1100))

  it('art-only edit request: apply_edit writes no metadata, then apply_art uploads the probe JPEG and verifies', async () => {
    const folder = `ART1-${RUN}`
    await artist(`Art One ${RUN}`, folder)
    const m = await seed(`${art(folder)}/a.mp3`, { playlists: [2] })
    const up = await insertArt(ownerId, 'ready', artDir)
    const id = await request('edit', m, { artId: up.id })
    const before = await writes()
    await applyEdit(ctx, { requestId: id })
    expect(await writes()).toBe(before) // no metadata PUT
    const job = take('apply_art')
    expect(job).toMatchObject({ payload: { requestId: id }, opts: { dedupeKey: `apply_art:request:${id}` } })
    expect(await reqRow(id)).toMatchObject({ status: 'applying' })
    const stampBefore = (await fileById(m.id)) as unknown as { art_updated_at: number }
    await applyArt(ctx, job.payload as never)
    // The real round trip: one multipart `file` part with exactly the probe JPEG.
    expect(await artUploadsFor(m.id)).toEqual([{ mediaId: m.id, field: 'file', filename: 'cover.jpg', sha256: up.sha, size: up.bytes.length }])
    expect(((await fileById(m.id)) as unknown as { art_updated_at: number }).art_updated_at).toBeGreaterThan(stampBefore.art_updated_at)
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
    expect(take('request_ticket_post').payload).toMatchObject({ requestId: id, event: 'applied' })
    take('reverify')
    const snaps = await ownerSql()`SELECT reason, had_art, art_sha256 FROM media_snapshots WHERE media_id = ${m.id} AND reason LIKE '%art' ORDER BY id`
    expect(snaps).toEqual([
      { reason: 'before_art', had_art: false, art_sha256: null },
      { reason: 'after_art', had_art: true, art_sha256: up.sha },
    ])
  })

  it('metadata + art: art is applied after the metadata, and after the move when the artist changes', async () => {
    const f1 = `ART2-${RUN}`
    const f2 = `ART3-${RUN}`
    await artist(`Art Two ${RUN}`, f1)
    await artist(`Art Three ${RUN}`, f2)
    const m = await seed(`${art(f1)}/b.mp3`, { artist: `Art Two ${RUN}`, playlists: [2] })
    const up = await insertArt(ownerId, 'ready', artDir)
    const id = await request('edit', m, { artist: `Art Three ${RUN}`, artId: up.id })
    await applyEdit(ctx, { requestId: id })
    expect(scheduled.map((x) => x.kind)).toEqual(['move'])
    expect((await fileById(m.id))!.artist).toBe(`Art Three ${RUN}`)
    await move(ctx, take('move').payload as never)
    expect(scheduled.map((x) => x.kind)).toEqual(['apply_art'])
    expect(await reqRow(id)).toMatchObject({ status: 'applying' })
    await applyArt(ctx, take('apply_art').payload as never)
    expect(await artUploadsFor(m.id)).toHaveLength(1)
    expect((await fileById(m.id))!.path).toBe(`${art(f2)}/b.mp3`)
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
  })

  it('apply_art: scan window, queues_paused, readiness, a swapped JPEG and a failed verify', async () => {
    const folder = `ART4-${RUN}`
    await artist(`Art Four ${RUN}`, folder)
    const m = await seed(`${art(folder)}/c.mp3`, { playlists: [2] })
    const up = await insertArt(ownerId, 'ready', artDir)
    clock = EARLY
    await expect(applyArt(ctx, { mediaId: m.id, artId: up.id })).rejects.toMatchObject({ message: 'outside scan window' })
    clock = IN_WINDOW
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"test"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      await expect(applyArt(ctx, { mediaId: m.id, artId: up.id })).rejects.toBeInstanceOf(QueuesPausedError)
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
    const processing = await insertArt(ownerId, 'processing', artDir)
    await expect(applyArt(ctx, { mediaId: m.id, artId: processing.id })).rejects.toMatchObject({ code: 'art_not_ready' })
    // The JPEG on disk no longer matches the probe's recorded sha: refused
    // before anything is sent.
    const swapped = await insertArt(ownerId, 'ready', artDir)
    writeFileSync(swapped.jpegPath, Buffer.concat([swapped.bytes, Buffer.from('x')]))
    await expect(applyArt(ctx, { mediaId: m.id, artId: swapped.id })).rejects.toMatchObject({ code: 'art_sha_mismatch' })
    expect(await artUploadsFor(m.id)).toHaveLength(0)
    // an upload that does not change the art fails the request
    const id = await request('edit', m, { artId: up.id }, 'applying')
    await runRequestJob(silentArt(), { id: 1, kind: 'apply_art', payload: { requestId: id }, attempts: 1, max_attempts: 8 })
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'art_verify_failed' })
    expect(await artUploadsFor(m.id)).toHaveLength(0)
  })

  it('apply_art verifies the art AzuraCast serves (a re-encoded copy with the probe dimensions passes), keeps the old art hash, and fails on the wrong image', async () => {
    const folder = `ART5-${RUN}`
    await artist(`Art Five ${RUN}`, folder)
    const m = await seed(`${art(folder)}/d.mp3`, { playlists: [2] })
    const one = await readyArt(jpeg(640, 480, `one ${RUN}`), 640, 480)
    await applyArt(ctx, { mediaId: m.id, artId: one.id })
    const served1 = (await servedArt(m.id))!
    expect(sha256(served1)).not.toBe(one.sha) // stored re-encoded, not byte-equal
    take('reverify')
    await pause1s() // art_updated_at has 1 s resolution (AzuraCast's time())
    const two = await readyArt(jpeg(800, 600, `two ${RUN}`), 800, 600)
    await applyArt(ctx, { mediaId: m.id, artId: two.id })
    take('reverify')
    const served2 = (await servedArt(m.id))!
    const snaps = await ownerSql()`SELECT reason, had_art, art_sha256 FROM media_snapshots WHERE media_id = ${m.id} AND reason LIKE '%art' ORDER BY id`
    expect(snaps).toEqual([
      { reason: 'before_art', had_art: false, art_sha256: null },
      { reason: 'after_art', had_art: true, art_sha256: sha256(served1) },
      { reason: 'before_art', had_art: true, art_sha256: sha256(served1) }, // the old art, for a restore by hand
      { reason: 'after_art', had_art: true, art_sha256: sha256(served2) },
    ])
    // AzuraCast answers success and moves art_updated_at, but serves an
    // image with other dimensions: not ours.
    const three = await readyArt(jpeg(300, 300, `three ${RUN}`), 300, 300)
    const wrong = ctxWith(async (url, init) => {
      if (init.method === 'GET' && url.endsWith(`/api/station/1/art/${m.id}`)) {
        const r = await fetch(url, init)
        if (r.status !== 200) return r
        return new Response(new Uint8Array(jpeg(100, 100, 'other')), { status: 200, headers: { 'content-type': 'image/jpeg' } })
      }
      return fetch(url, init)
    })
    await pause1s()
    await expect(applyArt(wrong, { mediaId: m.id, artId: three.id })).rejects.toMatchObject({ code: 'art_verify_failed', detail: { reason: 'dimensions_differ' } })
  })

  it('OpFailed carries a machine code', () => {
    expect(new OpFailed('x').code).toBe('x')
  })
})
