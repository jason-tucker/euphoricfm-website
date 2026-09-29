// start_kick / end_kick / teardown (plan §4 "Start kick", "End kick").
//
// Schedules reach Liquidsoap only when the backend restarts (the .liq is
// regenerated at start), so:
//   * start kick at start + 5 s: purge the queue, restart. A failed restart
//     is retried once after 30 s (the job has 2 attempts); a second failure
//     marks the build failed, posts to the ticket and alerts — it never
//     loops restarts (the efm watchdog has its own 10-min cooldown);
//   * end kick at the end: wait for the song that was playing at the end to
//     finish, at most events_end_wait_s (90 s, before the watchdog's third
//     mismatch minute), then disable the event's playlists, purge, restart.
//     When another built event starts within events_gap_min of this end
//     (a staff-booked adjacent pair), only disable: the next start kick does
//     the single purge + restart;
//   * teardown deletes the event's playlists 24 h after the end, or at once
//     for a cancelled/withdrawn/denied/expired event (with a purge + restart
//     if it was on air); an event sent back to pending/approved by an edit
//     only has its playlists disabled until it is rebuilt.

import { EventsAzuraCastError, type NowPlaying, type PlaylistScope } from '../../azuracast/client'
import type { EventJobPayload } from '../../contract/jobs'
import { PLAYLIST_DELETE_AFTER_H, START_KICK_DELAY_S, START_KICK_RETRY_S } from '../../contract/rules'
import type { EventStatus } from '../../contract/types'
import type { EventsCtx } from '../ctx'
import { Permanent, Retry, waitUntil } from '../errors'
import type { EventRow, RegistryRow } from '../store'
import { playlistScope } from './build'
import { postToTicket, whenLine } from './tickets'

const KICKABLE: readonly EventStatus[] = ['built', 'live']
const GONE: readonly EventStatus[] = ['cancelled', 'withdrawn', 'denied', 'expired', 'failed']
const SONG_END_SLACK_MS = 2000

async function restartOrRetry(ctx: EventsCtx, what: string): Promise<void> {
  try {
    await ctx.az.restartBackend()
  } catch (e) {
    if (e instanceof EventsAzuraCastError && e.code.startsWith('refused_')) throw e
    throw new Retry(START_KICK_RETRY_S, `${what}: restart failed (${e instanceof Error ? e.message : 'error'})`)
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
    await ctx.store.audit('events.kick.skipped', 'event', ev.id, { kind: 'start', status: ev.status })
    return
  }
  const build = await ctx.store.latestAppliedBuild(ev.id)
  if (!build || build.version !== ev.version) {
    // Never restart into a build that is not the event's current version.
    await ctx.alert(`events start kick for event #${ev.id}: no applied build for version ${ev.version}; not restarting`, { eventId: ev.id })
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
  await restartOrRetry(ctx, 'start kick')
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
  if (!KICKABLE.includes(ev.status)) {
    await ctx.store.audit('events.kick.skipped', 'event', ev.id, { kind: 'end', status: ev.status })
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
  await disableAll(ctx, ev, rows, scope)
  await clearQueueQuietly(ctx, ev.id)
  await restartOrRetry(ctx, 'end kick')
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
  if (GONE.includes(ev.status)) {
    await deleteAll(ctx, ev, rows, scope)
    if (onAirWindow) {
      await clearQueueQuietly(ctx, ev.id)
      await restartOrRetry(ctx, 'teardown')
    }
    return
  }
  // pending / approved / draft: an edit sent it back for review. Keep the
  // playlists for the rebuild, but nothing of it may air meanwhile.
  await disableAll(ctx, ev, rows, scope)
  if (onAirWindow) {
    await clearQueueQuietly(ctx, ev.id)
    await restartOrRetry(ctx, 'teardown')
  }
}
