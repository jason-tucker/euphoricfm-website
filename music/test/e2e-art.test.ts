// Album-art uploads (art contract 2026-09-27) through the real web + probe
// containers: accepted types, refusals, the status IDOR and the signed preview.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { idMaker, REVIEWER_ROLE } from './helpers/e2e'
import { E2E } from './helpers/env'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { fxBuf } from './helpers/fixtures'
import { Jar, req, reqFresh } from './helpers/http'
import { waitFor } from './helpers/wait'

const newId = idMaker('8')

function form(fields: [string, Buffer | string, string?][]): FormData {
  const f = new FormData()
  for (const [name, value, filename] of fields) {
    if (typeof value === 'string') f.append(name, value)
    else f.append(name, new Blob([new Uint8Array(value)], { type: 'application/octet-stream' }), filename ?? 'x.bin')
  }
  return f
}

async function upload(jar: Jar, fields: [string, Buffer | string, string?][], headers: Record<string, string> = {}) {
  return req(jar, '/api/uploads/art', { method: 'POST', body: form(fields), headers })
}

type Status = { artId: string; status: string; reason?: string; previewUrl?: string; width?: number; height?: number }

async function settledArt(jar: Jar, artId: string): Promise<Status> {
  return waitFor(async () => {
    const s = (await (await req(jar, `/api/uploads/art/${artId}`)).json()) as Status
    return s.status !== 'processing' ? s : null
  }, 45_000)
}

describe.skipIf(!E2E())('album-art uploads', () => {
  it('JPEG, PNG and WebP become ready probe JPEGs (the client MIME type is ignored); the preview is a sandboxed image/jpeg', async () => {
    const jar = await loginOk({ id: newId() })
    for (const name of ['art.jpg', 'art.png', 'art.webp']) {
      const r = await upload(jar, [['art', fxBuf(name), 'evil.svg']])
      expect(r.status, name).toBe(202)
      const { artId, status } = (await r.json()) as Status
      expect(status).toBe('processing')
      const s = await settledArt(jar, artId)
      expect(s).toMatchObject({ status: 'ready', previewUrl: expect.stringMatching(/^\/api\/media\/art\//) })
      const img = await req(jar, s.previewUrl!)
      expect(img.status).toBe(200)
      expect(img.headers.get('content-type')).toBe('image/jpeg')
      expect(img.headers.get('x-content-type-options')).toBe('nosniff')
      expect(img.headers.get('content-security-policy')).toMatch(/^sandbox/)
      const bytes = Buffer.from(await img.arrayBuffer())
      const row = (await ownerSql()`SELECT jpeg_path, jpeg_sha256, raw_path FROM art_uploads WHERE id = ${artId}`)[0]!
      expect(row.jpeg_path).toBe(`/staging/art/${artId}/cover.jpg`)
      expect(row.jpeg_sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  it('refuses SVG, GIF, >5 MB, truncated, extra fields and cross-site posts', async () => {
    const jar = await loginOk({ id: newId() })
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')
    expect((await upload(jar, [['art', svg, 'a.png']])).status).toBe(415)
    expect((await upload(jar, [['art', fxBuf('art.gif'), 'a.gif']])).status).toBe(415)
    const png = fxBuf('art.png')
    const huge = Buffer.concat([png.subarray(0, png.length - 12), Buffer.alloc(5 * 1024 * 1024), png.subarray(png.length - 12)])
    // oversized: on its own connection (the early 413 closes it)
    const big = new Response(form([['art', huge, 'a.png']]))
    const bigBody = Buffer.from(await big.arrayBuffer())
    const r413 = await reqFresh(jar, '/api/uploads/art', { body: bigBody, headers: { 'content-type': big.headers.get('content-type')! } })
    expect(r413.status).toBe(413)
    const trunc = await upload(jar, [['art', png.subarray(0, png.length - 100), 'a.png']])
    expect(trunc.status).toBe(422)
    expect(await trunc.json()).toEqual({ error: 'image_truncated' })
    expect((await upload(jar, [['art', png, 'a.png'], ['note', 'x']])).status).toBe(400)
    expect((await upload(jar, [['picture', png, 'a.png']])).status).toBe(400)
    expect((await upload(jar, [['art', png, 'a.png']], { origin: 'https://euphoric.fm', 'sec-fetch-site': 'same-site' })).status).toBe(403)
    expect((await req(null, '/api/uploads/art', { method: 'POST', body: form([['art', png, 'a.png']]) })).status).toBe(401)
  })

  it('status and preview IDOR: another member gets 404; a reviewer may look; a signature is bound to its viewer', async () => {
    const owner = await loginOk({ id: newId() })
    const other = await loginOk({ id: newId() })
    const reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    const { artId } = (await (await upload(owner, [['art', fxBuf('art.jpg'), 'a.jpg']])).json()) as Status
    const s = await settledArt(owner, artId)
    expect((await req(other, `/api/uploads/art/${artId}`)).status).toBe(404)
    expect((await req(other, s.previewUrl!)).status).toBe(404)
    expect((await req(other, '/api/uploads/art/not-a-uuid')).status).toBe(404)
    const rv = (await (await req(reviewer, `/api/uploads/art/${artId}`)).json()) as Status
    expect(rv.status).toBe('ready')
    expect((await req(reviewer, s.previewUrl!)).status).toBe(403) // the owner's signature
    expect((await req(reviewer, rv.previewUrl!)).status).toBe(200)
  })
})
