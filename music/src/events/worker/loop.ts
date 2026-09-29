// The events worker loop: claims ONLY from event_jobs (FOR UPDATE SKIP
// LOCKED, store-pg.ts), honours settings.queues_paused for the kinds that
// write to AzuraCast (never claimed while paused, re-checked before the
// handler runs, and the wrapper's write gate refuses again), and runs the
// periodic sweeps on timers.

import { ZodError } from 'zod'
import { EventsAzuraCastError } from '../azuracast/client'
import { isEventJobKind, parseEventJobPayload, type EventJobKind } from '../contract/jobs'
import { STINGER_SYNC_EVERY_H } from '../contract/rules'
import type { EventsCtx } from './ctx'
import { Permanent, Retry, Wait } from './errors'
import { audioDelete, audioFinalize, audioIngest, collectAudio } from './jobs/audio'
import { buildJob, buildNowJob, recheckJob, verifyJob } from './jobs/build'
import { endKick, offAirRestart, startKick, startKickFailed, teardown } from './jobs/kicks'
import { audioExpire, pendingExpire, pendingReminder, stingerSync } from './jobs/sweeps'
import { ticketClose, ticketOpen, ticketPost } from './jobs/tickets'
import type { ClaimedJob } from './store'

// Every kind that writes to AzuraCast (queues_paused holds them).
export const EVENTS_MUTATING_KINDS: readonly EventJobKind[] = ['audio_ingest', 'audio_delete', 'build', 'build_now', 'start_kick', 'end_kick', 'teardown', 'off_air_restart', 'recheck']

export async function dispatch(ctx: EventsCtx, kind: EventJobKind, payload: unknown): Promise<void> {
  switch (kind) {
    case 'ticket_open':
      return ticketOpen(ctx, parseEventJobPayload(kind, payload))
    case 'ticket_post':
      return ticketPost(ctx, parseEventJobPayload(kind, payload))
    case 'ticket_close':
      return ticketClose(ctx, parseEventJobPayload(kind, payload))
    case 'audio_collect':
      await collectAudio(ctx)
      return
    case 'audio_finalize':
      return audioFinalize(ctx, parseEventJobPayload(kind, payload))
    case 'audio_ingest':
      return audioIngest(ctx, parseEventJobPayload(kind, payload))
    case 'audio_delete':
      return audioDelete(ctx, parseEventJobPayload(kind, payload))
    case 'stinger_sync':
      await stingerSync(ctx)
      return
    case 'build':
      return buildJob(ctx, parseEventJobPayload(kind, payload))
    case 'build_now':
      return buildNowJob(ctx, parseEventJobPayload(kind, payload))
    case 'verify':
      return verifyJob(ctx, parseEventJobPayload(kind, payload))
    case 'start_kick':
      return startKick(ctx, parseEventJobPayload(kind, payload))
    case 'end_kick':
      return endKick(ctx, parseEventJobPayload(kind, payload))
    case 'teardown':
      return teardown(ctx, parseEventJobPayload(kind, payload))
    case 'off_air_restart':
      return offAirRestart(ctx, parseEventJobPayload(kind, payload))
    case 'recheck':
      return recheckJob(ctx, parseEventJobPayload(kind, payload))
    case 'pending_expire':
      await pendingExpire(ctx)
      return
    case 'pending_reminder':
      await pendingReminder(ctx)
      return
    case 'audio_expire':
      await audioExpire(ctx)
      return
  }
}

function describe(e: unknown): string {
  if (e instanceof EventsAzuraCastError) return `EventsAzuraCastError: ${e.code}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 300)}` : ''}`
  if (e instanceof ZodError) return 'ZodError: bad payload'
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : 'error'
}

// What a job that ended dead leaves behind for its owner.
async function onDead(ctx: EventsCtx, job: ClaimedJob, error: string): Promise<void> {
  const p = (job.payload ?? {}) as Record<string, unknown>
  await ctx.alert(`events job ${job.kind} #${job.id} failed permanently`, { error, payload: p })
  const eventId = typeof p.eventId === 'number' ? p.eventId : null
  const audioId = typeof p.audioId === 'number' ? p.audioId : null
  if (job.kind === 'start_kick' && eventId) await startKickFailed(ctx, eventId, error)
  if ((job.kind === 'build' || job.kind === 'build_now') && eventId) {
    const ev = await ctx.store.getEvent(eventId)
    const b = ev ? await ctx.store.buildFor(ev.id, ev.version) : null
    if (b && b.status !== 'applied') await ctx.store.setBuild(b.id, { status: 'failed', lastError: error.slice(0, 300) })
  }
  if ((job.kind === 'audio_finalize' || job.kind === 'audio_ingest') && audioId) {
    await ctx.store.updateAudio(audioId, { status: 'failed', lastError: error.slice(0, 200) }, ['ready', 'ingesting'])
  }
}

export async function runEventJob(ctx: EventsCtx, job: ClaimedJob): Promise<void> {
  const s = ctx.store
  try {
    if (!isEventJobKind(job.kind)) throw new Permanent(`unknown job kind ${job.kind}`)
    // The pause may have landed after the claim.
    if (EVENTS_MUTATING_KINDS.includes(job.kind) && (await s.queuesPaused())) {
      await s.finishJob(job.id, { status: 'queued', error: 'queues paused', delayS: 60, refund: true })
      return
    }
    await dispatch(ctx, job.kind, job.payload)
    await s.finishJob(job.id, { status: 'done' })
  } catch (e) {
    const msg = describe(e)
    if (e instanceof EventsAzuraCastError && e.code === 'refused_queues_paused') {
      await s.finishJob(job.id, { status: 'queued', error: msg, delayS: 60, refund: true })
      return
    }
    if (e instanceof Wait) {
      if (job.ageS > e.maxAgeS) {
        await s.finishJob(job.id, { status: 'dead', error: `gave up waiting: ${msg}` })
        await onDead(ctx, job, `gave up waiting: ${e.message}`)
        return
      }
      const floor = e.exact ? 0 : Math.min(1800, job.ageS / 20)
      await s.finishJob(job.id, { status: 'queued', error: msg, delayS: Math.max(1, Math.max(e.delayS, floor)), refund: true })
      return
    }
    const dead = e instanceof Permanent || e instanceof ZodError || (e instanceof EventsAzuraCastError && e.code.startsWith('refused_')) || job.attempts >= job.maxAttempts
    if (dead) {
      await s.finishJob(job.id, { status: 'dead', error: msg })
      await onDead(ctx, job, msg)
      return
    }
    const delay = e instanceof Retry ? e.delayS : Math.min(3600, 15 * 2 ** job.attempts)
    await s.finishJob(job.id, { status: 'queued', error: msg, delayS: delay, refund: false })
  }
}

// ------------------------------------------------------------ periodic ---

export type PeriodicState = Record<string, number>

export const PERIODIC_EVERY_MS: Record<string, number> = {
  audio_collect: 15_000,
  stinger_sync: STINGER_SYNC_EVERY_H * 3600_000,
  pending_expire: 5 * 60_000,
  pending_reminder: 30 * 60_000,
  audio_expire: 3600_000,
}

const PERIODIC: Record<string, (ctx: EventsCtx) => Promise<unknown>> = {
  audio_collect: collectAudio,
  stinger_sync: stingerSync,
  pending_expire: pendingExpire,
  pending_reminder: pendingReminder,
  audio_expire: audioExpire,
}

export async function tickPeriodic(ctx: EventsCtx, state: PeriodicState): Promise<void> {
  const now = ctx.now()
  for (const [kind, every] of Object.entries(PERIODIC_EVERY_MS)) {
    if (state[kind] !== undefined && now - state[kind]! < every) continue
    state[kind] = now
    try {
      await PERIODIC[kind]!(ctx)
    } catch (e) {
      console.error(`[events-worker] ${kind} failed`, describe(e))
    }
  }
}
