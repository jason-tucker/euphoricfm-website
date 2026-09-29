// Events API use cases (events-web). Each mutation runs in ONE transaction:
// lock the event row (and the slot lock for time decisions), apply the pure
// rules / state machine, write, enqueue the worker's jobs and the audit row,
// so a job or audit entry never exists without the change it describes.

import { and, eq } from 'drizzle-orm'
import { audit } from '../../server/audit'
import { loadEventsSettings } from '../../server/admin/events-settings'
import type { DB } from '../../server/db/client'
import { events } from '../../server/db/schema'
import { badRequest, forbidden, HttpError, notFound } from '../../server/http/errors'
import { oneOrConflict } from '../../server/authz/transitions'
import { enqueueEventJob } from '../enqueue'
import { buildInputKey } from '../contract/build-key'
import { isReservedPlaylistName } from '../contract/paths'
import { CALENDAR_MAX_WINDOW_DAYS, CALENDAR_STATUSES, SLOT_HOLDING_STATUSES } from '../contract/rules'
import type { EventsSettings } from '../contract/settings'
import type { CreateEventRequest, PatchEventRequest, PutPlaylistRequest, StaffBookRequest } from '../contract/api'
import type { EventAnnouncement, EventStatus, EventTrack, EventView, FullEventView, PlaylistOrder, Visibility } from '../contract/types'
import * as repo from './repo'
import type { EventRow, Q, Tx } from './repo'
import {
  assertEditable,
  assertSubmittable,
  bad,
  changedFields,
  checkClash,
  checkTiming,
  clash,
  needsReapproval,
  playlistKey,
  trackLabel,
  announcementLabel,
  validatePlaylist,
  type Actor,
  type DetailFields,
  type Lookup,
} from './rules'
import { jobsFor, MAY_BE_BUILT, nextStatus, type Action, type PlannedJob } from './state'
import { diffLines, editedBody, type DiffSide } from './tickets-outbound'
import { timeText } from './time'
import { fullView, publicView, seesFull, viewEvent } from './view'

const MIN = 60_000
const DAY = 86_400_000

type Clock = { now?: () => number }
const nowOf = (c?: Clock) => (c?.now ? c.now() : Date.now())

// ------------------------------------------------------------ helpers ---

async function enqueueAll(tx: Tx, jobs: readonly PlannedJob[]): Promise<void> {
  for (const j of jobs) {
    await enqueueEventJob(tx, j.kind, j.payload as never, { dedupeExtra: j.dedupeExtra, runAfter: j.runAfter })
  }
}

async function auditEv(tx: Tx, actor: Actor, action: string, eventId: number, detail: Record<string, unknown> = {}) {
  await audit(tx, { actorUserId: actor.userId, actorDiscordId: actor.discordId, action, targetType: 'event', targetId: eventId, detail })
}

/** The row, if this actor may act on it at all (owner or staff); 404 otherwise. */
async function loadOwned(q: Q, actor: Actor, id: number, lock = false): Promise<EventRow> {
  const ev = await repo.getEvent(q, id, lock)
  if (!ev || !seesFull(ev, actor)) throw notFound()
  return ev
}

async function fullOf(q: Q, ev: EventRow, actor: Actor | null, s: EventsSettings, now: number): Promise<FullEventView> {
  const x = await repo.loadFullExtras(q, [ev], s, now)
  return fullView(ev, actor, x.get(ev.id)!)
}

const core = (ev: EventRow) => ({
  id: ev.id,
  ownerUserId: ev.ownerUserId,
  status: ev.status as EventStatus,
  startsAt: ev.startsAt,
  endsAt: ev.endsAt,
  visibility: ev.visibility as Visibility,
  playlistOrder: ev.playlistOrder as PlaylistOrder,
  version: ev.version,
})

const hasTicket = (ev: EventRow) => ev.ticketId !== null || ev.submittedAt !== null
const mayBeBuilt = (ev: EventRow) => MAY_BE_BUILT.includes(ev.status as EventStatus) || ev.decidedAt !== null

function checkVersion(ev: EventRow, version: number | undefined) {
  if (version !== undefined && version !== ev.version) throw new HttpError(409, 'version_conflict', { version: ev.version })
}

/** Conditional write: the row must still have the status + version we decided on. */
async function writeEvent(tx: Tx, ev: EventRow, set: Partial<typeof events.$inferInsert>): Promise<EventRow> {
  return oneOrConflict(
    await tx
      .update(events)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(events.id, ev.id), eq(events.status, ev.status), eq(events.version, ev.version)))
      .returning(),
    'state_changed',
  )
}

async function slotCheck(tx: Tx, w: { id?: number; startsAt: number; endsAt: number }, s: EventsSettings, actor: Actor) {
  await repo.lockSlots(tx)
  const pad = s.events_gap_min * MIN
  const others = await repo.slotRows(tx, new Date(w.startsAt - pad), new Date(w.endsAt + pad), SLOT_HOLDING_STATUSES)
  return checkClash(w, others, s.events_gap_min, actor)
}

function displaySide(ev: Pick<EventRow, 'title' | 'hostName' | 'description' | 'location' | 'eventType' | 'startsAt' | 'endsAt' | 'visibility' | 'playlistOrder'>, p: { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }, lk: Lookup): DiffSide {
  const name = (t: EventTrack) => {
    const l = trackLabel(t, lk)
    return l ? `${l.artist ? `${l.artist} – ` : ''}${l.title}` : t.source === 'library' ? `Library song #${t.mediaId}` : `Upload #${t.audioId}`
  }
  const sorted = [...p.tracks].sort((a, b) => a.position - b.position)
  return {
    title: ev.title,
    hostName: ev.hostName,
    description: ev.description,
    location: ev.location,
    eventType: ev.eventType,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    visibility: ev.visibility as Visibility,
    playlistOrder: ev.playlistOrder as PlaylistOrder,
    songs: sorted.filter((t) => t.pinAt === null).map(name),
    pins: sorted.filter((t) => t.pinAt !== null).map((t) => `${name(t)} at ${timeText(new Date(t.pinAt!))}`),
    announcements: p.announcements.map((a) => {
      const l = announcementLabel(a, lk)
      const what = l?.title ?? (a.source === 'stinger' ? `Stinger #${a.mediaId}` : `Upload #${a.audioId}`)
      return a.mode === 'at' ? `${what}: at ${timeText(new Date(a.at!))}` : `${what}: every ${a.everyMin} min, ${timeText(new Date(a.from!))} – ${timeText(new Date(a.until!))}`
    }),
  }
}

// ------------------------------------------------------------ reads -----

function checkWindow(from: string, to: string): { from: Date; to: Date } {
  const f = new Date(from)
  const t = new Date(to)
  if (t.getTime() - f.getTime() > CALENDAR_MAX_WINDOW_DAYS * DAY) throw badRequest('bad_range')
  return { from: f, to: t }
}

/** Calendar JSON: pending + public statuses, projected per viewer. */
export async function calendar(db: DB, actor: Actor | null, range: { from: string; to: string }, clock?: Clock): Promise<EventView[]> {
  const { from, to } = checkWindow(range.from, range.to)
  const rows = await repo.eventsInRange(db, from, to, CALENDAR_STATUSES)
  return projectAll(db, rows, actor, nowOf(clock))
}

async function projectAll(db: Q, rows: readonly EventRow[], actor: Actor | null, now: number): Promise<EventView[]> {
  const fullRows = rows.filter((r) => seesFull(r, actor))
  const s = await loadEventsSettings(db)
  const extras = fullRows.length ? await repo.loadFullExtras(db, fullRows, s, now) : new Map()
  const out: EventView[] = []
  for (const r of rows) {
    const v = viewEvent(r, actor, () => extras.get(r.id)!)
    if (v) out.push(v)
  }
  return out
}

/** ICS rows: anonymous projections only, 30 days back to 400 days ahead. */
export async function icsViews(db: DB, clock?: Clock) {
  const now = nowOf(clock)
  const rows = await repo.eventsInRange(db, new Date(now - 30 * DAY), new Date(now + CALENDAR_MAX_WINDOW_DAYS * DAY), CALENDAR_STATUSES)
  return rows.map((r) => publicView(r)).filter((v): v is NonNullable<typeof v> => v !== null)
}

export async function getEventView(db: DB, actor: Actor | null, id: number, clock?: Clock): Promise<EventView> {
  const ev = await repo.getEvent(db, id)
  if (!ev) throw notFound()
  const [v] = await projectAll(db, [ev], actor, nowOf(clock))
  if (!v) throw notFound()
  return v
}

/** Busy intervals (+ the gap padding) for the request form's clash check. */
export async function availability(db: DB, range: { from: string; to: string; exclude?: number }) {
  const { from, to } = checkWindow(range.from, range.to)
  const s = await loadEventsSettings(db)
  const pad = s.events_gap_min * MIN
  const rows = await repo.slotRows(db, new Date(from.getTime() - pad), new Date(to.getTime() + pad), SLOT_HOLDING_STATUSES)
  const out: { startsAt: string; endsAt: string; kind: 'event' | 'gap' }[] = []
  for (const r of rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    if (r.id === range.exclude) continue
    const st = r.startsAt.getTime()
    const en = r.endsAt.getTime()
    if (pad > 0) out.push({ startsAt: new Date(st - pad).toISOString(), endsAt: r.startsAt.toISOString(), kind: 'gap' })
    out.push({ startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), kind: 'event' })
    if (pad > 0) out.push({ startsAt: r.endsAt.toISOString(), endsAt: new Date(en + pad).toISOString(), kind: 'gap' })
  }
  return out
}

export async function myEvents(db: DB, actor: Actor, clock?: Clock): Promise<FullEventView[]> {
  const rows = await repo.eventsOfOwner(db, actor.userId)
  const s = await loadEventsSettings(db)
  const now = nowOf(clock)
  const extras = await repo.loadFullExtras(db, rows, s, now)
  return rows.map((r) => fullView(r, actor, extras.get(r.id)!))
}

export async function staffQueue(db: DB, actor: Actor, clock?: Clock) {
  if (!actor.staff) throw forbidden()
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  const pending = await repo.eventsByStatus(db, ['pending'], new Date(now))
  const upcoming = await repo.eventsByStatus(db, ['approved', 'built', 'live'], new Date(now))
  const extras = await repo.loadFullExtras(db, [...pending, ...upcoming], s, now)
  return {
    pending: pending.map((r) => fullView(r, actor, extras.get(r.id)!)),
    upcoming: upcoming.map((r) => fullView(r, actor, extras.get(r.id)!)),
  }
}

// ------------------------------------------------------------ create ----

// A public title becomes the main playlist's name on the Events station. A
// title shaped like the internal helper playlists (`EVT<id> s<n>` /
// `EVT<id> a<n>`, any case or separator, with or without '~') is refused, so
// a main playlist can never pass for — or be hidden like — a helper.
function assertTitleAllowed(title: string | undefined): void {
  if (title !== undefined && isReservedPlaylistName(title)) throw badRequest('title_reserved')
}

export async function createEvent(db: DB, actor: Actor, input: CreateEventRequest, clock?: Clock): Promise<FullEventView> {
  assertTitleAllowed(input.title)
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  if (!s.events_enabled && !actor.staff) throw forbidden('events_disabled')
  const w = { startsAt: Date.parse(input.startsAt), endsAt: Date.parse(input.endsAt) }
  const { shortNotice } = checkTiming(w, actor, s, now)
  return db.transaction(async (tx) => {
    if (!actor.staff) {
      const n = await repo.countCreatedSince(tx, actor.userId, new Date(now - DAY))
      if (n >= s.events_member_daily_creates) throw new HttpError(429, 'daily_cap', { limit: s.events_member_daily_creates })
    }
    const { adjacent } = await slotCheck(tx, w, s, actor)
    const [row] = await tx
      .insert(events)
      .values({
        ownerUserId: actor.userId,
        ownerDiscordId: actor.discordId,
        title: input.title,
        hostName: input.hostName,
        description: input.description,
        location: input.location,
        eventType: input.eventType,
        startsAt: new Date(w.startsAt),
        endsAt: new Date(w.endsAt),
        enteredTz: input.enteredTz,
        visibility: input.visibility,
        playlistOrder: input.playlistOrder,
        status: 'draft',
        shortNotice,
      })
      .returning()
    await auditEv(tx, actor, 'events.event.create', row!.id, { startsAt: input.startsAt, endsAt: input.endsAt, visibility: input.visibility, adjacent })
    return fullOf(tx, row!, actor, s, now)
  })
}

export async function staffBook(db: DB, actor: Actor, input: StaffBookRequest, clock?: Clock): Promise<FullEventView> {
  if (!actor.staff) throw forbidden()
  assertTitleAllowed(input.title)
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  const w = { startsAt: Date.parse(input.startsAt), endsAt: Date.parse(input.endsAt) }
  const { shortNotice } = checkTiming(w, actor, s, now)
  const owner = input.ownerDiscordId ? await repo.userByDiscordId(db, input.ownerDiscordId) : { id: actor.userId, discordId: actor.discordId }
  if (!owner) throw badRequest('unknown_member')
  return db.transaction(async (tx) => {
    const { adjacent } = await slotCheck(tx, w, s, actor)
    const at = new Date(now)
    const [row] = await tx
      .insert(events)
      .values({
        ownerUserId: owner.id,
        ownerDiscordId: owner.discordId,
        title: input.title,
        hostName: input.hostName,
        description: input.description,
        location: input.location,
        eventType: input.eventType,
        startsAt: new Date(w.startsAt),
        endsAt: new Date(w.endsAt),
        enteredTz: input.enteredTz,
        visibility: input.visibility,
        playlistOrder: input.playlistOrder,
        status: 'approved',
        shortNotice,
        createdByStaff: true,
        decidedAt: at,
        decidedBy: actor.discordId,
        // submitted_at marks "a ticket was requested" (ticket posts wait for it).
        submittedAt: input.openTicket ? at : null,
      })
      .returning()
    // No build yet: a booking has no songs. A staff playlist save enqueues it.
    if (input.openTicket) await enqueueEventJob(tx, 'ticket_open', { eventId: row!.id })
    await auditEv(tx, actor, 'events.event.book', row!.id, { ownerDiscordId: owner.discordId, openTicket: input.openTicket, adjacent })
    return fullOf(tx, row!, actor, s, now)
  })
}

// ------------------------------------------------------------ edits -----

const LIVE_OK_WITHOUT_RESTART = new Set(['title', 'hostName', 'description', 'location', 'eventType', 'visibility'])

/**
 * Jobs after a content edit (version already bumped): the ticket diff, and
 * what the station needs when the edit goes straight to it (a staff edit of
 * an approved/built/live event, or a member details-only edit):
 *   - `buildRelevant` (the build-input key changed: contract/build-key.ts):
 *     a build when events_autobuild_enabled, otherwise a rebuild_needed job
 *     (the worker alerts staff + notes the ticket: "press Build now");
 *   - details only: nothing — the applied build stays current (the kicks
 *     compare build inputs, not versions); an approved event not built yet
 *     re-queues its build for the new version (autobuild on).
 */
function editJobs(before: EventRow, after: EventRow, actor: Actor, s: EventsSettings, diff: string[], reapproval: boolean, buildable: boolean, buildRelevant: boolean): PlannedJob[] {
  const out: PlannedJob[] = []
  if (before.status !== 'draft' && hasTicket(before) && diff.length) {
    out.push({ kind: 'ticket_post', payload: { eventId: after.id, kind: 'edited', body: editedBody(diff, { byStaff: actor.staff, reapproval }), idem: `edited:${after.id}:${after.version}` } })
  }
  // Back to review: take the approved build off the station until staff
  // approve again (its playlists would otherwise stay enabled).
  if (reapproval) out.push({ kind: 'teardown', payload: { eventId: after.id }, dedupeExtra: `v${after.version}:reapproval` })
  if (!reapproval && buildable && MAY_BE_BUILT.includes(after.status as EventStatus)) {
    if (s.events_autobuild_enabled) {
      if (buildRelevant || after.status === 'approved') out.push({ kind: 'build', payload: { eventId: after.id, version: after.version } })
    } else if (buildRelevant) {
      out.push({ kind: 'rebuild_needed', payload: { eventId: after.id, version: after.version } })
    }
  }
  return out
}

type KeyEvent = Pick<EventRow, 'title' | 'visibility' | 'startsAt' | 'endsAt' | 'playlistOrder'>
const inputKey = (ev: KeyEvent, p: { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }) => buildInputKey(ev, p.tracks, p.announcements)

export async function patchEvent(db: DB, actor: Actor, id: number, input: PatchEventRequest, clock?: Clock): Promise<FullEventView> {
  assertTitleAllowed(input.title)
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  return db.transaction(async (tx) => {
    const ev = await loadOwned(tx, actor, id, true)
    checkVersion(ev, input.version)
    assertEditable(core(ev), actor, s, now)
    const patch: Partial<DetailFields> = {}
    for (const k of ['title', 'hostName', 'description', 'location', 'eventType', 'visibility', 'playlistOrder'] as const) {
      if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k]
    }
    if (input.startsAt !== undefined) patch.startsAt = new Date(input.startsAt)
    if (input.endsAt !== undefined) patch.endsAt = new Date(input.endsAt)
    const changed = changedFields({ ...ev, visibility: ev.visibility as Visibility, playlistOrder: ev.playlistOrder as PlaylistOrder }, patch)
    if (changed.length === 0 && input.enteredTz === undefined) return fullOf(tx, ev, actor, s, now)
    const startsAt = patch.startsAt ?? ev.startsAt
    const endsAt = patch.endsAt ?? ev.endsAt
    const timeChanged = changed.includes('startsAt') || changed.includes('endsAt')
    if (ev.status === 'live' && changed.some((k) => !LIVE_OK_WITHOUT_RESTART.has(k)) && input.confirmRestart !== true) throw clash('restart_required')

    let shortNotice = ev.shortNotice
    let adjacent: number[] = []
    const tracks = (await repo.tracksOf(tx, [ev.id])).get(ev.id) ?? []
    const anns = (await repo.announcementsOf(tx, [ev.id])).get(ev.id) ?? []
    const lookup = await repo.loadLookup(tx, repo.lookupIds([{ tracks, announcements: anns }]))
    if (timeChanged) {
      ;({ shortNotice } = checkTiming({ startsAt: startsAt.getTime(), endsAt: endsAt.getTime() }, actor, s, now))
      ;({ adjacent } = await slotCheck(tx, { id: ev.id, startsAt: startsAt.getTime(), endsAt: endsAt.getTime() }, s, actor))
      // Existing pins / announcements must still fit the new window.
      // A draft's timing rules wait for submit (0.5.3 autosave).
      validatePlaylist({ startsAt, endsAt, ownerUserId: ev.ownerUserId }, { tracks, announcements: anns }, lookup, s, actor, { structuralOnly: ev.status === 'draft' })
    }
    const reapproval = !actor.staff && (ev.status === 'approved' || ev.status === 'built') && needsReapproval(changed, false)
    const after = await writeEvent(tx, ev, {
      ...patch,
      ...(input.enteredTz !== undefined ? { enteredTz: input.enteredTz } : {}),
      shortNotice,
      version: ev.version + 1,
      ...(reapproval ? { status: 'pending' } : {}),
    })
    const p = { tracks, announcements: anns }
    const diff = diffLines(displaySide(ev, p, lookup), displaySide(after, p, lookup))
    await enqueueAll(tx, editJobs(ev, after, actor, s, diff, reapproval, true, inputKey(ev, p) !== inputKey(after, p)))
    await auditEv(tx, actor, 'events.event.edit', ev.id, { changed, reapproval, fromVersion: ev.version, adjacent, ...(ev.status === 'live' ? { liveRestart: input.confirmRestart === true } : {}) })
    return fullOf(tx, after, actor, s, now)
  })
}

/** Pins and announcements are schedule rows (a restart); unpinned songs are membership only. */
function scheduleKey(p: { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }): string {
  return playlistKey({ tracks: p.tracks.filter((t) => t.pinAt !== null).map((t) => ({ ...t, position: 0 })), announcements: p.announcements, playlistOrder: 'shuffle' })
}

export async function putPlaylist(db: DB, actor: Actor, id: number, input: PutPlaylistRequest, clock?: Clock): Promise<FullEventView> {
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  const next = {
    tracks: [...input.tracks].sort((a, b) => a.position - b.position).map(({ label: _l, ...t }) => t),
    announcements: input.announcements.map(({ label: _l, id: _id, ...a }) => a),
  }
  return db.transaction(async (tx) => {
    const ev = await loadOwned(tx, actor, id, true)
    checkVersion(ev, input.version)
    assertEditable(core(ev), actor, s, now)
    const prev = {
      tracks: (await repo.tracksOf(tx, [ev.id])).get(ev.id) ?? [],
      announcements: (await repo.announcementsOf(tx, [ev.id])).get(ev.id) ?? [],
    }
    const same = playlistKey({ ...prev, playlistOrder: ev.playlistOrder as PlaylistOrder }) === playlistKey({ ...next, playlistOrder: input.playlistOrder })
    if (same) return fullOf(tx, ev, actor, s, now)
    if (ev.status === 'live' && scheduleKey(prev) !== scheduleKey(next) && input.confirmRestart !== true) throw clash('restart_required')
    const lookup = await repo.loadLookup(tx, repo.lookupIds([prev, next]))
    // A DRAFT stores any structurally valid playlist (the autosave keeps
    // everything the member added); submit runs the full timing check.
    const { rows } = validatePlaylist({ startsAt: ev.startsAt, endsAt: ev.endsAt, ownerUserId: ev.ownerUserId }, next, lookup, s, actor, { structuralOnly: ev.status === 'draft' })
    await repo.replacePlaylist(tx, ev.id, next.tracks, next.announcements)
    if (ev.status !== 'draft') await repo.markAudioUsed(tx, repo.audioIdsOf(next))
    const reapproval = !actor.staff && (ev.status === 'approved' || ev.status === 'built')
    const after = await writeEvent(tx, ev, { playlistOrder: input.playlistOrder, version: ev.version + 1, ...(reapproval ? { status: 'pending' } : {}) })
    const diff = diffLines(displaySide(ev, prev, lookup), displaySide(after, next, lookup))
    // A member's playlist change always needs re-approval; staff edits build.
    await enqueueAll(tx, editJobs(ev, after, actor, s, diff, reapproval, actor.staff && next.tracks.some((t) => t.pinAt === null), inputKey(ev, prev) !== inputKey(after, next)))
    await auditEv(tx, actor, 'events.playlist.save', ev.id, {
      tracks: next.tracks.length,
      announcements: next.announcements.length,
      rows,
      reapproval,
      fromVersion: ev.version,
      ...(ev.status === 'live' ? { liveRestart: input.confirmRestart === true } : {}),
    })
    return fullOf(tx, after, actor, s, now)
  })
}

// ------------------------------------------------------------ transitions

export async function transition(db: DB, actor: Actor, id: number, action: Action, opts: { reason?: string } = {}, clock?: Clock): Promise<FullEventView> {
  const now = nowOf(clock)
  const s = await loadEventsSettings(db)
  return db.transaction(async (tx) => {
    const ev = await loadOwned(tx, actor, id, true)
    const to = nextStatus(action, { ownerUserId: ev.ownerUserId, status: ev.status as EventStatus }, actor)
    const set: Partial<typeof events.$inferInsert> = { status: to }
    const detail: Record<string, unknown> = { from: ev.status, to, version: ev.version }

    if (action === 'submit') {
      if (!s.events_enabled && !actor.staff) throw forbidden('events_disabled')
      const w = { id: ev.id, startsAt: ev.startsAt.getTime(), endsAt: ev.endsAt.getTime() }
      const { shortNotice } = checkTiming(w, actor, s, now)
      const tracks = (await repo.tracksOf(tx, [ev.id])).get(ev.id) ?? []
      const anns = (await repo.announcementsOf(tx, [ev.id])).get(ev.id) ?? []
      assertSubmittable({ tracks, announcements: anns })
      const lookup = await repo.loadLookup(tx, repo.lookupIds([{ tracks, announcements: anns }]))
      validatePlaylist({ startsAt: ev.startsAt, endsAt: ev.endsAt, ownerUserId: ev.ownerUserId }, { tracks, announcements: anns }, lookup, s, actor)
      if (!actor.staff) {
        if ((await repo.countOwner(tx, ev.ownerUserId, ['pending'])) >= s.events_member_max_pending) throw clash('max_pending', { limit: s.events_member_max_pending })
        if ((await repo.countOwner(tx, ev.ownerUserId, ['approved', 'built', 'live'], new Date(now))) >= s.events_member_max_upcoming) {
          throw clash('max_upcoming', { limit: s.events_member_max_upcoming })
        }
      }
      detail.adjacent = (await slotCheck(tx, w, s, actor)).adjacent
      await repo.markAudioUsed(tx, repo.audioIdsOf({ tracks, announcements: anns }))
      Object.assign(set, { submittedAt: new Date(now), shortNotice })
    } else if (action === 'approve') {
      if (ev.endsAt.getTime() <= now) throw clash('not_editable')
      detail.adjacent = (await slotCheck(tx, { id: ev.id, startsAt: ev.startsAt.getTime(), endsAt: ev.endsAt.getTime() }, s, actor)).adjacent
      Object.assign(set, { decidedAt: new Date(now), decidedBy: actor.discordId, denyReason: null })
      detail.autobuild = s.events_autobuild_enabled
    } else if (action === 'deny' || action === 'cancel') {
      if (!opts.reason) throw bad('reason_required')
      Object.assign(set, { decidedAt: new Date(now), decidedBy: actor.discordId, denyReason: opts.reason })
      detail.reason = opts.reason
    }
    const after = await writeEvent(tx, ev, set)
    await enqueueAll(tx, jobsFor(action, ev, { autobuild: s.events_autobuild_enabled, hasTicket: hasTicket(after), mayBeBuilt: mayBeBuilt(ev), reason: opts.reason }))
    await auditEv(tx, actor, `events.event.${action}`, ev.id, detail)
    return fullOf(tx, after, actor, s, now)
  })
}

/** Staff "build this event now" (manage): bypasses the autobuild flag for this id. */
export async function buildNow(db: DB, actor: Actor, id: number, clock?: Clock): Promise<{ queued: boolean }> {
  if (!actor.manage) throw forbidden()
  const now = nowOf(clock)
  return db.transaction(async (tx) => {
    const ev = await loadOwned(tx, actor, id, true)
    // `failed` = rolled back by a start kick (0.5.2): Build now is how staff
    // put it back on air (the worker re-arms exactly one start kick).
    if (!(MAY_BE_BUILT.includes(ev.status as EventStatus) || ev.status === 'failed') || ev.endsAt.getTime() <= now) throw clash('not_editable')
    // Permanent dedupe keys: one per version per minute (a second press in
    // the same minute is a no-op; a later press can retry).
    await enqueueEventJob(tx, 'build_now', { eventId: ev.id }, { dedupeExtra: `v${ev.version}:${Math.floor(now / MIN)}` })
    await auditEv(tx, actor, 'events.event.build_now', ev.id, { version: ev.version })
    return { queued: true }
  })
}
