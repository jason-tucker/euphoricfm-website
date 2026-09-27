// P4 worker jobs against the P0d/P0d-B AzuraCast mock and the real music-db
// (plan §6 P4). Handlers run in-process with an injected clock; follow-up
// jobs are captured instead of queued, so the running music-worker never
// races these tests.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AzuraCastClient, type StationMedia } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { closeDb, getDb } from '@/server/db/client'
import { TicketsClient } from '@/server/tickets/client'
import { runJob } from '@/worker/main'
import {
  applyArt,
  applyEdit,
  archiveMedia,
  move,
  restoreMedia,
  reverify,
  runRequestJob,
  setPlaylistsJob,
  sweepParkedRequests,
  type RequestsCtx,
} from '@/worker/requests/jobs'
import { OpFailed } from '@/worker/requests/media'
import { Deferred } from '@/worker/requests/window'
import { DBENV, MOCKS } from './helpers/env'
import { ensureArtUploadsStub, insertArt, ownerSql } from './helpers/db'
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

  beforeAll(async () => {
    const recFetch = (async (url: string, init: RequestInit) => {
      ticketCalls.push(`${init.method} ${url}`)
      return new Response(JSON.stringify({ messageId: 'm', discordMessageId: '1', created: true }), { status: 201 })
    }) as unknown as typeof fetch
    ctx = {
      db: getDb(process.env.TEST_APP_DATABASE_URL, 2),
      azuracast: new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(ENV), canaryStationId: 7, env: ENV }),
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
    expect((await ownerSql()`SELECT count(*)::int AS n FROM archive WHERE media_id = ${m.id}`)[0]!.n).toBe(0)
  })

  it('archive refuses when another station keeps a membership, and puts the playlists back', async () => {
    const folder = `EVT-${RUN}`
    await artist(`Evt ${RUN}`, folder)
    const m = await seed(`${art(folder)}/ev.mp3`, { playlists: [2, 74] })
    await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toMatchObject({ code: 'memberships_remain' })
    const after = await fileById(m.id)
    expect(after!.path).toBe(m.path)
    expect(ids(after)).toEqual([2, 74])
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
      expect(e).toBeInstanceOf(Deferred)
      expect(e).toMatchObject({ reason: 'now_playing' })
    }
    for (const np of [{ now_playing: { song: { id: songId } } }]) {
      await control('/__mock/az/nowplaying', np)
      await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toBeInstanceOf(Deferred)
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
        expect(e).toBeInstanceOf(Deferred)
        expect(e).toMatchObject({ reason: 'outside_scan_window', delayS: t === EARLY ? 25 : 45 })
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
        expect(e).toBeInstanceOf(Deferred)
        expect(e).toMatchObject({ reason: 'queues_paused' })
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
    expect(row.last_error).toMatch(/outside_scan_window/)
    await ownerSql()`UPDATE jobs SET status = 'done' WHERE id = ${j!.id}`
  })

  // ------------------------------------------------------------ art ---
  // uploadArt is the foundation's wrapper method (STUBBED here): a fake that
  // records the call and bumps art_updated_at in the mock like a real upload.
  function withArt(bump = true) {
    const uploads: unknown[][] = []
    const az = Object.create(ctx.azuracast) as typeof ctx.azuracast & { uploadArt: (...a: unknown[]) => Promise<void> }
    az.uploadArt = async (...a: unknown[]) => {
      uploads.push(a)
      if (bump) await control('/__mock/az/art', { id: a[0] })
    }
    return { c: { ...ctx, azuracast: az } as RequestsCtx, uploads }
  }

  it('art-only edit request: apply_edit writes no metadata, then apply_art uploads the probe JPEG and verifies', async () => {
    await ensureArtUploadsStub()
    const folder = `ART1-${RUN}`
    await artist(`Art One ${RUN}`, folder)
    const m = await seed(`${art(folder)}/a.mp3`, { playlists: [2] })
    const up = await insertArt(ownerId)
    const id = await request('edit', m, { artId: up.id })
    const { c, uploads } = withArt()
    const before = await writes()
    await applyEdit(c, { requestId: id })
    expect(await writes()).toBe(before) // no metadata PUT
    const job = take('apply_art')
    expect(job).toMatchObject({ payload: { requestId: id }, opts: { dedupeKey: `apply_art:request:${id}` } })
    expect(await reqRow(id)).toMatchObject({ status: 'applying' })
    await applyArt(c, job.payload as never)
    expect(uploads).toEqual([[m.id, up.jpegPath, up.sha]])
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
    await ensureArtUploadsStub()
    const f1 = `ART2-${RUN}`
    const f2 = `ART3-${RUN}`
    await artist(`Art Two ${RUN}`, f1)
    await artist(`Art Three ${RUN}`, f2)
    const m = await seed(`${art(f1)}/b.mp3`, { artist: `Art Two ${RUN}`, playlists: [2] })
    const up = await insertArt(ownerId)
    const id = await request('edit', m, { artist: `Art Three ${RUN}`, artId: up.id })
    const { c, uploads } = withArt()
    await applyEdit(c, { requestId: id })
    expect(scheduled.map((x) => x.kind)).toEqual(['move'])
    expect((await fileById(m.id))!.artist).toBe(`Art Three ${RUN}`)
    await move(c, take('move').payload as never)
    expect(scheduled.map((x) => x.kind)).toEqual(['apply_art'])
    expect(await reqRow(id)).toMatchObject({ status: 'applying' })
    await applyArt(c, take('apply_art').payload as never)
    expect(uploads).toHaveLength(1)
    expect((await fileById(m.id))!.path).toBe(`${art(f2)}/b.mp3`)
    expect(await reqRow(id)).toMatchObject({ status: 'verifying' })
  })

  it('apply_art: scan window, queues_paused, readiness, the missing wrapper method and a failed verify', async () => {
    await ensureArtUploadsStub()
    const folder = `ART4-${RUN}`
    await artist(`Art Four ${RUN}`, folder)
    const m = await seed(`${art(folder)}/c.mp3`, { playlists: [2] })
    const up = await insertArt(ownerId)
    const { c, uploads } = withArt()
    clock = EARLY
    await expect(applyArt(c, { mediaId: m.id, artId: up.id })).rejects.toMatchObject({ reason: 'outside_scan_window' })
    clock = IN_WINDOW
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"test"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      await expect(applyArt(c, { mediaId: m.id, artId: up.id })).rejects.toMatchObject({ reason: 'queues_paused' })
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
    const processing = await insertArt(ownerId, 'processing')
    await expect(applyArt(c, { mediaId: m.id, artId: processing.id })).rejects.toMatchObject({ code: 'art_not_ready' })
    expect(uploads).toHaveLength(0)
    await expect(applyArt(ctx, { mediaId: m.id, artId: up.id })).rejects.toMatchObject({ code: 'upload_art_unavailable' })
    // an upload that does not change the art fails the request
    const id = await request('edit', m, { artId: up.id }, 'applying')
    const silent = withArt(false)
    await runRequestJob(silent.c, { id: 1, kind: 'apply_art', payload: { requestId: id }, attempts: 1, max_attempts: 8 })
    expect(await reqRow(id)).toMatchObject({ status: 'failed', error: 'art_verify_failed' })
  })

  it('OpFailed carries a machine code', () => {
    expect(new OpFailed('x').code).toBe('x')
  })
})
