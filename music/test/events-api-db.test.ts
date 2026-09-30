// v0.5.0 events API (workstream A) against Postgres: the service layer the
// /api/ev routes call, end to end through the DB — create → playlist →
// submit → approve → re-approval edit → withdraw, the jobs and audit rows
// each step writes, clashes, version conflicts, the events_enabled gate,
// My audio (attach → probe request, in-use delete), and privacy on every
// read surface for a second member. Skips without the DB (test/run.sh).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, getDb } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { buildInputKey } from '@/events/contract/build-key'
import { probeRequestIdForUpload } from '@/events/contract/paths'
import type { EventAnnouncement, EventTrack, FullEventView } from '@/events/contract/types'
import { createAudio, deleteAudio, listAudio } from '@/events/server/audio'
import type { Actor } from '@/events/server/rules'
import * as svc from '@/events/server/service'
import { ownerSql } from './helpers/db'
import { DBENV } from './helpers/env'
import { mkUser } from './helpers/p3'

process.env.APP_ENC_KEY ??= '0'.repeat(64)

const db = () => getDb(process.env.TEST_APP_DATABASE_URL, 2)
const H = 3600_000
const hex = () => randomUUID().replace(/-/g, '')
const rnd = (n: number) => Math.floor(Math.random() * n)

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'ok'
  } catch (e) {
    if (e instanceof HttpError) return e.code
    throw e
  }
}

async function setSetting(key: string, value: unknown) {
  await ownerSql()`INSERT INTO settings (key, value) VALUES (${key}, ${ownerSql().json(value as never)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
}

async function jobs(eventId: number) {
  return ownerSql()`SELECT kind, payload, dedupe_key FROM event_jobs WHERE payload->>'eventId' = ${String(eventId)} ORDER BY id`
}

async function audits(eventId: number) {
  return (await ownerSql()`SELECT action FROM audit_log WHERE target_type = 'event' AND target_id = ${String(eventId)} ORDER BY id`).map((r) => r.action as string)
}

describe.skipIf(!DBENV())('events API service (DB)', () => {
  let owner: Actor
  let other: Actor
  let staff: Actor
  let lib1: number
  let lib2: number
  let stinger: number
  let ownAudio: number
  let otherAudio: number
  // A private window far enough ahead for member notice, unique per run.
  // A random day 20–160 days out, starting 16:00–18:00 UTC (12–2 PM ET), so the
  // test's windows never touch the 01:55–02:05 ET nightly-restart band (a
  // random hour used to land there now and then → nightly_restart instead of
  // the expected error).
  const base = Math.floor((Date.now() + (20 + rnd(140)) * 24 * H) / (24 * H)) * (24 * H) + (16 + rnd(3)) * H
  const start = new Date(base)
  const end = new Date(base + 3 * H)
  const iso = (t: number) => new Date(t).toISOString()
  const draft = {
    title: 'Secret Birthday',
    hostName: 'Secret Host',
    description: 'Secret description',
    location: 'Secret Place',
    eventType: 'private_party' as const,
    startsAt: iso(base),
    endsAt: iso(base + 3 * H),
    enteredTz: 'America/New_York',
    visibility: 'private' as const,
    playlistOrder: 'shuffle' as const,
  }

  beforeAll(async () => {
    const [o, x, s] = await Promise.all([mkUser(), mkUser(), mkUser()])
    owner = { userId: o.id, discordId: o.discordId, name: 'Owner', staff: false, manage: false }
    other = { userId: x.id, discordId: x.discordId, name: 'Other', staff: false, manage: false }
    staff = { userId: s.id, discordId: s.discordId, name: 'Staff', staff: true, manage: true }
    lib1 = 900000 + rnd(90000)
    lib2 = lib1 + 1
    stinger = lib1 + 2
    await ownerSql()`INSERT INTO library_cache (media_id, unique_id, path, title, artist, length_s) VALUES
      (${lib1}, ${hex()}, ${`Music/Artists/Evt${lib1}/one.mp3`}, 'Song One', 'Artist A', 200),
      (${lib2}, ${hex()}, ${`Music/Artists/Evt${lib1}/two.mp3`}, 'Song Two', 'Artist A', 180)`
    await ownerSql()`INSERT INTO event_stingers (media_id, path, title, length_s) VALUES (${stinger}, ${`EFM Stingers/id-${stinger}.mp3`}, 'EFM ID', 12)`
    const [a] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${owner.userId}, ${owner.discordId}, 'song', 'My Secret Mix', 'Me', 'live', 300) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${other.userId}, ${other.discordId}, 'song', 'Theirs', 'X', 'live', 300) RETURNING id`
    ownAudio = Number(a!.id)
    otherAudio = Number(b!.id)
    await setSetting('events_enabled', true)
    await setSetting('events_uploads_enabled', true)
    await setSetting('events_autobuild_enabled', false)
  })

  afterAll(async () => {
    await ownerSql()`DELETE FROM settings WHERE key IN ('events_enabled', 'events_uploads_enabled', 'events_autobuild_enabled')`
    await closeDb()
  })

  const tracks = (): EventTrack[] => [
    { position: 0, source: 'library', mediaId: lib1, audioId: null, pinAt: null },
    { position: 1, source: 'upload', mediaId: null, audioId: ownAudio, pinAt: null },
    { position: 2, source: 'library', mediaId: lib2, audioId: null, pinAt: iso(base + H) },
  ]
  const anns = (): EventAnnouncement[] => [{ source: 'stinger', mediaId: stinger, audioId: null, mode: 'at', at: iso(base + 30 * 60_000), everyMin: null, from: null, until: null }]

  let ev: FullEventView

  it('creates a draft, saves a playlist (no-op re-save), refuses another member’s audio', async () => {
    // 0.5.2: a title shaped like a helper playlist is refused before anything is written
    for (const title of ['EVT1 s1', 'evt7 a2', '~EVT1 s1', 'EVT1-s1']) expect(await codeOf(svc.createEvent(db(), owner, { ...draft, title }))).toBe('title_reserved')
    ev = await svc.createEvent(db(), owner, draft)
    expect(ev).toMatchObject({ kind: 'full', status: 'draft', version: 1, visibility: 'private', ownerName: null })
    expect(await codeOf(svc.patchEvent(db(), owner, ev.id, { title: 'EVT1 a1' }))).toBe('title_reserved')
    expect(await codeOf(svc.putPlaylist(db(), owner, ev.id, { tracks: [...tracks(), { position: 3, source: 'upload', mediaId: null, audioId: otherAudio, pinAt: null }], announcements: [], playlistOrder: 'shuffle' }))).toBe('media_not_allowed')
    ev = await svc.putPlaylist(db(), owner, ev.id, { tracks: tracks(), announcements: anns(), playlistOrder: 'shuffle' })
    expect(ev.version).toBe(2)
    expect(ev.tracks.map((t) => t.label?.title)).toEqual(['Song One', 'My Secret Mix', 'Song Two'])
    expect(ev.announcements[0]!.label).toEqual({ title: 'EFM ID', artist: null, lengthS: 12 })
    // The editor PUTs before every submit: identical content is not an edit.
    const again = await svc.putPlaylist(db(), owner, ev.id, { tracks: ev.tracks, announcements: ev.announcements, playlistOrder: 'shuffle' })
    expect(again.version).toBe(2)
    // Drafts open no ticket.
    expect(await jobs(ev.id)).toHaveLength(0)
  })

  it('0.5.3 draft autosave: a draft stores a playlist that breaks the timing rules; submit refuses it; a pending request does not store it', async () => {
    const late = base + 5 * 24 * H
    let d = await svc.createEvent(db(), owner, { ...draft, title: 'Autosave draft', startsAt: iso(late), endsAt: iso(late + 2 * H) })
    // a pin 5 minutes before the end (also after the time change below) and an announcement after the end
    const badTracks: EventTrack[] = [
      { position: 0, source: 'library', mediaId: lib1, audioId: null, pinAt: null },
      { position: 1, source: 'library', mediaId: lib2, audioId: null, pinAt: iso(late + 3 * H - 5 * 60_000) },
    ]
    const badAnns: EventAnnouncement[] = [{ source: 'stinger', mediaId: stinger, audioId: null, mode: 'at', at: iso(late + 3 * H), everyMin: null, from: null, until: null }]
    d = await svc.putPlaylist(db(), owner, d.id, { tracks: badTracks, announcements: badAnns, playlistOrder: 'sequential', version: d.version })
    expect(d.tracks).toHaveLength(2)
    expect(d.announcements).toHaveLength(1)
    expect(d.playlistOrder).toBe('sequential')
    expect(await audits(d.id)).toContain('events.playlist.save')
    // structural refusals still apply to drafts
    expect(await codeOf(svc.putPlaylist(db(), owner, d.id, { tracks: [badTracks[0]!, { ...badTracks[0]!, position: 1 }], announcements: [], playlistOrder: 'shuffle' }))).toBe('duplicate_track')
    expect(await codeOf(svc.putPlaylist(db(), owner, d.id, { tracks: [{ position: 0, source: 'upload', mediaId: null, audioId: otherAudio, pinAt: null }], announcements: [], playlistOrder: 'shuffle' }))).toBe('media_not_allowed')
    // a draft time change is not refused because of the stored pins
    d = await svc.patchEvent(db(), owner, d.id, { startsAt: iso(late + H), endsAt: iso(late + 3 * H), version: d.version })
    // submit runs the full check
    expect(await codeOf(svc.transition(db(), owner, d.id, 'submit'))).toBe('pin_out_of_range')
    expect((await svc.getEventView(db(), owner, d.id)).status).toBe('draft')
    // fixed → submit works; once pending, the full check applies to saves again
    d = await svc.putPlaylist(db(), owner, d.id, { tracks: [badTracks[0]!], announcements: [], playlistOrder: 'sequential', version: d.version })
    d = await svc.transition(db(), owner, d.id, 'submit')
    expect(d.status).toBe('pending')
    expect(await codeOf(svc.putPlaylist(db(), owner, d.id, { tracks: badTracks, announcements: [], playlistOrder: 'sequential', version: d.version }))).toBe('pin_out_of_range')
    await svc.transition(db(), owner, d.id, 'withdraw')
  })

  it('0.5.3: an upload that is being ingested (ready → ingesting) is accepted by a draft save and by submit; a probing one is not', async () => {
    const [ing] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${owner.userId}, ${owner.discordId}, 'song', 'Fresh Upload', 'Me', 'ingesting', 240) RETURNING id`
    const [prb] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${owner.userId}, ${owner.discordId}, 'song', 'Still Checking', 'Me', 'probing', NULL) RETURNING id`
    const late = base + 7 * 24 * H
    let d = await svc.createEvent(db(), owner, { ...draft, title: 'Ingesting upload', startsAt: iso(late), endsAt: iso(late + 2 * H) })
    const withUp = (audioId: number): EventTrack[] => [
      { position: 0, source: 'library', mediaId: lib1, audioId: null, pinAt: null },
      { position: 1, source: 'upload', mediaId: null, audioId, pinAt: null },
    ]
    expect(await codeOf(svc.putPlaylist(db(), owner, d.id, { tracks: withUp(Number(prb!.id)), announcements: [], playlistOrder: 'shuffle', version: d.version }))).toBe('audio_not_ready')
    d = await svc.putPlaylist(db(), owner, d.id, { tracks: withUp(Number(ing!.id)), announcements: [], playlistOrder: 'shuffle', version: d.version })
    expect(d.tracks.map((t) => t.label?.title)).toEqual(['Song One', 'Fresh Upload'])
    d = await svc.transition(db(), owner, d.id, 'submit')
    expect(d.status).toBe('pending')
    await svc.transition(db(), owner, d.id, 'withdraw')
  })

  it('0.5.3 status guard (event 16): a stale draft tab\'s PATCH / PUT after submit and after approve is 409 status_changed and changes nothing', async () => {
    const u = await mkUser()
    const m: Actor = { userId: u.id, discordId: u.discordId, name: 'Guard', staff: false, manage: false }
    const t0 = base + 9 * 24 * H
    const one: EventTrack[] = [{ position: 0, source: 'library', mediaId: lib1, audioId: null, pinAt: null }]
    const two: EventTrack[] = [...one, { position: 1, source: 'library', mediaId: lib2, audioId: null, pinAt: null }]
    let d = await svc.createEvent(db(), m, { ...draft, title: 'Guard draft', startsAt: iso(t0), endsAt: iso(t0 + 2 * H) })
    // tab A autosaves (expectStatus draft + a saveId)
    d = await svc.putPlaylist(db(), m, d.id, { tracks: one, announcements: [], playlistOrder: 'shuffle', version: d.version, expectStatus: 'draft', saveId: 'save-a-0001' })
    const stale = d.version // tab B loaded this version
    const errOf = async (p: Promise<unknown>) => {
      try {
        await p
        return 'ok'
      } catch (e) {
        if (e instanceof HttpError) return { http: e.status, code: e.code, ...e.extra }
        throw e
      }
    }
    const snap = async () => ({
      row: (await ownerSql()`SELECT status, version, title, location, updated_at FROM events WHERE id = ${d.id}`)[0],
      tracks: (await ownerSql()`SELECT media_id FROM event_tracks WHERE event_id = ${d.id} ORDER BY position`).map((r) => Number(r.media_id)),
      audits: await audits(d.id),
      jobs: (await jobs(d.id)).map((j) => `${j.kind}:${j.dedupe_key}`),
    })
    const expectRefused = async (now: string) => {
      const p = await errOf(svc.patchEvent(db(), m, d.id, { title: 'Changed in B', location: 'Place From B', version: stale, expectStatus: 'draft', saveId: 'save-b-0001' }))
      const q = await errOf(svc.putPlaylist(db(), m, d.id, { tracks: two, announcements: [], playlistOrder: 'shuffle', version: stale, expectStatus: 'draft', saveId: 'save-b-0002' }))
      const w = await errOf(svc.transition(db(), m, d.id, 'withdraw', { expectStatus: 'draft' }))
      // 409, and the body names the status the event has now
      for (const e of [p, q, w]) expect(e).toEqual({ http: 409, code: 'status_changed', status: now })
    }
    // submit (does not bump the version)
    d = await svc.transition(db(), m, d.id, 'submit')
    expect(d).toMatchObject({ status: 'pending', version: stale })
    const s1 = await snap()
    await expectRefused('pending')
    expect(await snap()).toEqual(s1)
    // staff approve (does not bump the version either): the exact event-16 flow
    d = await svc.transition(db(), staff, d.id, 'approve')
    expect(d).toMatchObject({ status: 'approved', version: stale })
    const s2 = await snap()
    await expectRefused('approved')
    const s3 = await snap()
    expect(s3).toEqual(s2)
    expect(s3.row).toMatchObject({ status: 'approved', version: stale, title: 'Guard draft', location: 'Secret Place' })
    expect(s3.tracks).toEqual([lib1])
    expect(s3.jobs.some((j) => j.startsWith('teardown'))).toBe(false)
    expect(s3.audits.filter((a) => a === 'events.event.edit')).toHaveLength(0)
    // without a version too; and an edit confirmed against "pending" never lands on the approved event
    expect(await errOf(svc.patchEvent(db(), m, d.id, { location: 'x', expectStatus: 'draft' }))).toEqual({ http: 409, code: 'status_changed', status: 'approved' })
    expect(await errOf(svc.putPlaylist(db(), m, d.id, { tracks: two, announcements: [], playlistOrder: 'shuffle', version: stale, expectStatus: 'pending' }))).toEqual({
      http: 409,
      code: 'status_changed',
      status: 'approved',
    })
    expect(await snap()).toEqual(s2)
    // a matching expectStatus still works (the explicit editor on the approved event)
    d = await svc.patchEvent(db(), m, d.id, { description: 'Explicit edit', version: stale, expectStatus: 'approved', saveId: 'save-c-0001' })
    expect(d).toMatchObject({ status: 'approved', version: stale + 1, description: 'Explicit edit' })
    // saveIds: recorded with the edit, newest first, owner and staff only; refused saves never appear
    const own = await svc.getEventView(db(), m, d.id)
    expect(own).toMatchObject({ kind: 'full', recentSaveIds: ['save-c-0001', 'save-a-0001'] })
    expect(await svc.getEventView(db(), staff, d.id)).toMatchObject({ kind: 'full', recentSaveIds: ['save-c-0001', 'save-a-0001'] })
    const stranger = await svc.getEventView(db(), other, d.id)
    expect(stranger.kind).toBe('private')
    expect(stranger).not.toHaveProperty('recentSaveIds')
    // only the single-event GET carries them (lists stay lean)
    expect((await svc.myEvents(db(), m)).find((e) => e.id === d.id)).not.toHaveProperty('recentSaveIds')
    await svc.transition(db(), m, d.id, 'withdraw', { expectStatus: 'approved' })
  })

  it('0.5.3: a failed or rejected upload is audio_failed (with its id); a probing one stays audio_not_ready', async () => {
    const [fl] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${owner.userId}, ${owner.discordId}, 'song', 'Failed Upload', 'Me', 'failed', NULL) RETURNING id`
    const [rj] = await ownerSql()`INSERT INTO event_audio (owner_user_id, owner_discord_id, kind, title, artist, status, duration_s)
      VALUES (${owner.userId}, ${owner.discordId}, 'announcement', 'Rejected Upload', NULL, 'rejected', NULL) RETURNING id`
    const late = base + 11 * 24 * H
    const d = await svc.createEvent(db(), owner, { ...draft, title: 'Failed upload', startsAt: iso(late), endsAt: iso(late + 2 * H) })
    const t = (audioId: number): EventTrack[] => [{ position: 0, source: 'upload', mediaId: null, audioId, pinAt: null }]
    try {
      await svc.putPlaylist(db(), owner, d.id, { tracks: t(Number(fl!.id)), announcements: [], playlistOrder: 'shuffle', version: d.version })
      expect.unreachable()
    } catch (e) {
      expect(e).toMatchObject({ status: 400, code: 'audio_failed', extra: { audioId: Number(fl!.id) } })
    }
    const annUp: EventAnnouncement = { source: 'upload', mediaId: null, audioId: Number(rj!.id), mode: 'at', at: iso(late + 30 * 60_000), everyMin: null, from: null, until: null }
    expect(await codeOf(svc.putPlaylist(db(), owner, d.id, { tracks: [], announcements: [annUp], playlistOrder: 'shuffle', version: d.version }))).toBe('audio_failed')
    expect((await svc.getEventView(db(), owner, d.id)) as FullEventView).toMatchObject({ version: d.version, tracks: [], announcements: [] })
    await svc.transition(db(), owner, d.id, 'withdraw')
  })

  it('a stranger cannot read, edit or act on the draft', async () => {
    expect(await codeOf(svc.getEventView(db(), other, ev.id))).toBe('not_found')
    expect(await codeOf(svc.getEventView(db(), null, ev.id))).toBe('not_found')
    expect(await codeOf(svc.patchEvent(db(), other, ev.id, { title: 'x' }))).toBe('not_found')
    expect(await codeOf(svc.transition(db(), other, ev.id, 'submit'))).toBe('not_found')
    expect(await codeOf(svc.putPlaylist(db(), other, ev.id, { tracks: tracks(), announcements: [], playlistOrder: 'shuffle' }))).toBe('not_found')
  })

  it('submit → pending, opens the ticket, marks the audio used; clashes are refused', async () => {
    ev = await svc.transition(db(), owner, ev.id, 'submit')
    expect(ev.status).toBe('pending')
    expect((await jobs(ev.id)).map((j) => j.kind)).toEqual(['ticket_open'])
    const [a] = await ownerSql()`SELECT used_at FROM event_audio WHERE id = ${ownAudio}`
    expect(a!.used_at).not.toBeNull()
    // the pending request holds its slot (+ gap) for everyone else
    expect(await codeOf(svc.createEvent(db(), other, { ...draft, startsAt: iso(base + 3 * H + 5 * 60_000), endsAt: iso(base + 5 * H) }))).toBe('overlap')
    expect(await codeOf(svc.createEvent(db(), other, { ...draft, startsAt: iso(base + H), endsAt: iso(base + 2 * H) }))).toBe('overlap')
  })

  it('privacy: a second member sees only "Pending" + time on every surface', async () => {
    const window = { from: iso(base - 24 * H), to: iso(base + 24 * H) }
    for (const viewer of [other, null]) {
      const cal = (await svc.calendar(db(), viewer, window)).filter((v) => v.id === ev.id)
      expect(cal).toEqual([{ kind: 'pending', id: ev.id, startsAt: start.toISOString(), endsAt: end.toISOString(), status: 'pending', label: 'Pending' }])
      expect(await svc.getEventView(db(), viewer, ev.id)).toEqual(cal[0])
    }
    const ics = (await svc.icsViews(db())).filter((v) => v.id === ev.id)
    expect(ics).toEqual([{ kind: 'pending', id: ev.id, startsAt: start.toISOString(), endsAt: end.toISOString(), status: 'pending', label: 'Pending' }])
    expect((await svc.myEvents(db(), other)).map((e) => e.id)).not.toContain(ev.id)
    const avail = await svc.availability(db(), { ...window })
    expect(avail).toContainEqual({ startsAt: start.toISOString(), endsAt: end.toISOString(), kind: 'event' })
    expect(JSON.stringify(avail)).not.toContain('Secret')
    const excluded = await svc.availability(db(), { ...window, exclude: ev.id })
    expect(excluded).not.toContainEqual({ startsAt: start.toISOString(), endsAt: end.toISOString(), kind: 'event' })
    // the owner and staff get the full view
    expect((await svc.getEventView(db(), owner, ev.id)).kind).toBe('full')
    expect((await svc.getEventView(db(), staff, ev.id)).kind).toBe('full')
    expect((await svc.staffQueue(db(), staff)).pending.map((e) => e.id)).toContain(ev.id)
    expect(await codeOf(svc.staffQueue(db(), other))).toBe('forbidden')
  })

  it('members cannot approve; staff approve (no build while autobuild is off)', async () => {
    expect(await codeOf(svc.transition(db(), owner, ev.id, 'approve'))).toBe('forbidden')
    ev = await svc.transition(db(), staff, ev.id, 'approve')
    expect(ev.status).toBe('approved')
    const j = await jobs(ev.id)
    expect(j.map((r) => r.kind)).toEqual(['ticket_open', 'ticket_post'])
    expect(j[1]!.payload).toMatchObject({ kind: 'approved', idem: `approved:${ev.id}:${ev.version}` })
    // private + approved: strangers see the booked label only
    const v = await svc.getEventView(db(), other, ev.id)
    expect(v).toEqual({ kind: 'private', id: ev.id, startsAt: start.toISOString(), endsAt: end.toISOString(), status: 'approved', label: 'Booked · Private event' })
  })

  it('a details edit keeps the approval; a stale version is a conflict', async () => {
    const before = ev.version
    ev = await svc.patchEvent(db(), owner, ev.id, { description: 'Still secret', version: before })
    expect(ev).toMatchObject({ status: 'approved', version: before + 1, description: 'Still secret' })
    expect(await codeOf(svc.patchEvent(db(), owner, ev.id, { title: 'x', version: before }))).toBe('version_conflict')
  })

  it('a member time / visibility / playlist edit sends it back to pending with a diff and a teardown', async () => {
    ev = await svc.patchEvent(db(), owner, ev.id, { visibility: 'public' })
    expect(ev.status).toBe('pending')
    const j = await jobs(ev.id)
    const edited = j.filter((r) => r.kind === 'ticket_post' && (r.payload as { kind: string }).kind === 'edited').at(-1)!
    expect((edited.payload as { body: string }).body).toContain('Visibility: Private → Public')
    expect((edited.payload as { body: string }).body).toContain('need staff approval again')
    expect(j.map((r) => r.kind)).toContain('teardown')
    ev = await svc.transition(db(), staff, ev.id, 'approve')
    ev = await svc.putPlaylist(db(), owner, ev.id, { tracks: tracks().slice(0, 2), announcements: anns(), playlistOrder: 'sequential' })
    expect(ev.status).toBe('pending')
    const body = (await jobs(ev.id)).filter((r) => r.kind === 'ticket_post').map((r) => (r.payload as { body: string }).body).at(-1)!
    expect(body).toContain('Play order: shuffle → sequential')
    expect(body).toContain('Pinned songs: 1 → 0')
  })

  it('staff edits of an approved event enqueue a build when autobuild is on', async () => {
    ev = await svc.transition(db(), staff, ev.id, 'approve')
    await setSetting('events_autobuild_enabled', true)
    try {
      ev = await svc.patchEvent(db(), staff, ev.id, { title: 'Renamed by staff' })
      expect(ev.status).toBe('approved')
      const builds = (await jobs(ev.id)).filter((r) => r.kind === 'build')
      expect(builds.at(-1)!.payload).toEqual({ eventId: ev.id, version: ev.version })
      expect(await codeOf(svc.buildNow(db(), owner, ev.id))).toBe('forbidden')
      expect(await svc.buildNow(db(), staff, ev.id)).toEqual({ queued: true })
      // 0.5.2: a start kick that rolled the event back leaves it `failed`;
      // Build now stays allowed (it is how staff put it back on air)
      await ownerSql()`UPDATE events SET status = 'failed' WHERE id = ${ev.id}`
      expect(await svc.buildNow(db(), staff, ev.id, { now: () => Date.now() + 61_000 })).toEqual({ queued: true })
      await ownerSql()`UPDATE events SET status = 'approved' WHERE id = ${ev.id}`
    } finally {
      await setSetting('events_autobuild_enabled', false)
    }
  })

  it('audio in use cannot be deleted by the member; withdraw closes the ticket and tears down', async () => {
    expect(await codeOf(deleteAudio(db(), owner, ownAudio))).toBe('audio_in_use')
    expect(await codeOf(deleteAudio(db(), other, ownAudio))).toBe('not_found')
    ev = await svc.transition(db(), owner, ev.id, 'withdraw')
    expect(ev.status).toBe('withdrawn')
    const kinds = (await jobs(ev.id)).map((r) => r.kind)
    expect(kinds.slice(-3)).toEqual(['ticket_post', 'ticket_close', 'teardown'])
    expect(await codeOf(svc.getEventView(db(), other, ev.id))).toBe('not_found')
    expect(await codeOf(svc.patchEvent(db(), owner, ev.id, { title: 'x' }))).toBe('not_editable')
    expect(await deleteAudio(db(), owner, ownAudio)).toEqual({ deleted: true })
    const aj = await ownerSql()`SELECT kind FROM event_jobs WHERE payload->>'audioId' = ${String(ownAudio)}`
    expect(aj.map((r) => r.kind)).toEqual(['audio_delete'])
    expect(await audits(ev.id)).toEqual(
      expect.arrayContaining(['events.event.create', 'events.playlist.save', 'events.event.submit', 'events.event.approve', 'events.event.edit', 'events.event.withdraw']),
    )
  })

  it('events_enabled=false: members cannot create or submit; staff can', async () => {
    await setSetting('events_enabled', false)
    try {
      const w = { ...draft, startsAt: iso(base + 30 * H), endsAt: iso(base + 31 * H) }
      expect(await codeOf(svc.createEvent(db(), other, w))).toBe('events_disabled')
      const s = await svc.createEvent(db(), staff, w)
      expect(s.status).toBe('draft')
    } finally {
      await setSetting('events_enabled', true)
    }
  })

  it('member limits: notice and daily creates', async () => {
    expect(await codeOf(svc.createEvent(db(), other, { ...draft, startsAt: iso(Date.now() + 2 * H), endsAt: iso(Date.now() + 3 * H) }))).toBe('too_soon')
    await setSetting('events_member_daily_creates', 0)
    try {
      expect(await codeOf(svc.createEvent(db(), other, { ...draft, startsAt: iso(base + 40 * H), endsAt: iso(base + 41 * H) }))).toBe('daily_cap')
    } finally {
      await ownerSql()`DELETE FROM settings WHERE key = 'events_member_daily_creates'`
    }
  })

  it('staff book directly (approved, created_by_staff), adjacent allowed for staff only', async () => {
    const b = await svc.staffBook(db(), staff, { ...draft, visibility: 'public', title: 'Staff Night', startsAt: iso(base + 50 * H), endsAt: iso(base + 52 * H), openTicket: false })
    expect(b).toMatchObject({ status: 'approved', title: 'Staff Night' })
    const adj = await svc.staffBook(db(), staff, { ...draft, startsAt: iso(base + 52 * H), endsAt: iso(base + 53 * H), openTicket: false })
    expect(adj.status).toBe('approved')
    expect(await codeOf(svc.createEvent(db(), other, { ...draft, startsAt: iso(base + 53 * H + 5 * 60_000), endsAt: iso(base + 54 * H) }))).toBe('overlap')
    const pub = await svc.getEventView(db(), other, b.id)
    expect(pub).toMatchObject({ kind: 'public', title: 'Staff Night' })
    expect(await codeOf(svc.staffBook(db(), owner, { ...draft, startsAt: iso(base + 60 * H), endsAt: iso(base + 61 * H), openTicket: false }))).toBe('forbidden')
    expect(await codeOf(svc.staffBook(db(), staff, { ...draft, title: 'EVT3 s1', startsAt: iso(base + 60 * H), endsAt: iso(base + 61 * H), openTicket: false }))).toBe('title_reserved')
  })

  it('My audio: attach a complete events upload → probing + a probe request under the derived id', async () => {
    const spool = mkdtempSync(join(tmpdir(), 'evapi-spool-'))
    const uploadId = hex()
    const musicUpload = hex()
    await ownerSql()`INSERT INTO uploads (id, owner_user_id, length, status, site) VALUES
      (${uploadId}, ${other.userId}, 12345, 'complete', 'events'),
      (${musicUpload}, ${other.userId}, 12345, 'complete', 'music')`
    expect(await codeOf(createAudio(db(), other, { uploadId: musicUpload, kind: 'song', title: 'T', artist: 'A' }, spool))).toBe('upload_not_available')
    expect(await codeOf(createAudio(db(), owner, { uploadId, kind: 'song', title: 'T', artist: 'A' }, spool))).toBe('upload_not_available')
    expect(await codeOf(createAudio(db(), other, { uploadId, kind: 'song', title: 'T', artist: null }, spool))).toBe('invalid_body')
    const a = await createAudio(db(), other, { uploadId, kind: 'song', title: 'Track', artist: 'Artist' }, spool)
    expect(a).toMatchObject({ status: 'probing', title: 'Track', usedAt: null })
    const file = join(spool, `${probeRequestIdForUpload(uploadId)}.json`)
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ type: 'probe', upload: uploadId, expectedSize: 12345 })
    const [u] = await ownerSql()`SELECT status FROM uploads WHERE id = ${uploadId}`
    expect(u!.status).toBe('attached')
    expect((await listAudio(db(), other)).map((r) => r.id)).toContain(a.id)
    expect((await listAudio(db(), owner)).map((r) => r.id)).not.toContain(a.id)
    expect(await codeOf(listAudio(db(), owner, other.userId))).toBe('forbidden')
    expect((await listAudio(db(), staff, other.userId)).map((r) => r.id)).toContain(a.id)
  })

  it('autobuild off: details edits keep the applied build current; a staff build-input edit flags needsRebuild + a rebuild_needed job; a member title edit needs re-approval', async () => {
    let e = await svc.staffBook(db(), staff, { ...draft, visibility: 'public', title: 'Launch Night', ownerDiscordId: owner.discordId, startsAt: iso(base + 80 * H), endsAt: iso(base + 82 * H), openTicket: false })
    e = await svc.putPlaylist(db(), staff, e.id, { tracks: tracks().filter((t) => t.source === 'library').map((t) => ({ ...t, pinAt: null })), announcements: [], playlistOrder: 'shuffle' })
    const kinds = async () => (await jobs(e.id)).map((r) => r.kind)
    expect(await kinds()).toEqual(['rebuild_needed'])
    // the worker built it: an applied build carrying the key of these inputs
    const key = buildInputKey(e, e.tracks, e.announcements)
    await ownerSql()`UPDATE events SET status = 'built' WHERE id = ${e.id}`
    await ownerSql()`INSERT INTO event_builds (event_id, version, plan, status) VALUES (${e.id}, ${e.version}, ${ownerSql().json({ v: 1, playlists: [], inputKey: key })}, 'applied')`
    e = (await svc.getEventView(db(), staff, e.id)) as FullEventView
    expect(e).toMatchObject({ status: 'built', needsRebuild: false })
    // details only (staff or member): version moves, the build stays current, no job
    e = await svc.patchEvent(db(), staff, e.id, { description: 'Doors at 8', hostName: 'DJ Staff', location: 'Pier 4', eventType: 'club_night' })
    e = await svc.patchEvent(db(), owner, e.id, { description: 'Doors at 8:30' })
    expect(e).toMatchObject({ status: 'built', needsRebuild: false })
    expect(await kinds()).toEqual(['rebuild_needed'])
    // a staff title edit renames the public main playlist: needs a rebuild
    e = await svc.patchEvent(db(), staff, e.id, { title: 'Launch Night Live' })
    expect(e).toMatchObject({ status: 'built', needsRebuild: true })
    const rj = (await jobs(e.id)).filter((r) => r.kind === 'rebuild_needed').at(-1)!
    expect(rj.payload).toEqual({ eventId: e.id, version: e.version })
    // reverting it makes the applied build current again
    e = await svc.patchEvent(db(), staff, e.id, { title: 'Launch Night' })
    expect(e.needsRebuild).toBe(false)
    // members: a title edit of a built event goes back to review (and off the station)
    e = await svc.patchEvent(db(), owner, e.id, { title: 'My Launch' })
    expect(e.status).toBe('pending')
    expect((await jobs(e.id)).map((r) => r.kind).at(-1)).toBe('teardown')
  })
})
