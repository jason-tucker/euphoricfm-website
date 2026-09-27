// Drives the real Auth.js flow against the mock Discord: csrf → signin POST →
// mock authorize (as `discordId`) → callback on music-web.
import { control, freshIp, Jar, req } from './http'

export type MockUser = { id: string; member?: boolean; pending?: boolean; roles?: string[]; revoked?: boolean; refreshFails?: boolean; memberError?: number; expiresIn?: number }

export async function mockUser(u: MockUser) {
  await control('/__mock/discord/user', u)
}

export async function login(discordId: string): Promise<{ jar: Jar; final: Response; location: string }> {
  const jar = new Jar()
  const ip = freshIp()
  const csrf = await req(jar, '/api/auth/csrf', { ip })
  const { csrfToken } = (await csrf.json()) as { csrfToken: string }
  const signin = await req(jar, '/api/auth/signin/discord', {
    ip,
    body: new URLSearchParams({ csrfToken, callbackUrl: '/dashboard' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const authorize = signin.headers.get('location')
  if (signin.status !== 302 || !authorize) throw new Error(`signin: ${signin.status}`)
  const a = new URL(authorize)
  a.searchParams.set('mock_user', discordId)
  const ar = await fetch(a, { redirect: 'manual' })
  const cb = ar.headers.get('location')
  if (ar.status !== 302 || !cb) throw new Error(`authorize: ${ar.status} ${await ar.text()}`)
  const c = new URL(cb)
  const final = await req(jar, `${c.pathname}${c.search}`, { ip })
  return { jar, final, location: final.headers.get('location') ?? '' }
}

export async function loginOk(u: MockUser): Promise<Jar> {
  await mockUser(u)
  const r = await login(u.id)
  if (!r.jar.get('__Host-authjs.session-token')) throw new Error(`login failed → ${r.final.status} ${r.location}`)
  return r.jar
}
