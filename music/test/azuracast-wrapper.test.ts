import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { AzuraCastClient, AzuraCastError, base64JsonStream, mergePlaylists, samePathLoose, TEST_SEND } from '@/server/azuracast/client'
import { loadWorkerEnv } from '@/server/env'
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

// The transport is private; tests reach it only through the seam, which runs
// the same validate().
const send = (c: AzuraCastClient, ...a: Parameters<AzuraCastClient[typeof TEST_SEND]>) => c[TEST_SEND](...a)

async function refused(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toBeInstanceOf(AzuraCastError)
  await expect(p).rejects.toMatchObject({ code })
}

describe('AzuraCast wrapper refusals (no request leaves the process)', () => {
  it('forbidden batch actions: delete, queue, immediate, reprocess, anything else', async () => {
    const { c, calls } = fakeClient()
    for (const action of ['delete', 'queue', 'immediate', 'reprocess', 'clear', 'playlist_add']) {
      await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: { do: action, files: ['Portal-Test/Music/Artists/A/a.mp3'], currentDirectory: 'Portal-Test/Music/Artists/A' } }), 'refused_batch_action')
    }
    expect(calls).toHaveLength(0)
  })

  it('non-empty dirs is refused (folder moves / folder playlist links)', async () => {
    const { c, calls } = fakeClient()
    await refused(
      send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'move', files: ['Portal-Test/Music/Artists/A/a.mp3'], dirs: ['Portal-Test/Music'], currentDirectory: 'Portal-Test/Music/Artists/A', directory: 'Portal-Test/Removed/1' } }),
      'refused_batch_dirs',
    )
    expect(calls).toHaveLength(0)
  })

  it('`path` or `playlists` in a file PUT is refused', async () => {
    const { c, calls } = fakeClient()
    const m = { title: 't', artist: 'a', album: '', genre: '' }
    await refused(send(c, 'PUT', '/api/station/1/file/5', { body: { ...m, path: 'Portal-Test/Music/Artists/B/x.mp3' } }), 'refused_metadata_body')
    await refused(send(c, 'PUT', '/api/station/1/file/5', { body: { ...m, playlists: [2] } }), 'refused_metadata_body')
    await refused(send(c, 'PUT', '/api/station/1/file/5', { body: { title: 't' } }), 'refused_metadata_body')
    expect(calls).toHaveLength(0)
  })

  it('the raw transport is not public; the seam refuses outside vitest', async () => {
    const { c, calls } = fakeClient()
    expect((c as unknown as Record<string, unknown>).send).toBeUndefined()
    const prev = process.env.VITEST
    process.env.VITEST = 'false'
    try {
      await refused(send(c, 'GET', '/api/openapi.yml'), 'test_seam_disabled')
    } finally {
      process.env.VITEST = prev
    }
    expect(calls).toHaveLength(0)
  })

  it('a raw metadata PUT on an id outside the prefix / Music/Artists makes ZERO PUT calls', async () => {
    const calls: { url: string; method: string }[] = []
    const paths: Record<string, string> = { '1103': 'Events/Show/x.mp3', '1104': 'Music/Artists/GRIM/luvusm.mp3', '1105': 'Portal-Test/ADS/x.mp3', '1106': 'Portal-Test/Music/Artists/A/ok.mp3' }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method) })
      const id = /\/file\/(\d+)$/.exec(url)?.[1]
      if (init.method === 'GET' && id && paths[id]) return new Response(JSON.stringify({ id: Number(id), unique_id: 'u', path: paths[id], playlists: [] }), { status: 200 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(PREFIX_ENV), canaryStationId: 7, fetchImpl, env: PREFIX_ENV })
    const body = { title: 't', artist: 'a', album: '', genre: '' }
    await refused(send(c, 'PUT', '/api/station/1/file/1103', { body }), 'refused_test_prefix')
    await refused(send(c, 'PUT', '/api/station/1/file/1104', { body }), 'refused_test_prefix')
    await refused(send(c, 'PUT', '/api/station/1/file/1105', { body }), 'refused_metadata_target')
    await refused(c.updateMetadata(1103, body), 'refused_test_prefix')
    expect(calls.filter((x) => x.method === 'PUT')).toHaveLength(0)
    // In prod (no prefix) the Music/Artists pattern still applies.
    const prod = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(PROD_ENV), canaryStationId: 7, fetchImpl, env: PROD_ENV })
    await refused(send(prod, 'PUT', '/api/station/1/file/1103', { body }), 'refused_metadata_target')
    expect(calls.filter((x) => x.method === 'PUT')).toHaveLength(0)
    // A file on the surface passes: GET then PUT.
    await send(c, 'PUT', '/api/station/1/file/1106', { body })
    expect(calls.filter((x) => x.method === 'PUT')).toHaveLength(1)
  })

  it('a raw playlist batch needs an allowed set, and every id must be in it', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    const body = { do: 'playlist', files: ['Music/Artists/A/x.mp3'], dirs: [], currentDirectory: 'Music/Artists/A', playlists: [2, 99] }
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body }), 'refused_playlist_set_missing')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body, allowedPlaylistIds: new Set([2]) }), 'refused_playlist_id')
    await refused(send(c, 'GET', '/api/openapi.yml', { allowedPlaylistIds: new Set([2]) }), 'refused_playlist_set_misuse')
    expect(calls).toHaveLength(0)
    await send(c, 'PUT', '/api/station/1/files/batch', { body, allowedPlaylistIds: new Set([2, 99]) })
    expect(calls).toHaveLength(1)
  })

  it('what is validated is exactly what is sent (a toJSON cannot swap the body)', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    const sneaky = { title: 't', artist: 'a', album: '', genre: '', toJSON: () => ({ do: 'delete', files: ['Music/Artists/A/x.mp3'] }) }
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: sneaky }), 'refused_batch_action')
    expect(calls).toHaveLength(0)
  })

  it('collision compare is case- and accent-insensitive (MariaDB _ci collations)', () => {
    expect(samePathLoose('Music/Artists/GRIM/GRIM - Touch.mp3', 'Music/Artists/Grim/Grim - touch.mp3')).toBe(true)
    expect(samePathLoose('Music/Artists/Beyoncé/x.mp3', 'Music/Artists/Beyonce/x.mp3')).toBe(true)
    expect(samePathLoose('Music/Artists/A/x.mp3', 'Music/Artists/A/y.mp3')).toBe(false)
  })

  it('every canary station must answer 403 (e.g. 7 and 14)', async () => {
    const fetchImpl = (async (url: string) => new Response('[]', { status: url.includes('/station/14/') ? 200 : url.includes('/station/7/') ? 403 : 200 })) as unknown as typeof fetch
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(PROD_ENV), canaryStationId: 7, extraCanaryStationIds: [14], fetchImpl, env: PROD_ENV })
    await refused(c.selfCheck(), 'self_check_canary_not_403')
  })

  it('AZURACAST_BASE_URL must be a bare origin', () => {
    const base = { DATABASE_URL: 'postgres://x', AZURACAST_API_KEY: 'k'.repeat(20), TICKETS_WRITE_KEY: 'k' }
    expect(loadWorkerEnv({ ...base, AZURACAST_BASE_URL: 'https://euphoric.fm/' }).AZURACAST_BASE_URL).toBe('https://euphoric.fm')
    expect(() => loadWorkerEnv({ ...base, AZURACAST_BASE_URL: 'https://euphoric.fm/proxy' })).toThrow(/bare origin/)
    expect(() => loadWorkerEnv({ ...base, AZURACAST_BASE_URL: 'https://euphoric.fm/?x=1' })).toThrow(/bare origin/)
  })

  it('uploadArt: only a probe JPEG under the art dir, with the recorded sha, onto a Music/Artists file under the prefix', async () => {
    const artDir = mkdtempSync(join(tmpdir(), 'art-'))
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])])
    const id = randomUUID()
    mkdirSync(join(artDir, id))
    writeFileSync(join(artDir, id, 'cover.jpg'), jpeg)
    const sha = createHash('sha256').update(jpeg).digest('hex')
    const calls: { url: string; method: string; ct?: string }[] = []
    const paths: Record<string, string> = { '11': 'Portal-Test/Music/Artists/A/ok.mp3', '12': 'Events/Show/x.mp3', '13': 'Music/Artists/GRIM/luvusm.mp3' }
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), ct: (init.headers as Record<string, string>)['content-type'] })
      const mid = /\/file\/(\d+)$/.exec(url)?.[1]
      if (mid && paths[mid]) return new Response(JSON.stringify({ id: Number(mid), unique_id: 'u', path: paths[mid] }), { status: 200 })
      return new Response(JSON.stringify({ success: true }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(PREFIX_ENV), canaryStationId: 7, fetchImpl, env: PREFIX_ENV, artDir })
    const posts = () => calls.filter((x) => x.method === 'POST')
    await refused(c.uploadArt(12, join(artDir, id, 'cover.jpg'), sha), 'refused_test_prefix')
    await refused(c.uploadArt(13, join(artDir, id, 'cover.jpg'), sha), 'refused_test_prefix')
    await refused(c.uploadArt(11, join(artDir, id, 'cover.jpg'), '0'.repeat(64)), 'sha_mismatch')
    await refused(c.uploadArt(11, '/etc/passwd', sha), 'refused_art_path')
    await refused(c.uploadArt(11, `${artDir}/${id}/../${id}/cover.jpg`, sha), 'refused_art_path')
    const linkId = randomUUID()
    mkdirSync(join(artDir, linkId))
    symlinkSync(join(artDir, id, 'cover.jpg'), join(artDir, linkId, 'cover.jpg'))
    await refused(c.uploadArt(11, join(artDir, linkId, 'cover.jpg'), sha), 'art_missing') // never through a symlink
    const notJpeg = randomUUID()
    mkdirSync(join(artDir, notJpeg))
    writeFileSync(join(artDir, notJpeg, 'cover.jpg'), Buffer.from('<svg/>'))
    await refused(c.uploadArt(11, join(artDir, notJpeg, 'cover.jpg'), createHash('sha256').update('<svg/>').digest('hex')), 'refused_art_not_jpeg')
    expect(posts()).toHaveLength(0)
    // the raw transport cannot bypass the media-id check either
    await refused(send(c, 'POST', '/api/station/1/art/12', { artBytes: jpeg }), 'refused_test_prefix')
    await refused(send(c, 'POST', '/api/station/7/art/11', { artBytes: jpeg }), 'refused_station')
    await refused(send(c, 'POST', '/api/station/1/art/11', { body: { x: 1 } }), 'refused_art_shape')
    expect(posts()).toHaveLength(0)
    await c.uploadArt(11, join(artDir, id, 'cover.jpg'), sha)
    expect(posts()).toHaveLength(1)
    expect(posts()[0]!.url).toBe('https://az.invalid/api/station/1/art/11')
    expect(posts()[0]!.ct).toMatch(/^multipart\/form-data; boundary=efm[0-9a-f]{32}$/)
  })

  it('art read: station-checked, numeric id only, read-only, and a redirect is reported (never followed)', async () => {
    const { c, calls } = fakeClient()
    await refused(send(c, 'GET', '/api/station/7/art/5'), 'refused_station')
    await refused(send(c, 'GET', '/api/station/1/art/abc'), 'refused_not_allowlisted')
    await refused(send(c, 'GET', '/api/station/1/art/5?x=1'), 'refused_query')
    await refused(send(c, 'GET', '/api/station/1/art/5', { body: {} }), 'refused_body_on_read')
    expect(calls).toHaveLength(0)
    const seen: RequestInit[] = []
    const redirecting = new AzuraCastClient({
      baseUrl: 'https://az.invalid',
      apiKey: 'k'.repeat(20),
      profile: resolveProfile(PREFIX_ENV),
      canaryStationId: 7,
      env: PREFIX_ENV,
      writeGate: async () => {
        throw new Error('a read must not hit the write gate')
      },
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(init)
        return new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/generic.jpg' } })
      }) as unknown as typeof fetch,
    })
    expect(await redirecting.getArt(5)).toEqual({ kind: 'none' })
    expect(seen[0]).toMatchObject({ method: 'GET', redirect: 'manual' })
  })

  it('a wrong station id is refused on every route', async () => {
    const { c, calls } = fakeClient()
    await refused(send(c, 'GET', '/api/station/7/files/list?currentDirectory=&flushCache=true'), 'refused_station')
    await refused(send(c, 'GET', '/api/station/14/file/1'), 'refused_station')
    await refused(send(c, 'PUT', '/api/station/2/files/batch', { body: {} }), 'refused_station')
    await refused(send(c, 'POST', '/api/station/7/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Portal-Test/Music/Artists/A/a.mp3' }), 'refused_station')
    expect(calls).toHaveLength(0)
  })

  it('the canary exception is GET files/list on the canary station only', async () => {
    const { c, calls } = fakeClient()
    await refused(send(c, 'GET', '/api/station/7/file/1', { canary: true }), 'refused_station')
    await refused(send(c, 'GET', '/api/station/14/files/list?currentDirectory=&flushCache=true', { canary: true }), 'refused_station')
    expect(calls).toHaveLength(0)
  })

  it('PORTAL_TEST_PREFIX: every write path must start with it', async () => {
    const { c, calls } = fakeClient()
    await refused(send(c, 'POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Music/Artists/A/a.mp3' }), 'refused_test_prefix')
    await refused(
      send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'move', files: ['Music/Artists/A/a.mp3'], dirs: [], currentDirectory: 'Music/Artists/A', directory: 'Removed/1' } }),
      'refused_batch_body',
    )
    await refused(c.moveFile('Music/Artists/A/a.mp3', 'Removed/1'), 'refused_batch_body')
    await refused(c.setPlaylists('Music/Artists/A/a.mp3', [2], new Set([2])), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('upload path must match the ingest pattern (no traversal, mp3 only)', async () => {
    const { c, calls } = fakeClient()
    for (const p of ['Portal-Test/Music/Artists/../../ADS/x.mp3', 'Portal-Test/ADS/x.mp3', 'Portal-Test/Music/Artists/A/x.m4a', 'Portal-Test/Music/Artists/A/b/x.mp3', 'Portal-Test/Music/Artists/A/.x.mp3/..']) {
      await expect(send(c, 'POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: p })).rejects.toBeInstanceOf(AzuraCastError)
    }
    const { c: prod, calls: prodCalls } = fakeClient(PROD_ENV)
    await refused(send(prod, 'POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'Music/Artists/../ADS/x.mp3' }), 'refused_unsafe_path')
    await refused(send(prod, 'POST', '/api/station/1/files', { uploadBytes: Buffer.from('x'), uploadPath: 'ADS/x.mp3' }), 'refused_ingest_path')
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

  it('move: a batch "success" whose GET shows another path is a failure', async () => {
    const calls: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`)
      if (url.includes('/files/list') && url.includes('currentDirectory=Music%2FArtists%2FA&')) {
        return new Response(JSON.stringify([{ path: 'Music/Artists/A/x.mp3', type: 'media', media: { id: 9, unique_id: 'u', path: 'Music/Artists/A/x.mp3' } }]), { status: 200 })
      }
      if (url.includes('/files/list')) return new Response('[]', { status: 200 })
      if (url.endsWith('/file/9')) return new Response(JSON.stringify({ id: 9, unique_id: 'u', path: 'Music/Artists/A/x.mp3' }), { status: 200 })
      return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const c = new AzuraCastClient({ baseUrl: 'https://az.invalid', apiKey: 'k'.repeat(20), profile: resolveProfile(PROD_ENV), canaryStationId: 7, fetchImpl, env: PROD_ENV })
    await refused(c.moveFile('Music/Artists/A/x.mp3', 'Music/Artists/B'), 'move_verify_failed')
    expect(calls.filter((x) => x.startsWith('PUT'))).toHaveLength(1)
  })

  it('playlists must be integer ids from the allowed set ("new" would create one)', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    await refused(c.setPlaylists('Music/Artists/A/x.mp3', [3], new Set([2])), 'refused_playlist_id')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'playlist', files: ['Music/Artists/A/x.mp3'], currentDirectory: 'Music/Artists/A', playlists: ['new'], new_playlist_name: 'x' } }), 'refused_batch_body')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'playlist', files: ['Music/Artists/A/x.mp3', 'Music/Artists/A/y.mp3'], currentDirectory: 'Music/Artists/A', playlists: [2] } }), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('anything off the allowlist is refused (DELETE, other paths, extra query keys)', async () => {
    const { c, calls } = fakeClient(PROD_ENV)
    await refused(send(c, 'DELETE', '/api/station/1/file/5'), 'refused_not_allowlisted')
    await refused(send(c, 'GET', '/api/admin/users'), 'refused_not_allowlisted')
    await refused(send(c, 'GET', '/api/station/1/playlists'), 'refused_not_allowlisted')
    await refused(send(c, 'POST', '/api/station/1/files/upload'), 'refused_not_allowlisted')
    await refused(send(c, 'GET', '/api/station/1/files/list?currentDirectory=Music'), 'refused_query_missing')
    await refused(send(c, 'GET', '/api/station/1/files/list?currentDirectory=Music&flushCache=true&searchPhrase=x'), 'refused_query')
    await refused(send(c, 'GET', '/api/station/1/files/list?currentDirectory=../x&flushCache=true'), 'refused_query')
    await refused(send(c, 'GET', 'https://evil.example/api/openapi.yml'), 'refused_path')
    await refused(send(c, 'GET', '/api/station/1/file/%35'), 'refused_encoded_path')
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
    const src = `Portal-Test/Music/Artists/Err${Date.now()}/x.mp3`
    await control('/__mock/az/seed', { files: [{ path: src }] })
    await control('/__mock/az/batch-errors-next', { errors: [`${src}: simulated`] })
    await expect(c.setPlaylists(src, [2], new Set([2]))).rejects.toMatchObject({ code: 'batch_errors' })
  })

  it('move: a missing source is refused BEFORE the batch (upstream would report success)', async () => {
    const c = client()
    const before = ((await control('/__mock/az/calls')) as { path: string }[]).length
    await expect(c.moveFile(`Portal-Test/Music/Artists/Nope${Date.now()}/missing.mp3`, 'Portal-Test/Removed/9')).rejects.toMatchObject({ code: 'move_source_missing' })
    const calls = ((await control('/__mock/az/calls')) as { path: string }[]).slice(before)
    expect(calls.some((x) => x.path.endsWith('/files/batch'))).toBe(false)
    // and the mock really does mirror upstream: a raw batch on it "succeeds"
    const r = await fetch(`${process.env.MOCKS_AZURACAST}/api/station/1/files/batch`, {
      method: 'PUT',
      headers: { 'X-API-Key': process.env.AZURACAST_API_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({ do: 'move', files: ['Portal-Test/Music/Artists/Nope/missing.mp3'], currentDirectory: 'Portal-Test/Music/Artists/Nope', directory: 'Portal-Test/Removed/9' }),
    })
    expect(await r.json()).toMatchObject({ success: true, errors: [] })
  })

  it('move: an occupied destination (media or unscanned) is refused and nothing is overwritten', async () => {
    const c = client()
    const t = Date.now()
    const a = `Portal-Test/Music/Artists/A${t}/Song.mp3`
    const bDir = `Portal-Test/Music/Artists/B${t}`
    await control('/__mock/az/seed', { files: [{ path: a }, { path: `${bDir}/Song.mp3` }] })
    const before = ((await control('/__mock/az/calls')) as { path: string }[]).length
    await expect(c.moveFile(a, bDir)).rejects.toMatchObject({ code: 'refused_move_collision' })
    const cDir = `Portal-Test/Music/Artists/C${t}`
    await control('/__mock/az/unscanned', { path: `${cDir}/Song.mp3` })
    await expect(c.moveFile(a, cDir)).rejects.toMatchObject({ code: 'refused_move_collision' })
    const calls = ((await control('/__mock/az/calls')) as { path: string; query: Record<string, string> }[]).slice(before)
    expect(calls.some((x) => x.path.endsWith('/files/batch'))).toBe(false)
    expect(calls.filter((x) => x.path.endsWith('/files/list')).every((x) => x.query.flushCache === 'true')).toBe(true)
    expect(((await control('/__mock/az/overwrites')) as { dest: string }[]).filter((o) => o.dest.includes(String(t)))).toEqual([])
    // A free destination moves, and the new path is verified by id.
    const dDir = `Portal-Test/Music/Artists/D${t}`
    await c.moveFile(a, dDir)
    const files = (await control('/__mock/az/files')) as { path: string }[]
    expect(files.some((f) => f.path === `${dDir}/Song.mp3`)).toBe(true)
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

  it('uploadArt against the mock: one multipart `file` part with the exact bytes; art_updated_at moves', async () => {
    const artDir = mkdtempSync(join(tmpdir(), 'art-m-'))
    const c = new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(env), canaryStationId: 7, env, artDir })
    const path = `Portal-Test/Music/Artists/Art${Date.now()}/x.mp3`
    await control('/__mock/az/seed', { files: [{ path }] })
    const media = (await c.listDirectory(path.slice(0, path.lastIndexOf('/'))))[0]!.media!
    expect((media as { art_updated_at?: number }).art_updated_at).toBe(0)
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 3), Buffer.from([0xff, 0xd9])])
    const id = randomUUID()
    mkdirSync(join(artDir, id))
    writeFileSync(join(artDir, id, 'cover.jpg'), jpeg)
    const sha = createHash('sha256').update(jpeg).digest('hex')
    await c.uploadArt(media.id, join(artDir, id, 'cover.jpg'), sha)
    const ups = (await control('/__mock/az/art-uploads')) as { mediaId: number; field: string; sha256: string }[]
    expect(ups.at(-1)).toMatchObject({ mediaId: media.id, field: 'file', sha256: sha })
    expect(((await c.getFile(media.id)) as { art_updated_at?: number }).art_updated_at).toBeGreaterThan(0)
    // The read-only art GET: the stored image (no key or prefix rule needed:
    // it names no path), and before any upload the generic-image redirect,
    // reported as 'none', never followed.
    const got = await c.getArt(media.id)
    expect(got).toMatchObject({ kind: 'art', sha256: sha })
    const other = `Portal-Test/Music/Artists/Art${Date.now()}b/y.mp3`
    await control('/__mock/az/seed', { files: [{ path: other }] })
    const bare = (await c.listDirectory(other.slice(0, other.lastIndexOf('/'))))[0]!.media!
    expect(await c.getArt(bare.id)).toEqual({ kind: 'none' })
  })

  it('full list uses pagination', async () => {
    const all = await client().listAllFiles(2)
    expect(all.length).toBeGreaterThan(0)
    const calls = (await control('/__mock/az/calls')) as { path: string; query: Record<string, string> }[]
    const pages = calls.filter((x) => (x as { method?: string }).method === 'GET' && x.path === '/api/station/1/files')
    expect(pages.length).toBeGreaterThan(1)
    // (the running worker's library sync pages too, with per_page=100)
    expect(pages.every((x) => x.query.per_page && x.query.page)).toBe(true)
    expect(pages.filter((x) => x.query.per_page === '2').length).toBeGreaterThan(1)
  })
})

// v0.3.3: the UNRELEASED import may name that folder ONLY through the two
// legacy methods (memberships of the file, and its move to Removed/<id>),
// and the release may rename ONLY inside one Removed/<id>/ folder.
describe('v0.3.3 legacy import + release: the only requests that may name UNRELEASED or rename', () => {
  const L = 'Portal-Test/UNRELEASED-DO NOT ADD TO ROTATION'
  const R = 'Portal-Test/Removed/5'

  it('the general methods (and any hand-built batch) still refuse the UNRELEASED folder', async () => {
    const { c, calls } = fakeClient()
    await refused(c.moveFile(`${L}/x.m4a`, 'Portal-Test/Removed/5'), 'refused_batch_body')
    await refused(c.moveFile(`${L}/x.m4a`, 'Portal-Test/Music/Artists/A'), 'refused_batch_body')
    await refused(c.setPlaylists(`${L}/x.m4a`, [], new Set()), 'refused_batch_body')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'move', files: [`${L}/x.m4a`], dirs: [], currentDirectory: L, directory: R } }), 'refused_batch_body')
    await refused(send(c, 'PUT', '/api/station/1/files/batch', { body: { do: 'playlist', files: [`${L}/x.m4a`], dirs: [], currentDirectory: L, playlists: [] }, allowedPlaylistIds: new Set() }), 'refused_batch_body')
    expect(calls).toHaveLength(0)
  })

  it('the legacy methods take only an UNRELEASED .mp3/.m4a, and move it only to Removed/<id>', async () => {
    const { c, calls } = fakeClient()
    await refused(c.moveLegacyToArchive(`${L}/x.m4a`, 'Portal-Test/Music/Artists/A'), 'refused_batch_body')
    await refused(c.moveLegacyToArchive(`${L}/x.m4a`, 'Portal-Test/Removed/5/sub'), 'refused_batch_body')
    await refused(c.moveLegacyToArchive('Portal-Test/Music/Artists/A/x.mp3', R), 'refused_batch_body')
    await refused(c.moveLegacyToArchive('Portal-Test/Removed/4/x.mp3', R), 'refused_batch_body')
    await refused(c.moveLegacyToArchive(`${L}/x.flac`, R), 'refused_batch_body')
    await refused(c.moveLegacyToArchive(`${L}/a/b/c/d/x.mp3`, R), 'refused_batch_body')
    await refused(c.moveLegacyToArchive('UNRELEASED-DO NOT ADD TO ROTATION/x.mp3', R), 'refused_batch_body') // outside the test prefix
    await refused(c.setLegacyPlaylists('Portal-Test/Music/Artists/A/x.mp3', [], new Set()), 'refused_batch_body')
    await refused(c.setLegacyPlaylists(`${L}/x.mp3`, [2], new Set([3])), 'refused_playlist_id')
    // the legacy flag is refused on anything but a batch
    await refused(send(c, 'PUT', '/api/station/1/file/5', { body: { title: 't', artist: 'a', album: '', genre: '' }, legacySource: true }), 'refused_legacy_misuse')
    await refused(send(c, 'PUT', '/api/station/1/files/rename', { body: { file: `${R}/x.m4a`, newPath: `${R}/x (2).m4a` }, legacySource: true }), 'refused_legacy_misuse')
    expect(calls).toHaveLength(0)
    // A legacy playlist REPLACE on a nested m4a: exactly this body leaves.
    await c.setLegacyPlaylists(`${L}/Music/KOKORO/x.m4a`, [], new Set([2]))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ do: 'playlist', files: [`${L}/Music/KOKORO/x.m4a`], dirs: [], currentDirectory: `${L}/Music/KOKORO`, playlists: [] })
  })

  it('rename: only inside one Removed/<id>/ folder, same extension, never a no-op; nothing else', async () => {
    const { c, calls } = fakeClient()
    const bad: [string, string][] = [
      [`${R}/x.m4a`, 'Portal-Test/Music/Artists/A/x.m4a'],
      [`${R}/x.m4a`, 'Portal-Test/Removed/6/x.m4a'],
      [`${R}/x.m4a`, `${R}/x.mp3`],
      [`${R}/x.m4a`, `${R}/x.m4a`],
      ['Portal-Test/Music/Artists/A/x.m4a', 'Portal-Test/Music/Artists/A/x (2).m4a'],
      [`${L}/x.m4a`, `${L}/x (2).m4a`],
      [`${R}/x.m4a`, `${R}/sub/x (2).m4a`],
      [`${R}/x.m4a`, `${R}/../x (2).m4a`],
      ['Removed/5/x.m4a', 'Removed/5/x (2).m4a'], // outside the test prefix
    ]
    for (const [a, b] of bad) await refused(c.renameInArchive(a, b), 'refused_rename_body')
    await refused(send(c, 'PUT', '/api/station/1/files/rename', { body: { file: `${R}/x.m4a`, newPath: `${R}/x (2).m4a`, extra: 1 } }), 'refused_rename_body')
    await refused(send(c, 'PUT', '/api/station/1/files/rename', { body: { file: `${R}/x.m4a` } }), 'refused_rename_body')
    await refused(send(c, 'POST', '/api/station/1/files/rename', { body: { file: `${R}/x.m4a`, newPath: `${R}/x (2).m4a` } }), 'refused_not_allowlisted')
    expect(calls).toHaveLength(0)
  })
})

describe.skipIf(!MOCKS())('v0.3.3 rename + legacy move against the upstream-faithful mock', () => {
  const env = { ...PREFIX_ENV }
  const client = () => new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(env), canaryStationId: 7, env })
  const files = async () => (await control('/__mock/az/files')) as { id: number; path: string; playlists: { id: number }[] }[]

  it('renameInArchive: same id, new name; an occupied name (media or unscanned) is refused and nothing is overwritten', async () => {
    const c = client()
    const dir = `Portal-Test/Removed/${900000 + (Date.now() % 90000)}`
    await control('/__mock/az/seed', { files: [{ path: `${dir}/song.m4a`, title: 'S', artist: 'A' }, { path: `${dir}/song (2).m4a`, title: 'Other', artist: 'B' }] })
    await control('/__mock/az/unscanned', { path: `${dir}/song (3).m4a` })
    const before = (await files()).find((f) => f.path === `${dir}/song.m4a`)!
    const over0 = ((await control('/__mock/az/overwrites')) as unknown[]).length
    const ren0 = ((await control('/__mock/az/renames')) as unknown[]).length
    await refused(c.renameInArchive(`${dir}/song.m4a`, `${dir}/song (2).m4a`), 'refused_move_collision')
    await refused(c.renameInArchive(`${dir}/song.m4a`, `${dir}/song (3).m4a`), 'refused_move_collision')
    await refused(c.renameInArchive(`${dir}/missing.m4a`, `${dir}/missing (2).m4a`), 'move_source_missing')
    expect(((await control('/__mock/az/renames')) as unknown[]).length).toBe(ren0)
    await c.renameInArchive(`${dir}/song.m4a`, `${dir}/song (4).m4a`)
    const after = (await files()).find((f) => f.id === before.id)!
    expect(after.path).toBe(`${dir}/song (4).m4a`)
    expect(((await control('/__mock/az/overwrites')) as unknown[]).length).toBe(over0)
    const call = ((await control('/__mock/az/calls')) as { method: string; path: string; body: unknown }[]).filter((x) => x.path === '/api/station/1/files/rename').at(-1)!
    expect(call).toMatchObject({ method: 'PUT', body: { file: `${dir}/song.m4a`, newPath: `${dir}/song (4).m4a` } })
  })

  it('moveLegacyToArchive + setLegacyPlaylists: a same-id move of an m4a; the REPLACE is station-scoped', async () => {
    const c = client()
    const n = Date.now()
    const src = `Portal-Test/UNRELEASED-DO NOT ADD TO ROTATION/Music/W${n}/w${n}.m4a`
    await control('/__mock/az/seed', { files: [{ path: src, title: 'W', artist: 'A', playlists: [2, 74] }] })
    const m = (await files()).find((f) => f.path === src)!
    await c.setLegacyPlaylists(src, [], new Set([2]))
    expect((await files()).find((f) => f.id === m.id)!.playlists.map((p) => p.id)).toEqual([74]) // station 14's stays
    const dest = `Portal-Test/Removed/${m.id}`
    await c.moveLegacyToArchive(src, dest)
    const moved = (await files()).find((f) => f.id === m.id)!
    expect(moved.path).toBe(`${dest}/w${n}.m4a`)
  })
})
