// v0.5.0: the music worker next to event playlists on the shared storage
// (plan §4 "Music library sync" and the set_playlists MERGE). An event
// playlist on station 14 that the events worker registered (event_registry)
// must never be alerted on, absorbed into station_playlist_ids or the
// library cache, or sent back / dropped by a manager's playlist change.
// Real music-db + the AzuraCast mock; the music handlers run in-process.
// [W0]: needs only the contract commit (sync.ts reads event_registry).
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb } from '@/server/db/client'
import { syncLibrary } from '@/worker/library/sync'
import { setPlaylistsJob, type RequestsCtx } from '@/worker/requests/jobs'
import { ownerSql } from './helpers/db'
import { DBENV, MOCKS } from './helpers/env'
import { control, mockFile, playlistIds } from './helpers/events'
import { makeCtx, uniq } from './helpers/p3'

const ready = () => DBENV() && MOCKS()

async function setting(key: string): Promise<unknown> {
  return (await ownerSql()`SELECT value FROM settings WHERE key = ${key}`)[0]?.value ?? null
}
async function putSetting(key: string, value: unknown) {
  if (value === null) await ownerSql()`DELETE FROM settings WHERE key = ${key}`
  else await ownerSql()`INSERT INTO settings (key, value) VALUES (${key}, ${ownerSql().json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
}

// A built event as the events worker leaves it: an event row far outside
// every e2e slot (so it never clashes with API-created events), a build and
// a main registry row pointing at a real station-14 playlist on the mock.
async function registeredEventPlaylist(tag: string): Promise<{ eventId: number; playlistId: number }> {
  const pl = (await control('/__mock/az/station14/playlist', {
    name: `E2E Music ${tag}`,
    is_enabled: true,
    schedule_items: [{ start_time: 2000, end_time: 2200, start_date: '2030-01-01', end_date: '2030-01-01', days: [], loop_once: false }],
  })) as { id: number }
  const discordId = `8${String(Date.now()).slice(-9)}${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
  const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${discordId}) RETURNING id`
  const [ev] = await ownerSql()`INSERT INTO events (owner_user_id, owner_discord_id, title, event_type, starts_at, ends_at, entered_tz, visibility, status)
    VALUES (${u!.id}, ${discordId}, ${`E2E Music ${tag}`}, 'other', now() + interval '300 days', now() + interval '300 days 2 hours', 'UTC', 'public', 'built') RETURNING id`
  const [b] = await ownerSql()`INSERT INTO event_builds (event_id, version, plan, status) VALUES (${ev!.id}, 1, '{}'::jsonb, 'applied') RETURNING id`
  await ownerSql()`INSERT INTO event_registry (event_id, build_id, role, intent_name, playlist_id) VALUES (${ev!.id}, ${b!.id}, 'main', ${`E2E Music ${tag}`}, ${pl.id})`
  return { eventId: Number(ev!.id), playlistId: pl.id }
}

describe.skipIf(!ready())('events × music: shared storage, registry playlists', () => {
  afterAll(async () => closeDb())

  it('[W0] library sync: a registered event playlist is never alerted, absorbed or cached; a manager playlist change keeps it', async () => {
    const tag = uniq()
    const prevAssignable = await setting('assignable_playlist_ids')
    await putSetting('assignable_playlist_ids', [2, 5])
    try {
      const { playlistId } = await registeredEventPlaylist(tag)
      const path = `Music/Artists/EvMusic ${tag}/EvMusic ${tag} - Shared.mp3`
      await control('/__mock/az/seed', { files: [{ path, title: 'Shared', artist: `EvMusic ${tag}`, playlists: [2, 74] }] })
      // the events worker's membership write on station 14 (74 kept, event id added)
      await control('/__mock/az/station14', { path, playlists: [74, playlistId] })
      const f = await mockFile(path)
      expect(playlistIds(f)).toEqual([2, 74, playlistId].sort((a, b) => a - b))

      // 1. the music library sync (prod root: the real Music/Artists/** surface)
      const ctx = makeCtx(Date.now(), { root: '' })
      await syncLibrary(ctx)
      await syncLibrary(ctx)
      const mentions = (a: { title: string; detail: Record<string, unknown> }) =>
        new RegExp(`\\b${playlistId}\\b`).test(a.title) || (Array.isArray(a.detail.playlistIds) && (a.detail.playlistIds as number[]).includes(playlistId))
      expect(ctx.alerts.filter(mentions)).toEqual([])
      expect((await setting('station_playlist_ids')) as number[]).not.toContain(playlistId)
      expect(((await setting('unconfirmed_playlist_ids')) as number[] | null) ?? []).not.toContain(playlistId)
      const cached = (await ownerSql()`SELECT playlist_ids FROM library_cache WHERE media_id = ${f.id}`)[0]!
      expect(cached.playlist_ids).toEqual([2])

      // 2. a manager moves the song from playlist 2 to 5 (set_playlists MERGE):
      //    the station-1 write never names 74 or the event playlist, and both
      //    memberships survive it.
      const scheduled: string[] = []
      const rctx: RequestsCtx = { ...ctx, root: '', now: () => Date.now(), schedule: async (kind) => void scheduled.push(kind) }
      await setPlaylistsJob(rctx, { mediaId: f.id, chosen: [5] })
      const calls = (await control('/__mock/az/calls')) as { method: string; path: string; key: string | null; body?: { do?: string; files?: string[]; playlists?: number[] } }[]
      const batch = calls.filter((c) => c.method === 'PUT' && c.path === '/api/station/1/files/batch' && c.body?.files?.[0] === path).at(-1)!
      expect(batch.key).toBe('music')
      expect(batch.body).toMatchObject({ do: 'playlist', playlists: [5] })
      expect(batch.body!.playlists).not.toContain(playlistId)
      expect(playlistIds(await mockFile(path))).toEqual([5, 74, playlistId].sort((a, b) => a - b))
      expect(scheduled).toContain('reverify')
      ctx.cleanup()
    } finally {
      await putSetting('assignable_playlist_ids', prevAssignable)
    }
  })

  it('[W0] the music key cannot reach station 14 and the events key cannot reach station 1 (mock roles)', async () => {
    const az = process.env.MOCKS_AZURACAST!
    const get = async (sid: number, key: string) => (await fetch(`${az}/api/station/${sid}/playlists`, { headers: { 'X-API-Key': key } })).status
    expect(await get(14, process.env.AZURACAST_API_KEY!)).toBe(403)
    expect(await get(1, process.env.TEST_EVENTS_AZURACAST_KEY!)).toBe(403)
    expect(await get(7, process.env.TEST_EVENTS_AZURACAST_KEY!)).toBe(403)
    expect(await get(14, process.env.TEST_EVENTS_AZURACAST_KEY!)).toBe(200)
  })
})
