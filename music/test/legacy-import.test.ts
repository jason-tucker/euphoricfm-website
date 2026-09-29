// v0.3.6: the UNRELEASED import (dry run, per-file archive job, pacing,
// resume, reconciler), the release of an Unreleased song into an artist
// folder, and the Archived songs visibility / member links, against the
// upstream-faithful AzuraCast mock and the real music-db. Handlers run
// in-process with an injected clock; follow-up jobs are captured, and web
// actions that queue a job run while the queues are paused (the live
// music-worker never claims them).
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AzuraCastClient, type StationMedia } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import type { Viewer } from '@/server/authz/predicates'
import { closeDb, getDb } from '@/server/db/client'
import { enqueueImportJobs, PLAN_KEY, summarize } from '@/server/requests/legacy-import'
import { legacyImport, linkArchive, linkCandidates, releaseSong, restoreSong, unlinkArchive } from '@/server/requests/manage'
import { ARCHIVED_PAGE_SIZE, archivedSongs } from '@/server/ui/browse'
import { TicketsClient } from '@/server/tickets/client'
import { RetryLater } from '@/worker/handlers'
import { archiveMedia, importLegacyArchive, reconcileArchive, restoreMedia, reverify, runRequestJob, type RequestsCtx } from '@/worker/requests/jobs'
import { formatPlan, legacyImportPlanJob, planLegacyImport } from '@/worker/requests/legacy'
import { DBENV, MOCKS } from './helpers/env'
import { ownerSql } from './helpers/db'
import { control } from './helpers/http'

const ORIGIN = 'https://music.euphoric.fm'
const PREFIX = 'Portal-Test/'
const L = `${PREFIX}UNRELEASED-DO NOT ADD TO ROTATION`
const ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: PREFIX }
const RUN = Date.now().toString(36)
const IN_WINDOW = Date.UTC(2026, 8, 27, 12, 2, 0) // :x2:00, phase 60 s
const SLOT = 300_000

type Scheduled = { kind: string; payload: Record<string, unknown>; opts: { dedupeKey?: string; runAfter?: Date } }
type Call = { method: string; path: string; body?: Record<string, unknown> }

describe.skipIf(!(DBENV() && MOCKS()))('v0.3.6 UNRELEASED import, release and visibility (mock AzuraCast, Portal-Test/ root)', () => {
  let ctx: RequestsCtx
  let scheduled: Scheduled[]
  let alerts: string[]
  let clock = IN_WINDOW
  let managerId: string
  const art = (folder: string) => `${PREFIX}Music/Artists/${folder}`

  async function seed(path: string, f: Partial<{ title: string; artist: string; playlists: number[]; song_id: string }> = {}): Promise<StationMedia> {
    await control('/__mock/az/seed', { files: [{ path, title: 'T', artist: 'A', playlists: [], ...f }] })
    return file(path)
  }
  async function file(path: string): Promise<StationMedia> {
    const f = ((await control('/__mock/az/files')) as StationMedia[]).find((x) => x.path === path)
    if (!f) throw new Error(`mock has no ${path}`)
    return f
  }
  const fileById = async (id: number) => ((await control('/__mock/az/files')) as StationMedia[]).find((x) => x.id === id)
  const ids = (m: StationMedia | undefined) => (m?.playlists ?? []).map((p) => p.id).sort((a, b) => a - b)
  const calls = async () => (await control('/__mock/az/calls')) as Call[]
  const writes = async () => (await calls()).filter((c) => c.method !== 'GET').length
  const archiveRow = async (mediaId: number) => (await ownerSql()`SELECT * FROM archive WHERE media_id = ${mediaId} ORDER BY id DESC LIMIT 1`)[0]
  const take = (kind: string) => {
    const i = scheduled.findIndex((s) => s.kind === kind)
    if (i < 0) throw new Error(`nothing scheduled of kind ${kind}: ${scheduled.map((s) => s.kind).join(',')}`)
    return scheduled.splice(i, 1)[0]!
  }
  async function artist(name: string, folder: string, status = 'active') {
    const [r] = await ownerSql()`INSERT INTO artists (name, folder, status) VALUES (${name}, ${folder}, ${status}::artist_status) RETURNING id`
    return r!.id as number
  }
  async function user(prefix: string) {
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id, name) VALUES (${randomUUID()}, ${prefix + String(Date.now()).padStart(17, '0').slice(-17) + String(Math.floor(Math.random() * 90) + 10)}, ${`${prefix}-${RUN}`}) RETURNING id, discord_id`
    return { id: u!.id as string, discordId: u!.discord_id as string }
  }
  const viewer = (id: string, perms: string[]): Viewer => ({ userId: id, discordId: '500000000000000009', name: null, perms: new Set(perms) as Viewer['perms'] })
  const manager = () => viewer(managerId, ['submit', 'request', 'review', 'manage'])
  // One import, then the next scan-window slot.
  async function imp(m: StationMedia, c: RequestsCtx = ctx) {
    await importLegacyArchive(c, { mediaId: m.id, path: m.path })
    clock += SLOT
  }
  function ctxWith(f: (url: string, init: RequestInit) => Promise<Response>): RequestsCtx {
    const az = new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(ENV), canaryStationId: 7, env: ENV, fetchImpl: f as unknown as typeof fetch })
    return { ...ctx, azuracast: az }
  }
  const batchOf = (url: string, init: RequestInit): string | null =>
    init.method === 'PUT' && url.endsWith('/api/station/1/files/batch') ? ((JSON.parse(String(init.body)) as { do?: string }).do ?? null) : null
  // A web action that queues a worker job, run while the queues are paused
  // (the live worker never claims a mutating job then); handed back here.
  async function webQueued<T>(fn: () => Promise<T>, kind: string, n = 1): Promise<{ result: T; payloads: Record<string, unknown>[]; rows: { payload: Record<string, unknown>; run_after: Date; dedupe_key: string }[] }> {
    const max = ((await ownerSql()`SELECT coalesce(max(id), 0)::bigint AS max FROM jobs`)[0]!.max as string | number).toString()
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"test_web_enqueue"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      const result = await fn()
      const rows = await ownerSql()`UPDATE jobs SET status = 'done' WHERE id > ${max}::bigint AND kind = ${kind} AND status = 'queued' RETURNING payload, run_after, dedupe_key`
      expect(rows).toHaveLength(n)
      return { result, payloads: rows.map((r) => r.payload as Record<string, unknown>), rows: rows as never }
    } finally {
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
  }

  beforeAll(async () => {
    ctx = {
      db: getDb(process.env.TEST_APP_DATABASE_URL, 2),
      azuracast: new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(ENV), canaryStationId: 7, env: ENV }),
      tickets: new TicketsClient({ baseUrl: 'http://tickets.invalid', key: 'k', portalOrigin: ORIGIN, fetchImpl: (async () => new Response('{}', { status: 201 })) as unknown as typeof fetch }),
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
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('assignable_playlist_ids', '[2,3]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    managerId = (await user('7')).id
  })
  beforeEach(async () => {
    scheduled = []
    alerts = []
    clock = IN_WINDOW
    await ownerSql()`DELETE FROM settings WHERE key = 'legacy_import_slot'`
    await control('/__mock/az/nowplaying', {})
  })
  afterAll(async () => {
    await ownerSql()`UPDATE settings SET value = '[2]'::jsonb WHERE key = 'assignable_playlist_ids'`
    await ownerSql()`DELETE FROM settings WHERE key = 'legacy_import_slot'`
    await control('/__mock/az/nowplaying', {})
    await closeDb()
  })

  it('dry run: every planned move (source → Removed/<id>/name), the playlists each file loses, refusals and skips; nothing is written', async () => {
    const a = await seed(`${L}/kokoro_-_aodhi_-_something-${RUN}.m4a`, { artist: 'Aodhi', title: `Something ${RUN}` })
    const b = await seed(`${L}/save_me_from_me-${RUN}.mp3`, { artist: 'Jacob Gallagher', title: `Save Me From Me ${RUN}`, playlists: [2] })
    const c = await seed(`${L}/Music/KOKORO-${RUN}/kokoro_-_kokoro_-_rage-${RUN}.m4a`, { artist: 'Band Scanario', title: `Rage ${RUN}` })
    const e = await seed(`${L}/ev-${RUN}.mp3`, { artist: 'Ev', title: `Ev ${RUN}`, playlists: [2, 74] })
    const flac = await seed(`${L}/flac-${RUN}.flac`, { artist: 'F', title: 'F' })
    await control('/__mock/az/unscanned', { path: `${L}/processing-${RUN}.mp3` })
    const before = await writes()
    const plan = await planLegacyImport(ctx)
    expect(await writes()).toBe(before)
    const mine = plan.files.filter((f) => f.path.includes(RUN))
    expect(mine.map((f) => [f.mediaId, f.action])).toEqual(
      expect.arrayContaining([
        [a.id, 'archive'],
        [b.id, 'archive'],
        [c.id, 'archive'],
        [e.id, 'refuse_events'],
      ]),
    )
    expect(mine).toHaveLength(4)
    expect(mine.find((f) => f.mediaId === b.id)).toMatchObject({ path: b.path, dest: `${PREFIX}Removed/${b.id}/save_me_from_me-${RUN}.mp3`, playlistIds: [2], foreignPlaylistIds: [] })
    expect(mine.find((f) => f.mediaId === c.id)).toMatchObject({ dest: `${PREFIX}Removed/${c.id}/kokoro_-_kokoro_-_rage-${RUN}.m4a`, playlistIds: [] })
    expect(mine.find((f) => f.mediaId === e.id)).toMatchObject({ playlistIds: [2], foreignPlaylistIds: [74] })
    expect(plan.others).toEqual(expect.arrayContaining([
      { path: flac.path, type: 'media', reason: 'unsupported_path' },
      { path: `${L}/processing-${RUN}.mp3`, type: 'other', reason: 'not_scanned' },
    ]))
    const text = formatPlan({ ...plan, files: mine, others: plan.others.filter((o) => o.path.includes(RUN)), summary: summarize(mine, plan.others.filter((o) => o.path.includes(RUN))) })
    expect(text).toContain('DRY RUN (nothing was written)')
    expect(text).toContain(`→ ${PREFIX}Removed/${b.id}/save_me_from_me-${RUN}.mp3`)
    expect(text).toContain('clear playlists 2 (General Rotation) (comes off the air)')
    expect(text).toContain('REFUSED: in Events playlist(s) 74')
    expect(text).toContain('4 media file(s): 3 to archive (1 of them leave rotation), 1 refused')
    // The dry-run example the release notes quote (harness data dir).
    if (process.env.TEST_DATA_DIR) {
      mkdirSync(process.env.TEST_DATA_DIR, { recursive: true })
      writeFileSync(`${process.env.TEST_DATA_DIR}/legacy-dry-run.txt`, `${text}\n`)
    }
  })

  it('the plan job stores the plan under the manager’s request id only (read-only), and the confirm queues exactly that plan, once, paced', async () => {
    const m = await seed(`${L}/planned-${RUN}.m4a`, { title: `Planned ${RUN}` })
    const id = randomUUID()
    await ownerSql()`INSERT INTO settings (key, value) VALUES (${PLAN_KEY}, ${ownerSql().json({ id, status: 'queued', requestedAt: new Date().toISOString(), requestedBy: managerId })}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    const before = await writes()
    await legacyImportPlanJob(ctx, { planId: randomUUID() }) // not the current request: nothing stored
    expect(((await ownerSql()`SELECT value FROM settings WHERE key = ${PLAN_KEY}`)[0]!.value as { status: string }).status).toBe('queued')
    await legacyImportPlanJob(ctx, { planId: id })
    expect(await writes()).toBe(before)
    const state = (await ownerSql()`SELECT value FROM settings WHERE key = ${PLAN_KEY}`)[0]!.value as { status: string; plan: { files: { mediaId: number; action: string }[] } }
    expect(state.status).toBe('ready')
    const toGo = state.plan.files.filter((f) => f.action === 'archive' || f.action === 'refuse_events')
    expect(toGo.some((f) => f.mediaId === m.id)).toBe(true)
    // Members cannot; a stale id cannot; the right id queues one job per file, 300 s apart.
    await expect(legacyImport(ctx.db, viewer(managerId, ['submit', 'review']), { action: 'run', planId: id })).rejects.toMatchObject({ status: 403 })
    await expect(legacyImport(ctx.db, manager(), { action: 'run', planId: randomUUID() })).rejects.toMatchObject({ status: 409, code: 'plan_stale' })
    const { result, rows } = await webQueued(() => legacyImport(ctx.db, manager(), { action: 'run', planId: id }), 'import_legacy_archive', toGo.length)
    expect(result).toMatchObject({ planId: id, queued: toGo.length })
    const mineJob = rows.find((r) => r.payload.mediaId === m.id)!
    expect(mineJob.payload).toMatchObject({ mediaId: m.id, path: m.path, planId: id, actorUserId: managerId })
    expect(mineJob.dedupe_key).toBe(`import_legacy_archive:${id}:${m.id}`)
    const times = rows.map((r) => new Date(r.run_after).getTime()).sort((x, y) => x - y)
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(SLOT - 1000)
    await expect(legacyImport(ctx.db, manager(), { action: 'run', planId: id })).rejects.toMatchObject({ status: 409, code: 'plan_already_run' })
    // Queuing the same plan's files again never duplicates a job.
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"test_dedupe"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      const f = [{ mediaId: m.id, path: m.path, dest: '', artist: null, title: null, lengthS: null, playlistIds: [], foreignPlaylistIds: [], action: 'archive' as const }]
      await ctx.db.transaction((tx) => enqueueImportJobs(tx, id, f, { actorUserId: null, actorDiscordId: null }, Date.now(), 'cli'))
      expect((await ownerSql()`SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = ${`import_legacy_archive:${id}:${m.id}`}`)[0]!.n).toBe(1)
      // …and while an import job is queued, no new plan can be confirmed.
      await ctx.db.transaction((tx) => enqueueImportJobs(tx, randomUUID(), f, { actorUserId: null, actorDiscordId: null }, Date.now(), 'cli'))
      const id2 = randomUUID()
      await ownerSql()`UPDATE settings SET value = ${ownerSql().json({ ...state, id: id2, status: 'ready', readyAt: new Date().toISOString() })} WHERE key = ${PLAN_KEY}`
      await expect(legacyImport(ctx.db, manager(), { action: 'run', planId: id2 })).rejects.toMatchObject({ status: 409, code: 'import_in_progress' })
    } finally {
      await ownerSql()`UPDATE jobs SET status = 'done' WHERE kind = 'import_legacy_archive' AND status = 'queued'`
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
  })

  it('an m4a with no playlists: same id into Removed/<id>/, no playlist write, row origin legacy_unreleased, after_archive + re-verify', async () => {
    const m = await seed(`${L}/Music/KOKORO-${RUN}/kokoro_-_kokoro_-_circles-${RUN}.m4a`, { artist: 'Band Scanario', title: 'Circles' })
    const c0 = (await calls()).length
    await imp(m)
    const after = await fileById(m.id)
    expect(after).toMatchObject({ id: m.id, unique_id: m.unique_id, path: `${PREFIX}Removed/${m.id}/kokoro_-_kokoro_-_circles-${RUN}.m4a`, title: 'Circles', artist: 'Band Scanario' })
    const mine = (await calls()).slice(c0).filter((c) => c.method !== 'GET')
    expect(mine.map((c) => c.body?.do)).toEqual(['move']) // no REPLACE [] for a file with no membership, no metadata PUT
    expect(mine[0]!.body).toMatchObject({ do: 'move', files: [m.path], dirs: [], currentDirectory: `${L}/Music/KOKORO-${RUN}`, directory: `${PREFIX}Removed/${m.id}` })
    const row = (await archiveRow(m.id))!
    expect(row).toMatchObject({ status: 'archived', origin: 'legacy_unreleased', original_path: m.path, archived_path: after!.path, request_id: null, reason: null })
    const snaps = await ownerSql()`SELECT reason, path, playlist_ids FROM media_snapshots WHERE media_id = ${m.id} ORDER BY id`
    expect(snaps.map((s) => s.reason)).toEqual(['before_archive', 'after_archive'])
    const rv = take('reverify')
    expect(rv.payload).toMatchObject({ mediaId: m.id, attempt: 0 })
    await reverify(ctx, rv.payload as never) // Removed/: checked, never written
    const acts = (await ownerSql()`SELECT action FROM audit_log WHERE (target_type = 'archive' AND target_id = ${String(row.id)}) OR (target_type = 'media' AND target_id = ${String(m.id)}) ORDER BY id`).map((r) => r.action)
    expect(acts).toEqual(expect.arrayContaining(['legacy_import.start', 'media.archive']))
  })

  it('the file in playlist 2 comes off the air: memberships cleared first (legacy REPLACE []), the snapshot keeps [2]', async () => {
    const m = await seed(`${L}/save_me_from_me-b-${RUN}.mp3`, { artist: 'Jacob Gallagher', title: 'Save Me From Me', playlists: [2, 3] })
    const c0 = (await calls()).length
    await imp(m)
    const after = await fileById(m.id)
    expect(after!.path).toBe(`${PREFIX}Removed/${m.id}/save_me_from_me-b-${RUN}.mp3`)
    expect(ids(after)).toEqual([])
    const batches = (await calls()).slice(c0).filter((c) => c.path === '/api/station/1/files/batch')
    expect(batches.map((c) => c.body)).toEqual([
      { do: 'playlist', files: [m.path], dirs: [], currentDirectory: L, playlists: [] },
      { do: 'move', files: [m.path], dirs: [], currentDirectory: L, directory: `${PREFIX}Removed/${m.id}` },
    ])
    const row = (await archiveRow(m.id))!
    expect((await ownerSql()`SELECT playlist_ids, reason, title, artist FROM media_snapshots WHERE id = ${row.snapshot_id}`)[0]).toMatchObject({ playlist_ids: [2, 3], reason: 'before_archive', title: 'Save Me From Me', artist: 'Jacob Gallagher' })
    const audit = (await ownerSql()`SELECT detail FROM audit_log WHERE action = 'media.archive' AND target_id = ${String(m.id)} ORDER BY id DESC LIMIT 1`)[0]!
    expect(audit.detail).toMatchObject({ origin: 'legacy_unreleased', playlistsCleared: [2, 3], from: m.path })
  })

  it('a file on air (now playing or next) is deferred with nothing written, then imported', async () => {
    const m = await seed(`${L}/on_air-${RUN}.m4a`, { artist: 'Sophie', title: `Home ${RUN}`, playlists: [2] })
    const songId = (m as unknown as { song_id: string }).song_id
    const before = await writes()
    for (const np of [{ now_playing: { song: { id: songId } } }, { now_playing: { song: { id: 'x' } }, playing_next: { song: { id: songId } } }]) {
      await control('/__mock/az/nowplaying', np)
      const e = await importLegacyArchive(ctx, { mediaId: m.id, path: m.path }).catch((x) => x)
      expect(e).toBeInstanceOf(RetryLater)
      expect(e.message).toBe('now playing')
    }
    expect(await writes()).toBe(before)
    expect(await archiveRow(m.id)).toBeUndefined()
    expect(ids(await fileById(m.id))).toEqual([2]) // still on air, untouched
    await control('/__mock/az/nowplaying', {})
    await imp(m)
    expect((await fileById(m.id))!.path).toBe(`${PREFIX}Removed/${m.id}/on_air-${RUN}.m4a`)
  })

  it('a file in an Events (station 14) playlist is refused with an alert: nothing written, no row', async () => {
    const m = await seed(`${L}/events-${RUN}.mp3`, { artist: 'Ev', title: 'Ev', playlists: [2, 76] })
    const before = await writes()
    await runRequestJob(ctx, { id: 1, kind: 'import_legacy_archive', payload: { mediaId: m.id, path: m.path }, attempts: 1, max_attempts: 8 })
    expect(await writes()).toBe(before)
    expect(await archiveRow(m.id)).toBeUndefined()
    expect(await fileById(m.id)).toMatchObject({ path: m.path })
    expect(ids(await fileById(m.id))).toEqual([2, 76])
    expect(alerts).toContain('import_legacy_archive failed (in_events_playlists)')
    const a = (await ownerSql()`SELECT detail FROM audit_log WHERE action = 'job.import_legacy_archive.failed' ORDER BY id DESC LIMIT 1`)[0]!
    expect(a.detail).toMatchObject({ code: 'in_events_playlists', payload: { mediaId: m.id } })
  })

  it('crash between the clear and the move: the re-run resumes from the ORIGINAL snapshot; a stale row is rolled back by the reconciler', async () => {
    const crashAfterClear = (id: number) => {
      let cleared = false
      let failed = false
      return ctxWith(async (url, init) => {
        if (batchOf(url, init) === 'playlist') {
          const r = await fetch(url, init)
          cleared = true
          return r
        }
        if (cleared && !failed && init.method === 'GET' && url.endsWith(`/api/station/1/file/${id}`)) {
          failed = true
          throw new TypeError('fetch failed')
        }
        return fetch(url, init)
      })
    }
    // (a) resumed by the job's retry
    const m = await seed(`${L}/crash-${RUN}.mp3`, { title: 'Crash', playlists: [2, 3] })
    await expect(importLegacyArchive(crashAfterClear(m.id), { mediaId: m.id, path: m.path })).rejects.toBeInstanceOf(TypeError)
    expect(await fileById(m.id)).toMatchObject({ path: m.path, playlists: [] })
    expect(await archiveRow(m.id)).toMatchObject({ status: 'archiving', origin: 'legacy_unreleased' })
    await importLegacyArchive(ctx, { mediaId: m.id, path: m.path })
    const row = (await archiveRow(m.id))!
    expect(row.status).toBe('archived')
    expect((await fileById(m.id))!.path).toBe(`${PREFIX}Removed/${m.id}/crash-${RUN}.mp3`)
    expect((await ownerSql()`SELECT playlist_ids FROM media_snapshots WHERE id = ${row.snapshot_id}`)[0]!.playlist_ids).toEqual([2, 3])
    expect((await ownerSql()`SELECT count(*)::int AS n FROM media_snapshots WHERE media_id = ${m.id} AND reason = 'before_archive'`)[0]!.n).toBe(1)
    clock += SLOT
    // (b) the job is gone: the reconciler puts the memberships back on the
    // file still in UNRELEASED (through the legacy method) and closes the row.
    const m2 = await seed(`${L}/crash2-${RUN}.m4a`, { title: 'Crash 2', playlists: [2] })
    await expect(importLegacyArchive(crashAfterClear(m2.id), { mediaId: m2.id, path: m2.path })).rejects.toBeInstanceOf(TypeError)
    const r2 = (await archiveRow(m2.id))!
    expect(r2.status).toBe('archiving')
    const c0 = (await calls()).length
    await reconcileArchive(ctx, { archiveId: r2.id as number, manual: true })
    expect(await fileById(m2.id)).toMatchObject({ path: m2.path })
    expect(ids(await fileById(m2.id))).toEqual([2])
    expect(await archiveRow(m2.id)).toMatchObject({ id: r2.id, status: 'failed' })
    expect((await calls()).slice(c0).filter((c) => c.method !== 'GET').map((c) => c.body)).toEqual([{ do: 'playlist', files: [m2.path], dirs: [], currentDirectory: L, playlists: [2] }])
    // A later import starts fresh (new row, new snapshot).
    clock += SLOT
    await imp(m2)
    const again = (await archiveRow(m2.id))!
    expect(again.id).not.toBe(r2.id)
    expect(again).toMatchObject({ status: 'archived', origin: 'legacy_unreleased' })
  })

  it('re-running an imported file is a no-op (no write, no second row or snapshot); later plans leave it out', async () => {
    const m = await seed(`${L}/twice-${RUN}.m4a`, { title: 'Twice', playlists: [3] })
    await imp(m)
    const before = await writes()
    await imp(m)
    await runRequestJob(ctx, { id: 2, kind: 'import_legacy_archive', payload: { mediaId: m.id, path: m.path }, attempts: 1, max_attempts: 8 })
    expect(await writes()).toBe(before)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM archive WHERE media_id = ${m.id}`)[0]!.n).toBe(1)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM media_snapshots WHERE media_id = ${m.id} AND reason = 'before_archive'`)[0]!.n).toBe(1)
    expect(alerts).toEqual([])
    const plan = await planLegacyImport(ctx)
    expect(plan.files.some((f) => f.mediaId === m.id)).toBe(false) // no longer in the folder
  })

  it('one file per scan-window slot: a second file waits for the next slot', async () => {
    const a = await seed(`${L}/slot-a-${RUN}.m4a`)
    const b = await seed(`${L}/slot-b-${RUN}.m4a`)
    await importLegacyArchive(ctx, { mediaId: a.id, path: a.path })
    const before = await writes()
    const e = await importLegacyArchive(ctx, { mediaId: b.id, path: b.path }).catch((x) => x)
    expect(e).toBeInstanceOf(RetryLater)
    expect(e).toMatchObject({ exact: true, delayS: 270 }) // :x2:00 → next slot opens at :x6:30
    expect(await writes()).toBe(before)
    expect(await archiveRow(b.id)).toBeUndefined()
    clock += SLOT
    await importLegacyArchive(ctx, { mediaId: b.id, path: b.path })
    expect(await archiveRow(b.id)).toMatchObject({ status: 'archived' })
  })

  it('nothing else may touch the folder: the portal archive refuses it, a planned path must match, Restore is refused for a legacy row', async () => {
    const m = await seed(`${L}/portal-${RUN}.mp3`, { playlists: [2] })
    const before = await writes()
    await expect(archiveMedia(ctx, { mediaId: m.id })).rejects.toMatchObject({ code: 'target_not_allowed' })
    await expect(importLegacyArchive(ctx, { mediaId: m.id, path: `${L}/other-${RUN}.mp3` })).rejects.toMatchObject({ code: 'legacy_path_changed' })
    expect(alerts.some((a) => a.includes('no longer at its planned path'))).toBe(true)
    await expect(importLegacyArchive(ctx, { mediaId: m.id, path: `${PREFIX}Music/Artists/X/${RUN}.mp3` })).rejects.toMatchObject({ code: 'path_legacy_source_pattern' })
    await expect(importLegacyArchive(ctx, { mediaId: m.id, path: `UNRELEASED-DO NOT ADD TO ROTATION/portal-${RUN}.mp3` })).rejects.toMatchObject({ code: 'path_legacy_source_pattern' })
    expect(await writes()).toBe(before)
    await imp(m)
    const row = (await archiveRow(m.id))!
    await expect(restoreSong(ctx.db, manager(), row.id as number)).rejects.toMatchObject({ status: 409, code: 'release_required' })
  })

  it('release: into Music/Artists/<artist>/ with exactly the chosen playlists (the old membership is a hint only); metadata never written', async () => {
    const folder = `Jacob Gallagher ${RUN}`
    await artist(`Jacob Gallagher ${RUN}`, folder)
    const m = await seed(`${L}/save_me_from_me-rel-${RUN}.mp3`, { artist: `Jacob Gallagher ${RUN}`, title: 'Save Me From Me', playlists: [2] })
    await imp(m)
    scheduled = []
    const row = (await archiveRow(m.id))!
    await expect(releaseSong(ctx.db, viewer(managerId, ['submit', 'review']), row.id as number, { artist: folder, playlistIds: [] })).rejects.toMatchObject({ status: 403 })
    await expect(releaseSong(ctx.db, manager(), row.id as number, { artist: folder, playlistIds: [5] })).rejects.toMatchObject({ status: 400, code: 'playlist_not_assignable' })
    const { result, payloads } = await webQueued(() => releaseSong(ctx.db, manager(), row.id as number, { artist: `jacob gallagher ${RUN} feat. Guest`, playlistIds: [3] }), 'restore')
    expect(result).toMatchObject({ queued: 'restore', folder, newArtist: false, playlistIds: [3] })
    expect(await archiveRow(m.id)).toMatchObject({ status: 'archived', release_playlist_ids: [3] })
    const c0 = (await calls()).length
    await restoreMedia(ctx, payloads[0] as never)
    const after = await fileById(m.id)
    expect(after).toMatchObject({ id: m.id, unique_id: m.unique_id, path: `${art(folder)}/save_me_from_me-rel-${RUN}.mp3`, title: 'Save Me From Me', artist: `Jacob Gallagher ${RUN}` })
    expect(ids(after)).toEqual([3]) // chosen, NOT the old [2]
    const mine = (await calls()).slice(c0).filter((c) => c.method !== 'GET')
    expect(mine.some((c) => c.path === `/api/station/1/file/${m.id}`)).toBe(false) // no metadata PUT (tags never rewritten)
    expect(mine.map((c) => c.body?.do ?? c.path)).toEqual(['move', 'playlist'])
    expect(await archiveRow(m.id)).toMatchObject({ status: 'restored', restore_path: after!.path })
    expect((await ownerSql()`SELECT path FROM library_cache WHERE media_id = ${m.id}`)[0]!.path).toBe(after!.path)
    const rv = take('reverify')
    expect(rv.payload).toMatchObject({ mediaId: m.id, noMetadataWrite: true })
    await reverify(ctx, rv.payload as never)
    // A drifted title is NOT written back for a released song: alert + fail.
    await ownerSql()`UPDATE media_snapshots SET title = 'Drifted' WHERE id = ${rv.payload.snapshotId as number}`
    const w = await writes()
    await expect(reverify(ctx, rv.payload as never)).rejects.toMatchObject({ code: 'reverify_metadata_changed' })
    expect(await writes()).toBe(w)
    const audit = (await ownerSql()`SELECT detail FROM audit_log WHERE action = 'media.release' AND target_id = ${String(row.id)}`)[0]!
    expect(audit.detail).toMatchObject({ mediaId: m.id, to: after!.path, playlistIds: [3], renamed: false, folder })
  })

  it('release collision: the name gets " (2)" by a rename inside Removed/<id>/, then the move; the occupant is never overwritten; a crash after the rename resumes', async () => {
    const folder = `Sophie ${RUN}`
    await artist(`Sophie ${RUN}`, folder)
    const occupant = await seed(`${art(folder)}/kokoro_-_sophie_-_home.m4a`, { artist: `Sophie ${RUN}`, title: 'Home (released)' })
    const m = await seed(`${L}/Music/SOPHIE-${RUN}/kokoro_-_sophie_-_home.m4a`, { artist: `Sophie ${RUN}`, title: 'Home' })
    await imp(m)
    const row = (await archiveRow(m.id))!
    const { payloads } = await webQueued(() => releaseSong(ctx.db, manager(), row.id as number, { artist: folder, playlistIds: [] }), 'restore')
    const over0 = ((await control('/__mock/az/overwrites')) as unknown[]).length
    // The move's batch dies after the rename: the row is 'restoring', the
    // file renamed in Removed/<id>/, and archived_path follows it.
    const crash = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'move') throw new TypeError('fetch failed')
      return fetch(url, init)
    })
    await expect(restoreMedia(crash, payloads[0] as never)).rejects.toBeInstanceOf(TypeError)
    const renamed = `${PREFIX}Removed/${m.id}/kokoro_-_sophie_-_home (2).m4a`
    expect((await fileById(m.id))!.path).toBe(renamed)
    expect(await archiveRow(m.id)).toMatchObject({ status: 'restoring', archived_path: renamed, restore_path: `${art(folder)}/kokoro_-_sophie_-_home (2).m4a` })
    await restoreMedia(ctx, payloads[0] as never)
    expect(await fileById(m.id)).toMatchObject({ id: m.id, path: `${art(folder)}/kokoro_-_sophie_-_home (2).m4a`, title: 'Home' })
    expect(ids(await fileById(m.id))).toEqual([]) // no playlist chosen
    expect(await fileById(occupant.id)).toMatchObject({ path: occupant.path, title: 'Home (released)' })
    expect(((await control('/__mock/az/overwrites')) as unknown[]).length).toBe(over0)
    const renames = (await control('/__mock/az/renames')) as { from: string; to: string }[]
    expect(renames).toContainEqual({ from: `${PREFIX}Removed/${m.id}/kokoro_-_sophie_-_home.m4a`, to: renamed })
    expect(await archiveRow(m.id)).toMatchObject({ status: 'restored' })
    expect((await ownerSql()`SELECT detail FROM audit_log WHERE action = 'media.release' AND target_id = ${String(row.id)}`)[0]!.detail).toMatchObject({ renamed: true })
  })

  it('a release that never moved the file is archived again by the reconciler (Release can be pressed again)', async () => {
    const folder = `Nix ${RUN}`
    await artist(`Nix ${RUN}`, folder)
    const m = await seed(`${L}/kokoro_-_nix_-_avocado-${RUN}.m4a`, { artist: `Nix ${RUN}`, title: 'Avocado' })
    await imp(m)
    const row = (await archiveRow(m.id))!
    const { payloads } = await webQueued(() => releaseSong(ctx.db, manager(), row.id as number, { artist: folder, playlistIds: [2] }), 'restore')
    const lost = ctxWith(async (url, init) => {
      if (batchOf(url, init) === 'move') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      return fetch(url, init)
    })
    await expect(restoreMedia(lost, payloads[0] as never)).rejects.toMatchObject({ name: 'TimeoutError' })
    expect(await archiveRow(m.id)).toMatchObject({ status: 'restoring' })
    await reconcileArchive(ctx, { archiveId: row.id as number, manual: true })
    expect(await archiveRow(m.id)).toMatchObject({ status: 'archived', restore_path: null, archived_path: `${PREFIX}Removed/${m.id}/kokoro_-_nix_-_avocado-${RUN}.m4a` })
    expect(alerts.some((a) => a.includes('the release never moved the file'))).toBe(true)
    const again = await webQueued(() => releaseSong(ctx.db, manager(), row.id as number, { artist: folder, playlistIds: [2] }), 'restore')
    await restoreMedia(ctx, again.payloads[0] as never)
    expect(await fileById(m.id)).toMatchObject({ path: `${art(folder)}/kokoro_-_nix_-_avocado-${RUN}.m4a` })
    expect(ids(await fileById(m.id))).toEqual([2])
  })

  it('release to a NEW artist: only with the explicit tick; a folder of another artist is refused; created active and audited', async () => {
    const m = await seed(`${L}/new_artist-${RUN}.m4a`, { artist: `Brand New ${RUN}`, title: 'First' })
    await imp(m)
    const row = (await archiveRow(m.id))!
    await expect(releaseSong(ctx.db, manager(), row.id as number, { artist: `Brand New ${RUN}`, playlistIds: [] })).rejects.toMatchObject({ status: 409, code: 'artist_unknown' })
    await artist(`Someone Else ${RUN}`, `Taken Folder ${RUN}`)
    await expect(releaseSong(ctx.db, manager(), row.id as number, { artist: `Taken/Folder ${RUN}`, newArtist: true, playlistIds: [] })).rejects.toMatchObject({ status: 409, code: 'artist_folder_taken' })
    await artist(`Waiting ${RUN}`, `Waiting ${RUN}`, 'pending')
    await expect(releaseSong(ctx.db, manager(), row.id as number, { artist: `Waiting ${RUN}`, newArtist: true, playlistIds: [] })).rejects.toMatchObject({ status: 409, code: 'artist_pending' })
    const { result, payloads } = await webQueued(() => releaseSong(ctx.db, manager(), row.id as number, { artist: `Brand New ${RUN}`, newArtist: true, playlistIds: [] }), 'restore')
    expect(result).toMatchObject({ newArtist: true, folder: `Brand New ${RUN}` })
    const a = (await ownerSql()`SELECT status, folder FROM artists WHERE folder = ${`Brand New ${RUN}`}`)[0]!
    expect(a.status).toBe('active')
    expect((await ownerSql()`SELECT detail FROM audit_log WHERE action = 'artist.create' AND detail->>'folder' = ${`Brand New ${RUN}`}`)[0]!.detail).toMatchObject({ via: 'release', archiveId: row.id })
    await restoreMedia(ctx, payloads[0] as never)
    expect((await fileById(m.id))!.path).toBe(`${art(`Brand New ${RUN}`)}/new_artist-${RUN}.m4a`)
  })

  it('a second Release while the first is still queued is refused (409 archive_job_pending): the chosen artist and playlists stay, no second job, audit or artist; two presses at once: exactly one wins', async () => {
    const folder = `Twice ${RUN}`
    const artistId = await artist(folder, folder)
    const m = await seed(`${L}/twice-${RUN}.m4a`, { artist: folder, title: 'Twice' })
    await imp(m)
    const id = (await archiveRow(m.id))!.id as number
    const live = async () => ownerSql()`SELECT id FROM jobs WHERE kind = 'restore' AND status IN ('queued', 'running') AND payload->>'archiveId' = ${String(id)}`
    const releases = async () => ownerSql()`SELECT detail FROM audit_log WHERE action = 'library.release' AND target_id = ${String(id)} ORDER BY id`
    const created = async (f: string) => (await ownerSql()`SELECT count(*)::int AS n FROM artists WHERE folder = ${f}`)[0]!.n as number
    // Queues paused: the live worker never claims these restore jobs.
    await ownerSql()`INSERT INTO settings (key, value) VALUES ('queues_paused', '{"reason":"test_web_enqueue"}'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    try {
      await releaseSong(ctx.db, manager(), id, { artist: folder, playlistIds: [2] })
      await expect(releaseSong(ctx.db, manager(), id, { artist: `Other Twice ${RUN}`, newArtist: true, playlistIds: [3] })).rejects.toMatchObject({ status: 409, code: 'archive_job_pending' })
      await expect(releaseSong(ctx.db, manager(), id, { artist: folder, playlistIds: [3] })).rejects.toMatchObject({ status: 409, code: 'archive_job_pending' })
      expect(await live()).toHaveLength(1)
      expect((await releases()).map((r) => r.detail)).toEqual([expect.objectContaining({ artistId, playlistIds: [2] })])
      expect(await created(`Other Twice ${RUN}`)).toBe(0)
      expect(await archiveRow(m.id)).toMatchObject({ status: 'archived', release_artist_id: artistId, release_playlist_ids: [2] })

      // The first job is gone (as if it failed back to 'archived'): two
      // presses at the same moment, one of them a new artist. The row lock
      // lets exactly one through; the other is refused before any write.
      await ownerSql()`UPDATE jobs SET status = 'done' WHERE kind = 'restore' AND status = 'queued' AND payload->>'archiveId' = ${String(id)}`
      const nf = `Racing New ${RUN}`
      const both = await Promise.allSettled([
        releaseSong(ctx.db, manager(), id, { artist: folder, playlistIds: [3] }),
        releaseSong(ctx.db, manager(), id, { artist: nf, newArtist: true, playlistIds: [] }),
      ])
      const won = both.findIndex((r) => r.status === 'fulfilled')
      expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect((both[1 - won] as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'archive_job_pending' })
      expect(await live()).toHaveLength(1)
      expect(await releases()).toHaveLength(2)
      expect(await created(nf)).toBe(won === 1 ? 1 : 0)
      expect((await archiveRow(m.id))!.release_playlist_ids).toEqual(won === 0 ? [3] : [])
    } finally {
      await ownerSql()`UPDATE jobs SET status = 'done' WHERE kind = 'restore' AND status = 'queued' AND payload->>'archiveId' = ${String(id)}`
      await ownerSql()`UPDATE settings SET value = 'null'::jsonb WHERE key = 'queues_paused'`
    }
  })

  it('Archived songs is paged (newest first): every visible row is counted and reachable; an out-of-range page shows the last one', async () => {
    const who = await user('4')
    const base = 1_900_000_000 + Math.floor(Math.random() * 1_000_000)
    const n = ARCHIVED_PAGE_SIZE + 30
    const t0 = Date.UTC(2020, 0, 1)
    try {
      for (let i = 0; i < n; i++) {
        await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, origin, status, archived_at, linked_user_id)
          VALUES (${base + i}, ${`${L}/page-${RUN}-${i}.mp3`}, ${`${PREFIX}Removed/${base + i}/page-${RUN}-${i}.mp3`}, 'legacy_unreleased', 'archived', ${new Date(t0 + i * 60_000)}, ${who.id})`
      }
      const v = viewer(who.id, ['submit', 'request'])
      const p1 = await archivedSongs(ctx.db, v)
      expect(p1).toMatchObject({ total: n, page: 1, pages: 2 })
      expect(p1.rows).toHaveLength(ARCHIVED_PAGE_SIZE)
      expect(p1.rows[0]!.fileName).toBe(`page-${RUN}-${n - 1}.mp3`) // newest first
      const p2 = await archivedSongs(ctx.db, v, { page: 2 })
      expect(p2.rows).toHaveLength(30)
      expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(n) // none lost, none twice
      expect(await archivedSongs(ctx.db, v, { page: 99 })).toMatchObject({ page: 2, pages: 2 })
      // Staff count them too (the page says how many there are).
      expect((await archivedSongs(ctx.db, manager())).total).toBeGreaterThanOrEqual(n)
    } finally {
      await ownerSql()`DELETE FROM archive WHERE media_id >= ${base} AND media_id < ${base + n}`
    }
  })

  it('visibility: staff see every archived song; a member sees what they uploaded or were linked to, read-only; link/unlink are manager-only and audited', async () => {
    const up = await user('8')
    const linked = await user('9')
    const other = await user('6')
    const reviewer = await user('5')
    // A portal upload that was later removed (items → batch owner).
    const own = await seed(`${art(`Own ${RUN}`)}/own.mp3`, { title: `Own ${RUN}`, artist: `Own ${RUN}` })
    await artist(`Own ${RUN}`, `Own ${RUN}`)
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status) VALUES (${up.id}, 'completed') RETURNING id`
    await ownerSql()`INSERT INTO items (batch_id, owner_user_id, status, media_id, title, artist) VALUES (${b!.id}, ${up.id}, 'live', ${own.id}, ${`Own ${RUN}`}, ${`Own ${RUN}`})`
    await archiveMedia(ctx, { mediaId: own.id, reason: 'Left the label' })
    const ownRow = (await archiveRow(own.id))!
    // Two Unreleased imports, one of which gets linked to `linked`.
    const u1 = await seed(`${L}/vis1-${RUN}.m4a`, { title: `Vis One ${RUN}`, artist: 'Vis' })
    const u2 = await seed(`${L}/vis2-${RUN}.m4a`, { title: `Vis Two ${RUN}`, artist: 'Vis' })
    clock += SLOT
    await imp(u1)
    await imp(u2)
    const r1 = (await archiveRow(u1.id))!
    const r2 = (await archiveRow(u2.id))!
    const mine = (p: Awaited<ReturnType<typeof archivedSongs>>) => p.rows.filter((r) => [ownRow.id, r1.id, r2.id].includes(r.id))

    // Members may not link; managers link one signed-in user, audited.
    await expect(linkArchive(ctx.db, viewer(reviewer.id, ['submit', 'review']), r1.id as number, { userId: linked.id })).rejects.toMatchObject({ status: 403 })
    await expect(linkArchive(ctx.db, manager(), r1.id as number, { userId: 'nobody' })).rejects.toMatchObject({ status: 400, code: 'unknown_user' })
    expect((await linkCandidates(ctx.db, manager(), `9-${RUN}`)).map((u) => u.id)).toEqual([linked.id])
    await expect(linkCandidates(ctx.db, viewer(reviewer.id, ['submit', 'review']), 'x')).rejects.toMatchObject({ status: 403 })
    await linkArchive(ctx.db, manager(), r1.id as number, { userId: other.id })
    await linkArchive(ctx.db, manager(), r1.id as number, { userId: linked.id })
    const la = await ownerSql()`SELECT actor_user_id, detail FROM audit_log WHERE action = 'archive.link' AND target_id = ${String(r1.id)} ORDER BY id`
    expect(la.map((x) => x.detail)).toEqual([
      expect.objectContaining({ userId: other.id, previousUserId: null }),
      expect.objectContaining({ userId: linked.id, previousUserId: other.id }),
    ])
    expect(la[0]!.actor_user_id).toBe(managerId)

    const staffView = mine(await archivedSongs(ctx.db, viewer(reviewer.id, ['submit', 'request', 'review'])))
    expect(staffView.map((r) => r.id).sort()).toEqual([ownRow.id, r1.id, r2.id].sort())
    expect(staffView.find((r) => r.id === r1.id)).toMatchObject({ label: 'Unreleased', title: `Vis One ${RUN}`, staff: { origin: 'legacy_unreleased', linkedUser: { id: linked.id } } })
    expect(staffView.find((r) => r.id === ownRow.id)).toMatchObject({ label: 'Removed', reason: 'Left the label', staff: { uploader: { id: up.id } } })

    const upView = mine(await archivedSongs(ctx.db, viewer(up.id, ['submit', 'request'])))
    // The manager's archive reason is staff-only (V-1): the uploader gets none.
    expect(upView).toEqual([{ id: ownRow.id, label: 'Removed', title: `Own ${RUN}`, artist: `Own ${RUN}`, fileName: 'own.mp3', archivedAt: expect.any(String), reason: null }])
    const linkedView = mine(await archivedSongs(ctx.db, viewer(linked.id, ['submit', 'request'])))
    expect(linkedView.map((r) => [r.id, r.label])).toEqual([[r1.id, 'Unreleased']])
    expect(linkedView[0]!.staff).toBeUndefined() // read-only: no paths, playlists, ids
    expect(mine(await archivedSongs(ctx.db, viewer(other.id, ['submit', 'request'])))).toEqual([]) // unlinked since
    await expect(archivedSongs(ctx.db, viewer(other.id, []))).rejects.toMatchObject({ status: 403 })

    await unlinkArchive(ctx.db, manager(), r1.id as number)
    expect(mine(await archivedSongs(ctx.db, viewer(linked.id, ['submit', 'request'])))).toEqual([])
    const ul = (await ownerSql()`SELECT detail FROM audit_log WHERE action = 'archive.unlink' AND target_id = ${String(r1.id)}`)[0]!
    expect(ul.detail).toMatchObject({ previousUserId: linked.id })
  })

  it('reasons (V-1): a member never sees a reason someone else wrote, only their own removal request\'s; staff see every reason', async () => {
    const me = await user('4')
    const someone = await user('3')
    const reviewer = await user('2')
    const base = 800_000_000 + Math.floor(Math.random() * 1_000_000) * 10
    // A: a manager's archive, with the manager's reason, linked to `me`.
    // B: archived by `me`'s own removal request (its reason is theirs).
    // C: archived by someone else's removal request, linked to `me`.
    const [rb] = await ownerSql()`INSERT INTO requests (owner_user_id, kind, media_id, target_path, status, reason) VALUES (${me.id}, 'removal', ${base + 1}, ${`${PREFIX}Music/Artists/V1/b.mp3`}, 'done', 'My own words') RETURNING id`
    const [rc] = await ownerSql()`INSERT INTO requests (owner_user_id, kind, media_id, target_path, status, reason) VALUES (${someone.id}, 'removal', ${base + 2}, ${`${PREFIX}Music/Artists/V1/c.mp3`}, 'done', 'Someone else wrote this') RETURNING id`
    const [a, b, c] = await ownerSql()`INSERT INTO archive (media_id, original_path, archived_path, request_id, reason, linked_user_id, status, origin) VALUES
      (${base}, ${`${PREFIX}Music/Artists/V1/a.mp3`}, ${`${PREFIX}Removed/${base}/a.mp3`}, NULL, 'Manager note', ${me.id}, 'archived', 'portal'),
      (${base + 1}, ${`${PREFIX}Music/Artists/V1/b.mp3`}, ${`${PREFIX}Removed/${base + 1}/b.mp3`}, ${rb!.id}, NULL, ${me.id}, 'archived', 'portal'),
      (${base + 2}, ${`${PREFIX}Music/Artists/V1/c.mp3`}, ${`${PREFIX}Removed/${base + 2}/c.mp3`}, ${rc!.id}, NULL, ${me.id}, 'archived', 'portal')
      RETURNING id`
    try {
      const pick = (p: Awaited<ReturnType<typeof archivedSongs>>) => Object.fromEntries(p.rows.filter((r) => [a!.id, b!.id, c!.id].includes(r.id)).map((r) => [r.id, r.reason]))
      expect(pick(await archivedSongs(ctx.db, viewer(me.id, ['submit', 'request'])))).toEqual({ [a!.id]: null, [b!.id]: 'My own words', [c!.id]: null })
      expect(pick(await archivedSongs(ctx.db, viewer(reviewer.id, ['submit', 'review'])))).toEqual({ [a!.id]: 'Manager note', [b!.id]: 'My own words', [c!.id]: 'Someone else wrote this' })
      expect(pick(await archivedSongs(ctx.db, manager()))).toEqual({ [a!.id]: 'Manager note', [b!.id]: 'My own words', [c!.id]: 'Someone else wrote this' })
    } finally {
      await ownerSql()`DELETE FROM archive WHERE media_id >= ${base} AND media_id <= ${base + 2}`
    }
  })
})
