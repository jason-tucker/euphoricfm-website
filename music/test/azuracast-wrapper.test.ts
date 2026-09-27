import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AzuraCastClient, AzuraCastError, base64JsonStream, mergePlaylists } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { MOCKS } from './helpers/env'
import { control } from './helpers/http'

const PREFIX_ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: 'Portal-Test/' }
const PROD_ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1' }

function fakeClient(env: Record<string, string> = PREFIX_ENV) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 })
  }) as unknown as typeof fetch
  const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(env), canaryStationId: 7, fetchImpl, env })
  return { c, calls }
}

async function refused(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AzuraCastError)
  await expect(p).rejects.toMatchObject({ code })
}

describe('AzuraCast wrapper refusals (no request leaves the process)', () => {
  it('forbidden batch actions: delete, queue, immediate, reprocess, anything else', async () => {
    const { c, calls } = fakeClient()
    for (const action of ['delete', 'queue', 'immediate', 'reprocess', 'clear', 'playlist_add']) {
      await refused(c.send('PUT', '/api/station/1/files/batch', { body: { do: action, files: ['Portal-Test/Music/Artists/A/a.mp3'], currentDirectory: 'Portal-Test/Music/Artists/A' } }), 'refused_batch_action')
    }
    expect(calls).toHaveLength(0)
  })

  it('non-empty dirs is refused (folder moves / folder playlist links)', async () => {
    const { c, calls } = fakeClient()
    await refused(
      c.send('PUT', '/api/station/1/files/batch', { body: { do: 'move', files: ['Portal-Test/Music/Artists/A/a.mp3'], dirs: ['Portal-Test/Music'], currentDirectory: 'Portal-Test/Music/Artists/A', directory: 'Portal-Test/Removed/1' } }),
      'refused_batch_dirs',
    )
    expect(calls).toHaveLength(0)
  })

  it('`path` or `playlists` in a file PUT is refused', async () => {
    const { c, calls } = fakeClient()
    const m = { title: 't', artist: 'a', album: '', genre: '' }
    await refused(c.send('PUT', '/api/station/1/file/5', { body: { ...m, path: 'Portal-Test/Music/Artists/B/x.mp3' } }), 'refused_metadata_body')
    await refused(c.send('PUT', '/api/station/1/file/5', { body: { ...m, playlists: [2] } }), 'refused_metadata_body')
    await refused(c.send('PUT', '/api/station/1/file/5', { body: { title: 't' } }), 'refused_metadata_body')
    expect(calls).toHaveLength(0)
  })

  it('a wrong station id is refused on every route', async () => {
    const { c, calls } = fakeClient()
    await refused(c.send('GET', '/api/station/7/files/list?currentDirectory=&flushCache=true'), 'refused_station')
    await refused(c.send('GET', '/api/station/14/file/1'), 'refused_station')
    await refused(c.send('PUT', '/api/station/2/files/batch', { body: {} }), 'refused_station')
    await refused(c.send('POST', '/api/station/7/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Portal-Test/Music/Artists/A/a.mp3' }), 'refused_station')
    expect(calls).toHaveLength(0)
  })

  it('the canary exception is GET files/list on the canary station only', async () => {
    const { c, calls } = fakeClient()
    await refused(c.send('GET', '/api/station/7/file/1', { canary: true }), 'refused_station')
    await refused(c.send('GET', '/api/station/14/files/list?currentDirectory=&flushCache=true', { canary: true }), 'refused_station')
    expect(calls).toHaveLength(0)
  })

  it('PORTAL_TEST_PREFIX: every write path must start with it', async () => {
    const { c, calls } = fakeClient()
    await refused(c.send('POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Music/Artists/A/a.mp3' }), 'refused_test_prefix')
    await refused(
      c.send('PUT', '/api/station/1/files/batch', { body: { do: 'move', files: ['Music/Artists/A/a.mp3'], dirs: [], currentDirectory: 'Music/Artists/A', directory: 'Removed/1' } }),
      'refused_batch_body',
    )
    await refused(c.moveFile('Music/Artists/A/a.mp3', 'Removed/1'), 'refused_batch_body')
    await refused(c.setPlaylists('Music/Artists/A/a.mp3', [2], new Set([2])), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('upload path must match the ingest pattern (no traversal, mp3 only)', async () => {
    const { c, calls } = fakeClient()
    for (const p of ['Portal-Test/Music/Artists/../../ADS/x.mp3', 'Portal-Test/ADS/x.mp3', 'Portal-Test/Music/Artists/A/x.m4a', 'Portal-Test/Music/Artists/A/b/x.mp3', 'Portal-Test/Music/Artists/A/.x.mp3/..']) {
      await expect(c.send('POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: p })).rejects.toBeInstanceOf(AzuraCastError)
    }
    const { c: prod, calls: prodCalls } = fakeClient(PROD_ENV)
    await refused(prod.send('POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Music/Artists/../ADS/x.mp3' }), 'refused_unsafe_path')
    await refused(prod.send('POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'ADS/x.mp3' }), 'refused_ingest_path')
    expect(calls).toHaveLength(0)
    expect(prodCalls).toHaveLength(0)
  })

  it('moves must follow the builder patterns', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    await refused(c.moveFile('ADS/Paid/x.mp3', 'Removed/3'), 'refused_batch_body')
    await refused(c.moveFile('Music/Artists/A/x.mp3', 'ADS'), 'refused_batch_body')
    await refused(c.moveFile('Removed/3/x.mp3', 'Removed/4'), 'refused_batch_body')
    await refused(c.moveFile('Music/Artists/A/x.mp3', 'Music/Artists/A'), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('playlists must be integer ids from the allowed set ("new" would create one)', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    await refused(c.setPlaylists('Music/Artists/A/x.mp3', [3], new Set([2])), 'refused_playlist_id')
    await refused(c.send('PUT', '/api/station/1/files/batch', { body: { do: 'playlist', files: ['Music/Artists/A/x.mp3'], currentDirectory: 'Music/Artists/A', playlists: ['new'], new_playlist_name: 'x' } }), 'refused_batch_body')
    await refused(c.send('PUT', '/api/station/1/files/batch', { body: { do: 'playlist', files: ['Music/Artists/A/x.mp3', 'Music/Artists/A/y.mp3'], currentDirectory: 'Music/Artists/A', playlists: [2] } }), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('anything off the allowlist is refused (DELETE, other paths, extra query keys)', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    await refused(c.send('DELETE', '/api/station/1/file/5'), 'refused_not_allowlisted')
    await refused(c.send('GET', '/api/admin/users'), 'refused_not_allowlisted')
    await refused(c.send('GET', '/api/station/1/playlists'), 'refused_not_allowlisted')
    await refused(c.send('POST', '/api/station/1/files/upload'), 'refused_not_allowlisted')
    await refused(c.send('GET', '/api/station/1/files/list?currentDirectory=Music'), 'refused_query_missing')
    await refused(c.send('GET', '/api/station/1/files/list?currentDirectory=Music&flushCache=true&searchPhrase=x'), 'refused_query')
    await refused(c.send('GET', '/api/station/1/files/list?currentDirectory=../x&flushCache=true'), 'refused_query')
    await refused(c.send('GET', 'https://evil.example/api/openapi.yml'), 'refused_path')
    await refused(c.send('GET', '/api/station/1/file/%35'), 'refused_encoded_path')
    expect(calls).toHaveLength(0)
  })

  it('an env change after start refuses every call', async () => {
    const env = { ...PREFIX_ENV }
    const calls: unknown[] = []
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(env), canaryStationId: 7, fetchImpl: (async () => { calls.push(1); return new Response('[]') }) as unknown as typeof fetch, env })
    env.PORTAL_TEST_PREFIX = ''
    await expect(c.listDirectory('Portal-Test')).rejects.toThrow(/changed at runtime/)
    expect(calls).toHaveLength(0)
  })

  it('upload refuses bytes whose sha256 is not the finalized one', async () => {
    const { c, calls } = fakeClient()
    await refused(c.uploadFile('Portal-Test/Music/Artists/A/a.mp3', Buffer.from('abc'), '0'.repeat(64)), 'sha_mismatch')
    expect(calls).toHaveLength(0)
  })

  it('streams the upload body as exact JSON', async () => {
    const bytes = Buffer.from(Array.from({ length: 1_000_003 }, (_, i) => i % 251))
    const s = base64JsonStream('Portal-Test/Music/Artists/A/"q".mp3', bytes)
    const text = Buffer.from(await new Response(s.body).arrayBuffer()).toString('utf8')
    expect(text.length).toBe(s.length)
    const parsed = JSON.parse(text)
    expect(parsed.path).toBe('Portal-Test/Music/Artists/A/"q".mp3')
    expect(Buffer.from(parsed.file, 'base64').equals(bytes)).toBe(true)
  })

  it('playlist merge keeps station memberships outside the assignable set, drops foreign ids', () => {
    const merged = mergePlaylists({ current: [2, 3, 74, 75], stationPlaylistIds: new Set([2, 3, 9]), assignable: new Set([2, 9]), chosen: [9] })
    expect(merged).toEqual([3, 9])
    expect(() => mergePlaylists({ current: [], stationPlaylistIds: new Set([2]), assignable: new Set([2]), chosen: [3] })).toThrow(AzuraCastError)
  })
})

describe.skipIf(!MOCKS())('AzuraCast wrapper against the P0d-B mock', () => {
  const env = { ...PREFIX_ENV }
  const client = () =>
    new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(env), canaryStationId: 7, env })

  beforeEach(async () => {
    await control('/__mock/az/mode', { superadmin: false, drift: false })
  })

  it('self-check passes with a station-scoped key and fails when the canary answers 200', async () => {
    await expect(client().selfCheck()).resolves.toBeUndefined()
    await control('/__mock/az/mode', { superadmin: true })
    await expect(client().selfCheck()).rejects.toMatchObject({ code: 'self_check_canary_not_403' })
  })

  it('collision check always flushes the 300 s list cache and sees unscanned files', async () => {
    const c = client()
    const dir = `Portal-Test/Music/Artists/Cache${Date.now()}`
    expect(await c.listDirectory(dir)).toEqual([]) // non-existent dir → 200 []
    await control('/__mock/az/unscanned', { path: `${dir}/SFTP - Upload.mp3` })
    // A plain (cached) listing would still be []: prove the wrapper flushes.
    const cached = await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/list?currentDirectory=${encodeURIComponent(dir)}`, { headers: { 'X-API-Key': process.env.AZURACAST_API_KEY! } })
    expect(await cached.json()).toEqual([])
    const entries = await c.listDirectory(dir)
    expect(entries).toEqual([expect.objectContaining({ type: 'other', text: 'File Processing', media: null })])
    expect(await c.pathTaken(dir, `${dir}/SFTP - Upload.mp3`)).toBe(true)
    const calls = (await control('/__mock/az/calls')) as { path: string; query: Record<string, string> }[]
    expect(calls.filter((x) => x.path.endsWith('/files/list') && x.query.currentDirectory === dir && x.query.flushCache !== 'true')).toHaveLength(1) // only the probe above
  })

  it('upload returns the media object; the overwrite is silent, so pathTaken must be checked first', async () => {
    const c = client()
    const path = `Portal-Test/Music/Artists/Up${Date.now()}/Artist - Song.mp3`
    const bytes = Buffer.from('fake mp3 bytes')
    const sha = createHash('sha256').update(bytes).digest('hex')
    const dir = path.slice(0, path.lastIndexOf('/'))
    expect(await c.pathTaken(dir, path)).toBe(false)
    const m1 = await c.uploadFile(path, bytes, sha)
    expect(m1).toMatchObject({ path, id: expect.any(Number), unique_id: expect.any(String) })
    expect(await c.pathTaken(dir, path)).toBe(true)
    const m2 = await c.uploadFile(path, bytes, sha) // what the collision check prevents
    expect(m2.id).toBe(m1.id)
    expect(m2.unique_id).toBe(m1.unique_id)
  })

  it('batch errors arrive with HTTP 200 and are treated as failure', async () => {
    const c = client()
    await expect(c.moveFile('Portal-Test/Music/Artists/Nope/missing.mp3', 'Portal-Test/Removed/9')).rejects.toMatchObject({ code: 'batch_errors' })
  })

  it('move and playlist replace on seeded files; metadata PUT resolves the id first', async () => {
    const c = client()
    const src = `Portal-Test/Music/Artists/Mv${Date.now()}/x.mp3`
    await control('/__mock/az/seed', { files: [{ path: src, title: 't', artist: 'a', playlists: [3, 74] }] })
    await c.setPlaylists(src, [2, 3], new Set([2, 3]))
    const listed = (await c.listDirectory(src.slice(0, src.lastIndexOf('/'))))[0]!
    expect(listed.media!.playlists.map((p) => p.id).sort()).toEqual([2, 3, 74]) // station-14 id 74 still aggregated
    await c.updateMetadata(listed.media!.id, { title: 'New', artist: 'A', album: '', genre: '' })
    const removed = `Portal-Test/Removed/${Date.now()}`
    await c.moveFile(src, removed)
    const moved = await c.getFile(listed.media!.id)
    expect(moved.path).toBe(`${removed}/x.mp3`)
    // A file outside the prefix (or outside Music/Artists) cannot be edited by id.
    await control('/__mock/az/seed', { files: [{ path: 'Music/Artists/GRIM/luvusm.mp3', title: 'Luv U SM', artist: 'GRIM' }] })
    const real = (await (await fetch(`${process.env.MOCKS_CONTROL}/__mock/az/files`)).json()) as { id: number; path: string }[]
    const grim = real.find((f) => f.path === 'Music/Artists/GRIM/luvusm.mp3')!
    await expect(c.updateMetadata(grim.id, { title: 'x', artist: 'x', album: '', genre: '' })).rejects.toMatchObject({ code: 'refused_test_prefix' })
    const calls = (await control('/__mock/az/calls')) as { method: string; path: string; body: { do?: string } }[]
    expect(calls.some((x) => x.body?.do === 'delete')).toBe(false)
    expect(calls.filter((x) => x.method === 'PUT' && x.path === `/api/station/1/file/${grim.id}`)).toHaveLength(0)
  })

  it('full list uses pagination', async () => {
    const all = await client().listAllFiles(2)
    expect(all.length).toBeGreaterThan(0)
    const calls = (await control('/__mock/az/calls')) as { path: string; query: Record<string, string> }[]
    const pages = calls.filter((x) => (x as { method?: string }).method === 'GET' && x.path === '/api/station/1/files')
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.every((x) => x.query.per_page === '2' && x.query.page)).toBe(true)
  })
})
