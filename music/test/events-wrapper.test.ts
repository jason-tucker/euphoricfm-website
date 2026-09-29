import { describe, expect, it } from 'vitest'
import { assertWritablePlaylistId, checkMembershipWrite, type PlaylistBodyT } from '@/events/azuracast/allowlist'
import { EventsAzuraCastClient, EventsAzuraCastError, TEST_SEND, type PlaylistScope } from '@/events/azuracast/client'
import { applyFileMembership, mergeMembership, MembershipError } from '@/events/azuracast/membership'
import { folderLinkCheck, keySelfCheck } from '@/events/azuracast/selfcheck'
import { FakeAz, OTHER, OWNER } from './events-fakes'

const send = (c: EventsAzuraCastClient, ...a: Parameters<EventsAzuraCastClient[typeof TEST_SEND]>) => c[TEST_SEND](...a)

async function refused(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(EventsAzuraCastError)
  await expect(p).rejects.toMatchObject({ code })
}

const WINDOW = { startsAt: new Date('2026-10-10T20:00:00-04:00').getTime(), endsAt: new Date('2026-10-10T22:00:00-04:00').getTime() }
const row = { start_time: 2000, end_time: 2200, start_date: '2026-10-10', end_date: '2026-10-10', days: [], loop_once: false }
function body(over: Partial<PlaylistBodyT> & Record<string, unknown> = {}): PlaylistBodyT {
  return {
    name: 'Grand Opening',
    type: 'default',
    source: 'songs',
    order: 'shuffle',
    is_enabled: false,
    is_jingle: false,
    weight: 3,
    include_in_requests: false,
    include_in_on_demand: false,
    avoid_duplicates: true,
    backend_options: [],
    schedule_items: [row],
    ...over,
  } as PlaylistBodyT
}

function setup() {
  const az = new FakeAz()
  const c = az.client()
  // An event playlist of event 42 (registry id 101), one of event 43 (102).
  az.playlists.set(101, { ...az.playlists.get(76)!, id: 101, name: 'Grand Opening' })
  az.playlists.set(102, { ...az.playlists.get(76)!, id: 102, name: 'Other Event' })
  const scope: PlaylistScope = { eventId: 42, window: WINDOW, registry: new Map([[101, 'Grand Opening']]), intentNames: new Set(['Grand Opening', 'EVT42 s1']) }
  return { az, c, scope }
}

describe('events wrapper: default deny (no write leaves the process)', () => {
  it('refuses any other station, and canary reads outside the self-check', async () => {
    const { az, c } = setup()
    await refused(send(c, 'GET', '/api/station/1/playlists'), 'refused_station')
    await refused(send(c, 'GET', '/api/station/7/file/5'), 'refused_station')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: {} }), 'refused_station')
    await refused(send(c, 'GET', '/api/nowplaying/1'), 'refused_station')
    await refused(send(c, 'GET', '/api/station/1/file/5', { canary: true }), 'refused_station')
    await refused(send(c, 'GET', '/api/station/14/playlists', { canary: true }), 'refused_canary')
    expect(az.calls).toHaveLength(0)
  })

  it('refuses every route outside the allowlist', async () => {
    const { az, c } = setup()
    const forbidden: [string, string][] = [
      ['PUT', '/api/station/14/files/rename'],
      ['POST', '/api/station/14/fallback'],
      ['GET', '/api/station/14/sftp-users'],
      ['POST', '/api/station/14/sftp-users'],
      ['PUT', '/api/station/14/playlist/101/toggle'],
      ['POST', '/api/station/14/playlist/101/clone'],
      ['PUT', '/api/station/14/playlist/101/empty'],
      ['POST', '/api/station/14/playlist/101/import'],
      ['PUT', '/api/station/14/playlist/101/apply-to'],
      ['POST', '/api/station/14/backend/stop'],
      ['POST', '/api/station/14/backend/skip'],
      ['POST', '/api/station/14/restart'],
      ['POST', '/api/station/14/frontend/restart'],
      ['DELETE', '/api/station/14/queue'],
      ['POST', '/api/station/14/files/upload'],
      ['POST', '/api/station/14/files/mkdir'],
      ['GET', '/api/station/14/files/download'],
      ['GET', '/api/admin/stations'],
      ['DELETE', '/api/station/14/playlists'],
    ]
    for (const [m, p] of forbidden) await refused(send(c, m, p), 'refused_not_allowlisted')
    await refused(send(c, 'GET', '/api/station/14/%66ile/5'), 'refused_encoded_path')
    await refused(send(c, 'GET', 'https://evil.example/api/station/14/playlists'), 'refused_path')
    await refused(send(c, 'GET', '/api/station/14/files/list?currentDirectory=Music&flushCache=true'), 'refused_query')
    await refused(send(c, 'GET', '/api/station/14/files/list?currentDirectory=Events&currentDirectory=Events&flushCache=true'), 'refused_duplicate_query')
    await refused(send(c, 'GET', '/api/station/14/playlists?x=1'), 'refused_query')
    expect(az.calls).toHaveLength(0)
  })

  it('batch: only do=playlist, no dirs, exact file surfaces', async () => {
    const { az, c } = setup()
    const f = az.addFile('Music/Artists/A/a.mp3', { playlists: [74] })
    const scope = { mediaId: f.id, path: f.path, removable: new Set([101]), addable: new Set([101]) }
    for (const action of ['delete', 'queue', 'immediate', 'reprocess', 'move', 'clear']) {
      await refused(send(c, 'PUT', '/api/station/14/files/batch', { body: { do: action, files: [f.path], dirs: [], currentDirectory: 'Music/Artists/A' }, membership: scope }), 'refused_batch_action')
    }
    await refused(send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [f.path], dirs: ['Music'], currentDirectory: 'Music/Artists/A', playlists: [74, 101] }, membership: scope }), 'refused_batch_body')
    await refused(send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [f.path], dirs: [], currentDirectory: 'Music/Artists/A', playlists: [74, 101] } }), 'refused_scope_missing')
    const odd = az.addFile('ADS/x.mp3')
    await refused(
      send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [odd.path], dirs: [], currentDirectory: 'ADS', playlists: [101] }, membership: { ...scope, mediaId: odd.id, path: odd.path } }),
      'refused_batch_surface',
    )
    const trav = 'Music/Artists/../ADS/x.mp3'
    await refused(send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [trav], dirs: [], currentDirectory: 'Music/Artists/..', playlists: [101] }, membership: { ...scope, path: trav } }), 'refused_batch_path')
    expect(az.writes()).toHaveLength(0)
  })

  it('membership: never drops legacy 74 or another event, never adds a foreign id, fresh path only', async () => {
    const { az, c } = setup()
    const f = az.addFile('Music/Artists/A/a.mp3', { playlists: [74, 102, 5] })
    const scope = { mediaId: f.id, path: f.path, removable: new Set([101]), addable: new Set([101]) }
    const P = f.path
    const batch = (playlists: number[], s = scope) => send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [P], dirs: [], currentDirectory: 'Music/Artists/A', playlists }, membership: s })
    await refused(batch([102, 101]), 'refused_remove_legacy')
    await refused(batch([74, 101]), 'refused_remove_foreign')
    await refused(batch([74, 102, 101, 77]), 'refused_add_not_registry')
    await refused(batch([74, 102, 101, 103]), 'refused_not_station14_playlist')
    // a registry scope that (wrongly) lists a legacy id still cannot add it
    await refused(batch([74, 102, 78], { ...scope, addable: new Set([78]) }), 'refused_playlist_floor')
    await refused(batch([74, 102, 101], { ...scope, path: 'Music/Artists/B/b.mp3' }), 'refused_batch_path')
    f.path = 'Music/Artists/A/renamed.mp3'
    await refused(batch([74, 102, 101]), 'refused_batch_stale_path')
    f.path = 'Music/Artists/A/a.mp3'
    expect(az.writes()).toHaveLength(0)
    await batch([74, 102, 101])
    expect(az.writes()).toHaveLength(1)
    expect(f.playlists.sort((a, b) => a - b)).toEqual([5, 74, 101, 102])
  })

  it('membership on an archived song: removal only', async () => {
    const { az, c } = setup()
    const f = az.addFile('Removed/12/a.mp3', { playlists: [74, 101] })
    const scope = { mediaId: f.id, path: f.path, removable: new Set([101]), addable: new Set<number>(), removalOnly: true }
    const batch = (playlists: number[], s: typeof scope) => send(c, 'PUT', '/api/station/14/files/batch', { body: { do: 'playlist', files: [f.path], dirs: [], currentDirectory: 'Removed/12', playlists }, membership: s })
    await refused(batch([74, 101], { ...scope, removalOnly: false } as typeof scope), 'refused_batch_surface')
    await refused(batch([74, 101, 102], { ...scope, addable: new Set([102]) }), 'refused_add_on_removal_only')
    await batch([74], scope)
    expect(f.playlists).toEqual([74])
  })

  it('playlist bodies are pinned: source, remote_*, on-demand, requests, backend options, jingle, rows', async () => {
    const { az, c, scope } = setup()
    const bad: [Record<string, unknown>, string][] = [
      [{ source: 'remote_url' }, 'refused_playlist_body'],
      [{ remote_url: 'https://evil.example/s.mp3' }, 'refused_playlist_body'],
      [{ remote_type: 'stream' }, 'refused_playlist_body'],
      [{ include_in_on_demand: true }, 'refused_playlist_body'],
      [{ include_in_requests: true }, 'refused_playlist_body'],
      [{ backend_options: ['merge'] }, 'refused_playlist_body'],
      [{ backend_options: ['interrupt', 'interrupt'] }, 'refused_playlist_body'],
      [{ is_jingle: true }, 'refused_playlist_body'],
      [{ type: 'once_per_x_songs' }, 'refused_playlist_body'],
      [{ podcasts: [] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, start_date: null }] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, end_date: '2026-10-11' }] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, start_time: 2200, end_time: 2000 }] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, end_time: 2000 }] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, start_time: 2075 }] }, 'refused_playlist_body'],
      [{ schedule_items: [] }, 'refused_playlist_body'],
      [{ schedule_items: [{ ...row, start_time: 1900 }] }, 'refused_row_outside_event'],
      [{ schedule_items: [{ ...row, end_time: 2230 }] }, 'refused_row_outside_event'],
      [{ schedule_items: [{ ...row, start_date: '2026-10-11', end_date: '2026-10-11' }] }, 'refused_row_outside_event'],
      [{ name: 'EVT43 s1' }, 'refused_playlist_name_event'],
      // the pre-0.5.2 '~' helper name is never sent again (Liquidsoap parse error)
      [{ name: '~EVT42 s1' }, 'refused_playlist_body'],
      // a main-looking name shaped like a helper name (any case) is refused
      [{ name: 'evt42 s1' }, 'refused_playlist_body'],
      [{ name: 'Some other name' }, 'refused_create_without_intent'],
      [{ name: '~hidden' }, 'refused_playlist_body'],
    ]
    for (const [over, code] of bad) await refused(send(c, 'POST', '/api/station/14/playlists', { body: body(over), playlist: scope }), code)
    await refused(send(c, 'POST', '/api/station/14/playlists', { body: body() }), 'refused_scope_missing')
    expect(az.writes()).toHaveLength(0)
    await send(c, 'POST', '/api/station/14/playlists', { body: body(), playlist: scope })
    expect(az.writes()).toHaveLength(1)
  })

  it('playlist PUT/DELETE/order: registry ids only, never ≤ 80 or 74–78, re-read name must match', async () => {
    const { az, c, scope } = setup()
    for (const id of [74, 75, 78, 80]) {
      await refused(send(c, 'PUT', `/api/station/14/playlist/${id}`, { body: { is_enabled: false }, playlist: { ...scope, registry: new Map([[id, 'x']]) } }), 'refused_playlist_floor')
      await refused(send(c, 'DELETE', `/api/station/14/playlist/${id}`, { playlist: { ...scope, registry: new Map([[id, 'x']]) } }), 'refused_playlist_floor')
    }
    await refused(send(c, 'PUT', '/api/station/14/playlist/102', { body: { is_enabled: false }, playlist: scope }), 'refused_not_registry')
    await refused(send(c, 'DELETE', '/api/station/14/playlist/102', { playlist: scope }), 'refused_not_registry')
    await refused(send(c, 'DELETE', '/api/station/14/playlist/102', { playlist: { ...scope, registry: new Map([[102, 'Grand Opening']]) } }), 'refused_registry_name_mismatch')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101', { body: { is_enabled: true }, playlist: scope }), 'refused_playlist_body')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101', { body: body({ name: 'Renamed' }), playlist: { ...scope, intentNames: new Set(['Renamed']) } }), 'refused_playlist_name_mismatch')
    az.playlists.get(101)!.order = 'sequential'
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { '1': 1, '2': 2 } }, playlist: scope }), 'refused_order_not_permutation')
    await refused(send(c, 'DELETE', '/api/station/14/playlist/101', { body: { x: 1 }, playlist: scope }), 'refused_body_on_delete')
    expect(az.writes()).toHaveLength(0)
    await c.disablePlaylist(101, scope)
    await c.deletePlaylist(101, scope)
    expect(az.writes().map((w) => w.method)).toEqual(['PUT', 'DELETE'])
  })

  it('order: a {entry id: weight 1..n} map over exactly the playlist’s own fresh entries', async () => {
    const { az, c, scope } = setup()
    az.playlists.get(101)!.order = 'sequential'
    const a = az.addFile('Music/Artists/A/a.mp3', { playlists: [101] })
    const b = az.addFile('Music/Artists/B/b.mp3', { playlists: [101] })
    const ea = String(101 * 100000 + a.id)
    const eb = String(101 * 100000 + b.id)
    // the 0.5.1 live-build shape: a JSON list (AzuraCast would update no row)
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: [Number(eb), Number(ea)] }, playlist: scope }), 'refused_order_body')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { [ea]: 1 } }, playlist: scope }), 'refused_order_not_permutation')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { [ea]: 1, [eb]: 2, '999': 3 } }, playlist: scope }), 'refused_order_not_permutation')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { [ea]: 1, [eb]: 1 } }, playlist: scope }), 'refused_order_duplicates')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { [ea]: 1, [eb]: 7 } }, playlist: scope }), 'refused_order_weights')
    await refused(send(c, 'PUT', '/api/station/14/playlist/101/order', { body: { order: { [ea]: 1, [eb]: 2 }, extra: 1 }, playlist: scope }), 'refused_order_body')
    expect(az.writes()).toHaveLength(0)
    await c.setOrder(101, [b.id, a.id], scope)
    // sent exactly as AzuraCast's setMediaOrder reads it
    expect(az.writes()).toEqual([{ method: 'PUT', path: '/api/station/14/playlist/101/order', body: { order: { [eb]: 1, [ea]: 2 } } }])
    expect((await c.playlistMediaOrder(101)).map((e) => e.mediaId)).toEqual([b.id, a.id])
    await c.setOrder(101, [a.id, b.id], scope)
    expect((await c.getPlaylistOrder(101)).map((e) => e.media?.id)).toEqual([a.id, b.id])
  })

  it('order: an echo that is not the sent map, or an order that did not change, fails the build step', async () => {
    const { az, c, scope } = setup()
    az.playlists.get(101)!.order = 'sequential'
    const a = az.addFile('Music/Artists/A/a.mp3', { playlists: [101] })
    const b = az.addFile('Music/Artists/B/b.mp3', { playlists: [101] })
    const real = az.fetch
    // AzuraCast answering 200 without applying the order (what a list body did)
    az.fetch = (async (input: string | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && String(input).endsWith('/order')) {
        const sent = JSON.parse(String(init.body)) as { order: Record<string, number> }
        return new Response(JSON.stringify(sent.order), { status: 200 })
      }
      return real(input, init)
    }) as unknown as typeof fetch
    const c2 = az.client()
    await expect(c2.setOrder(101, [b.id, a.id], scope)).rejects.toMatchObject({ code: 'order_not_applied' })
    // an echo of a list (the production answer to a list body)
    az.fetch = (async (input: string | URL, init: RequestInit = {}) => {
      if (init.method === 'PUT' && String(input).endsWith('/order')) return new Response(JSON.stringify([1, 2]), { status: 200 })
      return real(input, init)
    }) as unknown as typeof fetch
    await expect(az.client().setOrder(101, [b.id, a.id], scope)).rejects.toMatchObject({ code: 'unexpected_shape' })
    void c
  })

  it('POST /files only for the exact Events/Uploads path of that owner and audio id', async () => {
    const { az, c } = setup()
    const bytes = Buffer.from('ID3fake')
    const up = { ownerDiscordId: OWNER, audioId: 7 }
    await refused(send(c, 'POST', '/api/station/14/files', { uploadBytes: bytes, uploadPath: 'Music/Artists/A/x.mp3', upload: up }), 'refused_upload_path')
    await refused(send(c, 'POST', '/api/station/14/files', { uploadBytes: bytes, uploadPath: `Events/Uploads/${OWNER}/evt-a8.mp3`, upload: up }), 'refused_upload_path')
    await refused(send(c, 'POST', '/api/station/14/files', { uploadBytes: bytes, uploadPath: `Events/Uploads/${OWNER}/../x/evt-a7.mp3`, upload: up }), 'refused_upload_path')
    await refused(send(c, 'POST', '/api/station/14/files', { uploadBytes: bytes, uploadPath: `Events/Uploads/${OWNER}/evt-a7.mp3` }), 'refused_scope_missing')
    await refused(send(c, 'POST', '/api/station/14/files', { uploadBytes: bytes, uploadPath: 'x', upload: { ownerDiscordId: 'not-a-snowflake', audioId: 7 } }), 'refused_upload_identity')
    await refused(send(c, 'POST', '/api/station/14/files', { body: { path: 'x', file: '' }, upload: up }), 'refused_upload_shape')
    expect(az.writes()).toHaveLength(0)
    const m = await c.uploadFile(bytes, up)
    expect(m.path).toBe(`Events/Uploads/${OWNER}/evt-a7.mp3`)
  })

  it('PUT /file/{id}: strict metadata body, only on that audio’s Events/Uploads target', async () => {
    const { az, c } = setup()
    const lib = az.addFile('Music/Artists/A/a.mp3')
    const ev = az.addFile(`Events/Uploads/${OWNER}/evt-a7.mp3`)
    const m = { title: 't', artist: 'a', album: '', genre: '' }
    const scope = { mediaId: ev.id, ownerDiscordId: OWNER, audioId: 7 }
    await refused(send(c, 'PUT', `/api/station/14/file/${ev.id}`, { body: { ...m, playlists: [101] }, metadata: scope }), 'refused_metadata_body')
    await refused(send(c, 'PUT', `/api/station/14/file/${ev.id}`, { body: { ...m, path: 'Music/Artists/B/x.mp3' }, metadata: scope }), 'refused_metadata_body')
    await refused(send(c, 'PUT', `/api/station/14/file/${lib.id}`, { body: m, metadata: { ...scope, mediaId: lib.id } }), 'refused_metadata_target')
    await refused(send(c, 'PUT', `/api/station/14/file/${ev.id}`, { body: m, metadata: { ...scope, audioId: 8 } }), 'refused_metadata_target')
    await refused(send(c, 'PUT', `/api/station/14/file/${ev.id}`, { body: m, metadata: { ...scope, mediaId: lib.id } }), 'refused_scope_missing')
    expect(az.writes()).toHaveLength(0)
    await c.updateMetadata(ev.id, m, scope)
    expect(az.writes()).toHaveLength(1)
  })

  it('narrow DELETE /file/{id}: exact path, deleted row, no active or foreign membership', async () => {
    const { az, c } = setup()
    const lib = az.addFile('Music/Artists/A/a.mp3')
    const mine = az.addFile(`Events/Uploads/${OWNER}/evt-a7.mp3`)
    const base = { mediaId: mine.id, ownerDiscordId: OWNER, audioId: 7, audioDeleted: true, activeRegistryIds: new Set([101]), inactiveRegistryIds: new Set([102]) }
    const del = (id: number, s = base) => send(c, 'DELETE', `/api/station/14/file/${id}`, { fileDelete: s })
    await refused(del(lib.id, { ...base, mediaId: lib.id }), 'refused_delete_target')
    await refused(del(mine.id, { ...base, ownerDiscordId: OTHER }), 'refused_delete_target')
    await refused(del(mine.id, { ...base, audioDeleted: false }), 'refused_audio_not_deleted')
    await refused(send(c, 'DELETE', `/api/station/14/file/${mine.id}`), 'refused_scope_missing')
    mine.playlists = [101]
    await refused(del(mine.id), 'refused_delete_in_use')
    mine.playlists = [74]
    await refused(del(mine.id), 'refused_delete_foreign_membership')
    mine.playlists = [5]
    await refused(del(mine.id), 'refused_delete_foreign_membership')
    expect(az.writes()).toHaveLength(0)
    mine.playlists = [102]
    await c.deleteFile(mine.id, base)
    expect(az.files.has(mine.id)).toBe(false)
  })

  it('queue clear deletes only ids in a fresh queue read; restart takes no body', async () => {
    const { az, c } = setup()
    az.queue = [11, 12]
    await refused(send(c, 'DELETE', '/api/station/14/queue/99'), 'refused_queue_id')
    await refused(send(c, 'POST', '/api/station/14/backend/restart', { body: { force: true } }), 'refused_body_on_restart')
    expect(az.writes()).toHaveLength(0)
    expect(await c.clearQueue()).toBe(2)
    await c.restartBackend()
    expect(az.restarts).toBe(1)
  })

  it('queue rows are addressed by their links.self (AzuraCast sends no id); a foreign or inconsistent link is refused', async () => {
    const { az, c } = setup()
    az.queue = [11]
    expect(await c.getQueue()).toMatchObject([{ id: 11 }])
    const real = az.fetch
    const withQueue = (rows: unknown) =>
      Object.assign(new FakeAz(), {
        fetch: (async (input: string | URL, init: RequestInit = {}) => (String(input).endsWith('/api/station/14/queue') ? new Response(JSON.stringify(rows), { status: 200 }) : real(input, init))) as unknown as typeof fetch,
      }).client()
    await expect(withQueue([{ links: { self: 'https://az.invalid/api/station/1/queue/11' } }]).getQueue()).rejects.toMatchObject({ code: 'unexpected_shape' })
    await expect(withQueue([{ id: 12, links: { self: 'https://az.invalid/api/station/14/queue/11' } }]).getQueue()).rejects.toMatchObject({ code: 'unexpected_shape' })
    await expect(withQueue([{ song: { text: 'x' } }]).getQueue()).rejects.toMatchObject({ code: 'unexpected_shape' })
    expect(await withQueue([{ id: 11 }, { links: { self: '/api/station/14/queue/12' } }]).getQueue()).toMatchObject([{ id: 11 }, { id: 12 }])
  })

  it('a scope never rides on a read; the write gate runs last', async () => {
    const { az, c, scope } = setup()
    await refused(send(c, 'GET', '/api/station/14/playlists', { playlist: scope }), 'refused_scope_misuse')
    c.setWriteGate(async () => {
      throw new Error('paused')
    })
    await refused(c.disablePlaylist(101, scope), 'refused_queues_paused')
    expect(az.writes()).toHaveLength(0)
  })

  it('the transport is private; the seam refuses outside vitest; the client refuses station ≠ 14', async () => {
    const { az, c } = setup()
    expect((c as unknown as Record<string, unknown>).send).toBeUndefined()
    const prev = process.env.VITEST
    process.env.VITEST = 'false'
    try {
      await refused(send(c, 'GET', '/api/station/14/playlists'), 'test_seam_disabled')
    } finally {
      process.env.VITEST = prev
    }
    expect(() => new EventsAzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(24), stationId: 1, canaryStationIds: [7], fetchImpl: az.fetch })).toThrow()
    expect(() => new EventsAzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(24), stationId: 14, canaryStationIds: [14], fetchImpl: az.fetch })).toThrow()
    expect(() => new EventsAzuraCastClient({ baseUrl: 'https://az.invalid/x', apiKey: 'k'.repeat(24), stationId: 14, canaryStationIds: [1], fetchImpl: az.fetch })).toThrow()
    expect(az.calls).toHaveLength(0)
  })

  it('the id floor is independent of the registry', () => {
    for (const id of [1, 13, 74, 78, 80]) expect(() => assertWritablePlaylistId(id)).toThrow()
    expect(() => assertWritablePlaylistId(81)).not.toThrow()
  })
})

describe('events self-check', () => {
  it('own station 200 and the default canary 7 → 403 passes; station 1 is not probed (shared account)', async () => {
    const az = new FakeAz()
    const f = az.fetch
    // the one AzuraCast account manages stations 1 and 14: station 1 reads 200
    az.fetch = (async (u: string, i: RequestInit) => (String(u).includes('/station/1/') ? new Response('[]', { status: 200 }) : f(u, i))) as unknown as typeof fetch
    await keySelfCheck(az.client())
    expect(az.calls.map((x) => x.path)).toEqual(['/api/station/14/playlists', '/api/station/7/playlists'])
  })

  it('a key that reads a canary station refuses (a superadmin key reads station 7)', async () => {
    const az = new FakeAz()
    const f = az.fetch
    az.fetch = (async (u: string, i: RequestInit) => (String(u).includes('/station/7/') ? new Response('[]', { status: 200 }) : f(u, i))) as unknown as typeof fetch
    await expect(keySelfCheck(az.client())).rejects.toMatchObject({ code: 'self_check_canary_not_403' })
    // an explicit canary list is still honoured
    const az2 = new FakeAz()
    const f2 = az2.fetch
    az2.fetch = (async (u: string, i: RequestInit) => (String(u).includes('/station/1/') ? new Response('[]', { status: 200 }) : f2(u, i))) as unknown as typeof fetch
    await expect(keySelfCheck(az2.client([1, 7]))).rejects.toMatchObject({ code: 'self_check_canary_not_403', detail: { station: 1 } })
  })

  it('a key that cannot read station 14 refuses', async () => {
    const az = new FakeAz()
    az.fetch = (async () => new Response('{}', { status: 403 })) as unknown as typeof fetch
    await expect(keySelfCheck(az.client())).rejects.toMatchObject({ code: 'self_check_own_station' })
  })

  it('folder links: Events/Uploads or an owner folder blocks ingest; legacy 75 and 78 links do not', async () => {
    const az = new FakeAz()
    az.addFile('EFM Stingers/s.mp3', { playlists: [75] })
    az.addFile('Events/renfair/x.mp3', { playlists: [78] })
    az.addFile(`Events/Uploads/${OWNER}/evt-a1.mp3`)
    az.dirLinks.set('EFM Stingers', [75])
    az.dirLinks.set('Events/renfair', [78])
    expect((await folderLinkCheck(az.client())).ok).toBe(true)
    az.dirLinks.set(`Events/Uploads/${OWNER}`, [120])
    expect(await folderLinkCheck(az.client())).toMatchObject({ ok: false, linked: [{ folder: `Events/Uploads/${OWNER}` }] })
    az.dirLinks.delete(`Events/Uploads/${OWNER}`)
    az.dirLinks.set('Events', [120])
    expect((await folderLinkCheck(az.client())).ok).toBe(false)
  })
})

describe('membership merge', () => {
  const station14 = new Set([74, 75, 76, 77, 78, 101, 102, 201])

  it('shared song across two events + legacy 74 + a station-1 id: nothing foreign is dropped', () => {
    // song in legacy 74, event A's main (101) and station-1 playlist 5
    const m = mergeMembership({ current: [74, 101, 5], station14Ids: station14, superseded: new Set([201]), add: new Set([201]) })
    expect(m.desired).toEqual([74, 101, 201])
    expect(m.removed).toEqual([])
    expect(m.added).toEqual([201])
    // event B drops the song: only B's id goes
    const t = mergeMembership({ current: [74, 101, 201, 5], station14Ids: station14, superseded: new Set([201]), add: new Set() })
    expect(t.desired).toEqual([74, 101])
    expect(t.removed).toEqual([201])
  })

  it('rebuild: superseded ids of this event are replaced by the new ones', () => {
    const m = mergeMembership({ current: [74, 201, 202], station14Ids: new Set([...station14, 202, 203]), superseded: new Set([201, 202, 203]), add: new Set([203]) })
    expect(m.desired).toEqual([74, 203])
    expect(m.removed).toEqual([201, 202])
  })

  it('refuses to add a legacy or non-station-14 id, or to supersede one', () => {
    expect(() => mergeMembership({ current: [], station14Ids: station14, superseded: new Set(), add: new Set([74]) })).toThrow()
    expect(() => mergeMembership({ current: [], station14Ids: station14, superseded: new Set(), add: new Set([999]) })).toThrow(MembershipError)
    expect(() => mergeMembership({ current: [74], station14Ids: station14, superseded: new Set([74]), add: new Set() })).toThrow(MembershipError)
  })

  it('the wrapper re-applies the same rule on its own fresh read', () => {
    expect(() => checkMembershipWrite({ freshIds: [74, 101], station14Ids: station14, sent: [201], addable: new Set([201]), removable: new Set([201]) })).toThrow()
    expect(checkMembershipWrite({ freshIds: [74, 101, 5], station14Ids: station14, sent: [74, 101, 201], addable: new Set([201]), removable: new Set([201]) }).added).toEqual([201])
  })

  it('applyFileMembership writes only on change, and preserves everything else', async () => {
    const az = new FakeAz()
    az.playlists.set(101, { ...az.playlists.get(76)!, id: 101, name: 'A' })
    az.playlists.set(201, { ...az.playlists.get(76)!, id: 201, name: 'B' })
    const f = az.addFile('Music/Artists/A/a.mp3', { playlists: [74, 101, 5] })
    const c = az.client()
    const ids = new Set((await c.listPlaylists()).map((p) => p.id))
    await applyFileMembership(c, { mediaId: f.id, path: f.path, eventIds: new Set([201]), want: new Set([201]), station14Ids: ids })
    expect(f.playlists.sort((a, b) => a - b)).toEqual([5, 74, 101, 201])
    const n = az.writes().length
    await applyFileMembership(c, { mediaId: f.id, path: f.path, eventIds: new Set([201]), want: new Set([201]), station14Ids: ids })
    expect(az.writes()).toHaveLength(n)
  })
})
