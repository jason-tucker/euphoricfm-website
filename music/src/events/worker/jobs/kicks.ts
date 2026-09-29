// start_kick / end_kick / teardown (plan §4 "Start kick", "End kick").
//
// Schedules reach Liquidsoap only when the backend restarts (the .liq is
// regenerated at start), so:
//   * start kick at start + 5 s: purge the queue, restart, then CONFIRM the
//     backend is running (GET /status every 3 s, up to 40 s, two running
//     reads in a row). A restart that fails or a backend that does not come
//     up (Liquidsoap refusing the regenerated config — the 2026-09-29
//     station-14 outage) is ROLLED BACK at once, never retried into the
//     same config (station.ts rollbackEvent): every playlist of the event is
//     disabled, the queue is purged (the AutoDJ may already have queued a
//     song from the event's playlists — seen in the outage), the backend is
//     restarted once more and confirmed, and the EVENT becomes `failed` —
//     the one record of it: later start / end kicks skip it, only a staff
//     Build now re-arms it. Staff are alerted and the ticket is told. A rollback restart that does not
//     bring the station back pages "EVENT STATION DOWN" and stops. Never a
//     restart loop (the efm watchdog has its own 10-min cooldown);
//   * end kick at the end: wait for the song that was playing at the end to
//     finish, at most events_end_wait_s (90 s, before the watchdog's third
//     mismatch minute), then disable the event's playlists and hand the
//     purge + restart to an off_air_restart job.
//     When another built event starts within events_gap_min of this end
//     (a staff-booked adjacent pair), only disable: the next start kick does
//     the single purge + restart;
//   * teardown deletes the event's playlists 24 h after the end, or at once
//     for a cancelled/withdrawn/denied/expired event (with a purge + restart
//     if it was on air); an event sent back to pending/approved by an edit
//     only has its playlists disabled until it is rebuilt;
//   * off_air_restart (after an end kick or an on-air teardown) is enqueued
//     BEFORE the playlists are touched, so the decision survives a failed
//     restart and a retried teardown that finds no registry rows left. It
//     waits until none of the event's playlists is enabled any more, then
//     purges, restarts and confirms the backend runs: 2 attempts 30 s
//     apart, then an alert (never a loop of restarts). A backend that is
//     not running after an off-air restart pages "EVENT STATION DOWN" at
//     once.

import { EventsAzuraCastError, type NowPlaying, type PlaylistScope } from '../../azuracast/client'
import type { EventJobPayload } from '../../contract/jobs'
import { PLAYLIST_DELETE_AFTER_H, START_KICK_DELAY_S, START_KICK_RETRY_S } from '../../contract/rules'
import type { EventStatus } from '../../contract/types'
import type { EventsCtx } from '../ctx'
import { Permanent, Retry, Wait, waitUntil } from '../errors'
import type { EventRow, RegistryRow } from '../store'
import { buildIsCurrent, staleJob } from './build'
import { bannerNow, playlistScope, restartAndConfirm, rollbackEvent } from './station'
import { postToTicket, whenLine } from './tickets'

export { confirmBackendRunning, restartAndConfirm, type RestartOutcome } from './station'

const KICKABLE: readonly EventStatus[] = ['built', 'live']
const GONE: readonly EventStatus[] = ['cancelled', 'withdrawn', 'denied', 'expired', 'failed']
const SONG_END_SLACK_MS = 2000

async function clearQueueQuietly(ctx: EventsCtx, eventId: number): Promise<void> {
  try {
    await ctx.az.clearQueue()
  } catch (e) {
    if (e instanceof EventsAzuraCastError && e.code === 'refused_queues_paused') throw e
    await ctx.store.audit('events.kick.queue_clear_failed', 'event', eventId, { error: e instanceof Error ? e.message : 'error' })
  }
}

async function disableAll(ctx: EventsCtx, ev: EventRow, rows: readonly RegistryRow[], scope: PlaylistScope): Promise<void> {
  for (const r of rows) {
    if (r.playlistId === null) continue
    try {
      await ctx.az.disablePlaylist(r.playlistId, scope)
    } catch (e) {
      if (e instanceof EventsAzuraCastError && e.code === 'not_found') continue
      throw e
    }
  }
  await ctx.store.audit('events.playlists.disabled', 'event', ev.id, { playlists: rows.map((r) => r.playlistId) })
}

// ---------------------------------------------------------- start kick --

export async function startKick(ctx: EventsCtx, p: EventJobPayload<'start_kick'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  // Only built / live events are kicked. A `failed` event was rolled back by
  // an earlier kick (of this or another version): never restart into it
  // again, and no "press Build now" page on top of the rollback's own. Only
  // a staff Build now re-arms it (build.ts).
  if (!KICKABLE.includes(ev.status)) {
    await staleJob(ctx, 'start_kick', ev, {})
    return
  }
  const build = await ctx.store.latestAppliedBuild(ev.id)
  if (!build || !(await buildIsCurrent(ctx, ev, build))) {
    // Never restart into a build compiled from other inputs than the event
    // has now (a details-only edit keeps the applied build current).
    await ctx.alert(`events start kick for event #${ev.id}: no applied build for version ${ev.version} (needs rebuild — press Build now); not restarting`, { eventId: ev.id })
    return
  }
  const now = ctx.now()
  const at = ev.startsAt.getTime() + START_KICK_DELAY_S * 1000
  if (now < at) throw waitUntil(now, at, 'start kick')
  // Already live: restart only for a build applied after the last kick (a
  // staff-confirmed live schedule change). A second kick for the same build
  // (the kick of an earlier version, which waited for the same start) skips.
  if (ev.status === 'live') {
    const last = await ctx.store.lastStartKickMs(ev.id)
    if (last !== null && last >= build.updatedAt.getTime()) {
      await ctx.store.audit('events.kick.skipped', 'event', ev.id, { kind: 'start', reason: 'already kicked for this build' })
      return
    }
  }
  if (now >= ev.endsAt.getTime()) {
    await ctx.store.audit('events.kick.missed', 'event', ev.id, { kind: 'start' })
    return
  }
  await clearQueueQuietly(ctx, ev.id)
  const bannerBefore = await bannerNow(ctx)
  const outcome = await restartAndConfirm(ctx)
  if (!outcome.ok) {
    await rollbackEvent(ctx, ev, build, outcome, bannerBefore)
    return
  }
  const first = await ctx.store.setEventStatus(ev.id, ['built'], 'live')
  await ctx.store.audit('events.kick.start', 'event', ev.id, { buildId: build.id, first })
  await ctx.store.enqueue('verify', { eventId: ev.id, buildId: build.id }, { dedupeKey: `verify:${ev.id}:b${build.id}:kick:${now}`, runAfter: new Date(now + 60_000) })
  if (first) await postToTicket(ctx, ev.id, 'on_air', 'On air now on the Events station.', `on_air:${ev.id}:v${ev.version}`)
}

// A start kick that ran out of attempts (loop.ts failure hook).
export async function startKickFailed(ctx: EventsCtx, eventId: number, error: string): Promise<void> {
  const ev = await ctx.store.getEvent(eventId)
  if (!ev) return
  const build = await ctx.store.latestAppliedBuild(ev.id)
  if (build) await ctx.store.setBuild(build.id, { status: 'failed', lastError: `start kick: ${error}`.slice(0, 300) })
  await ctx.alert(`events start kick FAILED for event #${ev.id} (${whenLine(ev)}): station 14 did not restart`, { eventId: ev.id, error })
  await postToTicket(ctx, ev.id, 'failed', 'The Events station could not be started for this event. Staff have been alerted.', `start_failed:${ev.id}:v${ev.version}`)
}

// ------------------------------------------------------------ end kick --

// When to proceed with the end kick: the song that was on air at the end
// may finish, but never past the deadline (end + events_end_wait_s). A song
// that started after the end means the event's last song is over. Unknown
// now-playing waits for the deadline (songs are never cut on a guess).
export function endWaitTarget(np: NowPlaying | null, endMs: number, deadlineMs: number, nowMs: number): number {
  if (nowMs >= deadlineMs) return nowMs
  if (np && np.is_online === false) return nowMs
  const cur = np?.now_playing
  if (!cur || typeof cur.played_at !== 'number' || typeof cur.duration !== 'number' || !(cur.duration > 0)) return deadlineMs
  const started = cur.played_at * 1000
  if (started >= endMs) return nowMs
  const songEnd = started + cur.duration * 1000 + SONG_END_SLACK_MS
  return Math.max(nowMs, Math.min(songEnd, deadlineMs))
}

export async function endKick(ctx: EventsCtx, p: EventJobPayload<'end_kick'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  // No version check here, on purpose: the end kick is what takes the event
  // off the station, so an edit that bumped the version without a rebuild
  // (autobuild off) must not strand it. A rebuilt version's own end kick
  // then finds the event ended and skips.
  if (!KICKABLE.includes(ev.status) && ev.status !== 'failed') {
    await staleJob(ctx, 'end_kick', ev, {})
    return
  }
  const now = ctx.now()
  const end = ev.endsAt.getTime()
  if (now < end) throw waitUntil(now, end, 'end kick')
  const s = await ctx.store.settings()
  const rows = await ctx.store.registry(ev.id)
  const scope = playlistScope(ev, rows)
  // Rolled back (`failed`): its playlists were switched off and the station
  // restarted without them, the ticket was told. Make sure they stay off and
  // schedule the teardown — no restart (another event may be on air by now)
  // and no "ended" post after "could not start". It stays `failed`.
  if (ev.status === 'failed') {
    await disableAll(ctx, ev, rows, scope)
    await ctx.store.audit('events.kick.end', 'event', ev.id, { failed: true })
    await ctx.store.enqueue('teardown', { eventId: ev.id }, { dedupeExtra: `v${ev.version}:end`, runAfter: new Date(ev.endsAt.getTime() + PLAYLIST_DELETE_AFTER_H * 3600_000) })
    return
  }
  const next = await ctx.store.eventStartingBetween(ev.id, end, end + s.events_gap_min * 60_000)
  if (next) {
    // Adjacent staff pair: B's start kick purges and restarts once.
    await disableAll(ctx, ev, rows, scope)
    await finishEnded(ctx, ev, { adjacentTo: next.id })
    return
  }
  const deadline = end + s.events_end_wait_s * 1000
  if (now < deadline) {
    let np: NowPlaying | null = null
    try {
      np = await ctx.az.nowPlaying()
    } catch {
      np = null
    }
    const target = endWaitTarget(np, end, deadline, now)
    if (target > now) throw waitUntil(now, target, 'last song')
  }
  await requestOffAirRestart(ctx, ev, 'end', `v${ev.version}:end`)
  await disableAll(ctx, ev, rows, scope)
  await finishEnded(ctx, ev, {})
}

async function finishEnded(ctx: EventsCtx, ev: EventRow, detail: Record<string, unknown>): Promise<void> {
  const moved = await ctx.store.setEventStatus(ev.id, ['built', 'live'], 'ended')
  await ctx.store.audit('events.kick.end', 'event', ev.id, detail)
  await ctx.store.enqueue('teardown', { eventId: ev.id }, { dedupeExtra: `v${ev.version}:end`, runAfter: new Date(ev.endsAt.getTime() + PLAYLIST_DELETE_AFTER_H * 3600_000) })
  if (moved) await postToTicket(ctx, ev.id, 'ended', 'The event has ended on the Events station.', `ended:${ev.id}`)
}

// ------------------------------------------------------------ teardown --

async function deleteAll(ctx: EventsCtx, ev: EventRow, rows: readonly RegistryRow[], scope: PlaylistScope): Promise<void> {
  for (const r of rows) {
    if (r.playlistId !== null) {
      try {
        await ctx.az.deletePlaylist(r.playlistId, scope)
      } catch (e) {
        if (!(e instanceof EventsAzuraCastError && e.code === 'not_found')) throw e
      }
    }
    await ctx.store.markRegistryDeleted(r.id)
  }
  await ctx.store.setBuildsStatus(ev.id, ['pending', 'applying', 'applied', 'failed'], 'torn_down')
  await ctx.store.audit('events.playlists.deleted', 'event', ev.id, { playlists: rows.map((r) => r.playlistId) })
}

export async function teardown(ctx: EventsCtx, p: EventJobPayload<'teardown'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const rows = await ctx.store.registry(ev.id)
  if (rows.length === 0) return
  const scope = playlistScope(ev, rows)
  const now = ctx.now()
  const s = await ctx.store.settings()
  const onAirWindow = now >= ev.startsAt.getTime() && now < ev.endsAt.getTime() + s.events_end_wait_s * 1000
  if (KICKABLE.includes(ev.status)) return
  // Ended, or `failed` (rolled back: its playlists are already off and the
  // station was restarted without them — no off-air restart): deleted 24 h
  // after the end.
  if (ev.status === 'ended' || ev.status === 'failed') {
    const due = ev.endsAt.getTime() + PLAYLIST_DELETE_AFTER_H * 3600_000
    if (now < due) throw waitUntil(now, due, 'teardown after the end')
    await deleteAll(ctx, ev, rows, scope)
    return
  }
  // On air: the restart is decided (and persisted) before anything is
  // removed, never from what is left afterwards.
  if (onAirWindow) await requestOffAirRestart(ctx, ev, 'teardown', `${ev.status}:v${ev.version}`)
  if (GONE.includes(ev.status)) {
    await deleteAll(ctx, ev, rows, scope)
    return
  }
  // pending / approved / draft: an edit sent it back for review. Keep the
  // playlists for the rebuild, but nothing of it may air meanwhile.
  await disableAll(ctx, ev, rows, scope)
}

// ----------------------------------------------------- off-air restart --

const OFF_AIR_WAIT_S = 15
// Deferred behind another event on air: until its end + 2 min, and never
// for more than 2 days in all.
const OFF_AIR_DEFER_AFTER_S = 120
const OFF_AIR_DEFER_MAX_AGE_S = 2 * 24 * 3600
const OFF_AIR_MAX_WAIT_S = 3600

// Like the start kick: one retry after START_KICK_RETRY_S, then the job is
// dead, staff are paged (offAirRestartFailed) and it never loops restarts.
export const OFF_AIR_RESTART_MAX_ATTEMPTS = 2

async function requestOffAirRestart(ctx: EventsCtx, ev: EventRow, reason: 'end' | 'teardown', discriminator: string): Promise<void> {
  await ctx.store.enqueue('off_air_restart', { eventId: ev.id, reason }, { dedupeExtra: discriminator, maxAttempts: OFF_AIR_RESTART_MAX_ATTEMPTS })
}

// An off-air restart that ran out of attempts (loop.ts failure hook).
export async function offAirRestartFailed(ctx: EventsCtx, eventId: number, reason: unknown, error: string): Promise<void> {
  const ev = await ctx.store.getEvent(eventId)
  const when = ev ? ` (${whenLine(ev)})` : ''
  await ctx.alert(`events off-air restart FAILED for event #${eventId}${when} after its ${reason === 'end' ? 'end' : 'teardown'}: station 14 did not restart; its playlists may keep airing until the next restart`, { eventId, error })
}

/**
 * The purge + restart that takes an event off air (after its end kick or an
 * on-air teardown). Runs once none of the event's playlists is enabled on
 * the station any more (the enqueuing job disables or deletes them first;
 * until then it waits), so the regenerated .liq cannot carry them over.
 */
export async function offAirRestart(ctx: EventsCtx, p: EventJobPayload<'off_air_restart'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  // Sent back for review and rebuilt meanwhile: the new build's own start
  // kick restarts.
  if (p.reason === 'teardown' && KICKABLE.includes(ev.status)) {
    await staleJob(ctx, 'off_air_restart', ev, { reason: p.reason })
    return
  }
  for (const r of await ctx.store.registry(ev.id)) {
    if (r.playlistId === null) continue
    const pl = await ctx.az.getPlaylistOrNull(r.playlistId)
    if (pl && pl.is_enabled !== false) throw new Wait(OFF_AIR_WAIT_S, `playlist ${r.playlistId} of event ${ev.id} still enabled`, { maxAgeS: OFF_AIR_MAX_WAIT_S })
  }
  // Another event is on air (or inside its window): a restart now would cut
  // it. This event's playlists are off and outside their rows, so they do
  // not air meanwhile; the restart runs 2 min after that event's end (a
  // wait, bounded by the job's age — then it is dead and staff are paged).
  const nowMs = ctx.now()
  const other = await ctx.store.eventOnAirAt(ev.id, nowMs)
  if (other) {
    await ctx.store.audit('events.kick.off_air_deferred', 'event', ev.id, { reason: p.reason, onAir: other.id })
    throw waitUntil(nowMs, other.endsAt.getTime() + OFF_AIR_DEFER_AFTER_S * 1000, `event ${other.id} on air`, OFF_AIR_DEFER_MAX_AGE_S)
  }
  await clearQueueQuietly(ctx, ev.id)
  const outcome = await restartAndConfirm(ctx)
  if (!outcome.ok) {
    await ctx.store.audit('events.kick.off_air_failed', 'event', ev.id, { reason: p.reason, stage: outcome.stage, error: outcome.error, backend: outcome.backend })
    // Every playlist of the event is already off, so a backend that is not
    // running is the station itself down: page at once, loudly. The job's
    // one retry (30 s) is the only further restart.
    if (outcome.backend !== 'running') {
      await ctx.alert(`EVENT STATION DOWN — manual action needed: off-air restart after event ${ev.id}'s ${p.reason === 'end' ? 'end' : 'teardown'} left station 14's backend ${outcome.backend} (at most ${OFF_AIR_RESTART_MAX_ATTEMPTS} off-air restart attempts, ${START_KICK_RETRY_S} s apart)`, { eventId: ev.id, error: outcome.error })
    }
    throw new Retry(START_KICK_RETRY_S, `off-air restart (${p.reason}): ${outcome.error}`)
  }
  await ctx.store.audit('events.kick.off_air', 'event', ev.id, { reason: p.reason })
}
