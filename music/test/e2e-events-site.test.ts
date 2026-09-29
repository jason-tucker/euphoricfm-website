// v0.5.0 Events portal: the two sites side by side through the real
// containers (music-web and events-web, one database, one Discord app).
// Site gate, separate sign-ins, CSP/CSRF per origin, and the events tus path
// (uploads flag, site column, per-site sweepers). Tags: see helpers/events.ts
// ([W0] = contract commit only, [A] = events API).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loginOk, mockUser } from './helpers/auth'
import { appSql, ownerSql } from './helpers/db'
import { req } from './helpers/http'
import {
  ADMIN_ID,
  clearEventsSettings,
  EV_ORIGIN,
  evJson,
  evLogin,
  evLoginOk,
  evReq,
  EVENTS_E2E,
  newMemberId,
  setEventsSettings,
  type Jar,
} from './helpers/events'

const TUS = { 'tus-resumable': '1.0.0' }
const mp3Meta = { 'upload-metadata': `filetype ${Buffer.from('audio/mpeg').toString('base64')}` }

describe.skipIf(!EVENTS_E2E())('events site: gate, sign-in and uploads (real containers)', () => {
  let memberId: string
  let musicJar: Jar
  let eventsJar: Jar

  beforeAll(async () => {
    memberId = newMemberId()
    musicJar = await loginOk({ id: memberId })
    eventsJar = await evLoginOk({ id: memberId })
  })
  afterAll(async () => {
    await clearEventsSettings(['events_uploads_enabled'])
  })

  // ------------------------------------------------------------ gate ------

  it('[W0] music-web 404s the events tree: /ev pages and /api/ev routes', async () => {
    for (const p of ['/ev', '/ev/calendar', '/ev/my']) expect((await req(null, p)).status, p).toBe(404)
    for (const p of ['/api/ev/config', '/api/ev/calendar', '/api/ev/me']) {
      const r = await req(null, p)
      expect(r.status, p).toBe(404)
      expect(await r.json()).toEqual({ error: 'not_found' })
    }
    expect((await req(musicJar, '/api/ev/events', { json: {} })).status).toBe(404)
    expect((await req(null, '/api/health')).status).toBe(200)
  })

  it('[W0] events-web 404s every music route; /ev/** asked for directly is a 404 too', async () => {
    const api = ['/api/me', '/api/batches', '/api/items/1', '/api/library?q=x', '/api/requests', '/api/archive', '/api/admin/settings', '/api/media/1', '/api/uploads/art', '/api/ui/nav']
    for (const p of api) {
      const r = await evReq(eventsJar, p)
      expect(r.status, p).toBe(404)
    }
    for (const p of ['/api/hooks/tickets', '/api/batches', '/api/uploads/art']) expect((await evReq(eventsJar, p, { json: {} })).status, p).toBe(404)
    for (const p of ['/dashboard', '/submit', '/library', '/admin', '/ev', '/ev/calendar', '/ev/my']) expect((await evReq(eventsJar, p)).status, p).toBe(404)
    expect((await evReq(null, '/api/health')).status).toBe(200)
    // encoded tricks resolve to the same verdict
    expect((await evReq(eventsJar, '/api/%6De')).status).toBe(404)
    expect((await evReq(eventsJar, '/%65v/calendar')).status).toBe(404)
  })

  it('[W0] CSP: events adds https://euphoric.fm to media-src/connect-src; music does not', async () => {
    const ev = (await evReq(null, '/api/health')).headers.get('content-security-policy') ?? ''
    const mu = (await req(null, '/api/health')).headers.get('content-security-policy') ?? ''
    const dir = (csp: string, d: string) => csp.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${d} `)) ?? ''
    expect(dir(ev, 'media-src')).toContain('https://euphoric.fm')
    expect(dir(ev, 'connect-src')).toContain('https://euphoric.fm')
    expect(dir(mu, 'media-src')).not.toContain('https://euphoric.fm')
    expect(dir(mu, 'connect-src')).not.toContain('https://euphoric.fm')
  })

  it('[W0] CSRF is bound to each site’s own origin', async () => {
    // music origin on the events host, and the reverse
    const r1 = await evReq(eventsJar, '/api/ev/events', { json: {}, headers: { origin: 'https://music.euphoric.fm' } })
    expect(r1.status).toBe(403)
    expect(((await r1.json()) as { error: string }).error).toMatch(/^csrf_/)
    const r2 = await req(musicJar, '/api/batches', { method: 'POST', headers: { origin: EV_ORIGIN } })
    expect(r2.status).toBe(403)
  })

  // --------------------------------------------------------- sign-in -----

  it('[W0] sign-in on the events host: events redirect_uri, __Host- session, lands on /my', async () => {
    const id = newMemberId()
    await mockUser({ id })
    const r = await evLogin(id)
    expect(r.authorize.searchParams.get('redirect_uri')).toBe(`${EV_ORIGIN}/api/auth/callback/discord`)
    expect(r.authorize.searchParams.get('scope')).toBe('identify guilds.members.read')
    expect(r.final.status).toBe(302)
    expect(new URL(r.location, EV_ORIGIN).toString()).toBe(`${EV_ORIGIN}/my`)
    const set = r.final.headers.getSetCookie().find((c) => c.startsWith('__Host-authjs.session-token='))!
    expect(set).toMatch(/HttpOnly/i)
    expect(set).toMatch(/Secure/i)
    expect(set).not.toMatch(/Domain=/i)
    expect(set).toMatch(/Path=\//)
    const s =await evJson<{ user?: unknown }>(r.jar, '/api/auth/session')
    expect(s.status).toBe(200)
    expect(s.body?.user).toBeTruthy()
  })

  it('[W0] a non-member is denied on the events host too', async () => {
    const id = newMemberId()
    await mockUser({ id, member: false })
    const r = await evLogin(id)
    expect(r.location).toContain('/denied')
    expect(r.jar.get('__Host-authjs.session-token')).toBeUndefined()
  })

  it('[W0] each site signs in on its own (two sessions); one user and one encrypted account row behind both', async () => {
    // Sessions are DATABASE sessions shared by both webs: what keeps the two
    // sign-ins apart in a browser is the host-only __Host- cookie (asserted
    // in the sign-in test: no Domain attribute), not the AUTH_SECRET.
    const users = await ownerSql()`SELECT id FROM "user" WHERE discord_id = ${memberId}`
    expect(users).toHaveLength(1)
    const acc = await ownerSql()`SELECT access_token, refresh_token FROM account WHERE "providerAccountId" = ${memberId}`
    expect(acc).toHaveLength(1)
    expect(acc[0]!.access_token).toMatch(/^v1:/)
    // both sessions still work after the other site signed in (shared APP_ENC_KEY)
    expect((await req(musicJar, '/api/me')).status).toBe(200)
    const sessions = await ownerSql()`SELECT count(*)::int AS n FROM session s JOIN "user" u ON u.id = s."userId" WHERE u.discord_id = ${memberId}`
    expect(sessions[0]!.n).toBe(2)
  })

  it('[A] /api/ev/me and /api/ev/config on the events host', async () => {
    const anon = await evJson<{ signedIn: boolean }>(null, '/api/ev/me')
    expect(anon).toEqual({ status: 200, body: { signedIn: false } })
    const me = await evJson<{ signedIn: boolean; discordId: string; perms: Record<string, boolean> }>(eventsJar, '/api/ev/me')
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ signedIn: true, discordId: memberId, perms: { review: false, manage: false, admin: false } })
    await mockUser({ id: ADMIN_ID })
    const admin = await evLoginOk({ id: ADMIN_ID })
    expect((await evJson(admin, '/api/ev/me')).body).toMatchObject({ signedIn: true, perms: { review: true, manage: true, admin: true } })
    const cfg = await evJson<Record<string, unknown>>(null, '/api/ev/config')
    expect(cfg.status).toBe(200)
    expect(cfg.body).toMatchObject({
      stationListenUrl: 'https://euphoric.fm/listen/event/radio.mp3',
      nowPlayingUrl: 'https://euphoric.fm/api/nowplaying/event',
      minNoticeH: 24,
      warnNoticeH: 48,
    })
  })

  // ---------------------------------------------------------- uploads ----

  async function evTusCreate(jar: Jar, length: number) {
    return evReq(jar, '/api/uploads', { method: 'POST', headers: { ...TUS, 'upload-length': String(length), ...mp3Meta } })
  }

  it('[W0] events tus: refused while events_uploads_enabled is off; the art routes are 404', async () => {
    await setEventsSettings({ events_uploads_enabled: false })
    const r = await evTusCreate(eventsJar, 1000)
    expect(r.status).toBe(403)
    expect((await evReq(eventsJar, '/api/uploads/art', { json: {} })).status).toBe(404)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM uploads u JOIN "user" x ON x.id = u.owner_user_id WHERE x.discord_id = ${memberId} AND u.site = 'events'`)[0]!.n).toBe(0)
  })

  it('[W0] events tus: stamped site=events in the events staging dir; music sweepers never touch it', async () => {
    await setEventsSettings({ events_uploads_enabled: true })
    const r = await evTusCreate(eventsJar, 4096)
    expect(r.status).toBe(201)
    const id = r.headers.get('location')!.split('/').pop()!
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    const row = (await ownerSql()`SELECT site, status FROM uploads WHERE id = ${id}`)[0]!
    expect(row).toMatchObject({ site: 'events', status: 'uploading' })
    const data = process.env.TEST_DATA_DIR!
    expect(existsSync(join(data, 'events/staging/uploads', id))).toBe(true)
    expect(existsSync(join(data, 'staging/uploads', id))).toBe(false)
    // a music upload by the same member is site=music in music's dir
    const m = await req(musicJar, '/api/uploads', { method: 'POST', headers: { ...TUS, 'upload-length': '4096', ...mp3Meta } })
    expect(m.status).toBe(201)
    const mid = m.headers.get('location')!.split('/').pop()!
    expect((await ownerSql()`SELECT site FROM uploads WHERE id = ${mid}`)[0]!.site).toBe('music')
    expect(existsSync(join(data, 'staging/uploads', mid))).toBe(true)

    // Sweepers: two days on, both are stale 'uploading' rows. The music sweep
    // expires only music's; the events sweep only events'.
    const { sweepStaging } = await import('@/server/uploads/retention')
    const { getDb } = await import('@/server/db/client')
    const db = getDb(process.env.TEST_APP_DATABASE_URL, 2)
    const later = Date.now() + 2 * 24 * 3600_000
    await sweepStaging(db, join(data, 'staging/uploads'), later, 'music')
    expect((await appSql()`SELECT status FROM uploads WHERE id = ${id}`)[0]!.status).toBe('uploading')
    expect((await appSql()`SELECT status FROM uploads WHERE id = ${mid}`)[0]!.status).toBe('expired')
    await sweepStaging(db, join(data, 'events/staging/uploads'), later, 'events')
    expect((await appSql()`SELECT status FROM uploads WHERE id = ${id}`)[0]!.status).toBe('expired')
  })
})
