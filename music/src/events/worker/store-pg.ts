// Postgres implementation of EventsStore (Drizzle over the contract tables,
// migration 0010). Jobs: event_jobs only; the music `jobs` table is never
// read or written here.

import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm'
import { audit as auditRow } from '../../server/audit'
import type { DB } from '../../server/db/client'
import { loadEventsSettings } from '../../server/admin/events-settings'
import { eventAnnouncements, eventAudio, eventBuilds, eventJobs, eventRegistry, events, eventStingers, eventTracks, libraryCache, uploads } from '../../server/db/schema'
import { PAUSED_SQL } from '../../server/pause'
import { scanOffsetS } from '../../worker/ingest/window'
import { eventJobDedupeKey, parseEventJobPayload, PERIODIC_EVENT_JOB_KINDS, type EventJobKind, type EventJobPayload } from '../contract/jobs'
import type { EventsSettings } from '../contract/settings'
import type { AudioStatus, BuildStatus, EventStatus, RegistryRole } from '../contract/types'
import type { AnnouncementRow, AudioPatch, AudioRow, BuildRow, ClaimedJob, CreateAttemptMarker, EnqueueOpts, EventRow, EventsStore, JobOutcome, RegistryRow, StingerRow, TrackRow } from './store'

const ACTIVE: readonly EventStatus[] = ['approved', 'built', 'live']
export const UPLOAD_ATTEMPT_ACTION = 'events.audio.upload_attempted'
export const START_KICK_ACTION = 'events.kick.start'
export const CREATE_ATTEMPT_ACTION = 'events.registry.create_attempt'

type EventSel = typeof events.$inferSelect

function toEvent(r: EventSel): EventRow {
  return {
    id: r.id,
    ownerUserId: r.ownerUserId,
    ownerDiscordId: r.ownerDiscordId,
    title: r.title,
    eventType: r.eventType,
    visibility: r.visibility as EventRow['visibility'],
    status: r.status as EventStatus,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    playlistOrder: r.playlistOrder as EventRow['playlistOrder'],
    shortNotice: r.shortNotice,
    createdByStaff: r.createdByStaff,
    submittedAt: r.submittedAt,
    ticketId: r.ticketId,
    ticketNumber: r.ticketNumber,
    ticketUrl: r.ticketUrl,
    version: r.version,
  }
}

function toAudio(r: typeof eventAudio.$inferSelect): AudioRow {
  return { ...r, kind: r.kind as AudioRow['kind'], status: r.status as AudioStatus }
}

function toBuild(r: typeof eventBuilds.$inferSelect): BuildRow {
  return { ...r, status: r.status as BuildStatus }
}

function toRegistry(r: typeof eventRegistry.$inferSelect): RegistryRow {
  return { id: r.id, eventId: r.eventId, buildId: r.buildId, role: r.role as RegistryRole, intentName: r.intentName, playlistId: r.playlistId, scheduleIds: r.scheduleIds, deletedAt: r.deletedAt }
}

export class PgEventsStore implements EventsStore {
  constructor(private readonly db: DB) {}

  // ------------------------------------------------------------ jobs ---

  async claimJob(mutatingKinds: readonly string[]): Promise<ClaimedJob | null> {
    await this.db.execute(sql`UPDATE event_jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`)
    const mutating = mutatingKinds.length ? sql.join(mutatingKinds.map((k) => sql`${k}`), sql`, `) : sql`''`
    const rows = await this.db.execute<{ id: number; kind: string; payload: unknown; attempts: number; max_attempts: number; age_s: number }>(sql`
      UPDATE event_jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = (
        SELECT id FROM event_jobs
        WHERE status = 'queued' AND run_after <= now()
          AND NOT (kind IN (${mutating}) AND ${PAUSED_SQL})
        ORDER BY run_after, id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, payload, attempts, max_attempts, (EXTRACT(EPOCH FROM now() - created_at))::int AS age_s`)
    const r = (rows as unknown as { id: number; kind: string; payload: unknown; attempts: number; max_attempts: number; age_s: number }[])[0]
    return r ? { id: Number(r.id), kind: r.kind, payload: r.payload, attempts: r.attempts, maxAttempts: r.max_attempts, ageS: Number(r.age_s) } : null
  }

  async finishJob(id: number, o: JobOutcome): Promise<void> {
    if (o.status === 'done') {
      await this.db.execute(sql`UPDATE event_jobs SET status = 'done', updated_at = now(), last_error = NULL WHERE id = ${id}`)
    } else if (o.status === 'dead') {
      await this.db.execute(sql`UPDATE event_jobs SET status = 'dead', updated_at = now(), last_error = ${o.error.slice(0, 500)} WHERE id = ${id}`)
    } else {
      const delay = Math.max(1, Math.min(86_400, Math.ceil(o.delayS)))
      await this.db.execute(sql`
        UPDATE event_jobs SET status = 'queued', locked_at = NULL, updated_at = now(), last_error = ${o.error.slice(0, 500)},
          attempts = CASE WHEN ${o.refund} THEN GREATEST(attempts - 1, 0) ELSE attempts END,
          run_after = now() + make_interval(secs => ${delay})
        WHERE id = ${id}`)
    }
  }

  async enqueue<K extends EventJobKind>(kind: K, payload: EventJobPayload<K>, opts: EnqueueOpts = {}): Promise<void> {
    const p = parseEventJobPayload(kind, payload)
    const periodic = (PERIODIC_EVENT_JOB_KINDS as readonly string[]).includes(kind)
    const dedupeKey = opts.dedupeKey !== undefined ? opts.dedupeKey : periodic && opts.dedupeExtra === undefined ? null : eventJobDedupeKey(kind, p, opts.dedupeExtra)
    await this.db
      .insert(eventJobs)
      .values({ kind, payload: p as Record<string, unknown>, dedupeKey, runAfter: opts.runAfter ?? sql`now()`, ...(opts.maxAttempts ? { maxAttempts: opts.maxAttempts } : {}) })
      .onConflictDoNothing()
  }

  async wakeEventJobs(eventId: number, kinds: readonly EventJobKind[]): Promise<void> {
    if (kinds.length === 0) return
    await this.db.execute(sql`
      UPDATE event_jobs SET run_after = now(), updated_at = now()
      WHERE status = 'queued' AND kind IN (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)}) AND (payload->>'eventId') = ${String(eventId)}`)
  }

  async hasEventJob(kind: EventJobKind, eventId: number): Promise<boolean> {
    const rows = await this.db.execute(sql`SELECT 1 FROM event_jobs WHERE kind = ${kind} AND (payload->>'eventId') = ${String(eventId)} LIMIT 1`)
    return (rows as unknown as unknown[]).length > 0
  }

  // -------------------------------------------------- settings / pause ---

  async settings(): Promise<EventsSettings> {
    return loadEventsSettings(this.db)
  }

  async queuesPaused(): Promise<boolean> {
    const rows = await this.db.execute(sql`SELECT ${PAUSED_SQL} AS paused`)
    return Boolean((rows as unknown as { paused: boolean }[])[0]?.paused)
  }

  async scanOffsetS(): Promise<number> {
    return scanOffsetS(this.db)
  }

  // ----------------------------------------------------------- events ---

  async getEvent(id: number): Promise<EventRow | null> {
    const r = await this.db.query.events.findFirst({ where: eq(events.id, id) })
    return r ? toEvent(r) : null
  }

  async setEventStatus(id: number, from: readonly EventStatus[], to: EventStatus): Promise<boolean> {
    const rows = await this.db
      .update(events)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(events.id, id), inArray(events.status, [...from])))
      .returning({ id: events.id })
    return rows.length === 1
  }

  async setTicket(id: number, t: { ticketId: number; ticketNumber: number; ticketUrl: string }): Promise<void> {
    await this.db
      .update(events)
      .set({ ticketId: t.ticketId, ticketNumber: t.ticketNumber, ticketUrl: t.ticketUrl, updatedAt: new Date() })
      .where(and(eq(events.id, id), isNull(events.ticketId)))
  }

  async tracks(eventId: number): Promise<TrackRow[]> {
    const rows = await this.db.select().from(eventTracks).where(eq(eventTracks.eventId, eventId)).orderBy(asc(eventTracks.position))
    return rows.map((r) => ({ position: r.position, source: r.source as TrackRow['source'], mediaId: r.mediaId, audioId: r.audioId, pinAt: r.pinAt }))
  }

  async announcements(eventId: number): Promise<AnnouncementRow[]> {
    const rows = await this.db.select().from(eventAnnouncements).where(eq(eventAnnouncements.eventId, eventId)).orderBy(asc(eventAnnouncements.id))
    return rows.map((r) => ({
      id: r.id,
      source: r.source as AnnouncementRow['source'],
      mediaId: r.mediaId,
      audioId: r.audioId,
      mode: r.mode as AnnouncementRow['mode'],
      at: r.at,
      everyMin: r.everyMin,
      fromAt: r.fromAt,
      untilAt: r.untilAt,
    }))
  }

  async eventStartingBetween(eventId: number, fromMs: number, toMs: number): Promise<EventRow | null> {
    const r = await this.db.query.events.findFirst({
      where: and(ne(events.id, eventId), inArray(events.status, ['built', 'live']), gte(events.startsAt, new Date(fromMs)), lt(events.startsAt, new Date(toMs))),
      orderBy: asc(events.startsAt),
    })
    return r ? toEvent(r) : null
  }

  async eventOnAirAt(eventId: number, atMs: number): Promise<EventRow | null> {
    const at = new Date(atMs)
    const r = await this.db.query.events.findFirst({
      where: and(ne(events.id, eventId), inArray(events.status, ['built', 'live']), lte(events.startsAt, at), gt(events.endsAt, at)),
      orderBy: asc(events.startsAt),
    })
    return r ? toEvent(r) : null
  }

  async eventsByStatus(status: EventStatus, limit: number): Promise<EventRow[]> {
    const rows = await this.db.select().from(events).where(eq(events.status, status)).orderBy(asc(events.startsAt)).limit(limit)
    return rows.map(toEvent)
  }

  // ------------------------------------------------------------ audio ---

  async getAudio(id: number): Promise<AudioRow | null> {
    const r = await this.db.query.eventAudio.findFirst({ where: eq(eventAudio.id, id) })
    return r ? toAudio(r) : null
  }

  async audioByStatus(status: AudioStatus, limit: number): Promise<AudioRow[]> {
    const rows = await this.db.select().from(eventAudio).where(and(eq(eventAudio.status, status), isNull(eventAudio.deletedAt))).orderBy(asc(eventAudio.id)).limit(limit)
    return rows.map(toAudio)
  }

  async updateAudio(id: number, patch: AudioPatch, whereStatus?: readonly AudioStatus[]): Promise<boolean> {
    const cond = whereStatus ? and(eq(eventAudio.id, id), inArray(eventAudio.status, [...whereStatus])) : eq(eventAudio.id, id)
    const rows = await this.db
      .update(eventAudio)
      .set({ ...patch, updatedAt: new Date() })
      .where(cond)
      .returning({ id: eventAudio.id })
    return rows.length === 1
  }

  async setUploadLength(uploadId: string, bytes: number): Promise<void> {
    await this.db.update(uploads).set({ length: bytes }).where(and(eq(uploads.id, uploadId), eq(uploads.status, 'attached'), eq(uploads.site, 'events')))
  }

  async expireUpload(uploadId: string): Promise<void> {
    await this.db.update(uploads).set({ status: 'expired' }).where(and(eq(uploads.id, uploadId), eq(uploads.status, 'attached'), eq(uploads.site, 'events')))
  }

  async audioInActiveEvent(audioId: number): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM events e WHERE e.status IN ('approved', 'built', 'live') AND (
        EXISTS (SELECT 1 FROM event_tracks t WHERE t.event_id = e.id AND t.audio_id = ${audioId})
        OR EXISTS (SELECT 1 FROM event_announcements a WHERE a.event_id = e.id AND a.audio_id = ${audioId}))
      LIMIT 1`)
    return (rows as unknown as unknown[]).length > 0
  }

  async unusedAudio(createdBefore: Date, limit: number): Promise<AudioRow[]> {
    const rows = await this.db
      .select()
      .from(eventAudio)
      .where(and(isNull(eventAudio.deletedAt), isNull(eventAudio.usedAt), lt(eventAudio.createdAt, createdBefore)))
      .orderBy(asc(eventAudio.id))
      .limit(limit)
    return rows.map(toAudio)
  }

  async markAudioDeletedIfUnused(id: number, at: Date, reason: string): Promise<boolean> {
    const rows = await this.db
      .update(eventAudio)
      .set({ deletedAt: at, lastError: reason, updatedAt: new Date() })
      .where(and(eq(eventAudio.id, id), isNull(eventAudio.deletedAt), isNull(eventAudio.usedAt)))
      .returning({ id: eventAudio.id })
    return rows.length === 1
  }

  async libraryTagCollision(artist: string, title: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: libraryCache.mediaId })
      .from(libraryCache)
      .where(and(sql`lower(${libraryCache.artist}) = lower(${artist})`, sql`lower(${libraryCache.title}) = lower(${title})`))
      .limit(1)
    return rows.length > 0
  }

  async musicLastUploadAttemptMs(): Promise<number | null> {
    const rows = await this.db.execute<{ t: Date | string | null }>(sql`SELECT max(upload_attempted_at) AS t FROM ingest_runs`)
    const t = (rows as unknown as { t: Date | string | null }[])[0]?.t
    return t ? new Date(t).getTime() : null
  }

  async eventsUploadAttemptsSince(sinceMs: number): Promise<number[]> {
    const rows = await this.db.execute<{ t: Date | string }>(
      sql`SELECT at AS t FROM audit_log WHERE action = ${UPLOAD_ATTEMPT_ACTION} AND at > ${new Date(sinceMs).toISOString()}::timestamptz`,
    )
    return (rows as unknown as { t: Date | string }[]).map((r) => new Date(r.t).getTime())
  }

  async recordUploadAttempt(audioId: number, path: string): Promise<void> {
    await auditRow(this.db, { action: UPLOAD_ATTEMPT_ACTION, targetType: 'event_audio', targetId: audioId, detail: { path } })
  }

  // --------------------------------------------------------- stingers ---

  async stinger(mediaId: number): Promise<StingerRow | null> {
    const r = await this.db.query.eventStingers.findFirst({ where: eq(eventStingers.mediaId, mediaId) })
    return r ? { mediaId: r.mediaId, path: r.path, title: r.title, lengthS: r.lengthS } : null
  }

  async replaceStingers(rows: readonly StingerRow[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      const keep = rows.map((r) => r.mediaId)
      if (keep.length === 0) await tx.delete(eventStingers)
      else await tx.delete(eventStingers).where(sql`${eventStingers.mediaId} NOT IN (${sql.join(keep.map((k) => sql`${k}`), sql`, `)})`)
      for (const r of rows) {
        await tx
          .insert(eventStingers)
          .values({ mediaId: r.mediaId, path: r.path, title: r.title, lengthS: r.lengthS, refreshedAt: new Date() })
          .onConflictDoUpdate({ target: eventStingers.mediaId, set: { path: r.path, title: r.title, lengthS: r.lengthS, refreshedAt: new Date() } })
      }
    })
  }

  // ------------------------------------------------- builds / registry ---

  async buildFor(eventId: number, version: number): Promise<BuildRow | null> {
    const r = await this.db.query.eventBuilds.findFirst({ where: and(eq(eventBuilds.eventId, eventId), eq(eventBuilds.version, version)), orderBy: desc(eventBuilds.id) })
    return r ? toBuild(r) : null
  }

  async getBuild(id: number): Promise<BuildRow | null> {
    const r = await this.db.query.eventBuilds.findFirst({ where: eq(eventBuilds.id, id) })
    return r ? toBuild(r) : null
  }

  async latestAppliedBuild(eventId: number): Promise<BuildRow | null> {
    const r = await this.db.query.eventBuilds.findFirst({ where: and(eq(eventBuilds.eventId, eventId), eq(eventBuilds.status, 'applied')), orderBy: desc(eventBuilds.id) })
    return r ? toBuild(r) : null
  }

  async builds(eventId: number): Promise<BuildRow[]> {
    const rows = await this.db.select().from(eventBuilds).where(eq(eventBuilds.eventId, eventId)).orderBy(asc(eventBuilds.id))
    return rows.map(toBuild)
  }

  async createBuild(eventId: number, version: number, plan: unknown): Promise<BuildRow> {
    const [r] = await this.db.insert(eventBuilds).values({ eventId, version, plan: plan as Record<string, unknown>, status: 'applying' }).returning()
    return toBuild(r!)
  }

  async setBuild(id: number, patch: { status?: BuildStatus; lastError?: string | null; plan?: unknown }): Promise<void> {
    await this.db
      .update(eventBuilds)
      .set({
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.lastError !== undefined ? { lastError: patch.lastError === null ? null : patch.lastError.slice(0, 500) } : {}),
        ...(patch.plan !== undefined ? { plan: patch.plan as Record<string, unknown> } : {}),
        updatedAt: new Date(),
      })
      .where(eq(eventBuilds.id, id))
  }

  async setBuildsStatus(eventId: number, from: readonly BuildStatus[], to: BuildStatus): Promise<void> {
    await this.db
      .update(eventBuilds)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(eventBuilds.eventId, eventId), inArray(eventBuilds.status, [...from])))
  }

  async registry(eventId: number): Promise<RegistryRow[]> {
    const rows = await this.db.select().from(eventRegistry).where(and(eq(eventRegistry.eventId, eventId), isNull(eventRegistry.deletedAt))).orderBy(asc(eventRegistry.id))
    return rows.map(toRegistry)
  }

  async insertIntent(eventId: number, buildId: number, role: RegistryRole, intentName: string): Promise<RegistryRow> {
    const [r] = await this.db.insert(eventRegistry).values({ eventId, buildId, role, intentName }).returning()
    return toRegistry(r!)
  }

  async setRegistryPlaylist(rowId: number, playlistId: number, scheduleIds: number[]): Promise<void> {
    await this.db.update(eventRegistry).set({ playlistId, scheduleIds }).where(eq(eventRegistry.id, rowId))
  }

  async markRegistryDeleted(rowId: number): Promise<void> {
    await this.db.update(eventRegistry).set({ deletedAt: new Date() }).where(and(eq(eventRegistry.id, rowId), isNull(eventRegistry.deletedAt)))
  }

  async everRegisteredPlaylistIds(): Promise<Set<number>> {
    const rows = await this.db.select({ id: eventRegistry.playlistId }).from(eventRegistry).where(isNotNull(eventRegistry.playlistId))
    return new Set(rows.map((r) => r.id!))
  }

  async registryIdsByActivity(): Promise<{ active: Set<number>; inactive: Set<number> }> {
    const rows = await this.db
      .select({ id: eventRegistry.playlistId, status: events.status })
      .from(eventRegistry)
      .innerJoin(events, eq(events.id, eventRegistry.eventId))
      .where(and(isNotNull(eventRegistry.playlistId), isNull(eventRegistry.deletedAt)))
    const active = new Set<number>()
    const inactive = new Set<number>()
    for (const r of rows) ((ACTIVE as readonly string[]).includes(r.status) ? active : inactive).add(r.id!)
    return { active, inactive }
  }

  async withMembershipLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('efm-events-membership'))`)
      return fn()
    })
  }

  async audit(action: string, targetType: string, targetId: number, detail: Record<string, unknown> = {}): Promise<void> {
    await auditRow(this.db, { action, targetType, targetId, detail })
  }

  // The marker is an audit row (append-only: the app role cannot UPDATE or
  // DELETE audit_log), written by the worker only.
  async markCreateAttempt(rowId: number, m: CreateAttemptMarker): Promise<void> {
    await auditRow(this.db, { action: CREATE_ATTEMPT_ACTION, targetType: 'event_registry', targetId: rowId, detail: { eventId: m.eventId, buildId: m.buildId, name: m.name, maxIdBefore: m.maxIdBefore } })
  }

  async createAttempt(rowId: number): Promise<CreateAttemptMarker | null> {
    const rows = await this.db.execute<{ detail: Record<string, unknown> | null }>(
      sql`SELECT detail FROM audit_log WHERE action = ${CREATE_ATTEMPT_ACTION} AND target_type = 'event_registry' AND target_id = ${String(rowId)} ORDER BY id DESC LIMIT 1`,
    )
    const d = (rows as unknown as { detail: Record<string, unknown> | null }[])[0]?.detail
    if (!d) return null
    const n = (x: unknown) => (typeof x === 'number' && Number.isSafeInteger(x) ? x : null)
    const eventId = n(d.eventId)
    const buildId = n(d.buildId)
    const maxIdBefore = n(d.maxIdBefore)
    if (eventId === null || buildId === null || maxIdBefore === null || typeof d.name !== 'string') return null
    return { eventId, buildId, name: d.name, maxIdBefore }
  }

  async lastStartKickMs(eventId: number): Promise<number | null> {
    const rows = await this.db.execute<{ t: Date | string | null }>(
      sql`SELECT max(at) AS t FROM audit_log WHERE action = ${START_KICK_ACTION} AND target_type = 'event' AND target_id = ${String(eventId)}`,
    )
    const t = (rows as unknown as { t: Date | string | null }[])[0]?.t
    return t ? new Date(t).getTime() : null
  }
}
