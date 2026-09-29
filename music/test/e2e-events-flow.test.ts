// v0.5.0 Events portal, end to end through the real containers: a member
// creates and submits an event on events-web, the events worker opens the
// efm-events ticket, staff approve, and the event is compiled into station
// 14 on the AzuraCast mock (only with autobuild on, or build-now).
// Membership is preserve-only: a song shared by two events and a song in
// the legacy playlist 74 keep every other membership.
//
// Tags (helpers/events.ts): [A] events API only; [A+C] also the events
// worker (/app/events-worker.mjs). Every [A+C] test fails until both
// branches are merged.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb } from '@/server/db/client'
import { syncLibrary } from '@/worker/library/sync'
import { ownerSql } from './helpers/db'
import {
  ADMIN_ID,
  clearEventsSettings,
  control,
  eventBody,
  eventJobs,
  eventRow,
  EVENTS_E2E,
  events14Writes,
  evJson,
  evLoginOk,
  EV_ORIGIN,
  mockFile,
  newMemberId,
  playlistIds,
  REVIEWER_ROLE,
  bindReviewOnlyRole,
  seedLibrarySongs,
  setEventsSettings,
  station14,
  ticketFor,
  ticketMessages,
  uniqTag,
  waitEventStatus,
  type Jar,
  type MockMedia,
} from './helpers/events'
import { makeCtx } from './helpers/p3'
import { waitFor } from './helpers/wait'

type Full = { kind: 'full'; id: number; status: string; visibility: string; tracks: unknown[]; ticketUrl: string | null }
const SETTINGS = ['events_enabled', 'events_autobuild_enabled', 'events_uploads_enabled']
const created = (s: number) => expect([200, 201]).toContain(s)

describe.skipIf(!EVENTS_E2E())('events flow: request → ticket → approve → station 14', () => {
  const tag = uniqTag()
  let owner: Jar
  let ownerId: string
  let second: Jar
  let secondId: string
  let reviewer: Jar
  let reviewOnly: Jar
  let admin: Jar
  let songA: MockMedia
  let shared: MockMedia
  let songC: MockMedia
  let ev1: number
  let ev2: number

  const track = (position: number, m: MockMedia) => ({ position, source: 'library', mediaId: m.id, audioId: null, pinAt: null })
  const registry = async (eventId: number) =>
    (await ownerSql()`SELECT role, intent_name, playlist_id FROM event_registry WHERE event_id = ${eventId} AND deleted_at IS NULL ORDER BY id`) as unknown as {
      role: string
      intent_name: string
      playlist_id: number | null
    }[]
  const mainId = async (eventId: number) => (await registry(eventId)).find((r) => r.role === 'main')!.playlist_id!

  async function createEvent(jar: Jar, body: ReturnType<typeof eventBody>, tracks: ReturnType<typeof track>[]): Promise<number> {
    const c = await evJson<{ event: Full }>(jar, '/api/ev/events', { json: body })
    created(c.status)
    expect(c.body.event).toMatchObject({ kind: 'full', status: 'draft', visibility: body.visibility })
    const id = c.body.event.id
    const p = await evJson<{ event: Full }>(jar, `/api/ev/events/${id}/playlist`, { method: 'PUT', json: { tracks, announcements: [], playlistOrder: body.playlistOrder } })
    expect(p.status).toBe(200)
    expect(p.body.event.tracks).toHaveLength(tracks.length)
    return id
  }

  beforeAll(async () => {
    await setEventsSettings({ events_enabled: true, events_autobuild_enabled: false, events_uploads_enabled: false })
    ownerId = newMemberId()
    secondId = newMemberId()
    owner = await evLoginOk({ id: ownerId })
    second = await evLoginOk({ id: secondId })
    reviewer = await evLoginOk({ id: newMemberId(), roles: [REVIEWER_ROLE] })
    reviewOnly = await evLoginOk({ id: newMemberId(), roles: [await bindReviewOnlyRole()] })
    admin = await evLoginOk({ id: ADMIN_ID })
    for (const id of [ownerId, secondId]) await control('/__mock/tickets/member', { id, member: true })
    const seeded = await seedLibrarySongs([
      { path: `Music/Artists/EvFlow ${tag}/EvFlow ${tag} - Alpha.mp3`, title: 'Alpha', artist: `EvFlow ${tag}`, playlists: [2] },
      // in station 1's rotation AND the legacy Events playlist 74
      { path: `Music/Artists/EvFlow ${tag}/EvFlow ${tag} - Shared.mp3`, title: 'Shared', artist: `EvFlow ${tag}`, playlists: [2, 74] },
      // in no playlist at all. (Never put playlist 3 on the library surface:
      // the music sync would record it as unconfirmed, and e2e-requests relies
      // on 3 being a confirmed station-1 id.)
      { path: `Music/Artists/EvFlow ${tag}/EvFlow ${tag} - Gamma.mp3`, title: 'Gamma', artist: `EvFlow ${tag}`, playlists: [] },
    ])
    songA = seeded[0]!
    shared = seeded[1]!
    songC = seeded[2]!
  })
  afterAll(async () => {
    await clearEventsSettings(SETTINGS)
    await closeDb()
  })

  it('[A] a member creates a draft with a playlist: no ticket, not on the calendar', async () => {
    ev1 = await createEvent(owner, eventBody({ title: `Flow One ${tag}`, dayAhead: 20, playlistOrder: 'sequential' }), [track(0, songA), track(1, shared)])
    const row = await eventRow(ev1)
    expect(row).toMatchObject({ status: 'draft', owner_discord_id: ownerId, ticket_id: null })
    expect((await eventJobs(ev1)).map((j) => j.kind)).not.toContain('ticket_open')
    const { startsAt } = eventBody({ title: 'x', dayAhead: 20 })
    const from = new Date(Date.parse(startsAt) - 86_400_000).toISOString()
    const to = new Date(Date.parse(startsAt) + 86_400_000).toISOString()
    const cal = await evJson<{ id: number }[]>(null, `/api/ev/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
    expect(cal.status).toBe(200)
    expect(cal.body.map((e) => e.id)).not.toContain(ev1)
  })

  it('[A+C] submit → pending; the events worker opens ONE efm-events ticket in eventrequest', { timeout: 120_000 }, async () => {
    const s = await evJson<{ event: Full }>(owner, `/api/ev/events/${ev1}/submit`, { json: {} })
    expect(s.status).toBe(200)
    expect(s.body.event.status).toBe('pending')
    expect((await eventJobs(ev1)).map((j) => j.kind)).toContain('ticket_open')
    const t = await ticketFor(ev1, 90_000)
    expect(t).toMatchObject({ owner: 'efm-events', categoryKey: 'eventrequest', opener: ownerId, externalRef: `event:${ev1}`, status: 'open' })
    expect(new URL(t.card.link.url).origin).toBe(EV_ORIGIN)
    const row = await waitFor(async () => {
      const r = await eventRow(ev1)
      return r.ticket_id ? r : null
    }, 60_000)
    expect(Number(row.ticket_id)).toBe(t.id)
    // a second submit is refused (already pending); still one ticket
    expect((await evJson(owner, `/api/ev/events/${ev1}/submit`, { json: {} })).status).toBeGreaterThanOrEqual(400)
  })

  it('[A] only reviewers decide: the owner and another member cannot approve', async () => {
    expect((await evJson(owner, `/api/ev/events/${ev1}/approve`, { json: {} })).status).toBe(403)
    expect((await evJson(second, `/api/ev/events/${ev1}/approve`, { json: {} })).status).toBe(403)
    expect((await evJson(second, `/api/ev/events/${ev1}/playlist`, { method: 'PUT', json: { tracks: [], announcements: [], playlistOrder: 'shuffle' } })).status).toBeGreaterThanOrEqual(403)
  })

  it('[A+C] approve with autobuild OFF: approved, the ticket is told, and NOTHING is written to AzuraCast', { timeout: 120_000 }, async () => {
    const before = (await events14Writes()).length
    const plBefore = (await station14()).playlists.map((p) => p.id)
    const a = await evJson<{ event: Full }>(reviewer, `/api/ev/events/${ev1}/approve`, { json: {} })
    expect(a.status).toBe(200)
    expect(a.body.event.status).toBe('approved')
    // the worker has run the approval's ticket jobs (sync point)
    await waitFor(async () => {
      const jobs = await eventJobs(ev1)
      return jobs.length > 0 && jobs.every((j) => j.status === 'done') ? jobs : null
    }, 90_000)
    const t = await ticketFor(ev1)
    expect((await ticketMessages(t.id)).length).toBeGreaterThanOrEqual(1)
    expect((await eventJobs(ev1)).map((j) => j.kind).filter((k) => k === 'build' || k === 'build_now')).toEqual([])
    await new Promise((r) => setTimeout(r, 5000))
    expect((await events14Writes()).length).toBe(before)
    expect((await station14()).playlists.map((p) => p.id)).toEqual(plBefore)
    expect((await eventRow(ev1)).status).toBe('approved')
    expect(await registry(ev1)).toEqual([])
  })

  it('[A] build-now is manage-only (a review-only role is refused)', async () => {
    expect((await evJson<{ perms: Record<string, boolean> }>(reviewOnly, '/api/ev/me')).body.perms).toMatchObject({ review: true, manage: false })
    expect((await evJson(reviewOnly, `/api/ev/events/${ev1}/build-now`, { json: {} })).status).toBe(403)
    expect((await evJson(owner, `/api/ev/events/${ev1}/build-now`, { json: {} })).status).toBe(403)
  })

  it('[A+C] build-now (flag still off) compiles the event: registry first, main playlist, preserve-only membership, explicit order', { timeout: 180_000 }, async () => {
    const r = await evJson<{ queued: boolean }>(admin, `/api/ev/events/${ev1}/build-now`, { json: {} })
    expect(r.status).toBe(200)
    expect(r.body.queued).toBe(true)
    await waitEventStatus(ev1, 'built', 150_000)
    const reg = await registry(ev1)
    const main = reg.find((x) => x.role === 'main')!
    expect(main.playlist_id).toBeGreaterThan(80)
    expect(main.intent_name).toBe(`Flow One ${tag}`)
    const st = await station14()
    const pl = st.playlists.find((p) => p.id === main.playlist_id)!
    expect(pl).toMatchObject({ name: `Flow One ${tag}`, order: 'sequential' })
    expect(pl.schedule_items.length).toBeGreaterThan(0)
    for (const s of pl.schedule_items) {
      expect(s.start_date).toBeTruthy()
      expect(s.start_date).toBe(s.end_date)
      expect(s.start_time).toBeLessThan(s.end_time)
    }
    // preserve-only: station-1 rotation and legacy 74 stay
    expect(playlistIds(await mockFile(songA.path))).toEqual([2, main.playlist_id!].sort((a, b) => a - b))
    expect(playlistIds(await mockFile(shared.path))).toEqual([2, 74, main.playlist_id!].sort((a, b) => a - b))
    expect(playlistIds(await mockFile(songC.path))).toEqual([])
    // sequential: the order was set explicitly to the builder's order
    expect(st.order[String(main.playlist_id)]).toEqual([songA.id, shared.id])
    expect(st.violations).toEqual([])
    const ticket = await ticketFor(ev1)
    await waitFor(async () => ((await ticketMessages(ticket.id)).length >= 2 ? true : null), 60_000)
  })

  it('[A+C] autobuild ON: a second (private) event sharing a song builds on approve; the shared song keeps BOTH events and 74', { timeout: 240_000 }, async () => {
    await setEventsSettings({ events_autobuild_enabled: true })
    ev2 = await createEvent(second, eventBody({ title: `Flow Two ${tag}`, dayAhead: 22, visibility: 'private' }), [track(0, shared), track(1, songC)])
    expect((await evJson(second, `/api/ev/events/${ev2}/submit`, { json: {} })).status).toBe(200)
    await ticketFor(ev2, 90_000)
    expect((await evJson(reviewer, `/api/ev/events/${ev2}/approve`, { json: {} })).status).toBe(200)
    expect((await eventJobs(ev2)).map((j) => j.kind)).toContain('build')
    await waitEventStatus(ev2, 'built', 180_000)
    const m1 = await mainId(ev1)
    const m2 = await mainId(ev2)
    expect(m2).not.toBe(m1)
    const st = await station14()
    // a private event's playlist name carries no details
    expect(st.playlists.find((p) => p.id === m2)!.name).toBe('Private event')
    expect(playlistIds(await mockFile(shared.path))).toEqual([2, 74, m1, m2].sort((a, b) => a - b))
    expect(playlistIds(await mockFile(songA.path))).toEqual([2, m1].sort((a, b) => a - b))
    expect(playlistIds(await mockFile(songC.path))).toEqual([m2])
    expect(st.order[String(m1)]).toEqual([songA.id, shared.id]) // untouched by event 2
    expect(st.violations).toEqual([])
    await setEventsSettings({ events_autobuild_enabled: false })
  })

  it('[A+C] the music library sync never alerts on or absorbs the built events’ playlists', async () => {
    const ids = [await mainId(ev1), await mainId(ev2)]
    const ctx = makeCtx(Date.now(), { root: '' })
    await syncLibrary(ctx)
    const hit = ctx.alerts.filter((a) => ids.some((id) => new RegExp(`\\b${id}\\b`).test(a.title)))
    expect(hit).toEqual([])
    const station = ((await ownerSql()`SELECT value FROM settings WHERE key = 'station_playlist_ids'`)[0]?.value ?? []) as number[]
    const unconfirmed = ((await ownerSql()`SELECT value FROM settings WHERE key = 'unconfirmed_playlist_ids'`)[0]?.value ?? []) as number[]
    for (const id of ids) {
      expect(station).not.toContain(id)
      expect(unconfirmed).not.toContain(id)
    }
    const cached = (await ownerSql()`SELECT playlist_ids FROM library_cache WHERE media_id = ${shared.id}`)[0]!
    expect(cached.playlist_ids).toEqual([2])
    ctx.cleanup()
  })

  it('[A+C] withdrawing a built event tears down only its own memberships', { timeout: 180_000 }, async () => {
    const m1 = await mainId(ev1)
    const m2 = await mainId(ev2)
    expect((await evJson(owner, `/api/ev/events/${ev1}/withdraw`, { json: {} })).status).toBe(200)
    expect((await eventRow(ev1)).status).toBe('withdrawn')
    await waitFor(async () => (playlistIds(await mockFile(songA.path)).includes(m1) ? null : true), 150_000, 1000)
    expect(playlistIds(await mockFile(songA.path))).toEqual([2])
    expect(playlistIds(await mockFile(shared.path))).toEqual([2, 74, m2].sort((a, b) => a - b))
    expect(playlistIds(await mockFile(songC.path))).toEqual([m2])
    const st = await station14()
    expect(st.playlists.some((p) => p.id === m2)).toBe(true)
    for (const legacy of [74, 75, 76, 77, 78]) expect(st.playlists.some((p) => p.id === legacy)).toBe(true)
    expect(st.violations).toEqual([])
  })
})
