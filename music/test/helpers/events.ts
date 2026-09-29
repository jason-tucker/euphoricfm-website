// v0.5.0 Events portal e2e helpers: requests against the running events-web
// (PORTAL_SITE=events, origin https://events.euphoric.fm), the real Auth.js
// sign-in on that host, events_* settings, time slots, and the station-14
// side of the AzuraCast mock.
//
// Test-name tags used by the e2e-events-* files, so the integrator can tell
// which failures only mean "that branch is not merged yet":
//   [W0]   needs only the contract commit (feat/events): site gate, tus,
//          sweepers, library sync, compose
//   [A]    needs the events API (src/app/api/ev/**, src/events/server/**)
//   [A+C]  also needs the events worker (/app/events-worker.mjs)
import { control, fetchRetrySocket, freshIp, Jar, req, type ReqOpts } from './http'
import { mockUser, type MockUser } from './auth'
import { ownerSql } from './db'
import { has } from './env'
import { waitFor } from './wait'

export const EV_ORIGIN = 'https://events.euphoric.fm'
export const EV_WEB = () => process.env.E2E_EVENTS_WEB_URL!
export const EVENTS_E2E = () => has('E2E_EVENTS_WEB_URL', 'E2E_WEB_URL', 'MOCKS_CONTROL', 'TEST_OWNER_DATABASE_URL', 'TEST_DATA_DIR')

export const REVIEWER_ROLE = '1144462744456794153' // seeded with review AND manage (every seed role is)
// A role bound to `review` only (the seed gives every staff role manage too).
export const REVIEW_ONLY_ROLE = '1299990000000000001'
export async function bindReviewOnlyRole(): Promise<string> {
  await ownerSql()`INSERT INTO role_bindings (role_id, permission, note, created_by) VALUES (${REVIEW_ONLY_ROLE}, 'review', 'events e2e', 'test')
    ON CONFLICT DO NOTHING`
  return REVIEW_ONLY_ROLE
}
export const ADMIN_ID = '117501528641634310' // PORTAL_OWNER_IDS: admin ⇒ review + manage

let seq = 0
// A fresh member snowflake per call (prefix 7: distinct from the other suites).
export const newMemberId = () => `7${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`
export const uniqTag = () => `${Date.now().toString(36)}${(++seq).toString(36)}`

// A request to events-web. Unsafe methods carry the EVENTS origin (the
// shared req() would send music's).
export async function evReq(jar: Jar | null, path: string, o: ReqOpts = {}): Promise<Response> {
  const method = (o.method ?? (o.json !== undefined || o.body ? 'POST' : 'GET')).toUpperCase()
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const headers = { ...(unsafe && (o.sameOrigin ?? true) ? { origin: EV_ORIGIN, 'sec-fetch-site': 'same-origin' } : {}), ...(o.headers ?? {}) }
  return req(jar, `${EV_WEB()}${path}`, { ...o, method, headers, sameOrigin: unsafe ? (o.sameOrigin ?? true) : false })
}

export async function evJson<T = unknown>(jar: Jar | null, path: string, o: ReqOpts = {}): Promise<{ status: number; body: T }> {
  const r = await evReq(jar, path, o)
  const text = await r.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    /* not JSON */
  }
  return { status: r.status, body: body as T }
}

// The real Auth.js flow on the EVENTS host: csrf → signin POST → mock
// authorize → callback on events-web. Its own jar: the two sites' session
// cookies are separate (own AUTH_SECRET, host-only __Host- cookies).
export async function evLogin(discordId: string): Promise<{ jar: Jar; final: Response; location: string; authorize: URL }> {
  const jar = new Jar()
  const ip = freshIp()
  const csrf = await evReq(jar, '/api/auth/csrf', { ip })
  const { csrfToken } = (await csrf.json()) as { csrfToken: string }
  const signin = await evReq(jar, '/api/auth/signin/discord', {
    ip,
    body: new URLSearchParams({ csrfToken, callbackUrl: '/my' }).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  const authorizeUrl = signin.headers.get('location')
  if (signin.status !== 302 || !authorizeUrl) throw new Error(`events signin: ${signin.status}`)
  const a = new URL(authorizeUrl)
  a.searchParams.set('mock_user', discordId)
  const ar = await fetchRetrySocket(a.toString(), { redirect: 'manual' })
  const cb = ar.headers.get('location')
  if (ar.status !== 302 || !cb) throw new Error(`authorize: ${ar.status} ${await ar.text()}`)
  const c = new URL(cb)
  const final = await evReq(jar, `${c.pathname}${c.search}`, { ip })
  return { jar, final, location: final.headers.get('location') ?? '', authorize: a }
}

export async function evLoginOk(u: MockUser): Promise<Jar> {
  await mockUser(u)
  const r = await evLogin(u.id)
  if (!r.jar.get('__Host-authjs.session-token')) throw new Error(`events login failed → ${r.final.status} ${r.location}`)
  return r.jar
}

// ------------------------------------------------------------- settings ---

// events_* settings are read from the settings table on every use
// (server/admin/events-settings.ts loadEventsSettings), so a row written
// here applies to the next request / job.
export async function setEventsSettings(values: Record<string, unknown>): Promise<void> {
  for (const [key, value] of Object.entries(values)) {
    await ownerSql()`INSERT INTO settings (key, value) VALUES (${key}, ${ownerSql().json(value as never)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`
  }
}

export async function clearEventsSettings(keys: string[]): Promise<void> {
  await ownerSql()`DELETE FROM settings WHERE key = ANY(${keys})`
}

// ---------------------------------------------------------------- times ---

// A distinct slot per (day, hour): whole days ahead of now (≥ 2 days, so the
// 24 h minimum notice and the 48 h warning are both behind us), at a UTC hour
// that stays clear of the 01:55–02:05 ET nightly restart. Suites use
// disjoint day ranges so their events never clash (10-min gap rule).
// RUN_SHIFT moves every slot of one test process by 0–77 days, so a re-run
// against a kept stack (KEEP=1, same database) rarely lands on the previous
// run's events; a fresh harness run never has any.
const RUN_SHIFT = (Math.floor(Date.now() / 60_000) % 12) * 7
export function slot(dayAhead: number, hourUtc = 20, lengthMin = 120): { startsAt: string; endsAt: string } {
  const d = new Date()
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayAhead + RUN_SHIFT, hourUtc, 0, 0)
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + lengthMin * 60_000).toISOString() }
}

export function eventBody(o: { title: string; dayAhead: number; hourUtc?: number; lengthMin?: number; visibility?: 'public' | 'private'; playlistOrder?: 'shuffle' | 'sequential' }) {
  return {
    title: o.title,
    hostName: 'E2E Host',
    description: `Described ${o.title}`,
    location: 'Vinewood Bowl',
    eventType: 'club_night',
    ...slot(o.dayAhead, o.hourUtc, o.lengthMin),
    enteredTz: 'America/New_York',
    visibility: o.visibility ?? 'public',
    playlistOrder: o.playlistOrder ?? 'shuffle',
  }
}

// ----------------------------------------------------------- library ------

// Station-14 legacy playlist ids (never station 1's, never in library_cache).
export const LEGACY_14 = [74, 75, 76, 77, 78]

export type MockMedia = { id: number; path: string; title: string | null; artist: string | null; playlists: { id: number }[] }

export async function mockFiles(): Promise<MockMedia[]> {
  return (await control('/__mock/az/files')) as MockMedia[]
}
export async function mockFile(path: string): Promise<MockMedia> {
  const f = (await mockFiles()).find((x) => x.path === path)
  if (!f) throw new Error(`mock has no ${path}`)
  return f
}
export const playlistIds = (m: MockMedia | undefined) => (m?.playlists ?? []).map((p) => p.id).sort((a, b) => a - b)

// Seeds songs on the mock's shared storage (real Music/Artists/** paths: the
// events worker drives production paths; no Portal-Test/ prefix) and mirrors
// them into library_cache, which is what the events API validates library
// media ids against.
export async function seedLibrarySongs(songs: { path: string; title: string; artist: string; playlists?: number[]; length?: number }[]): Promise<MockMedia[]> {
  await control('/__mock/az/seed', { files: songs.map((s) => ({ length: 200, ...s, playlists: s.playlists ?? [] })) })
  const out: MockMedia[] = []
  for (const s of songs) {
    const f = await mockFile(s.path)
    await ownerSql()`INSERT INTO library_cache (media_id, unique_id, path, title, artist, playlist_ids, length_s)
      VALUES (${f.id}, ${'ev' + f.id}, ${f.path}, ${s.title}, ${s.artist}, ${(s.playlists ?? []).filter((id) => !LEGACY_14.includes(id))}, ${s.length ?? 200})
      ON CONFLICT (media_id) DO NOTHING`
    out.push(f)
  }
  return out
}

// ------------------------------------------------------- station 14 -------

export type Station14 = {
  playlists: { id: number; name: string; is_enabled: boolean; order: string; backend_options: string[]; schedule_items: { start_time: number; end_time: number; start_date: string | null; end_date: string | null }[] }[]
  order: Record<string, number[]>
  queue: { id: number }[]
  restarts: string[]
  violations: { method: string; path: string; why: string }[]
}
export async function station14(): Promise<Station14> {
  return (await control('/__mock/az/station14/state')) as Station14
}

export type AzCall = { method: string; path: string; key: 'music' | 'events' | null; body?: Record<string, unknown> }
export async function azCalls(): Promise<AzCall[]> {
  return (await control('/__mock/az/calls')) as AzCall[]
}
// Station-14 WRITES the events key made (reads, canaries and now-playing excluded).
export async function events14Writes(): Promise<AzCall[]> {
  return (await azCalls()).filter((c) => c.key === 'events' && c.method !== 'GET')
}

// --------------------------------------------------------------- tickets --

export type MockTicket = { id: number; owner: string; externalRef: string; categoryKey: string; opener: string; subject: string; card: { title: string; lines: string[]; link: { label: string; url: string } }; status: string }
export async function mockTickets(): Promise<MockTicket[]> {
  return (await control('/__mock/tickets/tickets')) as MockTicket[]
}
export async function ticketFor(eventId: number, timeoutMs = 60_000): Promise<MockTicket> {
  return waitFor(async () => (await mockTickets()).find((t) => t.owner === 'efm-events' && t.externalRef === `event:${eventId}`), timeoutMs)
}
export async function ticketMessages(ticketId: number): Promise<{ key: string; body: string; kind: string }[]> {
  return ((await control('/__mock/tickets/messages')) as { key: string; body: string; kind: string }[]).filter((m) => m.key.startsWith(`${ticketId}|`))
}

// ------------------------------------------------------------ event jobs --

export async function eventJobs(eventId: number): Promise<{ kind: string; status: string; payload: Record<string, unknown> }[]> {
  return (await ownerSql()`SELECT kind, status::text AS status, payload FROM event_jobs WHERE payload->>'eventId' = ${String(eventId)} ORDER BY id`) as never
}

export async function eventRow(eventId: number): Promise<Record<string, unknown>> {
  return (await ownerSql()`SELECT * FROM events WHERE id = ${eventId}`)[0]!
}

export async function waitEventStatus(eventId: number, status: string, timeoutMs = 90_000): Promise<Record<string, unknown>> {
  return waitFor(async () => {
    const r = await eventRow(eventId)
    return r.status === status ? r : null
  }, timeoutMs, 1000)
}

export { control, Jar, req }
