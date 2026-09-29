// start_kick / end_kick / teardown (plan §4 "Start kick", "End kick").
//
// Schedules reach Liquidsoap only when the backend restarts (the .liq is
// regenerated at start), so:
//   * start kick at start + 5 s: purge the queue, restart, then CONFIRM the
//     backend is running (GET /status every 3 s, up to 40 s, two running
//     reads in a row). A restart that fails or a backend that does not come
//     up (Liquidsoap refusing the regenerated config — the 2026-09-29
//     station-14 outage) is ROLLED BACK at once, never retried into the
//     same config: every playlist of the event is disabled, the backend is
//     restarted once more and confirmed, the build is marked failed, staff
//     are alerted and the ticket is told. A rollback restart that does not
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
import { PLAYLIST_DELETE_AFTER_H, RESTART_CONFIRM_MAX_S, RESTART_CONFIRM_POLL_S, RESTART_CONFIRM_STABLE_READS, START_KICK_DELAY_S, START_KICK_RETRY_S } from '../../contract/rules'
import type { EventStatus } from '../../contract/types'
import type { EventsCtx } from '../ctx'
import { Permanent, Retry, Wait, waitUntil } from '../errors'
import type { BuildRow, EventRow, RegistryRow } from '../store'
import { buildIsCurrent, lastLiquidsoapBanner, liquidsoapConfigErrors, playlistScope, readLiquidsoapLog, staleJob } from './build'
import { postToTicket, whenLine } from './tickets'

const KICKABLE: readonly EventStatus[] = ['built', 'live']
const GONE: readonly EventStatus[] = ['cancelled', 'withdrawn', 'denied', 'expired', 'failed']
const SONG_END_SLACK_MS = 2000

const errText = (e: unknown) => (e instanceof EventsAzuraCastError ? `${e.code}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 200)}` : ''}` : e instanceof Error ? e.message : 'error')

// ------------------------------------------------ restart + confirmation --

export type RestartOutcome =
  | { ok: true; reads: number }
  // stage 'restart': POST /backend/restart failed; 'not_running': it
  // answered, but GET /status never showed the backend running (stably).
  | { ok: false; stage: 'restart' | 'not_running'; error: string; backend: string }

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * GET /status until the backend reports running on RESTART_CONFIRM_STABLE_READS
 * reads in a row: one read every RESTART_CONFIRM_POLL_S, at most
 * RESTART_CONFIRM_MAX_S (a bounded number of reads, whatever the clock does).
 * A read that fails counts as "not running".
 */
export async function confirmBackendRunning(ctx: EventsCtx): Promise<RestartOutcome> {
  const sleep = ctx.sleep ?? defaultSleep
  const maxReads = Math.max(RESTART_CONFIRM_STABLE_READS, Math.ceil(RESTART_CONFIRM_MAX_S / RESTART_CONFIRM_POLL_S))
  let streak = 0
  let backend = 'unknown'
  for (let i = 1; i <= maxReads; i++) {
    await sleep(RESTART_CONFIRM_POLL_S * 1000)
    try {
      const st = await ctx.az.getStatus()
      backend = st.backend_running ? 'running' : 'not running'
      streak = st.backend_running ? streak + 1 : 0
    } catch (e) {
      backend = `unknown (${errText(e)})`
      streak = 0
    }
    if (streak >= RESTART_CONFIRM_STABLE_READS) return { ok: true, reads: i }
  }
  return { ok: false, stage: 'not_running', error: `backend ${backend} ${RESTART_CONFIRM_MAX_S} s after the restart`, backend }
}

/**
 * POST /backend/restart, then confirmBackendRunning. A refusal by the
 * wrapper (refused_*: nothing was sent — e.g. queues paused) is thrown; any
 * other failure is returned, never retried here.
 */
export async function restartAndConfirm(ctx: EventsCtx): Promise<RestartOutcome> {
  try {
    await ctx.az.restartBackend()
  } catch (e) {
    if (e instanceof EventsAzuraCastError && e.code.startsWith('refused_')) throw e
    let backend = 'unknown'
    try {
      backend = (await ctx.az.getStatus()).backend_running ? 'running' : 'not running'
    } catch {
      // stays unknown
    }
    return { ok: false, stage: 'restart', error: `restart failed (${errText(e)})`, backend }
  }
  return confirmBackendRunning(ctx)
}

// What the liquidsoap log says about the restart (alert detail only; the
// decision is backend_running). `newStart`: a start banner newer than the
// one logged before the restart (false: Liquidsoap never got going).
async function liquidsoapDiagnostics(ctx: EventsCtx, bannerBefore: string | null | undefined): Promise<Record<string, unknown>> {
  try {
    const contents = await readLiquidsoapLog(ctx)
    if (contents === null) return { liquidsoapLog: 'none' }
    const banner = lastLiquidsoapBanner(contents)
    return { liquidsoapErrors: liquidsoapConfigErrors(contents), newStart: bannerBefore === undefined ? null : banner !== null && banner !== bannerBefore }
  } catch (e) {
    return { liquidsoapLog: `unreadable (${errText(e)})` }
  }
}

async function bannerNow(ctx: EventsCtx): Promise<string | null | undefined> {
  try {
    const contents = await readLiquidsoapLog(ctx)
    return contents === null ? undefined : lastLiquidsoapBanner(contents)
  } catch {
    return undefined
  }
}

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
    await rollbackStart(ctx, ev, build, outcome, bannerBefore)
    return
  }
  const first = await ctx.store.setEventStatus(ev.id, ['built'], 'live')
  await ctx.store.audit('events.kick.start', 'event', ev.id, { buildId: build.id, first })
  await ctx.store.enqueue('verify', { eventId: ev.id, buildId: build.id }, { dedupeKey: `verify:${ev.id}:b${build.id}:kick:${now}`, runAfter: new Date(now + 60_000) })
  if (first) await postToTicket(ctx, ev.id, 'on_air', 'On air now on the Events station.', `on_air:${ev.id}:v${ev.version}`)
}

/**
 * The start kick's restart failed or the backend did not come up: take the
 * event's playlists out and bring the station back as it was. Every
 * registry playlist of the event is disabled (each tried, failures noted),
 * the backend restarted ONCE more and confirmed, the build marked failed,
 * staff alerted and the ticket told. If that restart does not bring the
 * backend back, a distinct "EVENT STATION DOWN" page goes out and nothing
 * else is tried.
 */
async function rollbackStart(ctx: EventsCtx, ev: EventRow, build: BuildRow, failure: Extract<RestartOutcome, { ok: false }>, bannerBefore: string | null | undefined): Promise<void> {
  const diag = await liquidsoapDiagnostics(ctx, bannerBefore)
  await ctx.store.audit('events.kick.start_failed', 'event', ev.id, { buildId: build.id, stage: failure.stage, error: failure.error, backend: failure.backend, ...diag })
  const rows = await ctx.store.registry(ev.id)
  const scope = playlistScope(ev, rows)
  const disabled: number[] = []
  const disableErrors: string[] = []
  for (const r of rows) {
    if (r.playlistId === null) continue
    try {
      await ctx.az.disablePlaylist(r.playlistId, scope)
      disabled.push(r.playlistId)
    } catch (e) {
      if (e instanceof EventsAzuraCastError && e.code === 'not_found') continue
      disableErrors.push(`${r.playlistId}: ${errText(e)}`.slice(0, 200))
    }
  }
  await ctx.store.audit('events.playlists.disabled', 'event', ev.id, { playlists: disabled, errors: disableErrors, reason: 'start rollback' })
  let restored: RestartOutcome
  try {
    restored = await restartAndConfirm(ctx)
  } catch (e) {
    restored = { ok: false, stage: 'restart', error: `rollback restart refused (${errText(e)})`, backend: 'unknown' }
  }
  await ctx.store.setBuild(build.id, { status: 'failed', lastError: `start kick: ${failure.error}; rolled back${restored.ok ? '' : ' — station still down'}`.slice(0, 300) })
  const detail = { eventId: ev.id, buildId: build.id, when: whenLine(ev), stage: failure.stage, error: failure.error, disabled, disableErrors, ...diag }
  if (restored.ok) {
    await ctx.store.audit('events.kick.rolled_back', 'event', ev.id, { buildId: build.id, restored: true })
    await ctx.alert(`start of event ${ev.id} failed — rolled back, Event station restored`, detail)
    await postToTicket(ctx, ev.id, 'failed', 'The Events station could not start this event, so its playlists were switched off and the station was put back as it was. Staff have been alerted and will look at it.', `start_rolled_back:${ev.id}:b${build.id}`)
    return
  }
  await ctx.store.audit('events.kick.rolled_back', 'event', ev.id, { buildId: build.id, restored: false, rollbackError: restored.error })
  await ctx.alert(`EVENT STATION DOWN — manual action needed: start of event ${ev.id} failed and the rollback restart did not bring station 14 back (${restored.error}; backend ${restored.backend})`, { ...detail, rollbackError: restored.error, backend: restored.backend })
  await postToTicket(ctx, ev.id, 'failed', 'The Events station could not start this event and is off the air. Staff have been alerted.', `start_down:${ev.id}:b${build.id}`)
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
  if (!KICKABLE.includes(ev.status)) {
    await staleJob(ctx, 'end_kick', ev, {})
    return
  }
  const now = ctx.now()
  const end = ev.endsAt.getTime()
  if (now < end) throw waitUntil(now, end, 'end kick')
  const s = await ctx.store.settings()
  const rows = await ctx.store.registry(ev.id)
  const scope = playlistScope(ev, rows)
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
  if (ev.status === 'ended') {
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
