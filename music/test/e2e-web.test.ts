// Headers, CSRF, body caps and tus against the built music-web container.
import { describe, expect, it } from 'vitest'
import { buildCsp } from '@/server/http/csp'
import { E2E } from './helpers/env'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { fxBuf } from './helpers/fixtures'
import { req } from './helpers/http'
import { tusCreate, tusHead, tusPatch, tusUpload } from './helpers/tus'

let seq = 0
const newId = () => `5${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

describe.skipIf(!E2E())('security headers on the built server', () => {
  it('pages carry exactly the plan CSP with a per-request nonce that matches every script tag', async () => {
    const r1 = await req(null, '/')
    const r2 = await req(null, '/')
    const csp = r1.headers.get('content-security-policy')!
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)![1]!
    expect(csp).toBe(buildCsp(nonce))
    expect(r2.headers.get('content-security-policy')).not.toBe(csp)
    const html = await r1.text()
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])
    expect(scripts.length).toBeGreaterThan(0)
    for (const s of scripts) expect(s).toContain(`nonce="${nonce}"`)
    expect(r1.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains')
    expect(r1.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r1.headers.get('referrer-policy')).toBe('same-origin')
    expect(r1.headers.get('x-powered-by')).toBeNull()
  })

  it('API responses and static assets get HSTS / nosniff / Referrer-Policy too', async () => {
    const api = await req(null, '/api/health')
    expect(api.headers.get('x-content-type-options')).toBe('nosniff')
    expect(api.headers.get('strict-transport-security')).toBeTruthy()
    const html = await (await req(null, '/')).text()
    const asset = /\/_next\/static\/[^"]+\.js/.exec(html)![0]
    const s = await req(null, asset)
    expect(s.status).toBe(200)
    expect(s.headers.get('x-content-type-options')).toBe('nosniff')
    expect(s.headers.get('referrer-policy')).toBe('same-origin')
  })
})

describe.skipIf(!E2E())('CSRF (exact Origin + Sec-Fetch-Site) and body caps', () => {
  it('a cross-site POST from a sibling euphoric.fm host is refused even with a valid session', async () => {
    const jar = await loginOk({ id: newId() })
    const before = (await ownerSql()`SELECT count(*)::int AS n FROM batches`)[0]!.n
    const cross = await req(jar, '/api/batches', { method: 'POST', headers: { origin: 'https://euphoric.fm', 'sec-fetch-site': 'same-site' } })
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'csrf_origin' })
    const noSite = await req(jar, '/api/batches', { method: 'POST', headers: { origin: 'https://music.euphoric.fm', 'sec-fetch-site': 'cross-site' } })
    expect(noSite.status).toBe(403)
    const noOrigin = await req(jar, '/api/batches', { method: 'POST', sameOrigin: false })
    expect(noOrigin.status).toBe(403)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM batches`)[0]!.n).toBe(before)
    expect((await req(jar, '/api/batches', { method: 'POST' })).status).toBe(201)
  })

  it('a cross-site server-action POST to a page is refused', async () => {
    const r = await req(null, '/', { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'next-action': 'x' }, body: '[]' })
    expect(r.status).toBe(403)
  })

  it('1 MB body cap on non-upload routes (declared and chunked)', async () => {
    const jar = await loginOk({ id: newId() })
    const b = (await (await req(jar, '/api/batches', { method: 'POST' })).json()) as { id: number }
    const big = JSON.stringify({ body: 'x'.repeat(1024 * 1024 + 10) })
    expect((await req(jar, `/api/batches/${b.id}/comments`, { body: big, headers: { 'content-type': 'application/json' } })).status).toBe(413)
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024)))
        c.close()
      },
    })
    const r = await req(jar, `/api/batches/${b.id}/comments`, { body: stream, headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(413)
  })

  it('mutations are rate-limited to 30/min per cf-connecting-ip', async () => {
    const jar = await loginOk({ id: newId() })
    const ip = `2001:db8::${Math.floor(Math.random() * 0xffff).toString(16)}:${Date.now().toString(16).slice(-4)}`
    const codes: number[] = []
    for (let i = 0; i < 31; i++) codes.push((await req(jar, '/api/batches', { method: 'POST', ip })).status)
    expect(codes.slice(0, 30).every((c) => c === 201)).toBe(true)
    expect(codes[30]).toBe(429)
  })
})

describe.skipIf(!E2E())('tus uploads', () => {
  it('create → patch → head works; HEAD resume needs no Origin', async () => {
    const jar = await loginOk({ id: newId() })
    const data = fxBuf('raw35.mp3')
    const c = await tusCreate(jar, data.length, { 'upload-metadata': `owner ${Buffer.from('someone-else').toString('base64')}` })
    expect(c.status).toBe(201)
    const loc = c.headers.get('location')!
    expect(loc).toMatch(/^\/api\/uploads\/[0-9a-f]{32}$/)
    const half = Math.floor(data.length / 2)
    expect((await tusPatch(jar, loc, 0, data.subarray(0, half))).status).toBe(204)
    const h = await tusHead(jar, loc, {}) // no Origin / Sec-Fetch-Site on a safe method
    expect(h.status).toBe(200)
    expect(h.headers.get('upload-offset')).toBe(String(half))
    expect((await tusPatch(jar, loc, half, data.subarray(half))).status).toBe(204)
    const id = loc.split('/').pop()!
    const row = (await ownerSql()`SELECT u.discord_id, up.status FROM uploads up JOIN "user" u ON u.id = up.owner_user_id WHERE up.id = ${id}`)[0]!
    expect(row.status).toBe('complete')
    expect(row.discord_id).not.toBe('someone-else') // client Upload-Metadata is discarded
  })

  it('IDOR: another member cannot HEAD, PATCH or DELETE the upload', async () => {
    const a = await loginOk({ id: newId() })
    const b = await loginOk({ id: newId() })
    const c = await tusCreate(a, 1000)
    const loc = c.headers.get('location')!
    expect((await tusHead(b, loc)).status).toBe(404)
    expect((await tusPatch(b, loc, 0, Buffer.alloc(100))).status).toBe(404)
    expect((await req(b, loc, { method: 'DELETE', headers: { 'tus-resumable': '1.0.0' } })).status).toBe(404)
    const h = await tusHead(a, loc)
    expect(h.status).toBe(200)
    expect(h.headers.get('upload-offset')).toBe('0')
    expect((await tusHead(null as never, loc)).status).toBe(401)
  })

  it('GET never streams staged bytes back', async () => {
    const a = await loginOk({ id: newId() })
    const id = await tusUpload(a, fxBuf('html.mp3'))
    expect((await req(a, `/api/uploads/${id}`)).status).toBe(405)
  })

  it('refuses Upload-Length −1 / >35 MB / missing, defer-length, concatenation, creation bodies', async () => {
    const a = await loginOk({ id: newId() })
    expect((await tusCreate(a, -1)).status).toBe(400)
    expect((await tusCreate(a, 35 * 1024 * 1024 + 1)).status).toBe(413)
    expect((await req(a, '/api/uploads', { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-defer-length': '1' } })).status).toBe(400)
    expect((await req(a, '/api/uploads', { method: 'POST', headers: { 'tus-resumable': '1.0.0', 'upload-concat': 'final;/api/uploads/a /api/uploads/b' } })).status).toBe(400)
    expect((await req(a, '/api/uploads', { method: 'POST', headers: { 'tus-resumable': '1.0.0' } })).status).toBe(400)
    const withBody = await req(a, '/api/uploads', { method: 'POST', body: 'abc', headers: { 'tus-resumable': '1.0.0', 'upload-length': '3', 'content-type': 'application/offset+octet-stream' } })
    expect(withBody.status).toBe(400)
  })

  it('refuses chunks over 8 MB and cross-site PATCH', async () => {
    const a = await loginOk({ id: newId() })
    const c = await tusCreate(a, 9 * 1024 * 1024)
    const loc = c.headers.get('location')!
    expect((await tusPatch(a, loc, 0, Buffer.alloc(8 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await tusPatch(a, loc, 0, Buffer.alloc(10), { origin: 'https://euphoric.fm', 'sec-fetch-site': 'same-site' })).status).toBe(403)
  })

  it('3 concurrent uploads per member, the 4th is refused', async () => {
    const a = await loginOk({ id: newId() })
    for (let i = 0; i < 3; i++) expect((await tusCreate(a, 1000)).status).toBe(201)
    const r = await tusCreate(a, 1000)
    expect(r.status).toBe(429)
  })

  it('1 GB in flight per member', async () => {
    const id = newId()
    const a = await loginOk({ id })
    const uid = (await ownerSql()`SELECT id FROM "user" WHERE discord_id = ${id}`)[0]!.id
    const big = 'f'.repeat(24) + String(Date.now()).slice(-8)
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status) VALUES (${big}, ${uid}, ${1024 * 1024 * 1024 - 100}, 'uploading')`
    try {
      expect((await tusCreate(a, 1000)).status).toBe(429)
    } finally {
      await ownerSql()`DELETE FROM uploads WHERE id = ${big}`
    }
  })

  it('5 GB staged globally', async () => {
    const id = newId()
    const a = await loginOk({ id })
    const uid = (await ownerSql()`SELECT id FROM "user" WHERE discord_id = ${id}`)[0]!.id
    // 160 attached 32 MB uploads (5 GB) minus a little headroom
    const tag = String(Date.now()).slice(-8)
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status)
      SELECT lpad(to_hex(g), 24, 'e') || ${tag}, ${uid}, (CASE WHEN g = 1 THEN ${32 * 1024 * 1024 - 500}::int ELSE ${32 * 1024 * 1024}::int END), 'attached'
      FROM generate_series(1, 160) g`
    try {
      const r = await tusCreate(a, 1000)
      expect(r.status).toBe(503)
      expect(await r.text()).toContain('staging_full')
    } finally {
      await ownerSql()`DELETE FROM uploads WHERE owner_user_id = ${uid} AND id LIKE ${'%' + tag}`
    }
  })
})
