import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decryptField, deriveSubkey, encryptField, parseEncKey } from '@/server/crypto'
import { checkCsrf } from '@/server/http/csrf'
import { buildCsp } from '@/server/http/csp'
import { clientKey, LIMITS, RateLimiter } from '@/server/http/ratelimit'
import { checkBodyLimited, readBodyLimited } from '@/server/http/body'
import { computePerms } from '@/server/authz/permissions'
import { canComment, canSeeComment, canViewOwned, type Viewer } from '@/server/authz/predicates'
import { verifyTicketsSignature } from '@/server/hooks/signature'
import { signMediaUrl, verifyMediaSig } from '@/server/media/signing'
import { assertProbeEnvClean, loadWebEnv, loadWorkerEnv } from '@/server/env'
import { assertSeedable } from '@/migrate/main'
import { encryptAccountTokens } from '@/server/auth/tokens'
import { checkCreateHeaders, checkPatchHeaders } from '@/server/uploads/caps'

const H = (o: Record<string, string>) => new Headers(o)
const ORIGIN = 'https://music.euphoric.fm'

describe('CSRF gate', () => {
  it('requires exact Origin AND Sec-Fetch-Site: same-origin on unsafe methods', () => {
    expect(checkCsrf('POST', '/api/batches', H({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' }), ORIGIN).ok).toBe(true)
    expect(checkCsrf('POST', '/api/batches', H({ origin: 'https://euphoric.fm', 'sec-fetch-site': 'same-site' }), ORIGIN)).toEqual({ ok: false, reason: 'origin' })
    expect(checkCsrf('POST', '/api/batches', H({ origin: ORIGIN, 'sec-fetch-site': 'same-site' }), ORIGIN)).toEqual({ ok: false, reason: 'fetch_site' })
    expect(checkCsrf('DELETE', '/x', H({ 'sec-fetch-site': 'same-origin' }), ORIGIN)).toEqual({ ok: false, reason: 'origin' })
    expect(checkCsrf('PATCH', '/x', H({ origin: 'null', 'sec-fetch-site': 'same-origin' }), ORIGIN).ok).toBe(false)
    expect(checkCsrf('PUT', '/x', H({ origin: `${ORIGIN}.evil.com`, 'sec-fetch-site': 'same-origin' }), ORIGIN).ok).toBe(false)
    expect(checkCsrf('POST', '/x', H({ origin: 'http://music.euphoric.fm', 'sec-fetch-site': 'same-origin' }), ORIGIN).ok).toBe(false)
  })
  it('safe methods pass; only the exact hook path is exempt', () => {
    expect(checkCsrf('GET', '/api/me', H({}), ORIGIN).ok).toBe(true)
    expect(checkCsrf('HEAD', '/api/uploads/x', H({}), ORIGIN).ok).toBe(true)
    expect(checkCsrf('POST', '/api/hooks/tickets', H({}), ORIGIN).ok).toBe(true)
    expect(checkCsrf('POST', '/api/hooks/tickets/x', H({}), ORIGIN).ok).toBe(false)
    expect(checkCsrf('POST', '/api/hooks/', H({}), ORIGIN).ok).toBe(false)
  })
})

describe('CSP', () => {
  it('is exactly the plan directives', () => {
    expect(buildCsp('N')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-N'; img-src 'self' data: blob: https://cdn.discordapp.com https://euphoric.fm; media-src 'self' blob:; connect-src 'self'; form-action 'self' https://discord.com; frame-ancestors 'none'; base-uri 'none'",
    )
  })
})

describe('rate limiter', () => {
  it('limits per key and window, evicts oldest keys', () => {
    const rl = new RateLimiter(3)
    for (let i = 0; i < 20; i++) expect(rl.hit(LIMITS.auth, 'a', 0).ok).toBe(true)
    expect(rl.hit(LIMITS.auth, 'a', 0)).toEqual({ ok: false, retryAfterS: 60 })
    expect(rl.hit(LIMITS.auth, 'b', 0).ok).toBe(true)
    expect(rl.hit(LIMITS.auth, 'a', 60_000).ok).toBe(true)
    rl.hit(LIMITS.auth, 'c', 0)
    rl.hit(LIMITS.auth, 'd', 0)
    expect((rl as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(3)
  })
  it('keys on cf-connecting-ip only when it looks like an IP', () => {
    expect(clientKey(H({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.9')
    expect(clientKey(H({ 'x-forwarded-for': '1.1.1.1' }))).toBe('no-cf-ip')
    expect(clientKey(H({ 'cf-connecting-ip': 'x; drop' }))).toBe('no-cf-ip')
    // IPv6: one bucket per /64; IPv4-mapped → IPv4
    expect(clientKey(H({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }))).toBe('2001:db8:1:2::/64')
    expect(clientKey(H({ 'cf-connecting-ip': '2001:db8:1:2:bbbb:cccc:dddd:eeee' }))).toBe('2001:db8:1:2::/64')
    expect(clientKey(H({ 'cf-connecting-ip': '2001:db8:1:3::1' }))).not.toBe('2001:db8:1:2::/64')
    expect(clientKey(H({ 'cf-connecting-ip': '::ffff:203.0.113.9' }))).toBe('203.0.113.9')
    expect(clientKey(H({ 'cf-connecting-ip': '::1' }))).toBe('0:0:0:0::/64')
    expect(clientKey(H({ 'cf-connecting-ip': '1:2:3:4:5:6:7:8:9' }))).toBe('no-cf-ip')
  })
})

describe('body cap', () => {
  it('refuses declared and streamed bodies over the cap', async () => {
    await expect(readBodyLimited(new Request('http://x', { method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '10' } }), 5)).rejects.toMatchObject({ status: 413 })
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)); c.enqueue(new Uint8Array(4)); c.close() } })
    await expect(readBodyLimited(new Request('http://x', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), 5)).rejects.toMatchObject({ status: 413 })
    expect((await readBodyLimited(new Request('http://x', { method: 'POST', body: 'abc' }), 5)).toString()).toBe('abc')
  })

  // bytes are counted first: a stream that fails AFTER the cap was exceeded
  // is still 413; one that fails below the cap is 400 bad_body
  const failing = (sizes: number[]) =>
    new Request('http://x', {
      method: 'POST',
      duplex: 'half',
      // pull-based: error() would discard chunks still queued
      body: new ReadableStream({
        pull(c) {
          const n = sizes.shift()
          if (n === undefined) c.error(new Error('ECONNRESET'))
          else c.enqueue(new Uint8Array(n))
        },
      }),
    } as RequestInit)
  it('a stream error after the cap is exceeded is 413, below it 400', async () => {
    await expect(readBodyLimited(failing([4, 4]), 5)).rejects.toMatchObject({ status: 413 })
    await expect(readBodyLimited(failing([4]), 5)).rejects.toMatchObject({ status: 400, code: 'bad_body' })
    expect(await checkBodyLimited(failing([4, 4]), 5)).toBe('too_large')
    expect(await checkBodyLimited(failing([4]), 5)).toBe('bad_body')
  })

  it('checkBodyLimited (middleware) reads to the end and applies the same cap', async () => {
    const chunked = (sizes: number[]) =>
      new Request('http://x', { method: 'POST', duplex: 'half', body: new ReadableStream({ start(c) { for (const n of sizes) c.enqueue(new Uint8Array(n)); c.close() } }) } as RequestInit)
    expect(await checkBodyLimited(chunked([2, 3]), 5)).toBe('ok')
    expect(await checkBodyLimited(chunked([2, 3, 1]), 5)).toBe('too_large')
    expect(await checkBodyLimited(new Request('http://x', { method: 'POST', body: 'x'.repeat(10), headers: { 'content-length': '10' } }), 5)).toBe('too_large')
    expect(await checkBodyLimited(new Request('http://x', { method: 'POST' }), 5)).toBe('ok')
    const cl = new Request('http://x', { method: 'POST', body: 'abc' })
    expect(await checkBodyLimited(cl, 5)).toBe('ok')
  })
})

describe('AES-256-GCM token envelopes', () => {
  const key = parseEncKey('0123456789abcdef'.repeat(4))
  it('round-trips and binds the AAD', () => {
    const e = encryptField('secret-token', 'account:discord:1:access_token', key)
    expect(e).not.toContain('secret-token')
    expect(decryptField(e, 'account:discord:1:access_token', key)).toBe('secret-token')
    expect(() => decryptField(e, 'account:discord:1:refresh_token', key)).toThrow()
    expect(() => decryptField(e, 'account:discord:2:access_token', key)).toThrow()
    const i = e.length - 2
    const tampered = e.slice(0, i) + (e[i] === 'A' ? 'B' : 'A') + e.slice(i + 1)
    expect(tampered).not.toBe(e)
    expect(() => decryptField(tampered, 'account:discord:1:access_token', key)).toThrow()
  })
  it('refuses short keys', () => {
    expect(() => parseEncKey('abcd')).toThrow()
  })
  it('the adapter hook encrypts every token column', () => {
    const acc = encryptAccountTokens({ provider: 'discord', providerAccountId: '1', access_token: 'A', refresh_token: 'R', type: 'oauth' }, key)
    expect(acc.access_token).toMatch(/^v1:/)
    expect(acc.refresh_token).toMatch(/^v1:/)
  })
  it('derives independent subkeys', () => {
    expect(deriveSubkey(key, 'a').equals(deriveSubkey(key, 'b'))).toBe(false)
  })
})

describe('signed media URLs', () => {
  const k = Buffer.alloc(32, 7)
  it('bind kind, item, user and expiry', () => {
    const u = new URL(signMediaUrl('audio', 5, 'user-a', 1000, k), 'http://x')
    const exp = u.searchParams.get('exp')
    const sig = u.searchParams.get('sig')
    expect(verifyMediaSig('audio', 5, 'user-a', exp, sig, 1000, k)).toBe(true)
    expect(verifyMediaSig('audio', 5, 'user-b', exp, sig, 1000, k)).toBe(false)
    expect(verifyMediaSig('cover', 5, 'user-a', exp, sig, 1000, k)).toBe(false)
    expect(verifyMediaSig('audio', 6, 'user-a', exp, sig, 1000, k)).toBe(false)
    expect(verifyMediaSig('audio', 5, 'user-a', exp, sig, 1000 + 301, k)).toBe(false)
    expect(verifyMediaSig('audio', 5, 'user-a', String(Number(exp) + 1), sig, 1000, k)).toBe(false)
    expect(verifyMediaSig('audio', 5, 'user-a', '99999999999', sig, 1000, k)).toBe(false)
  })
})

describe('permissions and predicates (plan §3.3)', () => {
  const bindings = [
    { roleId: '1144462744456794153', permission: 'review' as const },
    { roleId: '1144462744456794153', permission: 'manage' as const },
  ]
  const base = { member: true, pending: false, roleIds: [], discordId: '111111111111111111', bindings, ownerIds: ['117501528641634310'] }
  it('member → submit/request; bound role → review/manage; owner → admin', () => {
    expect([...computePerms(base)].sort()).toEqual(['request', 'submit'])
    expect([...computePerms({ ...base, roleIds: ['1144462744456794153'] })].sort()).toEqual(['manage', 'request', 'review', 'submit'])
    expect(computePerms({ ...base, discordId: '117501528641634310' }).has('admin')).toBe(true)
  })
  it('non-members and pending members get nothing, even the owner', () => {
    expect(computePerms({ ...base, member: false, discordId: '117501528641634310' }).size).toBe(0)
    expect(computePerms({ ...base, pending: true, roleIds: ['1144462744456794153'] }).size).toBe(0)
  })
  it('no role grants admin', () => {
    expect(computePerms({ ...base, roleIds: ['1144462744456794153'], bindings: [...bindings, { roleId: '9', permission: 'manage' }] }).has('admin')).toBe(false)
  })
  const v = (id: string, perms: string[]): Viewer => ({ userId: id, discordId: id, name: null, perms: new Set(perms) as Viewer['perms'] })
  it('ownership predicates and staff visibility', () => {
    const owner = v('a', ['submit'])
    const other = v('b', ['submit'])
    const reviewer = v('r', ['submit', 'review'])
    const row = { ownerUserId: 'a' }
    expect(canViewOwned(owner, row)).toBe(true)
    expect(canViewOwned(other, row)).toBe(false)
    expect(canViewOwned(reviewer, row)).toBe(true)
    expect(canSeeComment(owner, row, { visibility: 'staff' })).toBe(false)
    expect(canSeeComment(reviewer, row, { visibility: 'staff' })).toBe(true)
    expect(canComment(owner, row, 'staff')).toBe(false)
    expect(canComment(owner, row, 'all')).toBe(true)
    expect(canComment(other, row, 'all')).toBe(false)
  })
})

describe('tickets webhook signature (receiver side)', () => {
  const secret = 's'.repeat(40)
  const sign = (t: number, id: string, body: string) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${id}.${body}`).digest('hex')}`
  it('accepts a fresh valid signature; rejects stale, tampered, malformed', () => {
    const id = randomUUID()
    const body = '{"event":"ticket.closed","ticketId":1}'
    const now = 1_800_000_000
    const ok = (h: string, b = body, d: string = id, n = now) => verifyTicketsSignature({ secrets: [secret], header: h, deliveryId: d, rawBody: Buffer.from(b), nowSec: n })
    expect(ok(sign(now, id, body))).toEqual({ ok: true })
    expect(ok(sign(now - 301, id, body))).toEqual({ ok: false, reason: 'stale' })
    expect(ok(sign(now + 301, id, body))).toEqual({ ok: false, reason: 'stale' })
    expect(ok(sign(now, id, body), body + ' ')).toEqual({ ok: false, reason: 'mismatch' })
    expect(ok(sign(now, id, body), body, randomUUID())).toEqual({ ok: false, reason: 'mismatch' })
    expect(ok('t=1,v1=zz')).toEqual({ ok: false, reason: 'malformed' })
    expect(ok(sign(now, id, body), body, 'not-a-uuid')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyTicketsSignature({ secrets: ['other'.repeat(8), secret], header: sign(now, id, body), deliveryId: id, rawBody: Buffer.from(body), nowSec: now })).toEqual({ ok: true })
  })
})

describe('service env isolation', () => {
  const web = {
    DATABASE_URL: 'postgres://x', AUTH_SECRET: 'a'.repeat(40), AUTH_DISCORD_ID: 'i', AUTH_DISCORD_SECRET: 's',
    APP_ENC_KEY: '0'.repeat(64), TICKETS_WEBHOOK_SECRET: 'w'.repeat(40), AUTH_URL: 'https://music.euphoric.fm',
  }
  it('web refuses worker secrets and non-https Discord endpoints', () => {
    expect(() => loadWebEnv(web)).not.toThrow()
    expect(() => loadWebEnv({ ...web, AZURACAST_API_KEY: 'x' })).toThrow(/another service/)
    expect(() => loadWebEnv({ ...web, TICKETS_WRITE_KEY: 'x' })).toThrow(/another service/)
    expect(() => loadWebEnv({ ...web, DISCORD_TOKEN_URL: 'http://evil/token' })).toThrow(/https/)
    expect(() => loadWebEnv({ ...web, AUTH_URL: 'https://evil.example' })).toThrow(/AUTH_URL/)
    expect(() => loadWebEnv({ ...web, AUTH_URL: undefined })).toThrow(/AUTH_URL/)
  })
  it('worker refuses web secrets', () => {
    const w = { DATABASE_URL: 'postgres://x', AZURACAST_API_KEY: 'k'.repeat(20), TICKETS_WRITE_KEY: 't' }
    expect(() => loadWorkerEnv(w)).not.toThrow()
    expect(() => loadWorkerEnv({ ...w, TICKETS_GUILD_READ_KEY: 'x' })).toThrow(/another service/)
    expect(() => loadWorkerEnv({ ...w, APP_ENC_KEY: 'x' })).toThrow(/another service/)
    expect(() => loadWorkerEnv({ ...w, AZURACAST_BASE_URL: 'http://az' })).toThrow(/https/)
  })
  it('probe refuses any secret-looking env', () => {
    expect(() => assertProbeEnvClean({ PATH: '/bin', HOME: '/tmp', NODE_VERSION: '24' })).not.toThrow()
    for (const k of ['AZURACAST_API_KEY', 'DATABASE_URL', 'SOME_TOKEN', 'X_SECRET']) expect(() => assertProbeEnvClean({ [k]: '1' })).toThrow()
  })
  it('web.env.example holds no tickets:* write key and no AzuraCast key', () => {
    const text = readFileSync(new URL('../env/web.env.example', import.meta.url), 'utf8')
    const keys = text.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=')[0])
    expect(keys).not.toContain('TICKETS_WRITE_KEY')
    expect(keys).not.toContain('AZURACAST_API_KEY')
    expect(keys.filter((k) => k!.startsWith('TICKETS_') && k!.endsWith('_KEY'))).toEqual(['TICKETS_GUILD_READ_KEY'])
  })
})

describe('tus header admission', () => {
  it('Upload-Length 1..35 MB, no defer, no concat, no creation body', () => {
    expect(checkCreateHeaders(H({ 'upload-length': '1000' }))).toEqual({ length: 1000 })
    expect(checkCreateHeaders(H({ 'upload-length': String(35 * 1024 * 1024) }))).toEqual({ length: 35 * 1024 * 1024 })
    expect(checkCreateHeaders(H({ 'upload-length': String(35 * 1024 * 1024 + 1) }))).toMatchObject({ status: 413 })
    expect(checkCreateHeaders(H({ 'upload-length': '-1' }))).toMatchObject({ status: 400 })
    expect(checkCreateHeaders(H({ 'upload-length': '0' }))).toMatchObject({ status: 400 })
    expect(checkCreateHeaders(H({}))).toMatchObject({ code: 'upload_length_required' })
    expect(checkCreateHeaders(H({ 'upload-defer-length': '1' }))).toMatchObject({ code: 'defer_length_disabled' })
    expect(checkCreateHeaders(H({ 'upload-length': '10', 'upload-concat': 'partial' }))).toMatchObject({ code: 'concatenation_disabled' })
    expect(checkCreateHeaders(H({ 'upload-length': '10', 'content-length': '5' }))).toMatchObject({ code: 'creation_with_upload_disabled' })
    expect(checkPatchHeaders(H({ 'content-length': String(8 * 1024 * 1024 + 1) }))).toMatchObject({ status: 413 })
    expect(checkPatchHeaders(H({}))).toMatchObject({ status: 411 })
    expect(checkPatchHeaders(H({ 'content-length': '100' }))).toBeNull()
  })
})

describe('one-time reviewer seed', () => {
  it('refuses to mark the seed done with zero roles; later runs do not need roles', () => {
    expect(() => assertSeedable(false, [])).toThrow(/at least one role/)
    expect(() => assertSeedable(false, ['1144462744456794153'])).not.toThrow()
    expect(() => assertSeedable(true, [])).not.toThrow()
  })
})
