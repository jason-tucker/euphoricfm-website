// The events client's response schemas against REAL AzuraCast answers
// (test/fixtures/azuracast-real/: station 14 read with the events key on
// 2026-09-29 right after live test 1 built playlists 81 and 82; public song
// metadata only). The unit fakes and the harness mock guessed some of these
// shapes wrong (GET /order, backend_options, the PUT /order body), which the
// first live build found; every read the worker makes is parsed here with
// the client's own schemas, through its own transport.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { EventsAzuraCastClient, type PlaylistScope } from '@/events/azuracast/client'
import type { CompiledPlaylist } from '@/events/azuracast/compiler'
import { diffPlaylist } from '@/events/worker/jobs/build'
import { endWaitTarget } from '@/events/worker/jobs/kicks'

const DIR = fileURLToPath(new URL('./fixtures/azuracast-real/', import.meta.url))
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), 'utf8'))

const ROUTES: Record<string, string> = {
  '/api/station/14/playlists': 'st14_playlists.json',
  '/api/station/14/playlist/81': 'st14_playlist_81.json',
  '/api/station/14/playlist/82': 'st14_playlist_82.json',
  '/api/station/14/playlist/81/order': 'st14_playlist_81_order.json',
  '/api/station/14/file/4446': 'st14_file_4446.json',
  '/api/station/14/file/4473': 'st14_file_4473.json',
  '/api/station/14/queue': 'st14_queue.json',
  '/api/station/14/status': 'st14_status.json',
  '/api/station/14/logs': 'st14_logs.json',
  '/api/nowplaying/14': 'nowplaying_14.json',
}

type Sent = { method: string; path: string; body: unknown }

// Serves the fixtures; PUT /playlist/81/order behaves like PutOrderAction +
// setMediaOrder: a {entry id: weight} map re-weights those rows (a list
// would re-weight nothing) and the map is echoed.
function realStation() {
  const sent: Sent[] = []
  let order = fixture('st14_playlist_81_order.json') as { id: number; weight: number }[]
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(input))
    const method = String(init.method ?? 'GET')
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    sent.push({ method, path: u.pathname, body })
    if (method === 'PUT' && u.pathname === '/api/station/14/playlist/81/order') {
      const map = (body as { order: unknown }).order
      const pairs: [number, number][] = Array.isArray(map) ? map.map((w, i) => [i, Number(w)]) : Object.entries(map as Record<string, number>).map(([k, w]) => [Number(k), w])
      const weight = new Map(order.map((r) => [r.id, r.weight]))
      for (const [id, w] of pairs) if (weight.has(id)) weight.set(id, w)
      order = order.map((r) => ({ ...r, weight: weight.get(r.id)! })).sort((a, b) => a.weight - b.weight)
      return new Response(JSON.stringify(map), { status: 200 })
    }
    if (method === 'GET' && u.pathname === '/api/station/14/playlist/81/order') return new Response(JSON.stringify(order), { status: 200 })
    const file = method === 'GET' ? ROUTES[u.pathname] : undefined
    if (!file) return new Response(JSON.stringify({ code: 404, message: 'Record not found' }), { status: 404 })
    return new Response(readFileSync(join(DIR, file)), { status: 200 })
  }) as unknown as typeof fetch
  const client = new EventsAzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(24), stationId: 14, canaryStationIds: [7], fetchImpl })
  return { client, sent }
}

const WINDOW = { startsAt: Date.UTC(2026, 8, 29, 16, 30), endsAt: Date.UTC(2026, 8, 29, 17, 0) }
const scope81: PlaylistScope = { eventId: 1, window: WINDOW, registry: new Map([[81, 'Private event']]), intentNames: new Set(['Private event']) }

describe('AzuraCast real shapes (station 14, 2026-09-29)', () => {
  it('GET /playlists: every row parses; backend_options [""] reads as none', async () => {
    const { client } = realStation()
    const list = await client.listPlaylists()
    expect(list.map((p) => p.id).sort((a, b) => a - b)).toEqual([74, 75, 76, 77, 78, 81, 82])
    const byId = new Map(list.map((p) => [p.id, p]))
    expect(byId.get(76)!.backend_options).toEqual([])
    expect(byId.get(74)!.backend_options).toEqual(['interrupt'])
    expect(byId.get(82)!.backend_options).toEqual(['single_track'])
    // a date-less legacy row ("" dates) still parses
    expect(byId.get(77)!.schedule_items[0]).toMatchObject({ id: 51, start_date: '', end_date: '' })
  })

  it('GET /playlist/{id}: schedule rows carry their ids; verify sees no difference from what the build sent', async () => {
    const { client } = realStation()
    const main = await client.getPlaylist(81)
    const pin = await client.getPlaylist(82)
    expect(main.schedule_items.map((s) => s.id)).toEqual([58])
    expect(pin.schedule_items.map((s) => s.id)).toEqual([59])
    expect(main.backend_options).toEqual([])
    const compiled = (name: string, body: Record<string, unknown>) => ({ key: name, name, body }) as unknown as CompiledPlaylist
    const mainBody = { order: 'sequential', weight: 3, backend_options: [], schedule_items: [{ start_time: 1235, end_time: 1255, start_date: '2026-09-29', end_date: '2026-09-29', days: [], loop_once: false }] }
    const pinBody = { order: 'sequential', weight: 3, backend_options: ['single_track'], schedule_items: [{ start_time: 1240, end_time: 1255, start_date: '2026-09-29', end_date: '2026-09-29', days: [], loop_once: true }] }
    expect(diffPlaylist(main, compiled('Private event', mainBody), false)).toEqual([])
    expect(diffPlaylist(pin, compiled('~EVT1 s1', pinBody), false)).toEqual([])
    // and a real difference is still seen
    expect(diffPlaylist(main, compiled('Private event', { ...mainBody, backend_options: ['interrupt'] }), false)).toEqual(['backend_options'])
  })

  it('GET /playlist/{id}/order: an ARRAY of entries (entry id + media)', async () => {
    const { client } = realStation()
    const entries = await client.getPlaylistOrder(81)
    expect(entries.map((e) => [e.id, e.media?.id, e.media_id, e.playlist_id])).toEqual([
      [10581, 1103, 1103, 81],
      [10582, 881, 881, 81],
      [10583, 4446, 4446, 81],
    ])
    expect((await client.playlistMediaOrder(81)).map((e) => e.mediaId)).toEqual([1103, 881, 4446])
  })

  it('PUT /playlist/{id}/order sends the {entry id: weight} map setMediaOrder reads, accepts its echo, and re-reads the order', async () => {
    const { client, sent } = realStation()
    await client.setOrder(81, [4446, 1103, 881], scope81)
    const put = sent.filter((s) => s.method === 'PUT')
    expect(put).toEqual([{ method: 'PUT', path: '/api/station/14/playlist/81/order', body: { order: { '10583': 1, '10581': 2, '10582': 3 } } }])
    // fresh reads before the write (playlist name + order entries) and after it
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      'GET /api/station/14/playlist/81/order',
      'GET /api/station/14/playlist/81',
      'GET /api/station/14/playlist/81/order',
      'PUT /api/station/14/playlist/81/order',
      'GET /api/station/14/playlist/81/order',
    ])
    expect((await client.playlistMediaOrder(81)).map((e) => e.mediaId)).toEqual([4446, 1103, 881])
  })

  it('GET /file/{id}: path, length and every station’s memberships', async () => {
    const { client } = realStation()
    const song = await client.getFile(4446)
    expect(song).toMatchObject({ id: 4446, path: 'Music/Artists/Jake Gallagher/love_dealer_-_jake_gallagher_(prod._by_slayingibis).mp3', length: 165 })
    expect(song.playlists.map((p) => p.id)).toEqual([2, 77, 81])
    const stinger = await client.getFile(4473)
    expect(stinger).toMatchObject({ path: 'EFM Stingers/euphoricfm.mp3', length: 10 })
  })

  it('GET /queue (empty), /status, /logs, /nowplaying/14', async () => {
    const { client } = realStation()
    expect(await client.getQueue()).toEqual([])
    expect(await client.getStatus()).toMatchObject({ backend_running: true, frontend_running: true })
    const logs = await client.listLogs()
    expect(logs.map((l) => l.key)).toContain('liquidsoap_log')
    const np = await client.nowPlaying()
    expect(np.is_online).toBe(false)
    expect(np.now_playing).toMatchObject({ played_at: 0, duration: 0 })
    // an offline station never holds the end kick
    expect(endWaitTarget(np, 1000, 91_000, 2000)).toBe(2000)
  })
})
