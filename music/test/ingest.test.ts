// P3: review → ingest (worker side). Postgres + the AzuraCast / tickets
// mocks, a pinned far-future clock, and the test playing the probe.
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runFinalize } from '@/probe/finalize'
import { AzuraCastClient, AzuraCastError } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { closeDb } from '@/server/db/client'
import type { Viewer } from '@/server/authz/predicates'
import { HttpError } from '@/server/http/errors'
import { QueuesPausedError } from '@/server/pause'
import { mainArtist } from '@/server/library/artists'
import { clearItemArt, decideItem, editItemMetadata, setItemArt, submitBatch } from '@/server/submissions'
import { Defer } from '@/worker/handlers'
import { runIngest, runIngestVerify } from '@/worker/ingest/pipeline'
import { afterScans, pacingWaitMs, scanWindow, WindowConfigError } from '@/worker/ingest/window'
import { artUrlFor, isLibraryPath, stationSet, syncLibrary } from '@/worker/library/sync'
import { runJob } from '@/worker/main'
import { setPlaylistsJob, type RequestsCtx } from '@/worker/requests/jobs'
import { batchContractCheck, diskPush, finalCleanup, Scheduler } from '@/worker/scheduler'
import { autoCloseSweep, batchSummary, summaryBody, summarySweep, ticketAutoclose, ticketItemEvent } from '@/worker/scheduler/tickets'
import { ownerSql } from './helpers/db'
import { DBENV, MOCKS } from './helpers/env'
import { fx } from './helpers/fixtures'
import { control } from './helpers/http'
import { actAsProbe, item, makeCtx, mkArtist, mkBatch, mkItem, mkUser, PREFIX_ENV, run, slot, uniq, type TestCtx } from './helpers/p3'

const SHA = /^[0-9a-f]{64}$/

async function step(ctx: TestCtx, itemId: number): Promise<Defer | null> {
  try {
    await runIngest(ctx, { itemId })
    return null
  } catch (e) {
    if (e instanceof Defer) return e
    throw e
  }
}

async function verify(ctx: TestCtx, itemId: number): Promise<Defer | null> {
  try {
    await runIngestVerify(ctx, { itemId })
    return null
  } catch (e) {
    if (e instanceof Defer) return e
    throw e
  }
}

type AzFile = { id: number; path: string; title: string | null; artist: string | null; album: string | null; genre: string | null; playlists: { id: number }[] }
const azFiles = async () => (await control('/__mock/az/files')) as AzFile[]
const azFile = async (path: string) => (await azFiles()).find((f) => f.path === path)
const uploadsTo = async (needle: string) =>
  ((await control('/__mock/az/calls')) as { method: string; path: string; body?: { path?: string } }[]).filter(
    (c) => c.method === 'POST' && c.path === '/api/station/1/files' && (c.body?.path ?? '').includes(needle),
  )

// Walk one approved song to `verifying` at clock t.
async function ingestToVerifying(ctx: TestCtx, opts: { title?: string } = {}) {
  const owner = await mkUser()
  const folder = `PT ${uniq()}`
  const artistId = await mkArtist(folder)
  const b = await mkBatch(owner.id)
  const title = opts.title ?? 'Sunrise'
  const id = await mkItem({ batchId: b, ownerId: owner.id, title, artist: folder, artistId })
  expect((await step(ctx, id))?.message).toBe('finalize submitted')
  await actAsProbe(ctx, id)
  expect(await step(ctx, id)).toBeNull()
  const path = `Portal-Test/Music/Artists/${folder}/${folder} - ${title}.mp3`
  return { id, folder, path, batchId: b, owner }
}

// ------------------------------------------------------------ pure --------

describe('scan window and pacing (clock only)', () => {
  it('opens at :x1 + offset + 20 s and closes 30 s before :x6', () => {
    expect(scanWindow(slot(0, 1, 29), 10)).toEqual({ open: false, waitMs: 1000 })
    expect(scanWindow(slot(0, 1, 30), 10).open).toBe(true)
    expect(scanWindow(slot(0, 5, 29), 10).open).toBe(true)
    expect(scanWindow(slot(0, 5, 30), 10)).toEqual({ open: false, waitMs: 60_000 })
    expect(scanWindow(slot(0, 0, 50), 10)).toEqual({ open: false, waitMs: 40_000 })
    expect(scanWindow(slot(0, 6, 5), 10)).toEqual({ open: false, waitMs: 25_000 })
    expect(() => scanWindow(slot(0), 131)).toThrow(WindowConfigError) // 131 + 20 > 150: stop and ask
  })

  it('re-verify is due after the next two scans have finished', () => {
    expect(afterScans(slot(0, 1, 40), 2, 10)).toBe(slot(0, 11, 30))
    expect(afterScans(slot(0, 0, 59), 1, 10)).toBe(slot(0, 1, 30))
  })

  it('serial spacing ≥ 90 s and at most 6 uploads per trailing hour', () => {
    const t = slot(0)
    const caps = { ingestSpacingS: 90, ingestPerHour: 6 }
    expect(pacingWaitMs([], t, caps)).toBe(0)
    expect(pacingWaitMs([t - 30_000], t, caps)).toBe(60_000)
    expect(pacingWaitMs([t - 90_000], t, caps)).toBe(0)
    const six = [50, 40, 30, 20, 10, 5].map((m) => t - m * 60_000)
    expect(pacingWaitMs(six, t, caps)).toBe(10 * 60_000) // the 50-min-old one ages out in 10 min
    expect(pacingWaitMs(six.slice(1), t, caps)).toBe(0)
    expect(pacingWaitMs([t + 60_000], t, caps)).toBe(0) // future rows never block
  })

  it('main artist is the first-listed one', () => {
    expect(mainArtist('GRIM x KOKORO')).toBe('GRIM')
    expect(mainArtist('A & B')).toBe('A')
    expect(mainArtist('A, B')).toBe('A')
    expect(mainArtist('Jake Gallagher feat. Someone')).toBe('Jake Gallagher')
    expect(mainArtist('Malcolm X Band')).toBe('Malcolm X Band')
  })

  it('station playlist set: sync-owned, never shrinks by observation, alerts a new id once, drops only admin-foreign ids', () => {
    const foreign = new Set([74, 75, 76, 77, 78])
    // first sync: classified against the configured foreign list; an id that
    // is neither configured nor foreign is station 1 but UNCONFIRMED (an
    // admin can still move it to foreign) and alerted once (v0.2.2 #5)
    const r0 = stationSet({ prev: null, prevUnconfirmed: [], configured: [2], foreign, observed: new Set([2, 4, 74, 78]) })
    expect(r0).toEqual({ station: [2, 4], unconfirmed: [4], fresh: [4] })
    expect(stationSet({ prev: r0.station, prevUnconfirmed: r0.unconfirmed, configured: [2], foreign, observed: new Set([2, 4]) })).toEqual({ station: [2, 4], unconfirmed: [4], fresh: [] })
    // 4 not seen this time: kept; 79 is new: counted as station 1, alerted, unconfirmed
    const r1 = stationSet({ prev: [2, 4], prevUnconfirmed: [], configured: [2], foreign, observed: new Set([2, 79]) })
    expect(r1).toEqual({ station: [2, 4, 79], unconfirmed: [79], fresh: [79] })
    // next sync: no second alert for 79
    expect(stationSet({ prev: r1.station, prevUnconfirmed: r1.unconfirmed, configured: [2], foreign, observed: new Set([2, 79]) }).fresh).toEqual([])
    // an admin marks 79 foreign: it leaves the station set (and unconfirmed)
    expect(stationSet({ prev: r1.station, prevUnconfirmed: r1.unconfirmed, configured: [2], foreign: new Set([...foreign, 79]), observed: new Set([2, 79]) })).toEqual({ station: [2, 4], unconfirmed: [], fresh: [] })
    // a configured (assignable/default) id always stays station 1
    expect(stationSet({ prev: [2], prevUnconfirmed: [], configured: [2], foreign: new Set([2]), observed: new Set([2]) }).station).toEqual([2])
  })

  it('library whitelist: Music/Artists/** only; UNRELEASED*, Removed/ and Portal-Test/ never', () => {
    expect(isLibraryPath('Music/Artists/GRIM/luvusm.mp3')).toBe(true)
    expect(isLibraryPath('Music/Artists/GRIM/sub/x.m4a')).toBe(true)
    for (const p of [
      'UNRELEASED-DO NOT ADD TO ROTATION/x.mp3',
      'Music/Artists/UNRELEASED stuff/x.mp3',
      'Removed/12/x.mp3',
      'Portal-Test/Music/Artists/GRIM/x.mp3',
      'ADS/Paid/x.mp3',
      'Events/x.mp3',
      'Music/Holidays/x.mp3',
      'Music/Artists/../ADS/x.mp3',
      'Music/Artists/x.mp3',
    ]) {
      expect(isLibraryPath(p), p).toBe(false)
    }
  })

  it('batch summary text lists every decision and stays under the message cap', () => {
    const it = (id: number, status: string, denyReason: string | null = null) =>
      ({ id, status, kind: 'song', artist: 'A', title: `T${id}`, denyReason, newArtistName: null }) as never
    const body = summaryBody(9, [it(1, 'live'), it(2, 'denied', 'Too  quiet'), it(3, 'withdrawn')])
    expect(body).toContain('#1 A - T1: approved')
    expect(body).toContain('#2 A - T2: denied. Reason: Too quiet')
    expect(body).toContain('#3 A - T3: withdrawn')
    const many = summaryBody(9, Array.from({ length: 80 }, (_, i) => it(i + 1, 'denied', 'x'.repeat(200))))
    expect(many.length).toBeLessThanOrEqual(1800)
    expect(many).toMatch(/and \d+ more/)
  })
})

// ------------------------------------------------ wrapper whitelist ------

describe('AzuraCast wrapper: writes only on Music/Artists/** (and only under PORTAL_TEST_PREFIX when set)', () => {
  function fake(env: Record<string, string>, getPath = 'Music/Artists/A/a.mp3') {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`)
      const body = init.method === 'GET' ? { id: 5, unique_id: 'u', path: getPath, playlists: [] } : { success: true, errors: [] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    return { calls, c: new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(env), canaryStationId: 7, fetchImpl, env }) }
  }
  const PROD = { MUSIC_PROFILE: 'prod', STATION_ID: '1' }
  const X = Buffer.from('x')
  const X_SHA = createHash('sha256').update(X).digest('hex')
  const up = (c: AzuraCastClient, p: string) => c.uploadFile(p, X, X_SHA)

  it('production root: every non-artist path is refused before any request', async () => {
    const { c, calls } = fake(PROD)
    for (const p of ['ADS/x.mp3', 'Removed/1/x.mp3', 'UNRELEASED-DO NOT ADD TO ROTATION/x.mp3', 'Portal-Test/Music/Artists/A/x.mp3', 'Music/Holidays/x.mp3', 'Events/x.mp3', 'Music/Artists/x.mp3']) {
      await expect(up(c, p), p).rejects.toBeInstanceOf(AzuraCastError)
      await expect(c.setPlaylists(p, [], new Set()), p).rejects.toBeInstanceOf(AzuraCastError)
    }
    expect(calls).toHaveLength(0)
    await expect(up(c, 'Music/Artists/A/x.mp3')).rejects.toMatchObject({ code: 'unexpected_shape' }) // sent (fake reply)
    expect(calls).toHaveLength(1)
  })

  it('with PORTAL_TEST_PREFIX: only paths under it', async () => {
    const { c, calls } = fake(PREFIX_ENV)
    await expect(up(c, 'Music/Artists/A/x.mp3')).rejects.toMatchObject({ code: 'refused_test_prefix' })
    await expect(c.setPlaylists('Music/Artists/A/x.mp3', [2], new Set([2]))).rejects.toBeInstanceOf(AzuraCastError)
    expect(calls).toHaveLength(0)
    await expect(up(c, 'Portal-Test/Music/Artists/A/x.mp3')).rejects.toMatchObject({ code: 'unexpected_shape' }) // sent (fake reply)
    expect(calls).toHaveLength(1)
  })

  it('a metadata PUT resolves the id first and refuses a file off the surface', async () => {
    const { c, calls } = fake(PROD, 'ADS/Paid/ad.mp3')
    await expect(c.updateMetadata(5, { title: 't', artist: 'a', album: '', genre: '' })).rejects.toMatchObject({ code: 'refused_metadata_target' })
    expect(calls).toEqual(['GET https://az.invalid/api/station/1/file/5'])
  })
})

// --------------------------------------------------------- pipeline -------

describe.skipIf(!DBENV() || !MOCKS())('ingest pipeline (station 1, Portal-Test/ prefix)', () => {
  afterAll(async () => closeDb())

  it('happy path: finalize → upload in the window → playlists → snapshot → verifying → live after two scans', async () => {
    const ctx = makeCtx(slot(1))
    const owner = await mkUser()
    const folder = `PT Happy ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Sunrise', artist: `${folder} feat. Guest`, artistId })

    expect((await step(ctx, id))?.message).toBe('finalize submitted')
    expect((await item(id)).status).toBe('applying')
    const req = await actAsProbe(ctx, id)
    expect(req).toMatchObject({ type: 'finalize', approvedSha256: 'a'.repeat(64), tags: { title: 'Sunrise', artist: `${folder} feat. Guest`, album: 'Album', genre: 'Pop' }, cover: null })
    expect(await step(ctx, id)).toBeNull()

    const it1 = await item(id)
    const path = `Portal-Test/Music/Artists/${folder}/${folder} feat. Guest - Sunrise.mp3`
    expect(it1).toMatchObject({ status: 'verifying', target_path: path })
    expect(it1.final_sha256).toMatch(SHA)
    const f = (await azFile(path))!
    expect(f.id).toBe(it1.media_id)
    expect(f.playlists.map((p) => p.id)).toEqual([2])
    const snap = (await ownerSql()`SELECT * FROM media_snapshots WHERE item_id = ${id}`)[0]!
    expect(snap).toMatchObject({ reason: 'ingest', path, media_id: f.id, title: 'Sunrise', artist: `${folder} feat. Guest`, album: 'Album', genre: 'Pop', playlist_ids: [2] })
    const job = (await ownerSql()`SELECT run_after FROM jobs WHERE dedupe_key = ${`ingest_verify:item:${id}`}`)[0]!
    expect(new Date(job.run_after as string).getTime()).toBe(slot(1, 11, 30))

    ctx.clock.t = slot(1, 6, 0)
    expect((await verify(ctx, id))?.message).toBe('verify not due')
    ctx.clock.t = slot(1, 11, 31)
    expect(await verify(ctx, id)).toBeNull()
    const live = await item(id)
    expect(live.status).toBe('live')
    expect(new Date(live.live_at as string).getTime()).toBe(slot(1, 11, 31))
    expect((await ownerSql()`SELECT 1 FROM jobs WHERE dedupe_key = ${`ticket_item_event:item:${id}:live`}`).length).toBe(1)
    ctx.cleanup()
  })

  it('collision: any entry at the path (media or an unscanned file) moves the upload to the next suffix', async () => {
    const ctx = makeCtx(slot(2))
    const owner = await mkUser()
    const folder = `PT Coll ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const base = `Portal-Test/Music/Artists/${folder}/${folder} - Echo`
    await control('/__mock/az/seed', { files: [{ path: `${base}.mp3`, title: 'Existing', artist: 'Someone' }] })
    const before = (await azFile(`${base}.mp3`))!
    await control('/__mock/az/unscanned', { path: `${base} (2).mp3` })
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Echo', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    expect(await step(ctx, id)).toBeNull()
    expect((await item(id)).target_path).toBe(`${base} (3).mp3`)
    const after = (await azFile(`${base}.mp3`))!
    expect(after).toMatchObject({ id: before.id, title: 'Existing' }) // never overwritten
    const lists = ((await control('/__mock/az/calls')) as { path: string; query: Record<string, string> }[]).filter(
      (c) => c.path.endsWith('/files/list') && c.query.currentDirectory === `Portal-Test/Music/Artists/${folder}`,
    )
    expect(lists.length).toBeGreaterThanOrEqual(3)
    expect(lists.every((c) => c.query.flushCache === 'true')).toBe(true)
    ctx.cleanup()
  })

  it('the upload is refused outside the scan window (clock only) and starts once it opens', async () => {
    const ctx = makeCtx(slot(3, 0, 50))
    const owner = await mkUser()
    const folder = `PT Win ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Late', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    let d = await step(ctx, id)
    expect(d).toMatchObject({ message: 'outside scan window', delayS: 40 })
    ctx.clock.t = slot(3, 1, 10)
    d = await step(ctx, id)
    expect(d).toMatchObject({ message: 'outside scan window', delayS: 20 })
    ctx.clock.t = slot(3, 5, 31)
    d = await step(ctx, id)
    expect(d).toMatchObject({ message: 'outside scan window', delayS: 59 })
    expect(await uploadsTo(folder)).toHaveLength(0)
    expect((await run(id))!.stage).toBe('ready')
    ctx.clock.t = slot(3, 6, 30)
    expect(await step(ctx, id)).toBeNull()
    expect(await uploadsTo(folder)).toHaveLength(1)
    ctx.cleanup()
  })

  it('serial pacing: a second song waits ≥ 90 s after the previous upload', async () => {
    const ctx = makeCtx(slot(4, 1, 40))
    const a = await ingestToVerifying(ctx)
    const owner = await mkUser()
    const folder = `PT Pace ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Second', artist: folder, artistId })
    ctx.clock.t = slot(4, 2, 0)
    await step(ctx, id)
    await actAsProbe(ctx, id)
    const d = await step(ctx, id)
    expect(d).toMatchObject({ message: 'pacing', delayS: 70 })
    expect(await uploadsTo(folder)).toHaveLength(0)
    ctx.clock.t = slot(4, 3, 10)
    expect(await step(ctx, id)).toBeNull()
    const [ra, rb] = [await run(a.id), await run(id)]
    expect(new Date(rb!.uploaded_at as string).getTime() - new Date(ra!.uploaded_at as string).getTime()).toBeGreaterThanOrEqual(90_000)
    ctx.cleanup()
  })

  it('hourly cap: the 7th upload inside an hour waits', async () => {
    const ctx = makeCtx(slot(5, 51, 40))
    const owner = await mkUser()
    const b = await mkBatch(owner.id)
    // six uploads already in this hour
    for (const m of [0, 5, 10, 15, 20, 25]) {
      const dummy = await mkItem({ batchId: b, ownerId: owner.id, status: 'live' })
      await ownerSql()`INSERT INTO ingest_runs (item_id, stage, uploaded_at) VALUES (${dummy}, 'live', ${new Date(slot(5, 0, 0) + m * 60_000)})`
    }
    const folder = `PT Cap ${uniq()}`
    const artistId = await mkArtist(folder)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Seventh', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    const d = await step(ctx, id)
    expect(d?.message).toBe('pacing')
    expect(d!.delayS).toBe(3600 - 51 * 60 - 40) // until the :00 upload ages out
    expect(await uploadsTo(folder)).toHaveLength(0)
    ctx.cleanup()
  })

  it('sha mismatch blocks the upload: probe-side (approved sha) and worker-side (final sha)', async () => {
    const ctx = makeCtx(slot(6))
    const owner = await mkUser()
    const folder = `PT Sha ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const probeSide = await mkItem({ batchId: b, ownerId: owner.id, title: 'P', artist: folder, artistId })
    await step(ctx, probeSide)
    await actAsProbe(ctx, probeSide, { fail: 'sha_mismatch' })
    expect(await step(ctx, probeSide)).toBeNull()
    expect(await item(probeSide)).toMatchObject({ status: 'failed' })
    expect((await run(probeSide))!.last_error).toBe('finalize_sha_mismatch')

    const workerSide = await mkItem({ batchId: b, ownerId: owner.id, title: 'W', artist: folder, artistId })
    await step(ctx, workerSide)
    await actAsProbe(ctx, workerSide, { reportedSha: 'f'.repeat(64) })
    expect(await step(ctx, workerSide)).toBeNull()
    expect((await run(workerSide))!.last_error).toBe('final_sha_mismatch')

    const wrongInbox = await mkItem({ batchId: b, ownerId: owner.id, title: 'X', artist: folder, artistId })
    await step(ctx, wrongInbox)
    await actAsProbe(ctx, wrongInbox, { source: 'in-web' })
    expect(await step(ctx, wrongInbox)).toBeNull()
    expect((await run(wrongInbox))!.last_error).toBe('wrong_result_source')

    expect(await uploadsTo(folder)).toHaveLength(0)
    expect(ctx.alerts.filter((a) => a.title.startsWith('ingest failed'))).toHaveLength(3)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key IN (${`ticket_item_event:item:${probeSide}:failed`}, ${`ticket_item_event:item:${workerSide}:failed`})`)[0]!.n).toBe(2)
    ctx.cleanup()
  })

  it('lost row after a scan: poll by path, re-apply metadata then playlists, remap ids, alert; then live', async () => {
    const ctx = makeCtx(slot(7))
    const { id, path } = await ingestToVerifying(ctx)
    const oldId = (await item(id)).media_id as number
    // The scan dropped the row; the next one re-imported the file under a new id with the tags only.
    await control('/__mock/az/seed', { files: [{ path, title: 'from tags', artist: 'tag artist', playlists: [] }] })
    const newId = (await azFile(path))!.id
    expect(newId).not.toBe(oldId)

    ctx.clock.t = slot(7, 11, 31)
    expect((await verify(ctx, id))?.message).toBe('recovering')
    expect((await run(id))!.stage).toBe('recovering')
    expect(ctx.alerts.some((a) => a.title.includes('lost after a scan'))).toBe(true)

    ctx.clock.t = new Date((await run(id))!.verify_due_at as string).getTime()
    expect((await verify(ctx, id))?.message).toBe('recovered, re-verifying')
    const f = (await azFile(path))!
    expect(f).toMatchObject({ id: newId, title: 'Sunrise', album: 'Album', genre: 'Pop' })
    expect(f.playlists.map((p) => p.id)).toEqual([2])
    expect((await item(id)).media_id).toBe(newId)
    expect((await run(id))!.media_id).toBe(newId)
    expect((await ownerSql()`SELECT media_id FROM media_snapshots WHERE item_id = ${id}`)[0]!.media_id).toBe(newId)
    expect(ctx.alerts.some((a) => a.title.includes('recovered'))).toBe(true)
    const puts = ((await control('/__mock/az/calls')) as { method: string; path: string; body?: { do?: string; files?: string[] } }[]).filter(
      (c) => (c.method === 'PUT' && c.path === `/api/station/1/file/${newId}`) || (c.body?.do === 'playlist' && c.body.files?.[0] === path),
    )
    // metadata FIRST, then playlists
    expect(puts.at(-2)!.path).toBe(`/api/station/1/file/${newId}`)
    expect(puts.at(-1)!.body!.do).toBe('playlist')

    ctx.clock.t = new Date((await run(id))!.verify_due_at as string).getTime()
    expect(await verify(ctx, id)).toBeNull()
    expect((await item(id)).status).toBe('live')
    ctx.cleanup()
  })

  it('lost row that never comes back: ≥ 3 polls and ≥ 20 min, then failed + alert', async () => {
    const ctx = makeCtx(slot(8))
    const { id, path } = await ingestToVerifying(ctx)
    await control('/__mock/az/drop', { path })
    ctx.clock.t = slot(8, 11, 31)
    expect((await verify(ctx, id))?.message).toBe('recovering')
    let polls = 0
    for (;;) {
      ctx.clock.t = new Date((await run(id))!.verify_due_at as string).getTime()
      const d = await verify(ctx, id)
      if (!d) break
      expect(d.message).toBe('recovery poll')
      polls++
      expect(polls).toBeLessThan(10)
    }
    expect(polls).toBeGreaterThanOrEqual(2)
    const r = (await run(id))!
    expect(r).toMatchObject({ stage: 'failed', last_error: 'recovery_failed' })
    expect(r.recovery_polls).toBeGreaterThanOrEqual(2)
    expect(ctx.clock.t - new Date(r.recovery_started_at as string).getTime()).toBeGreaterThanOrEqual(20 * 60_000)
    expect((await item(id)).status).toBe('failed')
    expect(ctx.alerts.some((a) => a.title.includes('recovery_failed'))).toBe(true)
    ctx.cleanup()
  })

  it('playlists missing at re-verify are re-applied from the snapshot', async () => {
    const ctx = makeCtx(slot(9))
    const { id, path } = await ingestToVerifying(ctx)
    const mediaId = (await item(id)).media_id as number
    // Something replaced the station memberships (keeps station-14 ids ≥ 70).
    await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/batch`, {
      method: 'PUT',
      headers: { 'X-API-Key': process.env.AZURACAST_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'playlist', files: [path], playlists: [] }),
    })
    ctx.clock.t = slot(9, 11, 31)
    expect((await verify(ctx, id))?.message).toBe('playlists re-applied')
    expect((await azFile(path))!.playlists.map((p) => p.id)).toEqual([2])
    ctx.clock.t = new Date((await run(id))!.verify_due_at as string).getTime()
    expect(await verify(ctx, id)).toBeNull()
    expect(await item(id)).toMatchObject({ status: 'live', media_id: mediaId })
    ctx.cleanup()
  })

  it('queues_paused (contract drift) holds the ingest before any AzuraCast write', async () => {
    const ctx = makeCtx(slot(19))
    const owner = await mkUser()
    const folder = `PT Pause ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Held', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    await ownerSql()`UPDATE settings SET value = '{"reason":"test"}'::jsonb WHERE key = 'queues_paused'`
    try {
      // The foundation's pause: QueuesPausedError parks the job without an attempt.
      await expect(step(ctx, id)).rejects.toBeInstanceOf(QueuesPausedError)
      expect(await uploadsTo(folder)).toHaveLength(0)
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
    expect(await step(ctx, id)).toBeNull()
    expect(await uploadsTo(folder)).toHaveLength(1)
    ctx.cleanup()
  })

  // ING-1 / SEC-4: a path is reserved only right before the POST, other
  // active runs' reservations count as taken, and a reserved path's row is
  // adopted only when it is provably this run's upload.
  function gatedAz(opts: { refuseNext?: { on: boolean }; fetchImpl?: typeof fetch } = {}) {
    return new AzuraCastClient({
      baseUrl: process.env.MOCKS_AZURACAST!,
      apiKey: process.env.AZURACAST_API_KEY!,
      profile: resolveProfile(PREFIX_ENV),
      canaryStationId: 7,
      env: PREFIX_ENV,
      fetchImpl: opts.fetchImpl,
      writeGate: async () => {
        if (opts.refuseNext?.on) {
          opts.refuseNext.on = false
          throw new Error('queues paused')
        }
      },
    })
  }

  it('ING-1: a run parked after reserving its path never adopts a duplicate’s upload; the duplicate takes the next name', async () => {
    const refuse = { on: false }
    const ctx = makeCtx(slot(30), { az: gatedAz({ refuseNext: refuse }) })
    const owner = await mkUser()
    const folder = `PT Twin ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const a = await mkItem({ batchId: b, ownerId: owner.id, title: 'Twin', artist: folder, artistId })
    const dup = await mkItem({ batchId: b, ownerId: owner.id, title: 'Twin', artist: folder, artistId })
    for (const id of [a, dup]) {
      await step(ctx, id)
      await actAsProbe(ctx, id)
    }
    const P = `Portal-Test/Music/Artists/${folder}/${folder} - Twin.mp3`
    // A reserves P, then the pause lands between its checks and the POST.
    refuse.on = true
    await expect(step(ctx, a)).rejects.toMatchObject({ code: 'refused_queues_paused' })
    const ra = (await run(a))!
    expect(ra).toMatchObject({ stage: 'ready', target_path: P })
    expect(ra.upload_attempted_at).not.toBeNull()
    expect(await uploadsTo(folder)).toHaveLength(0)
    // The duplicate runs first: A's reservation counts as taken.
    expect(await step(ctx, dup)).toBeNull()
    expect(await item(dup)).toMatchObject({ status: 'verifying', target_path: P.replace(/\.mp3$/, ' (2).mp3') })
    // A resumes after the pacing gap: nothing of its own at P, so it uploads there.
    ctx.clock.t = slot(30, 3, 20)
    expect(await step(ctx, a)).toBeNull()
    const [ia, id2] = [await item(a), await item(dup)]
    expect(ia).toMatchObject({ status: 'verifying', target_path: P })
    expect(ia.media_id).not.toBe(id2.media_id)
    expect((await azFile(P))!.id).toBe(ia.media_id)
    expect(await uploadsTo(folder)).toHaveLength(2)
    ctx.cleanup()
  })

  it('ING-1: a lost upload reply is adopted on retry (size, time, sole holder), so nothing is uploaded twice', async () => {
    let drop = true
    const lossy = (async (url: string, init: RequestInit) => {
      if (drop && init.method === 'POST' && String(url).endsWith('/api/station/1/files')) {
        drop = false
        await fetch(url, init)
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      return fetch(url, init)
    }) as unknown as typeof fetch
    const ctx = makeCtx(slot(31), { az: gatedAz({ fetchImpl: lossy }) })
    const owner = await mkUser()
    const folder = `PT Lost ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Reply', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    await expect(step(ctx, id)).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await uploadsTo(folder)).toHaveLength(1)
    expect(await step(ctx, id)).toBeNull()
    expect(await uploadsTo(folder)).toHaveLength(1)
    const P = `Portal-Test/Music/Artists/${folder}/${folder} - Reply.mp3`
    expect(await item(id)).toMatchObject({ status: 'verifying', target_path: P, media_id: (await azFile(P))!.id })
    expect(ctx.alerts.filter((x) => x.title.includes('not its upload'))).toHaveLength(0)
    ctx.cleanup()
  })

  it('ING-1: a row at the reserved path that another item holds (same bytes, even) or that is a different file is never adopted', async () => {
    const ctx = makeCtx(slot(32))
    const owner = await mkUser()
    const folder = `PT Held ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const bytes = Buffer.from(`identical final bytes ${uniq()}`)
    const first = await mkItem({ batchId: b, ownerId: owner.id, title: 'Same', artist: folder, artistId })
    await step(ctx, first)
    await actAsProbe(ctx, first, { bytes })
    expect(await step(ctx, first)).toBeNull()
    const P = `Portal-Test/Music/Artists/${folder}/${folder} - Same.mp3`
    expect((await item(first)).target_path).toBe(P)
    await ownerSql()`UPDATE ingest_runs SET stage = 'live' WHERE item_id = ${first}`
    // A duplicate with byte-identical final audio holds a reservation of P
    // with an attempt marker (e.g. from before the migration): P's row has
    // the right size and time, but it is the first item's media.
    const second = await mkItem({ batchId: b, ownerId: owner.id, title: 'Same', artist: folder, artistId })
    await step(ctx, second)
    await actAsProbe(ctx, second, { bytes })
    ctx.clock.t = slot(32, 0, 50) // window closed: finalizing → ready, then it waits
    expect((await step(ctx, second))?.message).toBe('outside scan window')
    await ownerSql()`UPDATE ingest_runs SET target_path = ${P}, upload_attempted_at = now() - interval '1 minute' WHERE item_id = ${second}`
    ctx.clock.t = slot(32, 4, 55)
    expect(await step(ctx, second)).toBeNull()
    const [i1, i2] = [await item(first), await item(second)]
    expect(i2.target_path).toBe(P.replace(/\.mp3$/, ' (2).mp3'))
    expect(i2.media_id).not.toBe(i1.media_id)
    expect(ctx.alerts.find((x) => x.title.includes('not its upload'))!.detail).toMatchObject({ reasons: ['media_held_by_another_item'] })
    // A different file at a reserved path (an SFTP upload): size mismatch.
    ctx.clock.t = slot(33, 1, 40)
    const third = await mkItem({ batchId: b, ownerId: owner.id, title: 'Other', artist: folder, artistId })
    await step(ctx, third)
    await actAsProbe(ctx, third)
    const Q = `Portal-Test/Music/Artists/${folder}/${folder} - Other.mp3`
    await ownerSql()`UPDATE ingest_runs SET target_path = ${Q}, upload_attempted_at = now() WHERE item_id = ${third}`
    await control('/__mock/az/seed', { files: [{ path: Q, title: 'Staff SFTP', artist: 'Someone', uploaded_at: Math.floor(Date.now() / 1000) + 5 }] })
    const staff = (await azFile(Q))!
    expect(await step(ctx, third)).toBeNull()
    expect((await item(third)).target_path).toBe(Q.replace(/\.mp3$/, ' (2).mp3'))
    expect((await azFile(Q))!).toMatchObject({ id: staff.id, title: 'Staff SFTP' }) // untouched
    ctx.cleanup()
  })

  it('VER-1: a manager playlist change on a still-verifying song supersedes the ingest verify (no repair, no revert); it goes live', async () => {
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('station_playlist_ids', '[2,3,5]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    const ctx = makeCtx(slot(34))
    const { id, path } = await ingestToVerifying(ctx)
    const mediaId = (await item(id)).media_id as number
    expect((await azFile(path))!.playlists.map((p) => p.id)).toEqual([2])
    await setPlaylistsJob(ctx as unknown as RequestsCtx, { mediaId, chosen: [] })
    expect((await azFile(path))!.playlists).toEqual([])
    const before = ((await control('/__mock/az/calls')) as unknown[]).length
    ctx.clock.t = slot(34, 11, 31)
    expect(await verify(ctx, id)).toBeNull()
    expect(await item(id)).toMatchObject({ status: 'live', media_id: mediaId })
    expect((await azFile(path))!.playlists).toEqual([]) // the manager's change stands
    const writes = ((await control('/__mock/az/calls')) as { method: string }[]).slice(before).filter((c) => c.method !== 'GET')
    expect(writes).toHaveLength(0)
    await ownerSql()`UPDATE jobs SET status = 'done' WHERE kind = 'reverify' AND payload->>'mediaId' = ${String(mediaId)} AND status = 'queued'`
    ctx.cleanup()
  })

  it('v0.2.2 #4: a failed operation’s before_* snapshot never supersedes the ingest verify: lost memberships are still repaired', async () => {
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('station_playlist_ids', '[2,3,5]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    const ctx = makeCtx(slot(36))
    const { id, path } = await ingestToVerifying(ctx)
    const mediaId = (await item(id)).media_id as number
    // A manager playlist change that was refused (or failed its verify)
    // after taking its before_* snapshot: nothing of it applied.
    await ownerSql()`INSERT INTO media_snapshots (media_id, path, title, artist, album, genre, playlist_ids, reason) VALUES (${mediaId}, ${path}, 'x', 'x', '', '', '{}', 'before_playlists')`
    await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/batch`, {
      method: 'PUT',
      headers: { 'X-API-Key': process.env.AZURACAST_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'playlist', files: [path], playlists: [] }),
    })
    ctx.clock.t = slot(36, 11, 31)
    expect((await verify(ctx, id))?.message).toBe('playlists re-applied')
    expect((await azFile(path))!.playlists.map((p) => p.id)).toEqual([2])
    expect((await item(id)).status).toBe('verifying')
    ctx.cleanup()
  })

  it('v0.2.2 #2: the ingest verify waits while the song has an archive or restore in flight (no repair of a half-done archive)', async () => {
    const ctx = makeCtx(slot(37))
    const { id, path } = await ingestToVerifying(ctx)
    const mediaId = (await item(id)).media_id as number
    const [a] = await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, status) VALUES (${mediaId}, ${path}, ${`Portal-Test/Removed/${mediaId}/x.mp3`}, 'archiving') RETURNING id`
    try {
      // the archive cleared the memberships and has not moved the file yet
      await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/batch`, {
        method: 'PUT',
        headers: { 'X-API-Key': process.env.AZURACAST_API_KEY!, 'content-type': 'application/json' },
        body: JSON.stringify({ do: 'playlist', files: [path], playlists: [] }),
      })
      ctx.clock.t = slot(37, 11, 31)
      const before = ((await control('/__mock/az/calls')) as unknown[]).length
      expect((await verify(ctx, id))?.message).toMatch(/archive operation in progress/)
      const writes = ((await control('/__mock/az/calls')) as { method: string }[]).slice(before).filter((c) => c.method !== 'GET')
      expect(writes).toHaveLength(0)
      expect((await azFile(path))!.playlists).toEqual([])
      expect((await item(id)).status).toBe('verifying')
    } finally {
      await ownerSql()`UPDATE archive SET status = 'failed' WHERE id = ${a!.id}`
    }
    ctx.cleanup()
  })

  it('v0.2.2 #6: an upload refused only by the time check (clock skew) names the orphan file to delete in the alert', async () => {
    let drop = true
    const lossy = (async (url: string, init: RequestInit) => {
      if (drop && init.method === 'POST' && String(url).endsWith('/api/station/1/files')) {
        drop = false
        await fetch(url, init)
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      }
      return fetch(url, init)
    }) as unknown as typeof fetch
    const ctx = makeCtx(slot(38), { az: gatedAz({ fetchImpl: lossy }) })
    const owner = await mkUser()
    const folder = `PT Skew ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const id = await mkItem({ batchId: b, ownerId: owner.id, title: 'Skew', artist: folder, artistId })
    await step(ctx, id)
    await actAsProbe(ctx, id)
    await expect(step(ctx, id)).rejects.toMatchObject({ name: 'TimeoutError' })
    const P = `Portal-Test/Music/Artists/${folder}/${folder} - Skew.mp3`
    const orphan = (await azFile(P))!
    // The DB clock runs ahead of AzuraCast's by more than the slack.
    await ownerSql()`UPDATE ingest_runs SET upload_attempted_at = now() + interval '1 hour' WHERE item_id = ${id}`
    ctx.clock.t = slot(38, 3, 20)
    expect(await step(ctx, id)).toBeNull()
    expect(await uploadsTo(folder)).toHaveLength(2)
    expect((await item(id)).target_path).toBe(P.replace(/\.mp3$/, ' (2).mp3'))
    const a = ctx.alerts.find((x) => x.title.includes('not its upload'))!
    expect(a.detail).toMatchObject({ reasons: ['older_than_attempt'], orphanPath: P })
    expect(a.title).toContain(`"${P}" (media id ${orphan.id})`)
    expect(a.title).toMatch(/delete that file in AzuraCast by hand/)
    ctx.cleanup()
  })

  it('F1: an ingest_verify wait that ages out fails the item (terminal state + ticket event), not just the job', async () => {
    const ctx = makeCtx(slot(35))
    const { id } = await ingestToVerifying(ctx)
    const [j] = await ownerSql()`INSERT INTO jobs (kind, payload, status, attempts, created_at) VALUES ('ingest_verify', ${ownerSql().json({ itemId: id })}, 'running', 1, now() - interval '8 days') RETURNING id`
    await runJob(ctx, { id: Number(j!.id), kind: 'ingest_verify', payload: { itemId: id }, attempts: 1, max_attempts: 8, age_s: 8 * 86_400 } as never)
    expect((await ownerSql()`SELECT status FROM jobs WHERE id = ${j!.id}`)[0]!.status).toBe('dead')
    expect(await item(id)).toMatchObject({ status: 'failed' })
    expect((await run(id))!).toMatchObject({ stage: 'failed', last_error: 'wait_expired' })
    expect((await ownerSql()`SELECT 1 FROM jobs WHERE dedupe_key = ${`ticket_item_event:item:${id}:failed`}`).length).toBe(1)
    ctx.cleanup()
  })

  it('artist gate: waits on a pending new-artist item, fails when it is denied or the artist is unknown', async () => {
    const ctx = makeCtx(slot(10))
    const owner = await mkUser()
    const b = await mkBatch(owner.id)
    const name = `Gate ${uniq()}`
    const na = await mkItem({ batchId: b, ownerId: owner.id, kind: 'new_artist', status: 'pending', title: null, artist: name, newArtistName: name })
    const song = await mkItem({ batchId: b, ownerId: owner.id, title: 'Held', artist: name, newArtistName: name })
    expect(await step(ctx, song)).toMatchObject({ message: 'new_artist_pending' })
    expect((await item(song)).status).toBe('approved')
    await ownerSql()`UPDATE items SET status = 'denied' WHERE id = ${na}`
    expect(await step(ctx, song)).toBeNull()
    expect((await run(song))!.last_error).toBe('artist_denied')
    const orphan = await mkItem({ batchId: b, ownerId: owner.id, title: 'Nobody', artist: `Unknown ${uniq()}` })
    await step(ctx, orphan)
    expect((await run(orphan))!.last_error).toBe('artist_unknown')
    ctx.cleanup()
  })
})

// ------------------------------------------------ review + new artist -----

describe.skipIf(!DBENV() || !MOCKS())('review: new artists, metadata edits, attest version', () => {
  afterAll(async () => closeDb())
  const viewer = (u: { id: string; discordId: string }, review = false): Viewer => ({
    userId: u.id,
    discordId: u.discordId,
    name: null,
    perms: new Set(review ? ['submit', 'request', 'review', 'manage'] : ['submit', 'request']) as Viewer['perms'],
  })
  const httpCode = async (p: Promise<unknown>) => {
    try {
      await p
      return 'ok'
    } catch (e) {
      if (e instanceof HttpError) return `${e.status} ${e.code}`
      throw e
    }
  }

  it('submit records the attest version, links known artists and creates one new-artist item per new name', async () => {
    const ctx = makeCtx(slot(11))
    const owner = await mkUser()
    await control('/__mock/tickets/member', { id: owner.discordId, member: true })
    const tag = uniq()
    const known = await mkArtist(`Known ${tag}`)
    const b = await mkBatch(owner.id, { status: 'draft' })
    const s1 = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'A', artist: `Known ${tag} feat. X` })
    const s2 = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'B', artist: `Newbie ${tag} & Y` })
    const s3 = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'C', artist: `newbie ${tag}` })
    const v = viewer(owner)
    expect(await httpCode(submitBatch(ctx.db, v, b, true, 'bad version!'))).toBe('400 bad_attest_version')
    await submitBatch(ctx.db, v, b, true, '2026-09-27')
    expect((await ownerSql()`SELECT attest_version, attested_at FROM batches WHERE id = ${b}`)[0]).toMatchObject({ attest_version: '2026-09-27', attested_at: expect.any(Date) })
    expect((await item(s1)).artist_id).toBe(known)
    expect((await item(s2)).new_artist_name).toBe(`Newbie ${tag}`)
    const nas = await ownerSql()`SELECT * FROM items WHERE batch_id = ${b} AND kind = 'new_artist'`
    expect(nas).toHaveLength(1)
    expect(nas[0]).toMatchObject({ status: 'pending', new_artist_name: `Newbie ${tag}`, prefill: { proposedFolder: `Newbie ${tag}` } })

    // new-artist approval with the reviewer's folder
    const rev = viewer(await mkUser(), true)
    expect(await httpCode(decideItem(ctx.db, rev, nas[0]!.id as number, { decision: 'approve', folder: 'Bad/Folder' }))).toMatch(/^400 folder_/)
    expect(await httpCode(decideItem(ctx.db, rev, nas[0]!.id as number, { decision: 'approve', folder: ' .Newbie' }))).toBe('400 folder_not_sanitized')
    expect(await httpCode(decideItem(ctx.db, rev, s1, { decision: 'approve', folder: 'x' }))).toBe('400 folder_not_allowed')
    expect(await httpCode(decideItem(ctx.db, rev, nas[0]!.id as number, { decision: 'approve', folder: `Newbie ${tag} Music` }))).toBe('ok')
    const art = (await ownerSql()`SELECT * FROM artists WHERE folder = ${`Newbie ${tag} Music`}`)[0]!
    expect(art).toMatchObject({ name: `Newbie ${tag}`, status: 'active' })
    expect((await item(s2)).artist_id).toBe(art.id)
    expect((await item(s3)).artist_id).toBe(art.id)
    // a song approval enqueues ingest
    expect(await httpCode(decideItem(ctx.db, rev, s2, { decision: 'approve' }))).toBe('ok')
    expect((await ownerSql()`SELECT 1 FROM jobs WHERE dedupe_key = ${`ingest:item:${s2}`}`).length).toBe(1)
    ctx.cleanup()
  })

  it('a new-artist folder that already belongs to another artist is refused (409)', async () => {
    const ctx = makeCtx(slot(12))
    const owner = await mkUser()
    const tag = uniq()
    await mkArtist(`Taken ${tag}`)
    const b = await mkBatch(owner.id)
    const na = await mkItem({ batchId: b, ownerId: owner.id, kind: 'new_artist', status: 'pending', title: null, artist: `Other ${tag}`, newArtistName: `Other ${tag}` })
    const rev = viewer(await mkUser(), true)
    expect(await httpCode(decideItem(ctx.db, rev, na, { decision: 'approve', folder: `taken ${tag}` }))).toBe('409 artist_folder_taken')
    expect((await item(na)).status).toBe('pending') // rolled back
    ctx.cleanup()
  })

  it('PATCH metadata: owner while draft, reviewer while pending, 409 afterwards; artist change re-resolves', async () => {
    const ctx = makeCtx(slot(13))
    const owner = await mkUser()
    await control('/__mock/tickets/member', { id: owner.discordId, member: true })
    const other = await mkUser()
    const tag = uniq()
    const known = await mkArtist(`Edit ${tag}`)
    const b = await mkBatch(owner.id, { status: 'draft' })
    const s = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'Orig', artist: `Edit ${tag}` })
    const ov = viewer(owner)
    expect(await httpCode(editItemMetadata(ctx.db, viewer(other), s, { title: 'x' }))).toBe('404 not_found')
    expect(await httpCode(editItemMetadata(ctx.db, ov, s, {}))).toBe('400 invalid_edit')
    expect(await httpCode(editItemMetadata(ctx.db, ov, s, { title: '  ' }))).toBe('400 invalid_edit')
    expect(await httpCode(editItemMetadata(ctx.db, ov, s, { title: 'x', path: 'y' }))).toBe('400 invalid_edit')
    const r1 = await editItemMetadata(ctx.db, ov, s, { title: ' New Title ', album: null })
    expect(r1).toMatchObject({ title: 'New Title', album: null })
    const aud = await ownerSql()`SELECT detail FROM audit_log WHERE action = 'item.edit' AND target_id = ${String(s)}`
    expect(aud.at(-1)!.detail).toMatchObject({ changes: { title: { from: 'Orig', to: 'New Title' }, album: { from: 'Album', to: null } } })

    await submitBatch(ctx.db, ov, b, true, 'v1')
    expect((await item(s)).artist_id).toBe(known)
    expect(await httpCode(editItemMetadata(ctx.db, ov, s, { title: 'late' }))).toBe('409 not_editable')
    const rev = viewer(await mkUser(), true)
    await editItemMetadata(ctx.db, rev, s, { artist: `Brand New ${tag}` })
    expect(await item(s)).toMatchObject({ artist: `Brand New ${tag}`, artist_id: null, new_artist_name: `Brand New ${tag}` })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM items WHERE batch_id = ${b} AND kind = 'new_artist'`)[0]!.n).toBe(1)
    await ownerSql()`UPDATE items SET status = 'denied' WHERE id = ${s}`
    expect(await httpCode(editItemMetadata(ctx.db, rev, s, { title: 'after' }))).toBe('409 not_editable')
    ctx.cleanup()
  })
})

// ------------------------------------------------- library + tickets ------

describe.skipIf(!DBENV() || !MOCKS())('library sync, ticket posts, auto-close, scheduled duties', () => {
  afterAll(async () => closeDb())

  it('library sync caches only the Music/Artists/** surface, seeds artists and records station playlist ids', async () => {
    const ctx = makeCtx(slot(14))
    const tag = uniq()
    const lib = `Lib ${tag}`
    await control('/__mock/az/seed', {
      files: [
        { path: `Music/Artists/${lib}/${lib} - One.mp3`, title: 'One', artist: `${lib} feat. Other`, playlists: [2, 74] },
        { path: `Music/Artists/${lib}/two.m4a`, title: 'Two', artist: `Alias ${tag}` },
        { path: `UNRELEASED-DO NOT ADD TO ROTATION/u${tag}.mp3` },
        { path: `Music/Artists/UNRELEASED ${tag}/u.mp3` },
        { path: `Removed/77/r${tag}.mp3` },
        { path: `Portal-Test/Music/Artists/${lib}/p.mp3` },
        { path: `ADS/Paid/a${tag}.mp3` },
        { path: `Music/Holidays/h${tag}.mp3` },
        { path: `Events/e${tag}.mp3`, playlists: [75] },
      ],
    })
    const r = await syncLibrary(ctx)
    expect(r.library).toBeGreaterThanOrEqual(2)
    const rows = await ownerSql()`SELECT path, playlist_ids FROM library_cache WHERE path LIKE ${`%${tag}%`} ORDER BY path`
    expect(rows.map((x) => x.path)).toEqual([`Music/Artists/${lib}/${lib} - One.mp3`, `Music/Artists/${lib}/two.m4a`])
    expect(rows[0]!.playlist_ids).toEqual([2])
    const art = (await ownerSql()`SELECT name, aliases, status FROM artists WHERE folder = ${lib}`)[0]!
    expect(art).toMatchObject({ name: lib, status: 'active', aliases: [`Alias ${tag}`] })
    expect((await ownerSql()`SELECT count(*)::int AS n FROM artists WHERE folder LIKE ${`%UNRELEASED ${tag}%`}`)[0]!.n).toBe(0)
    const ids = (await ownerSql()`SELECT value FROM settings WHERE key = 'station_playlist_ids'`)[0]!.value as number[]
    expect(ids).toContain(2)
    expect(ids).not.toContain(74)
    expect(ids).not.toContain(75)
    // A playlist id never seen before (maybe a new Events playlist): counted as
    // station 1, recorded as unconfirmed, alerted once (by this sync or the
    // live worker's, whichever saw it first), never again.
    const newId = 900_000 + (Number.parseInt(tag.slice(-5), 36) % 90_000)
    await control('/__mock/az/seed', { files: [{ path: `Music/Artists/${lib}/${lib} - Three.mp3`, title: 'Three', artist: lib, playlists: [newId] }] })
    await syncLibrary(ctx)
    const setting = async (k: string) => (await ownerSql()`SELECT value FROM settings WHERE key = ${k}`)[0]!.value as number[]
    expect(await setting('station_playlist_ids')).toContain(newId)
    expect(await setting('unconfirmed_playlist_ids')).toContain(newId)
    const alertsFor = () => ctx.alerts.filter((a) => a.title.includes(String(newId)))
    expect(alertsFor().length).toBeLessThanOrEqual(1)
    const seen = alertsFor().length
    await syncLibrary(ctx)
    expect(alertsFor()).toHaveLength(seen)
    const pages = ((await control('/__mock/az/calls')) as { method: string; path: string; query: Record<string, string> }[]).filter((c) => c.method === 'GET' && c.path === '/api/station/1/files')
    expect(pages.at(-1)!.query).toMatchObject({ per_page: '100' })
    ctx.cleanup()
  })

  async function openTicket(ctx: TestCtx, ownerDiscordId: string, ref: string) {
    await control('/__mock/tickets/member', { id: ownerDiscordId, member: true })
    return ctx.tickets.openTicket({ categoryKey: 'newsong', openerDiscordId: ownerDiscordId, subject: 'Music submission', card: { title: 't', lines: [], link: { label: 'Open', url: 'https://music.euphoric.fm/' } }, externalRef: ref })
  }
  const ticketOf = async (id: number) => ((await control('/__mock/tickets/tickets')) as { id: number; status: string }[]).find((t) => t.id === id)!
  const messagesOf = async (id: number) => ((await control('/__mock/tickets/messages')) as { key: string; body: string; kind: string }[]).filter((m) => m.key.startsWith(`${id}|`))

  it('batch summary posts every decision (deny reason included), then PATCHes completed; ingest events post', async () => {
    const ctx = makeCtx(Date.now())
    const owner = await mkUser()
    const t = await openTicket(ctx, owner.discordId, `batch:p3-${uniq()}`)
    const b = await mkBatch(owner.id, { ticketId: t.ticketId })
    const ok = await mkItem({ batchId: b, ownerId: owner.id, status: 'live', title: 'Good', artist: 'Band' })
    await mkItem({ batchId: b, ownerId: owner.id, status: 'denied', title: 'Quiet', artist: 'Band' })
    await ownerSql()`UPDATE items SET deny_reason = 'Too quiet' WHERE batch_id = ${b} AND status = 'denied'`
    const pending = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'Wait', artist: 'Band' })
    await batchSummary(ctx, { batchId: b })
    expect((await messagesOf(t.ticketId)).length).toBe(0) // not all decided yet
    await ownerSql()`UPDATE items SET status = 'withdrawn' WHERE id = ${pending}`
    expect(await summarySweep(ctx)).toBeGreaterThanOrEqual(1)
    await batchSummary(ctx, { batchId: b })
    const msgs = await messagesOf(t.ticketId)
    const summary = msgs.find((m) => m.key.endsWith(`summary:batch:${b}`))!
    expect(summary.body).toContain('Review complete')
    expect(summary.body).toContain('Quiet: denied. Reason: Too quiet')
    expect((await ticketOf(t.ticketId)).status).toBe('completed')
    expect((await ownerSql()`SELECT status, ticket_status FROM batches WHERE id = ${b}`)[0]).toMatchObject({ status: 'completed', ticket_status: 'completed' })

    await ticketItemEvent(ctx, { itemId: ok, event: 'live' })
    await ticketItemEvent(ctx, { itemId: ok, event: 'live' }) // idempotent
    const live = (await messagesOf(t.ticketId)).filter((m) => m.key.endsWith(`ingest:item:${ok}:live`))
    expect(live).toHaveLength(1)
    expect(live[0]!.body).toContain('Added to the station: Band - Good')
    ctx.cleanup()
  })

  it('auto-close: a completed batch idle for auto_close_days is closed (tickets:close); recent activity keeps it open', async () => {
    const ctx = makeCtx(Date.now() + 8 * 86_400_000)
    const owner = await mkUser()
    const stale = await openTicket(ctx, owner.discordId, `batch:p3-${uniq()}`)
    const active = await openTicket(ctx, owner.discordId, `batch:p3-${uniq()}`)
    const bStale = await mkBatch(owner.id, { status: 'completed', ticketId: stale.ticketId })
    const bActive = await mkBatch(owner.id, { status: 'completed', ticketId: active.ticketId })
    await ownerSql()`INSERT INTO comments (batch_id, source, visibility, body, created_at) VALUES (${bActive}, 'ticket', 'all', 'still here', ${new Date(ctx.clock.t - 86_400_000)})`
    await autoCloseSweep(ctx)
    const jobs = await ownerSql()`SELECT payload FROM jobs WHERE kind = 'ticket_autoclose' AND (payload->>'batchId')::int IN (${bStale}, ${bActive})`
    expect(jobs.map((j) => (j.payload as { batchId: number }).batchId)).toEqual([bStale])
    await ticketAutoclose(ctx, { batchId: bStale })
    await ticketAutoclose(ctx, { batchId: bActive })
    expect((await ticketOf(stale.ticketId)).status).toBe('closed')
    expect((await ticketOf(active.ticketId)).status).not.toBe('closed')
    expect((await ownerSql()`SELECT status, ticket_status FROM batches WHERE id = ${bStale}`)[0]).toMatchObject({ status: 'closed', ticket_status: 'closed' })
    expect((await ownerSql()`SELECT status FROM batches WHERE id = ${bActive}`)[0]!.status).toBe('completed')
    ctx.cleanup()
  })

  it('final cleanup asks the probe to remove /staging/final files 7 days after live', async () => {
    const ctx = makeCtx(slot(15))
    const { id } = await ingestToVerifying(ctx)
    ctx.clock.t = slot(15, 11, 31)
    await verify(ctx, id)
    await finalCleanup(ctx)
    expect((await run(id))!.final_removed_at).toBeNull() // live, but not for 7 days yet
    ctx.clock.t = slot(22, 12, 0)
    expect(await finalCleanup(ctx)).toBeGreaterThanOrEqual(1)
    const r = (await run(id))!
    expect(r.final_removed_at).not.toBeNull()
    const reqs = readdirSync(ctx.spoolInDir)
      .filter((n) => n.endsWith('.json'))
      .map((n) => JSON.parse(readFileSync(`${ctx.spoolInDir}/${n}`, 'utf8')))
    expect(reqs).toContainEqual(expect.objectContaining({ type: 'cleanup_final', file: r.final_file }))
    ctx.cleanup()
  })

  it('disk push: no-op without a URL; up/down against the 85 % threshold with one', async () => {
    const calls: string[] = []
    const fetchImpl = (async (u: URL) => {
      calls.push(String(u))
      return new Response('{"ok":true}')
    }) as unknown as typeof fetch
    const off = makeCtx(slot(16), { fetchImpl })
    expect(await diskPush(off)).toEqual({ pushed: false })
    expect(calls).toHaveLength(0)
    const on = makeCtx(slot(16), { fetchImpl, kumaDiskPushUrl: 'https://kuma.example/api/push/abc' })
    const r = await diskPush(on)
    expect(r.pushed).toBe(true)
    const u = new URL(calls[0]!)
    expect(u.searchParams.get('status')).toBe(r.percent! >= 85 ? 'down' : 'up')
    expect(u.searchParams.get('msg')).toMatch(/^music staging disk [\d.]+%$/)
    off.cleanup()
    on.cleanup()
  })

  it('behavioural /files/batch contract check: skip without prefix or fixture; ok on the fixture; drift pauses the queues', async () => {
    const tag = uniq()
    const fixture = `Portal-Test/Music/Artists/Contract ${tag}/fixture.mp3`
    await control('/__mock/az/seed', { files: [{ path: fixture, title: 'fixture', artist: 'Portal Test', playlists: [74] }] })
    expect(await batchContractCheck(makeCtx(slot(17), { root: '', contractFixture: fixture }))).toBe('skipped')
    expect(await batchContractCheck(makeCtx(slot(17)))).toBe('skipped')
    expect(await batchContractCheck(makeCtx(slot(17), { contractFixture: 'Portal-Test/Music/Artists/Nope/none.mp3' }))).toBe('skipped')
    const ok = makeCtx(slot(17), { contractFixture: fixture })
    expect(await batchContractCheck(ok)).toBe('ok')
    expect((await azFile(fixture))!.playlists.map((p) => p.id)).toEqual([74]) // untouched
    const call = ((await control('/__mock/az/calls')) as { method: string; body?: { do?: string; files?: string[]; playlists?: number[] } }[])
      .filter((c) => c.method === 'PUT' && c.body?.files?.[0] === fixture)
      .at(-1)!
    expect(call.body).toMatchObject({ do: 'playlist', playlists: [] })

    // A reply that no longer echoes `files` is drift.
    const drifting = (async (url: string, init: RequestInit) => {
      const res = await fetch(url, init)
      if (init.method === 'PUT' && url.endsWith('/files/batch')) return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 })
      return res
    }) as unknown as typeof fetch
    const az = new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(PREFIX_ENV), canaryStationId: 7, fetchImpl: drifting, env: PREFIX_ENV })
    const bad = makeCtx(slot(17), { contractFixture: fixture, az })
    try {
      expect(await batchContractCheck(bad)).toBe('drift')
      const paused = (await ownerSql()`SELECT value FROM settings WHERE key = 'queues_paused'`)[0]!.value
      expect(paused).toMatchObject({ reason: 'batch_contract_drift', problems: ['files echo changed'] })
      expect(bad.alerts.some((a) => a.title.includes('queues paused'))).toBe(true)
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
  })

  it('scheduler: the first tick runs every duty once, then only when due', async () => {
    const ran: string[] = []
    const s = new Scheduler([
      { name: 'a', everyMs: 60_000, run: async () => void ran.push('a') },
      { name: 'b', everyMs: 600_000, run: async () => void ran.push('b') },
      { name: 'boom', everyMs: 60_000, run: async () => { throw new Error('x') } },
    ])
    const ctx = makeCtx(slot(18))
    await s.tick(ctx)
    ctx.clock.t += 30_000
    await s.tick(ctx)
    ctx.clock.t += 31_000
    await s.tick(ctx)
    expect(ran).toEqual(['a', 'b', 'a'])
    ctx.cleanup()
  })
})

// ---------------------------------------------------------- album art -----

describe.skipIf(!DBENV() || !MOCKS())('album art (art contract): item art, finalize cover, library art_url', () => {
  afterAll(async () => closeDb())

  // Rows in the foundation's art_uploads (owner = users.id; a ready row has
  // the probe-published absolute jpeg_path and its sha256).
  const mkArt = async (owner: string, status = 'ready', sha: string | null = 'b'.repeat(64)) => {
    const id = randomUUID()
    const jpegPath = status === 'ready' ? `/staging/art/${id}/cover.jpg` : null
    await ownerSql()`INSERT INTO art_uploads (id, owner, status, jpeg_path, jpeg_sha256) VALUES (${id}, ${owner}, ${status}::art_status, ${jpegPath}, ${sha})`
    return id
  }
  const viewer = (u: { id: string; discordId: string }, review = false): Viewer => ({
    userId: u.id,
    discordId: u.discordId,
    name: null,
    perms: new Set(review ? ['submit', 'request', 'review', 'manage'] : ['submit', 'request']) as Viewer['perms'],
  })
  const code = async (p: Promise<unknown>) => {
    try {
      await p
      return 'ok'
    } catch (e) {
      if (e instanceof HttpError) return `${e.status} ${e.code}`
      throw e
    }
  }

  it('PUT/DELETE item art: own ready upload only, same editors and 409 rule as the metadata PATCH', async () => {
    const owner = await mkUser()
    await control('/__mock/tickets/member', { id: owner.discordId, member: true })
    const other = await mkUser()
    const rev = await mkUser()
    const ctx = makeCtx(slot(20))
    await mkArtist(`Art ${uniq()}`)
    const b = await mkBatch(owner.id, { status: 'draft' })
    const s = await mkItem({ batchId: b, ownerId: owner.id, status: 'pending', title: 'Pic', artist: 'Band' })
    const ov = viewer(owner)
    const mine = await mkArt(owner.id)
    expect(await code(setItemArt(ctx.db, ov, s, { artId: 'nope' }))).toBe('400 invalid_art')
    expect(await code(setItemArt(ctx.db, ov, s, { artId: await mkArt(other.id) }))).toBe('404 not_found') // not the viewer's upload
    expect(await code(setItemArt(ctx.db, ov, s, { artId: await mkArt(owner.id, 'processing', null) }))).toBe('409 art_not_ready')
    expect(await code(setItemArt(ctx.db, viewer(other), s, { artId: mine }))).toBe('404 not_found')
    expect(await setItemArt(ctx.db, ov, s, { artId: mine })).toMatchObject({ customArtId: mine })
    expect((await clearItemArt(ctx.db, ov, s)).customArtId).toBeNull()
    await setItemArt(ctx.db, ov, s, { artId: mine })
    expect((await ownerSql()`SELECT action FROM audit_log WHERE target_id = ${String(s)} AND action LIKE 'item.art.%' ORDER BY id`).map((r) => r.action)).toEqual(['item.art.set', 'item.art.clear', 'item.art.set'])

    await ownerSql()`UPDATE batches SET status = 'submitted', attested_at = now() WHERE id = ${b}`
    expect(await code(setItemArt(ctx.db, ov, s, { artId: mine }))).toBe('409 not_editable') // owner after submit
    const rv = viewer(rev, true)
    const revArt = await mkArt(rev.id)
    expect(await setItemArt(ctx.db, rv, s, { artId: revArt })).toMatchObject({ customArtId: revArt }) // reviewer while pending
    await ownerSql()`UPDATE items SET status = 'approved' WHERE id = ${s}`
    expect(await code(clearItemArt(ctx.db, rv, s))).toBe('409 not_editable')
    ctx.cleanup()
  })

  it('finalize gets the EFFECTIVE cover: custom art by id, else the embedded cover; missing custom art fails', async () => {
    const ctx = makeCtx(slot(21))
    const owner = await mkUser()
    const folder = `PT Art ${uniq()}`
    const artistId = await mkArtist(folder)
    const b = await mkBatch(owner.id)
    const withArt = await mkItem({ batchId: b, ownerId: owner.id, title: 'Custom', artist: folder, artistId })
    const art = await mkArt(owner.id, 'ready', 'c'.repeat(64))
    const embedded = await mkItem({ batchId: b, ownerId: owner.id, title: 'Embedded', artist: folder, artistId })
    const coverFile = `cover-${randomUUID()}.jpg`
    await ownerSql()`UPDATE items SET custom_art_id = ${art} WHERE id = ${withArt}`
    await ownerSql()`UPDATE items SET cover_file = ${coverFile}, cover_sha256 = ${'d'.repeat(64)} WHERE id = ${embedded}`
    await step(ctx, withArt)
    await step(ctx, embedded)
    const reqOf = async (id: number) => JSON.parse(readFileSync(join(ctx.spoolInDir, `${(await run(id))!.finalize_request_id}.json`), 'utf8'))
    expect((await reqOf(withArt)).cover).toEqual({ artId: art, sha256: 'c'.repeat(64) })
    expect((await reqOf(embedded)).cover).toEqual({ file: coverFile, sha256: 'd'.repeat(64) })

    const gone = await mkItem({ batchId: b, ownerId: owner.id, title: 'Gone', artist: folder, artistId })
    await ownerSql()`UPDATE items SET custom_art_id = ${await mkArt(owner.id, 'rejected', null)} WHERE id = ${gone}`
    expect(await step(ctx, gone)).toBeNull()
    expect((await run(gone))!.last_error).toBe('custom_art_unavailable')
    ctx.cleanup()
  })

  it('probe finalize embeds the custom art JPEG as APIC after verifying its sha; a wrong sha is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fin-'))
    const dirs = { uploads: join(root, 'uploads'), work: join(root, 'work'), final: join(root, 'final'), art: join(root, 'art') }
    for (const d of Object.values(dirs)) mkdirSync(d)
    const upload = randomUUID().replace(/-/g, '')
    copyFileSync(fx('raw35.mp3'), join(dirs.uploads, upload))
    const mp3Sha = createHash('sha256').update(readFileSync(join(dirs.uploads, upload))).digest('hex')
    const artId = randomUUID()
    mkdirSync(join(dirs.art, artId))
    const jpg = join(dirs.art, artId, 'cover.jpg')
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', fx('cover.png'), '-vf', 'scale=320:-1', jpg])
    const jpgBytes = readFileSync(jpg)
    const jpgSha = createHash('sha256').update(jpgBytes).digest('hex')
    const base = { v: 1 as const, type: 'finalize' as const, upload, approvedSha256: mp3Sha, tags: { title: 'Art Song', artist: 'Band', album: '', genre: '' } }
    const ok = await runFinalize({ ...base, id: randomUUID(), cover: { artId, sha256: jpgSha } }, dirs)
    expect(ok).toMatchObject({ ok: true })
    const out = readFileSync(join(dirs.final, (ok as { file: string }).file))
    expect(out.includes(jpgBytes)).toBe(true) // APIC = the exact verified JPEG
    const bad = await runFinalize({ ...base, id: randomUUID(), cover: { artId, sha256: '0'.repeat(64) } }, dirs)
    expect(bad).toMatchObject({ ok: false, error: 'cover_sha_mismatch' })
    writeFileSync(jpg, Buffer.from('not a jpeg')) // swapped after approval
    const swapped = await runFinalize({ ...base, id: randomUUID(), cover: { artId, sha256: jpgSha } }, dirs)
    expect(swapped).toMatchObject({ ok: false, error: 'cover_sha_mismatch' })
  })

  it('library sync fills art_url: AzuraCast art on its own origin, else /api/station/<shortcode>/art/<unique_id>', async () => {
    expect(artUrlFor({ unique_id: 'u1', art: 'https://euphoric.fm/api/station/euphoricfm/art/u1-99.jpg' }, 'euphoricfm')).toBe('https://euphoric.fm/api/station/euphoricfm/art/u1-99.jpg')
    expect(artUrlFor({ unique_id: 'u2', art: 'https://evil.example/api/x.jpg' }, 'euphoricfm')).toBe('https://euphoric.fm/api/station/euphoricfm/art/u2')
    expect(artUrlFor({ unique_id: 'u3', art: null }, 'euphoricfm')).toBe('https://euphoric.fm/api/station/euphoricfm/art/u3')
    const ctx = makeCtx(slot(22))
    const tag = uniq()
    await control('/__mock/az/seed', {
      files: [
        { path: `Music/Artists/ArtLib ${tag}/a.mp3`, artist: `ArtLib ${tag}` },
        { path: `Music/Artists/ArtLib ${tag}/b.mp3`, artist: `ArtLib ${tag}` },
      ],
    })
    await syncLibrary(ctx)
    // The mock, like AzuraCast, always lists `art` as the public art route
    // (<unique_id>-<art_updated_at>.jpg); the fallback is covered above.
    const rows = await ownerSql()`SELECT path, unique_id, art_url FROM library_cache WHERE path LIKE ${`%ArtLib ${tag}%`} ORDER BY path`
    expect(rows).toHaveLength(2)
    for (const r of rows) expect(r.art_url).toBe(`https://euphoric.fm/api/station/euphoricfm/art/${r.unique_id}-0.jpg`)
    ctx.cleanup()
  })
})
