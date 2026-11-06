// v0.5.0 Events portal privacy (plan §3 "Privacy"): one viewEvent
// projection feeds the calendar JSON, the ICS feed, the detail route and the
// list APIs. A second member (and an anonymous visitor) sees a private event
// only as "Booked · Private event" + time, a pending one only as "Pending" +
// time, and never a draft; only the owner or staff see details and audio.
// Custom audio ids are bound to the event OWNER.
// [A]: needs the events API only (no worker, no AzuraCast).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ownerSql } from './helpers/db'
import {
  clearEventsSettings,
  control,
  eventBody,
  EVENTS_E2E,
  evJson,
  evLoginOk,
  evReq,
  newMemberId,
  REVIEWER_ROLE,
  seedLibrarySongs,
  setEventsSettings,
  slot,
  uniqTag,
  type Jar,
  type MockMedia,
} from './helpers/events'

type View = { kind: string; id: number; status: string; label?: string; title?: string } & Record<string, unknown>
const PRIVATE_LABEL = 'Booked · Private event'
const SETTINGS = ['events_enabled', 'events_autobuild_enabled']

describe.skipIf(!EVENTS_E2E())('events privacy: a second member, anonymous visitors, ICS', () => {
  const tag = uniqTag()
  // Unique strings that must never leak past the projection.
  const secret = {
    privTitle: `SecretTitle${tag}`,
    privDesc: `SecretDesc${tag}`,
    privLoc: `SecretLoc${tag}`,
    pendTitle: `PendingTitle${tag}`,
    pendDesc: `PendingDesc${tag}`,
    draftTitle: `DraftTitle${tag}`,
  }
  let owner: Jar
  let ownerId: string
  let other: Jar
  let otherId: string
  let reviewer: Jar
  let song: MockMedia
  const ids = { pub: 0, priv: 0, pend: 0, draft: 0, otherDraft: 0 }
  let ownerAudio = 0

  const range = () => {
    const a = slot(60)
    const b = slot(70)
    return `from=${encodeURIComponent(new Date(Date.parse(a.startsAt) - 86_400_000).toISOString())}&to=${encodeURIComponent(b.endsAt)}`
  }
  const leaks = (text: string) => Object.values(secret).filter((s) => text.includes(s))

  async function create(jar: Jar, body: Record<string, unknown>): Promise<number> {
    const r = await evJson<{ event: { id: number } }>(jar, '/api/ev/events', { json: body })
    expect([200, 201]).toContain(r.status)
    return r.body.event.id
  }
  async function withTrack(jar: Jar, id: number) {
    const r = await evReq(jar, `/api/ev/events/${id}/playlist`, {
      method: 'PUT',
      json: { tracks: [{ position: 0, source: 'library', mediaId: song.id, audioId: null, pinAt: null }], announcements: [], playlistOrder: 'shuffle' },
    })
    expect(r.status).toBe(200)
  }

  beforeAll(async () => {
    await setEventsSettings({ events_enabled: true, events_autobuild_enabled: false })
    ownerId = newMemberId()
    otherId = newMemberId()
    owner = await evLoginOk({ id: ownerId })
    other = await evLoginOk({ id: otherId })
    reviewer = await evLoginOk({ id: newMemberId(), roles: [REVIEWER_ROLE] })
    for (const id of [ownerId, otherId]) await control('/__mock/tickets/member', { id, member: true })
    song = (await seedLibrarySongs([{ path: `Music/Artists/EvPriv ${tag}/EvPriv ${tag} - Song.mp3`, title: 'Song', artist: `EvPriv ${tag}`, playlists: [2] }]))[0]!

    ids.pub = await create(owner, { ...eventBody({ title: `Public ${tag}`, dayAhead: 60 }), description: `Open to all ${tag}` })
    ids.priv = await create(owner, { ...eventBody({ title: secret.privTitle, dayAhead: 62, visibility: 'private' }), description: secret.privDesc, location: secret.privLoc })
    ids.pend = await create(owner, { ...eventBody({ title: secret.pendTitle, dayAhead: 64 }), description: secret.pendDesc })
    ids.draft = await create(owner, eventBody({ title: secret.draftTitle, dayAhead: 66 }))
    for (const id of [ids.pub, ids.priv, ids.pend]) {
      await withTrack(owner, id)
      expect((await evReq(owner, `/api/ev/events/${id}/submit`, { json: {} })).status).toBe(200)
    }
    for (const id of [ids.pub, ids.priv]) expect((await evReq(reviewer, `/api/ev/events/${id}/approve`, { json: {} })).status).toBe(200)
    ids.otherDraft = await create(other, eventBody({ title: `Other ${tag}`, dayAhead: 68 }))

    // One of the owner's custom audio items, ready (as the probe collection
    // would leave it). Its id must be refused for anyone else's event.
    const u = (await ownerSql()`SELECT id FROM "user" WHERE discord_id = ${ownerId}`)[0]!
    const [a] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, status, duration_s)
      VALUES (${u.id}, ${ownerId}, 'song', ${`Owner audio ${tag}`}, 'ready', 180) RETURNING id`
    ownerAudio = Number(a!.id)
  })
  afterAll(async () => {
    await clearEventsSettings(SETTINGS)
  })

  function checkProjection(views: View[]) {
    const byId = new Map(views.map((v) => [v.id, v]))
    expect(byId.get(ids.pub)).toMatchObject({ kind: 'public', title: `Public ${tag}`, status: 'approved' })
    const priv = byId.get(ids.priv)!
    expect(priv).toMatchObject({ kind: 'private', status: 'approved', label: PRIVATE_LABEL })
    expect(Object.keys(priv).sort()).toEqual(['endsAt', 'id', 'kind', 'label', 'startsAt', 'status'])
    const pend = byId.get(ids.pend)!
    expect(pend).toMatchObject({ kind: 'pending', status: 'pending', label: 'Pending' })
    expect(Object.keys(pend).sort()).toEqual(['endsAt', 'id', 'kind', 'label', 'startsAt', 'status'])
    expect(byId.has(ids.draft)).toBe(false)
    expect(byId.has(ids.otherDraft)).toBe(false)
    expect(views.some((v) => v.kind === 'full')).toBe(false)
  }

  it('[A] calendar JSON: second member and anonymous get only the public/private/pending projections', async () => {
    for (const jar of [other, null]) {
      const r = await evReq(jar, `/api/ev/calendar?${range()}`)
      expect(r.status).toBe(200)
      const text = await r.text()
      expect(leaks(text)).toEqual([])
      expect(text).not.toContain(ownerId)
      checkProjection(JSON.parse(text) as View[])
    }
  })

  it('[A] ICS: opaque UIDs, private → "Booked · Private event", pending → "Pending", no DESCRIPTION/LOCATION for either', async () => {
    const r = await evReq(null, '/api/ev/calendar.ics')
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/calendar/)
    const ics = await r.text()
    expect(leaks(ics)).toEqual([])
    expect(ics).not.toContain(ownerId)
    // unfold RFC 5545 continuation lines, then split into VEVENTs
    const unfolded = ics.replace(/\r?\n[ \t]/g, '')
    const vevents = unfolded.split('BEGIN:VEVENT').slice(1).map((b) => b.split('END:VEVENT')[0]!)
    const summaryOf = (b: string) => /^SUMMARY[^:]*:(.*)$/m.exec(b)?.[1]?.trim().replace(/\\,/g, ',') ?? ''
    const priv = vevents.filter((b) => summaryOf(b) === PRIVATE_LABEL)
    const pend = vevents.filter((b) => summaryOf(b) === 'Pending')
    expect(priv.length).toBeGreaterThanOrEqual(1)
    expect(pend.length).toBeGreaterThanOrEqual(1)
    for (const b of [...priv, ...pend]) {
      expect(b).not.toMatch(/^DESCRIPTION/m)
      expect(b).not.toMatch(/^LOCATION/m)
    }
    expect(vevents.some((b) => summaryOf(b) === `Public ${tag}`)).toBe(true)
    // opaque UIDs: a random-looking token (not the event id), one per event
    const uids = vevents.map((b) => /^UID[^:]*:(.*)$/m.exec(b)?.[1]?.trim() ?? '')
    for (const uid of uids) expect(uid.split('@')[0]).toMatch(/^[A-Za-z0-9_-]{16,}$/)
    expect(new Set(uids).size).toBe(uids.length)
  })

  it('[A] detail: the second member gets projections; drafts are 404; the owner and staff get the full view', async () => {
    const get = (jar: Jar | null, id: number) => evJson<View>(jar, `/api/ev/events/${id}`)
    for (const jar of [other, null]) {
      expect((await get(jar, ids.priv)).body).toMatchObject({ kind: 'private', label: PRIVATE_LABEL })
      expect((await get(jar, ids.pend)).body).toMatchObject({ kind: 'pending', label: 'Pending' })
      expect((await get(jar, ids.pub)).body).toMatchObject({ kind: 'public', title: `Public ${tag}` })
      expect((await get(jar, ids.draft)).status).toBe(404)
      const t = await (await evReq(jar, `/api/ev/events/${ids.priv}`)).text()
      expect(leaks(t)).toEqual([])
    }
    expect((await get(null, 999_999_999)).status).toBe(404)
    for (const jar of [owner, reviewer]) {
      const v = (await get(jar, ids.priv)).body
      expect(v).toMatchObject({ kind: 'full', title: secret.privTitle, description: secret.privDesc, location: secret.privLoc, visibility: 'private' })
      expect((v.tracks as unknown[]).length).toBe(1)
    }
    expect((await get(owner, ids.draft)).body).toMatchObject({ kind: 'full', status: 'draft' })
  })

  it('[A] my events: each member sees only their own (full views)', async () => {
    const mine = await evJson<View[]>(owner, '/api/ev/my/events')
    expect(mine.status).toBe(200)
    expect(new Set(mine.body.map((v) => v.id))).toEqual(new Set([ids.pub, ids.priv, ids.pend, ids.draft]))
    expect(mine.body.every((v) => v.kind === 'full')).toBe(true)
    const theirs = await evJson<View[]>(other, '/api/ev/my/events')
    expect(theirs.body.map((v) => v.id)).toEqual([ids.otherDraft])
    expect(leaks(JSON.stringify(theirs.body))).toEqual([])
    expect((await evReq(null, '/api/ev/my/events')).status).toBe(401)
  })

  it('[A] staff queue is review-only', async () => {
    expect((await evReq(other, '/api/ev/staff/queue')).status).toBe(403)
    const q = await evJson<{ pending: View[]; upcoming: View[] }>(reviewer, '/api/ev/staff/queue')
    expect(q.status).toBe(200)
    expect(q.body.pending.map((v) => v.id)).toContain(ids.pend)
  })

  it('[A] another member cannot edit, submit or withdraw the owner’s events', async () => {
    expect((await evReq(other, `/api/ev/events/${ids.draft}`, { method: 'PATCH', json: { title: 'Hijack' } })).status).toBeGreaterThanOrEqual(403)
    expect((await evReq(other, `/api/ev/events/${ids.draft}/submit`, { json: {} })).status).toBeGreaterThanOrEqual(403)
    expect((await evReq(other, `/api/ev/events/${ids.pend}/withdraw`, { json: {} })).status).toBeGreaterThanOrEqual(403)
    expect((await evReq(other, `/api/ev/events/${ids.draft}/playlist`, { method: 'PUT', json: { tracks: [], announcements: [], playlistOrder: 'shuffle' } })).status).toBeGreaterThanOrEqual(403)
    expect((await ownerSql()`SELECT title FROM events WHERE id = ${ids.draft}`)[0]!.title).toBe(secret.draftTitle)
  })

  it('[A] custom audio is bound to the event owner: another member’s audio_id is refused (tracks and announcements)', async () => {
    const upload = (audioId: number) => ({ position: 0, source: 'upload', mediaId: null, audioId, pinAt: null })
    const r1 = await evReq(other, `/api/ev/events/${ids.otherDraft}/playlist`, { method: 'PUT', json: { tracks: [upload(ownerAudio)], announcements: [], playlistOrder: 'shuffle' } })
    expect(r1.status).toBeGreaterThanOrEqual(400)
    expect(r1.status).toBeLessThan(500)
    const { startsAt } = eventBody({ title: 'x', dayAhead: 68 })
    const ann = { source: 'upload', mediaId: null, audioId: ownerAudio, mode: 'at', at: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(), everyMin: null, from: null, until: null }
    const r2 = await evReq(other, `/api/ev/events/${ids.otherDraft}/playlist`, { method: 'PUT', json: { tracks: [], announcements: [ann], playlistOrder: 'shuffle' } })
    expect(r2.status).toBeGreaterThanOrEqual(400)
    expect(r2.status).toBeLessThan(500)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM event_tracks WHERE audio_id = ${ownerAudio}`)[0]!.n).toBe(0)
    expect((await ownerSql()`SELECT count(*)::int AS n FROM event_announcements WHERE audio_id = ${ownerAudio}`)[0]!.n).toBe(0)
    // the owner may use it on their own draft
    const ok = await evReq(owner, `/api/ev/events/${ids.draft}/playlist`, { method: 'PUT', json: { tracks: [upload(ownerAudio)], announcements: [], playlistOrder: 'shuffle' } })
    expect(ok.status).toBe(200)
    // and nobody else sees it in My audio or can preview / delete it
    const theirs = await evJson<{ id: number }[]>(other, '/api/ev/audio')
    expect(theirs.body.map((a) => a.id)).not.toContain(ownerAudio)
    expect([403, 404]).toContain((await evReq(other, `/api/ev/audio/${ownerAudio}/preview`)).status)
    expect([403, 404]).toContain((await evReq(other, `/api/ev/audio/${ownerAudio}`, { method: 'DELETE' })).status)
    expect((await ownerSql()`SELECT deleted_at FROM event_audio WHERE id = ${ownerAudio}`)[0]!.deleted_at).toBeNull()
    const mine = await evJson<{ id: number }[]>(owner, '/api/ev/audio')
    expect(mine.body.map((a) => a.id)).toContain(ownerAudio)
  })
})
