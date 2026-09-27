// End-to-end: upload → network-less probe → worker → review → tickets, with
// the IDOR, preview, staff-visibility, webhook and inbox checks.
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { E2E } from './helpers/env'
import { loginOk } from './helpers/auth'
import { ownerSql } from './helpers/db'
import { fxBuf } from './helpers/fixtures'
import { control, Jar, req } from './helpers/http'
import { tusUpload } from './helpers/tus'
import { waitFor } from './helpers/wait'

const REVIEWER_ROLE = '1144462744456794153'
let seq = 0
const newId = () => `6${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

type Item = { id: number; status: string; title: string | null; probeError: string | null; hasCover: boolean }

async function createBatch(jar: Jar): Promise<number> {
  const r = await req(jar, '/api/batches', { method: 'POST' })
  expect(r.status).toBe(201)
  return ((await r.json()) as { id: number }).id
}

async function addFile(jar: Jar, batchId: number, fixture: string): Promise<number> {
  const uploadId = await tusUpload(jar, fxBuf(fixture))
  const r = await req(jar, `/api/batches/${batchId}/items`, { json: { uploadId } })
  expect(r.status).toBe(201)
  return ((await r.json()) as { id: number }).id
}

async function settled(jar: Jar, itemId: number): Promise<Item> {
  return waitFor(async () => {
    const it = (await (await req(jar, `/api/items/${itemId}`)).json()) as Item
    return it.status !== 'probing' ? it : null
  }, 45_000)
}

function sign(body: string, deliveryId: string, t = Math.floor(Date.now() / 1000)) {
  const secret = process.env.TICKETS_WEBHOOK_SECRET!
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${deliveryId}.${body}`).digest('hex')}`
}

async function hook(body: unknown, opts: { deliveryId?: string; t?: number; sig?: string; headers?: Record<string, string> } = {}) {
  const raw = JSON.stringify(body)
  const deliveryId = opts.deliveryId ?? randomUUID()
  const res = await fetch(`${process.env.E2E_WEB_URL}/api/hooks/tickets`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-euphoric-delivery': deliveryId,
      'x-euphoric-event': (body as { event: string }).event,
      'x-euphoric-signature': opts.sig ?? sign(raw, deliveryId, opts.t),
      ...(opts.headers ?? {}),
    },
    body: raw,
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, deliveryId }
}

describe.skipIf(!E2E())('submission flow through the real containers', () => {
  let owner: Jar
  let ownerId: string
  let other: Jar
  let reviewer: Jar
  let batchId: number
  let goodItem: number
  let svgItem: number

  beforeAll(async () => {
    ownerId = newId()
    owner = await loginOk({ id: ownerId })
    await control('/__mock/tickets/member', { id: ownerId, member: true })
    other = await loginOk({ id: newId() })
    reviewer = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    batchId = await createBatch(owner)
    goodItem = await addFile(owner, batchId, 'tagged-png.mp3')
    svgItem = await addFile(owner, batchId, 'svg-cover.mp3')
  })

  it('probe accepts a real mp3 and pre-fills its tags', async () => {
    const it1 = await settled(owner, goodItem)
    expect(it1).toMatchObject({ status: 'pending', title: 'Test Title', hasCover: true })
    const row = (await ownerSql()`SELECT probe_sha256 FROM items WHERE id = ${goodItem}`)[0]!
    expect(row.probe_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('hostile files are rejected by the network-less probe, with no egress', async () => {
    const b = await createBatch(owner)
    const hls = await addFile(owner, b, 'hls-id3.mp3')
    const hlsFake = await addFile(owner, b, 'hls-fakeframe.mp3')
    const bomb = await addFile(owner, b, 'zlib-bomb.mp3')
    const apic = await addFile(owner, b, 'huge-apic.mp3')
    expect(await settled(owner, hls)).toMatchObject({ status: 'rejected', probeError: 'not_mp3' })
    expect(await settled(owner, hlsFake)).toMatchObject({ status: 'rejected', probeError: 'not_mp3' })
    expect(await settled(owner, bomb)).toMatchObject({ status: 'rejected', probeError: 'id3_compressed_frame' })
    expect(await settled(owner, apic)).toMatchObject({ status: 'rejected', probeError: 'id3_too_large' })
    expect(await control('/__mock/canary/hits')).toEqual([])
  })

  it('previews: owner gets audio/mpeg with nosniff + sandbox CSP; others get 404; bad signatures 403', async () => {
    const p = (await (await req(owner, `/api/items/${goodItem}/preview`)).json()) as { audioUrl: string; coverUrl: string }
    const a = await req(owner, p.audioUrl)
    expect(a.status).toBe(200)
    expect(a.headers.get('content-type')).toBe('audio/mpeg')
    expect(a.headers.get('x-content-type-options')).toBe('nosniff')
    expect(a.headers.get('content-security-policy')).toMatch(/^sandbox/)
    expect(a.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(Buffer.from(await a.arrayBuffer()).equals(fxBuf('tagged-png.mp3'))).toBe(true)
    const range = await req(owner, p.audioUrl, { headers: { range: 'bytes=0-9' } })
    expect(range.status).toBe(206)
    expect((await range.arrayBuffer()).byteLength).toBe(10)
    // IDOR: the item and its preview do not exist for another member
    expect((await req(other, `/api/items/${goodItem}`)).status).toBe(404)
    expect((await req(other, `/api/items/${goodItem}/preview`)).status).toBe(404)
    expect((await req(other, p.audioUrl)).status).toBe(404)
    expect((await req(other, `/api/batches/${batchId}`)).status).toBe(404)
    // a reviewer may preview, but not with the owner's signature
    expect((await req(reviewer, p.audioUrl)).status).toBe(403)
    const forged = p.audioUrl.replace(/sig=[^&]+/, `sig=${'A'.repeat(43)}`)
    expect((await req(owner, forged)).status).toBe(403)
    const cover = await req(owner, p.coverUrl)
    expect(cover.headers.get('content-type')).toBe('image/jpeg')
  })

  it('an SVG cover is served only as a re-encoded JPEG', async () => {
    const it2 = await settled(owner, svgItem)
    expect(it2).toMatchObject({ status: 'pending', hasCover: true })
    const p = (await (await req(owner, `/api/items/${svgItem}/preview`)).json()) as { coverUrl: string }
    const c = await req(owner, p.coverUrl)
    expect(c.status).toBe(200)
    expect(c.headers.get('content-type')).toBe('image/jpeg')
    expect(c.headers.get('content-security-policy')).toMatch(/^sandbox/)
    const bytes = Buffer.from(await c.arrayBuffer())
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
    expect(bytes.includes(Buffer.from('<svg'))).toBe(false)
    expect(bytes.includes(Buffer.from('<script'))).toBe(false)
    expect(await control('/__mock/canary/hits')).toEqual([]) // the SVG's external href was never fetched
  })

  it('the dashboard lists only the member’s own items', async () => {
    const mine = await (await req(owner, '/dashboard')).text()
    expect(mine).toContain(`data-item-id="${goodItem}"`)
    const theirs = await (await req(other, '/dashboard')).text()
    expect(theirs).not.toContain(`data-item-id="${goodItem}"`)
    expect(theirs).not.toContain('Test Title')
  })

  it('another member cannot attach someone else’s upload, withdraw their item or comment on their batch', async () => {
    const uploadId = await tusUpload(owner, fxBuf('raw35.mp3'))
    const otherBatch = await createBatch(other)
    expect((await req(other, `/api/batches/${otherBatch}/items`, { json: { uploadId } })).status).toBe(409)
    expect((await req(other, `/api/batches/${batchId}/items`, { json: { uploadId } })).status).toBe(404)
    expect((await req(other, `/api/items/${goodItem}/withdraw`, { method: 'POST' })).status).toBe(404)
    expect((await req(other, `/api/batches/${batchId}/comments`, { json: { body: 'hi' } })).status).toBe(404)
    expect((await req(other, `/api/items/${goodItem}/decision`, { json: { decision: 'deny', reason: 'x' } })).status).toBe(403)
  })

  it('submitting opens exactly one ticket with the portal card', async () => {
    expect((await req(owner, `/api/batches/${batchId}/submit`, { json: { attest: false } })).status).toBe(400)
    expect((await req(owner, `/api/batches/${batchId}/submit`, { json: { attest: true } })).status).toBe(200)
    expect((await req(owner, `/api/batches/${batchId}/submit`, { json: { attest: true } })).status).toBe(409)
    const t = await waitFor(async () => {
      const all = (await control('/__mock/tickets/tickets')) as { externalRef: string; categoryKey: string; opener: string; card: { link: { url: string }; lines: string[] } }[]
      return all.find((x) => x.externalRef === `batch:${batchId}`)
    })
    expect(t.categoryKey).toBe('newsong')
    expect(t.opener).toBe(ownerId)
    expect(new URL(t.card.link.url).origin).toBe('https://music.euphoric.fm')
    expect(t.card.lines.some((l) => l.includes('Test Title'))).toBe(true)
    const b = await waitFor(async () => ((await (await req(owner, `/api/batches/${batchId}`)).json()) as { ticket: unknown }).ticket)
    expect(b).toMatchObject({ webUrl: expect.stringContaining('/t/') })
  })

  it('a staff comment is never forwarded and never shown to the submitter; a public one is', async () => {
    const staffBody = `staff-only ${randomUUID()}`
    const publicBody = `public note ${randomUUID()}`
    expect((await req(owner, `/api/batches/${batchId}/comments`, { json: { body: 'x', visibility: 'staff' } })).status).toBe(403)
    expect((await req(reviewer, `/api/batches/${batchId}/comments`, { json: { body: staffBody, visibility: 'staff', itemId: goodItem } })).status).toBe(201)
    expect((await req(reviewer, `/api/batches/${batchId}/comments`, { json: { body: publicBody, visibility: 'all' } })).status).toBe(201)
    const msgs = await waitFor(async () => {
      const m = (await control('/__mock/tickets/messages')) as { body: string; key: string }[]
      return m.some((x) => x.body.includes(publicBody)) ? m : null
    })
    expect(msgs.some((x) => x.body.includes(staffBody))).toBe(false)
    const calls = (await control('/__mock/tickets/calls')) as { body?: { body?: string } }[]
    expect(calls.some((c) => JSON.stringify(c.body ?? {}).includes(staffBody))).toBe(false)
    const ownerView = (await (await req(owner, `/api/batches/${batchId}/comments`)).json()) as { body: string }[]
    expect(ownerView.some((c) => c.body === staffBody)).toBe(false)
    expect(ownerView.some((c) => c.body === publicBody)).toBe(true)
    const revView = (await (await req(reviewer, `/api/batches/${batchId}/comments`)).json()) as { body: string }[]
    expect(revView.some((c) => c.body === staffBody)).toBe(true)
    const job = await ownerSql()`SELECT count(*)::int AS n FROM jobs WHERE kind = 'ticket_comment' AND payload->>'commentId' IN (SELECT id::text FROM comments WHERE body = ${staffBody})`
    expect(job[0]!.n).toBe(0)
  })

  it('two racing approvals: exactly one wins, the other gets 409; approved_sha256 = probe sha', async () => {
    const [a, b] = await Promise.all([
      req(reviewer, `/api/items/${goodItem}/decision`, { json: { decision: 'approve' } }),
      req(reviewer, `/api/items/${goodItem}/decision`, { json: { decision: 'approve' } }),
    ])
    expect([a.status, b.status].sort()).toEqual([200, 409])
    const row = (await ownerSql()`SELECT status, probe_sha256, approved_sha256, playlist_ids, self_approved FROM items WHERE id = ${goodItem}`)[0]!
    expect(row.status).toBe('approved')
    expect(row.approved_sha256).toBe(row.probe_sha256)
    expect(row.playlist_ids).toEqual([2])
    expect(row.self_approved).toBe(false)
    expect((await req(reviewer, `/api/items/${svgItem}/decision`, { json: { decision: 'approve', playlistIds: [3] } })).status).toBe(400)
    expect((await req(reviewer, `/api/items/${svgItem}/decision`, { json: { decision: 'deny' } })).status).toBe(400)
    expect((await req(reviewer, `/api/items/${svgItem}/decision`, { json: { decision: 'deny', reason: 'Wrong artist' } })).status).toBe(200)
    expect((await req(owner, `/api/items/${svgItem}/withdraw`, { method: 'POST' })).status).toBe(409)
    await waitFor(async () => {
      const m = (await control('/__mock/tickets/messages')) as { body: string; kind: string }[]
      return m.some((x) => x.kind === 'system' && x.body.includes('Denied') && x.body.includes('Wrong artist'))
    })
  })

  it('self-approval is allowed but flagged', async () => {
    const selfId = newId()
    const jar = await loginOk({ id: selfId, roles: [REVIEWER_ROLE] })
    const b = await createBatch(jar)
    const item = await addFile(jar, b, 'raw35.mp3')
    await settled(jar, item)
    const r = await req(jar, `/api/items/${item}/decision`, { json: { decision: 'approve' } })
    expect(await r.json()).toMatchObject({ status: 'approved', selfApproved: true })
  })

  it('tickets webhook: signed reply lands on the batch; replay, stale, bad signature and edge-routed requests are refused', async () => {
    const ticketId = (await ownerSql()`SELECT ticket_id FROM batches WHERE id = ${batchId}`)[0]!.ticket_id as number
    const body = `reply ${randomUUID()}`
    const payload = { event: 'message.created', ticketId, externalRef: `batch:${batchId}`, occurredAt: new Date().toISOString(), message: { id: randomUUID(), source: 'discord', body, createdAt: new Date().toISOString(), author: { discordId: '1', name: 'Staffer' }, attachments: [] } }
    const ok = await hook(payload)
    expect(ok).toMatchObject({ status: 200, body: { ok: true } })
    const replay = await hook(payload, { deliveryId: ok.deliveryId })
    expect(replay.body).toMatchObject({ duplicate: true })
    const count = await ownerSql()`SELECT count(*)::int AS n FROM comments WHERE body = ${body}`
    expect(count[0]!.n).toBe(1)
    expect((await hook(payload, { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401)
    expect((await hook(payload, { sig: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` })).status).toBe(401)
    expect((await hook(payload, { headers: { 'cf-connecting-ip': '1.2.3.4' } })).status).toBe(404)
    const view = (await (await req(owner, `/api/batches/${batchId}/comments`)).json()) as { body: string; source: string }[]
    expect(view).toContainEqual(expect.objectContaining({ body, source: 'ticket' }))
  })

  it('webhook anchoring is scoped to the ticket’s own batch', async () => {
    const ticketId = (await ownerSql()`SELECT ticket_id FROM batches WHERE id = ${batchId}`)[0]!.ticket_id as number
    const foreignBatch = await createBatch(other)
    const foreignItem = await addFile(other, foreignBatch, 'raw35.mp3')
    const mk = (item: number, body: string) => ({ event: 'message.created', ticketId, externalRef: `batch:${batchId}`, message: { id: randomUUID(), source: 'discord', body: `[item:${item}] ${body}`, author: null } })
    await hook(mk(foreignItem, 'foreign'))
    await hook(mk(goodItem, 'own'))
    const rows = await ownerSql()`SELECT item_id, batch_id, body FROM comments WHERE body LIKE ${'%foreign'} OR body = 'own' ORDER BY id DESC LIMIT 2`
    const foreign = rows.find((r) => String(r.body).includes('foreign'))!
    const own = rows.find((r) => r.body === 'own')!
    expect(foreign.item_id).toBeNull()
    expect(foreign.batch_id).toBe(batchId)
    expect(own.item_id).toBe(goodItem)
    // a ticket id with the wrong externalRef is ignored
    const wrong = await hook({ event: 'message.created', ticketId, externalRef: 'batch:999999', message: { id: randomUUID(), source: 'web', body: 'nope', author: null } })
    expect(wrong.body).toMatchObject({ ignored: 'unknown_ticket' })
  })

  it('the probe container refuses a finalize request dropped into in-web', async () => {
    const id = randomUUID()
    const row = (await ownerSql()`SELECT upload_id, probe_sha256 FROM items WHERE id = ${goodItem}`)[0]!
    const dir = join(process.env.TEST_DATA_DIR!, 'spool/probe/in-web')
    writeFileSync(join(dir, `.t-${id}`), JSON.stringify({ v: 1, id, type: 'finalize', upload: row.upload_id, approvedSha256: row.probe_sha256, tags: { title: 'a', artist: 'b', album: '', genre: '' }, cover: null }))
    const { renameSync } = await import('node:fs')
    renameSync(join(dir, `.t-${id}`), join(dir, `${id}.json`))
    const out = await waitFor(async () => {
      try {
        return JSON.parse(readFileSync(join(process.env.TEST_DATA_DIR!, `spool/probe/out/${id}.json`), 'utf8'))
      } catch {
        return null
      }
    })
    expect(out).toMatchObject({ ok: false, error: 'type_not_allowed_in_inbox', source: 'in-web', type: 'finalize' })
    expect(() => readFileSync(join(process.env.TEST_DATA_DIR!, `staging/final/${id}.mp3`))).toThrow()
  })
})
