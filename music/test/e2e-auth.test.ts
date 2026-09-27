// Against the running music-web container + mock Discord / tickets.
import { describe, expect, it } from 'vitest'
import { E2E } from './helpers/env'
import { login, loginOk, mockUser } from './helpers/auth'
import { ageMemberCache, ownerSql } from './helpers/db'
import { control, Jar, req } from './helpers/http'

const REVIEWER_ROLE = '1144462744456794153'
const OWNER = '117501528641634310'
let seq = 0
const newId = () => `4${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

async function sessionsOf(discordId: string) {
  const r = await ownerSql()`SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id = s."userId" WHERE u.discord_id = ${discordId}`
  return r[0]!.n as number
}

async function me(jar: Jar) {
  return req(jar, '/api/me')
}

describe.skipIf(!E2E())('auth: Discord OAuth + guild membership gate', () => {
  it('a member signs in; cookies are __Host-, HttpOnly, Secure, SameSite=Lax; tokens encrypted at rest', async () => {
    const id = newId()
    await mockUser({ id })
    const r = await login(id)
    expect(r.final.status).toBe(302)
    expect(r.location).toMatch(/\/dashboard$/)
    const set = r.final.headers.getSetCookie().find((c) => c.startsWith('__Host-authjs.session-token='))!
    expect(set).toMatch(/HttpOnly/i)
    expect(set).toMatch(/Secure/i)
    expect(set).toMatch(/SameSite=Lax/i)
    expect(set).toMatch(/Path=\//)
    expect(set).not.toMatch(/Domain=/i)
    const m = (await (await me(r.jar)).json()) as { perms: string[]; discordId: string }
    expect(m).toMatchObject({ discordId: id, perms: ['request', 'submit'] })
    const acc = await ownerSql()`SELECT access_token, refresh_token FROM account WHERE "providerAccountId" = ${id}`
    expect(acc[0]!.access_token).toMatch(/^v1:/)
    expect(acc[0]!.refresh_token).toMatch(/^v1:/)
    const log = (await control('/__mock/discord/log')) as { path: string; query: Record<string, string> }[]
    expect(log.filter((l) => l.path === '/oauth2/authorize').at(-1)!.query.scope).toBe('identify guilds.members.read')
  })

  it('a non-member is denied and gets no session', async () => {
    const id = newId()
    await mockUser({ id, member: false })
    const r = await login(id)
    expect(r.location).toContain('/denied?reason=not_member')
    expect(r.jar.get('__Host-authjs.session-token')).toBeUndefined()
    expect(await sessionsOf(id)).toBe(0)
  })

  it('a pending (membership screening) member is denied', async () => {
    const id = newId()
    await mockUser({ id, pending: true })
    const r = await login(id)
    expect(r.location).toContain('/denied?reason=pending')
    expect(r.jar.get('__Host-authjs.session-token')).toBeUndefined()
  })

  it('falls back to the tickets API (web guild:read key) when the Discord member call fails', async () => {
    const id = newId()
    await mockUser({ id, memberError: 503 })
    await control('/__mock/tickets/member', { id, member: true, roleIds: [REVIEWER_ROLE] })
    const jar = (await login(id)).jar
    const m = (await (await me(jar)).json()) as { perms: string[] }
    expect(m.perms).toContain('review')
    const calls = (await control('/__mock/tickets/calls')) as { path: string; headers: Record<string, string> }[]
    expect(calls.some((c) => c.path === `/api/v1/members/${id}`)).toBe(true)
    const denied = newId()
    await mockUser({ id: denied, memberError: 503 })
    await control('/__mock/tickets/member', { id: denied, member: false })
    expect((await login(denied)).location).toContain('/denied?reason=not_member')
  })

  it('reviewer roles map to review + manage; admin comes only from PORTAL_OWNER_IDS', async () => {
    const rev = await loginOk({ id: newId(), roles: [REVIEWER_ROLE] })
    expect(((await (await me(rev)).json()) as { perms: string[] }).perms).toEqual(['manage', 'request', 'review', 'submit'])
    const owner = await loginOk({ id: OWNER, roles: [] })
    expect(((await (await me(owner)).json()) as { perms: string[] }).perms).toEqual(['admin', 'manage', 'request', 'review', 'submit'])
    const fake = await loginOk({ id: newId(), roles: ['999999999999999999'] })
    expect(((await (await me(fake)).json()) as { perms: string[] }).perms).toEqual(['request', 'submit'])
  })

  it('a demoted reviewer loses review within 60 s', async () => {
    const id = newId()
    const jar = await loginOk({ id, roles: [REVIEWER_ROLE] })
    expect((await req(jar, '/api/items/2147483000/decision', { json: { decision: 'deny', reason: 'x' } })).status).toBe(404) // review passed, no such item
    await mockUser({ id, roles: [] })
    await ageMemberCache(id, 59)
    expect((await req(jar, '/api/items/2147483000/decision', { json: { decision: 'deny', reason: 'x' } })).status).toBe(404) // still inside 60 s
    await ageMemberCache(id, 61)
    expect((await req(jar, '/api/items/2147483000/decision', { json: { decision: 'deny', reason: 'x' } })).status).toBe(403)
  })

  it('leaving the guild deletes every session of the user', async () => {
    const id = newId()
    await mockUser({ id })
    const a = (await login(id)).jar
    const b = (await login(id)).jar
    expect(await sessionsOf(id)).toBe(2)
    await mockUser({ id, member: false })
    await ageMemberCache(id, 11 * 60)
    expect((await me(a)).status).toBe(401)
    expect(await sessionsOf(id)).toBe(0)
    expect((await me(b)).status).toBe(401)
    const audit = await ownerSql()`SELECT detail FROM audit_log WHERE action = 'auth.sessions_revoked' AND actor_discord_id = ${id}`
    expect(audit[0]!.detail).toEqual({ reason: 'not_member' })
  })

  it('a 401 from Discord on re-check deletes the sessions', async () => {
    const id = newId()
    const jar = await loginOk({ id })
    await mockUser({ id, revoked: true })
    await ageMemberCache(id, 11 * 60)
    expect((await me(jar)).status).toBe(401)
    expect(await sessionsOf(id)).toBe(0)
  })

  it('a failed token refresh deletes the sessions', async () => {
    const id = newId()
    const jar = await loginOk({ id, expiresIn: 30 }) // expires within the 60 s refresh margin
    await mockUser({ id, refreshFails: true })
    await ageMemberCache(id, 11 * 60)
    expect((await me(jar)).status).toBe(401)
    expect(await sessionsOf(id)).toBe(0)
  })

  it('a working refresh keeps the session and rotates the stored (encrypted) token', async () => {
    const id = newId()
    const jar = await loginOk({ id, expiresIn: 30 })
    const before = (await ownerSql()`SELECT access_token FROM account WHERE "providerAccountId" = ${id}`)[0]!.access_token
    await mockUser({ id, expiresIn: 604800 })
    await ageMemberCache(id, 11 * 60)
    expect((await me(jar)).status).toBe(200)
    const after = (await ownerSql()`SELECT access_token FROM account WHERE "providerAccountId" = ${id}`)[0]!.access_token
    expect(after).not.toBe(before)
    expect(after).toMatch(/^v1:/)
  })

  it('no session → 401 on the API, redirect on pages', async () => {
    expect((await req(null, '/api/me')).status).toBe(401)
    const d = await req(null, '/dashboard')
    expect([302, 303, 307]).toContain(d.status)
  })

  it('/api/auth/* is rate-limited to 20/min per cf-connecting-ip', async () => {
    const ip = `2001:db8::${Math.floor(Math.random() * 0xffff).toString(16)}:${Date.now().toString(16).slice(-4)}`
    const statuses: number[] = []
    for (let i = 0; i < 22; i++) statuses.push((await req(null, '/api/auth/csrf', { ip })).status)
    expect(statuses.slice(0, 20).every((s) => s === 200)).toBe(true)
    expect(statuses.slice(20)).toEqual([429, 429])
    expect((await req(null, '/api/auth/csrf', { ip: `${ip}1` })).status).toBe(200)
  })
})
