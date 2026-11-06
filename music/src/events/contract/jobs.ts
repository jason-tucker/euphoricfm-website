// EFM Events Portal — job kinds and payloads (contract "Job kinds").
//
// Jobs live in `event_jobs` (same shape as `jobs`) and are claimed ONLY by
// the events worker. The web enqueues with a payload that must parse here;
// the worker re-parses before acting. Dedupe keys: `kind:eventId:version`
// where a version applies (eventJobDedupeKey).

import { z } from 'zod'

export const EVENT_JOB_KINDS = [
  'ticket_open',
  'ticket_post',
  'ticket_close',
  'audio_collect',
  'audio_finalize',
  'audio_ingest',
  'audio_delete',
  'stinger_sync',
  'build',
  'build_now',
  'verify',
  'start_kick',
  'end_kick',
  'teardown',
  // The off-air purge + restart after an end kick or a teardown, as its own
  // job: the decision to restart is persisted before anything is removed,
  // and the restart has its own (small) attempt budget.
  'off_air_restart',
  // A staff edit changed what the station airs while autobuild is off: the
  // worker alerts staff and notes the ticket if the applied build is stale.
  'rebuild_needed',
  'recheck',
  'pending_expire',
  'pending_reminder',
  'audio_expire',
] as const
export type EventJobKind = (typeof EVENT_JOB_KINDS)[number]

/** Kinds the worker schedules for itself on a timer (no event id). */
export const PERIODIC_EVENT_JOB_KINDS = ['audio_collect', 'stinger_sync', 'pending_expire', 'pending_reminder', 'audio_expire'] as const satisfies readonly EventJobKind[]

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const eventId = id
const version = z.number().int().positive().max(2_147_483_647)

/** What a ticket post says (the tickets thread copy is built from this). */
export const TICKET_POST_KINDS = [
  'submitted',
  'edited',
  'approved',
  'denied',
  'withdrawn',
  'cancelled',
  'expired',
  'reminder',
  'built',
  'on_air',
  'ended',
  'failed',
  'recheck',
  'note',
] as const
export type TicketPostKind = (typeof TICKET_POST_KINDS)[number]

const empty = z.object({}).strict()

export const EVENT_JOB_PAYLOADS = {
  ticket_open: z.object({ eventId }).strict(),
  ticket_post: z
    .object({
      eventId,
      kind: z.enum(TICKET_POST_KINDS),
      body: z.string().min(1).max(4000),
      // Idempotency key, also the job dedupe key (e.g. `approved:<id>:<version>`).
      idem: z.string().min(1).max(200).regex(/^[A-Za-z0-9:_.-]+$/),
    })
    .strict(),
  ticket_close: z.object({ eventId, reason: z.string().min(1).max(200) }).strict(),
  audio_collect: empty,
  audio_finalize: z.object({ audioId: id }).strict(),
  audio_ingest: z.object({ audioId: id }).strict(),
  audio_delete: z.object({ audioId: id }).strict(),
  stinger_sync: empty,
  build: z.object({ eventId, version }).strict(),
  build_now: z.object({ eventId }).strict(),
  verify: z.object({ eventId, buildId: id }).strict(),
  start_kick: z.object({ eventId }).strict(),
  end_kick: z.object({ eventId }).strict(),
  teardown: z.object({ eventId }).strict(),
  off_air_restart: z.object({ eventId, reason: z.enum(['end', 'teardown']) }).strict(),
  rebuild_needed: z.object({ eventId, version }).strict(),
  recheck: z.object({ eventId }).strict(),
  pending_expire: empty,
  pending_reminder: empty,
  audio_expire: empty,
} as const satisfies Record<EventJobKind, z.ZodType>

export type EventJobPayload<K extends EventJobKind> = z.infer<(typeof EVENT_JOB_PAYLOADS)[K]>

export function isEventJobKind(kind: string): kind is EventJobKind {
  return (EVENT_JOB_KINDS as readonly string[]).includes(kind)
}

/** Parse a payload for `kind`; throws a ZodError on mismatch. */
export function parseEventJobPayload<K extends EventJobKind>(kind: K, payload: unknown): EventJobPayload<K> {
  return EVENT_JOB_PAYLOADS[kind].parse(payload) as EventJobPayload<K>
}

/**
 * Dedupe key: `kind:eventId[:version]` for event jobs, `kind:a<audioId>` for
 * audio jobs, `ticket_post:<idem>` for posts, and `kind:<bucket>` for the
 * periodic sweeps (the caller passes the time bucket, e.g. an ISO hour).
 */
export function eventJobDedupeKey<K extends EventJobKind>(kind: K, payload: EventJobPayload<K>, extra?: string | number): string {
  const p = payload as Record<string, unknown>
  if (kind === 'ticket_post') return `ticket_post:${String(p.idem)}`
  if (typeof p.eventId === 'number') {
    const v = typeof p.version === 'number' ? p.version : typeof p.buildId === 'number' ? `b${p.buildId}` : extra
    return v === undefined ? `${kind}:${p.eventId}` : `${kind}:${p.eventId}:${v}`
  }
  if (typeof p.audioId === 'number') return extra === undefined ? `${kind}:a${p.audioId}` : `${kind}:a${p.audioId}:${extra}`
  return extra === undefined ? kind : `${kind}:${extra}`
}
