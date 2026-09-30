// Events DB access for events-web (Drizzle). Thin: queries and row mapping
// only; every decision lives in rules.ts / state.ts / service.ts.

import { and, asc, desc, eq, gt, gte, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import type { DB } from '../../server/db/client'
import { archive, auditLog, eventAnnouncements, eventAudio, eventBuilds, events, eventStingers, eventTracks, libraryCache, users } from '../../server/db/schema'
import { escapeLike } from '../../server/ui/library'
import { isLibraryFile } from '../contract/paths'
import { RECENT_SAVE_IDS } from '../contract/rules'
import type { EventsSettings } from '../contract/settings'
import type { AudioKind, AudioStatus, EventAnnouncement, EventStatus, EventTrack, EveryMin } from '../contract/types'
import type { AudioInfo, LibraryInfo, Lookup, SlotRow, StingerInfo } from './rules'
import type { EventRecord, FullExtras } from './view'

export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0]
export type Q = DB | Tx

export type EventRow = typeof events.$inferSelect

// ------------------------------------------------------------ events ----

export async function getEvent(q: Q, id: number, lock = false): Promise<EventRow | null> {
  const base = q.select().from(events).where(eq(events.id, id))
  const rows = lock ? await base.for('update') : await base
  return rows[0] ?? null
}

/** Audit actions that record a client `saveId` (service.ts patchEvent / putPlaylist). */
export const SAVE_AUDIT_ACTIONS = ['events.event.edit', 'events.playlist.save'] as const

/** The latest recorded client save ids of an event, newest first (audit_log detail.saveId). */
export async function recentSaveIds(q: Q, id: number, limit = RECENT_SAVE_IDS): Promise<string[]> {
  const rows = await q
    .select({ saveId: sql<string | null>`${auditLog.detail} ->> 'saveId'` })
    .from(auditLog)
    .where(and(eq(auditLog.targetType, 'event'), eq(auditLog.targetId, String(id)), inArray(auditLog.action, [...SAVE_AUDIT_ACTIONS]), sql`(${auditLog.detail} ->> 'saveId') IS NOT NULL`))
    .orderBy(desc(auditLog.id))
    .limit(limit)
  return rows.map((r) => r.saveId).filter((x): x is string => typeof x === 'string')
}

/** Events with the given statuses overlapping [from, to). */
export async function eventsInRange(q: Q, from: Date, to: Date, statuses: readonly EventStatus[], limit = 2000): Promise<EventRow[]> {
  return q
    .select()
    .from(events)
    .where(and(inArray(events.status, [...statuses]), lt(events.startsAt, to), gt(events.endsAt, from)))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(limit)
}

export async function slotRows(q: Q, from: Date, to: Date, statuses: readonly EventStatus[]): Promise<SlotRow[]> {
  const rows = await q
    .select({ id: events.id, startsAt: events.startsAt, endsAt: events.endsAt, status: events.status })
    .from(events)
    .where(and(inArray(events.status, [...statuses]), lt(events.startsAt, to), gt(events.endsAt, from)))
  return rows.map((r) => ({ ...r, status: r.status as EventStatus }))
}

export async function eventsOfOwner(q: Q, userId: string, limit = 300): Promise<EventRow[]> {
  return q.select().from(events).where(eq(events.ownerUserId, userId)).orderBy(desc(events.startsAt), desc(events.id)).limit(limit)
}

export async function eventsByStatus(q: Q, statuses: readonly EventStatus[], endsAfter: Date, limit = 300): Promise<EventRow[]> {
  return q
    .select()
    .from(events)
    .where(and(inArray(events.status, [...statuses]), gt(events.endsAt, endsAfter)))
    .orderBy(asc(events.startsAt), asc(events.id))
    .limit(limit)
}

export async function countOwner(q: Q, userId: string, statuses: readonly EventStatus[], endsAfter?: Date): Promise<number> {
  const [r] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.ownerUserId, userId), inArray(events.status, [...statuses]), endsAfter ? gt(events.endsAt, endsAfter) : undefined))
  return Number(r?.n ?? 0)
}

export async function countCreatedSince(q: Q, userId: string, since: Date): Promise<number> {
  const [r] = await q
    .select({ n: sql<number>`count(*)::int` })
    .from(events)
    .where(and(eq(events.ownerUserId, userId), gte(events.createdAt, since), eq(events.createdByStaff, false)))
  return Number(r?.n ?? 0)
}

/** Serializes every slot decision (create / time edit / submit / approve / book). */
export async function lockSlots(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('efm-events:slots'))`)
}

/** Serializes one member's audio attaches (the My audio cap). */
export async function lockUserAudio(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'efm-events:audio:' + userId}))`)
}

// ------------------------------------------------------------ playlist --

export async function tracksOf(q: Q, ids: readonly number[]): Promise<Map<number, EventTrack[]>> {
  const out = new Map<number, EventTrack[]>()
  if (ids.length === 0) return out
  const rows = await q.select().from(eventTracks).where(inArray(eventTracks.eventId, [...ids])).orderBy(asc(eventTracks.eventId), asc(eventTracks.position))
  for (const r of rows) {
    const list = out.get(r.eventId) ?? []
    list.push({ position: r.position, source: r.source as EventTrack['source'], mediaId: r.mediaId, audioId: r.audioId, pinAt: r.pinAt ? r.pinAt.toISOString() : null })
    out.set(r.eventId, list)
  }
  return out
}

export async function announcementsOf(q: Q, ids: readonly number[]): Promise<Map<number, EventAnnouncement[]>> {
  const out = new Map<number, EventAnnouncement[]>()
  if (ids.length === 0) return out
  const rows = await q.select().from(eventAnnouncements).where(inArray(eventAnnouncements.eventId, [...ids])).orderBy(asc(eventAnnouncements.eventId), asc(eventAnnouncements.id))
  for (const r of rows) {
    const list = out.get(r.eventId) ?? []
    list.push({
      id: r.id,
      source: r.source as EventAnnouncement['source'],
      mediaId: r.mediaId,
      audioId: r.audioId,
      mode: r.mode as EventAnnouncement['mode'],
      at: r.at ? r.at.toISOString() : null,
      everyMin: (r.everyMin as EveryMin | null) ?? null,
      from: r.fromAt ? r.fromAt.toISOString() : null,
      until: r.untilAt ? r.untilAt.toISOString() : null,
    })
    out.set(r.eventId, list)
  }
  return out
}

export async function replacePlaylist(tx: Tx, eventId: number, tracks: readonly EventTrack[], anns: readonly EventAnnouncement[]): Promise<void> {
  await tx.delete(eventTracks).where(eq(eventTracks.eventId, eventId))
  await tx.delete(eventAnnouncements).where(eq(eventAnnouncements.eventId, eventId))
  if (tracks.length) {
    await tx.insert(eventTracks).values(
      tracks.map((t) => ({ eventId, position: t.position, source: t.source, mediaId: t.mediaId, audioId: t.audioId, pinAt: t.pinAt ? new Date(t.pinAt) : null })),
    )
  }
  if (anns.length) {
    await tx.insert(eventAnnouncements).values(
      anns.map((a) => ({
        eventId,
        source: a.source,
        mediaId: a.mediaId,
        audioId: a.audioId,
        mode: a.mode,
        at: a.at ? new Date(a.at) : null,
        everyMin: a.everyMin,
        fromAt: a.from ? new Date(a.from) : null,
        untilAt: a.until ? new Date(a.until) : null,
      })),
    )
  }
}

/** Custom audio attached to a submitted event is no longer "unused" (audio_expire). */
export async function markAudioUsed(tx: Tx, audioIds: readonly number[]): Promise<void> {
  if (audioIds.length === 0) return
  await tx
    .update(eventAudio)
    .set({ usedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(eventAudio.id, [...audioIds]), isNull(eventAudio.usedAt)))
}

export function audioIdsOf(p: { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }): number[] {
  const ids = new Set<number>()
  for (const t of p.tracks) if (t.audioId !== null) ids.add(t.audioId)
  for (const a of p.announcements) if (a.audioId !== null) ids.add(a.audioId)
  return [...ids]
}

// ------------------------------------------------------------ lookups ---

/** Open archive rows (archiving / archived / restoring) mean "not in the library". */
async function archivedIds(q: Q, mediaIds: readonly number[]): Promise<Set<number>> {
  if (mediaIds.length === 0) return new Set()
  const rows = await q
    .select({ mediaId: archive.mediaId })
    .from(archive)
    .where(and(inArray(archive.mediaId, [...mediaIds]), inArray(archive.status, ['archiving', 'archived', 'restoring'])))
  return new Set(rows.map((r) => r.mediaId))
}

export async function loadLookup(
  q: Q,
  ids: { library: Iterable<number>; stingers: Iterable<number>; audio: Iterable<number> },
): Promise<Lookup> {
  const lib = [...new Set(ids.library)]
  const st = [...new Set(ids.stingers)]
  const au = [...new Set(ids.audio)]
  const library = new Map<number, LibraryInfo>()
  const stingers = new Map<number, StingerInfo>()
  const audio = new Map<number, AudioInfo>()
  if (lib.length) {
    const arch = await archivedIds(q, lib)
    const rows = await q
      .select({ mediaId: libraryCache.mediaId, path: libraryCache.path, title: libraryCache.title, artist: libraryCache.artist, lengthS: libraryCache.lengthS })
      .from(libraryCache)
      .where(inArray(libraryCache.mediaId, lib))
    for (const r of rows) library.set(r.mediaId, { ...r, archived: arch.has(r.mediaId) })
  }
  if (st.length) {
    const rows = await q.select({ mediaId: eventStingers.mediaId, title: eventStingers.title, lengthS: eventStingers.lengthS }).from(eventStingers).where(inArray(eventStingers.mediaId, st))
    for (const r of rows) stingers.set(r.mediaId, r)
  }
  if (au.length) {
    const rows = await q
      .select({
        id: eventAudio.id,
        ownerUserId: eventAudio.ownerUserId,
        kind: eventAudio.kind,
        status: eventAudio.status,
        deletedAt: eventAudio.deletedAt,
        title: eventAudio.title,
        artist: eventAudio.artist,
        durationS: eventAudio.durationS,
      })
      .from(eventAudio)
      .where(inArray(eventAudio.id, au))
    for (const r of rows) audio.set(r.id, { ...r, kind: r.kind as AudioKind, status: r.status as AudioStatus })
  }
  return { library, stingers, audio }
}

export function lookupIds(lists: readonly { tracks: readonly EventTrack[]; announcements: readonly EventAnnouncement[] }[]) {
  const library: number[] = []
  const stingers: number[] = []
  const audio: number[] = []
  for (const p of lists) {
    for (const t of p.tracks) {
      if (t.mediaId !== null) library.push(t.mediaId)
      if (t.audioId !== null) audio.push(t.audioId)
    }
    for (const a of p.announcements) {
      if (a.mediaId !== null) stingers.push(a.mediaId)
      if (a.audioId !== null) audio.push(a.audioId)
    }
  }
  return { library, stingers, audio }
}

async function latestBuildStatus(q: Q, ids: readonly number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (ids.length === 0) return out
  const rows = await q
    .select({ eventId: eventBuilds.eventId, status: eventBuilds.status })
    .from(eventBuilds)
    .where(inArray(eventBuilds.eventId, [...ids]))
    .orderBy(asc(eventBuilds.eventId), desc(eventBuilds.id))
  for (const r of rows) if (!out.has(r.eventId)) out.set(r.eventId, r.status)
  return out
}

/** The latest applied build per event: version + the plan's build-input key. */
async function latestAppliedBuilds(q: Q, ids: readonly number[]): Promise<Map<number, { version: number; inputKey: string | null }>> {
  const out = new Map<number, { version: number; inputKey: string | null }>()
  if (ids.length === 0) return out
  const rows = await q
    .select({ eventId: eventBuilds.eventId, version: eventBuilds.version, inputKey: sql<string | null>`${eventBuilds.plan}->>'inputKey'` })
    .from(eventBuilds)
    .where(and(inArray(eventBuilds.eventId, [...ids]), eq(eventBuilds.status, 'applied')))
    .orderBy(asc(eventBuilds.eventId), desc(eventBuilds.id))
  for (const r of rows) if (!out.has(r.eventId)) out.set(r.eventId, { version: r.version, inputKey: typeof r.inputKey === 'string' ? r.inputKey : null })
  return out
}

async function userNames(q: Q, userIds: readonly string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  if (userIds.length === 0) return out
  const rows = await q.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(userIds)]))
  for (const r of rows) out.set(r.id, r.name)
  return out
}

/** Everything the full projection needs, for a batch of events. */
export async function loadFullExtras(q: Q, rows: readonly EventRow[], settings: EventsSettings, now: number): Promise<Map<number, FullExtras>> {
  const ids = rows.map((r) => r.id)
  const [tracks, anns, builds, applied, names] = await Promise.all([
    tracksOf(q, ids),
    announcementsOf(q, ids),
    latestBuildStatus(q, ids),
    latestAppliedBuilds(q, ids),
    userNames(q, rows.map((r) => r.ownerUserId)),
  ])
  const lists = ids.map((id) => ({ tracks: tracks.get(id) ?? [], announcements: anns.get(id) ?? [] }))
  const lookup = await loadLookup(q, lookupIds(lists))
  const out = new Map<number, FullExtras>()
  rows.forEach((r, i) => {
    out.set(r.id, {
      tracks: lists[i]!.tracks,
      announcements: lists[i]!.announcements,
      lookup,
      buildStatus: builds.get(r.id) ?? null,
      appliedBuild: applied.get(r.id) ?? null,
      ownerName: names.get(r.ownerUserId) ?? null,
      settings,
      now,
    })
  })
  return out
}

export const asRecord = (r: EventRow): EventRecord => r

// ------------------------------------------------------------ library ---

export type LibrarySearchRow = { mediaId: number; title: string; artist: string | null; lengthS: number | null; artUrl: string | null }

/** Library search: Music/Artists/<a>/<file> only, not archived. */
export async function searchLibrary(q: Q, text: string, limit = 50): Promise<LibrarySearchRow[]> {
  const pat = `%${escapeLike(text)}%`
  const rows = await q
    .select({ mediaId: libraryCache.mediaId, path: libraryCache.path, title: libraryCache.title, artist: libraryCache.artist, lengthS: libraryCache.lengthS, artUrl: libraryCache.artUrl })
    .from(libraryCache)
    .where(
      and(
        sql`${libraryCache.path} LIKE 'Music/Artists/%/%' AND ${libraryCache.path} NOT LIKE 'Music/Artists/%/%/%'`,
        or(ilike(libraryCache.title, pat), ilike(libraryCache.artist, pat)),
        sql`NOT EXISTS (SELECT 1 FROM ${archive} a WHERE a.media_id = ${libraryCache.mediaId} AND a.status IN ('archiving', 'archived', 'restoring'))`,
      ),
    )
    .orderBy(asc(libraryCache.artist), asc(libraryCache.title))
    .limit(limit)
  return rows
    .filter((r) => isLibraryFile(r.path))
    .map((r) => ({ mediaId: r.mediaId, title: r.title ?? 'Untitled', artist: r.artist, lengthS: r.lengthS, artUrl: r.artUrl }))
}

export async function listStingers(q: Q) {
  return q.select({ mediaId: eventStingers.mediaId, path: eventStingers.path, title: eventStingers.title, lengthS: eventStingers.lengthS }).from(eventStingers).orderBy(asc(eventStingers.title))
}

export async function userByDiscordId(q: Q, discordId: string) {
  const [r] = await q.select({ id: users.id, discordId: users.discordId, name: users.name }).from(users).where(eq(users.discordId, discordId))
  return r ?? null
}

export async function userById(q: Q, id: string) {
  const [r] = await q.select({ id: users.id, discordId: users.discordId, name: users.name, image: users.image }).from(users).where(eq(users.id, id))
  return r ?? null
}
