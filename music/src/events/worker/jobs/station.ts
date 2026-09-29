// Station-14 backend restarts, their confirmation, and the rollback of an
// event whose restart did not bring the station back (0.5.2; the 2026-09-29
// outage). Shared by the kicks (kicks.ts) and verify (build.ts), so it
// imports neither.
//
//   * restartAndConfirm: POST /backend/restart, then GET /status (short
//     timeout) every RESTART_CONFIRM_POLL_S until the backend has reported
//     running on consecutive reads spanning RESTART_CONFIRM_SPAN_S — bounded
//     by ELAPSED time (RESTART_CONFIRM_MAX_S) and by a read count;
//   * rollbackEvent: disable every registry playlist of the event → purge the
//     queue (the AutoDJ may already have queued an event song) → restart once
//     → confirm. Every applied build of the event is marked failed with the
//     ROLLED_BACK marker, so any later start kick of it skips until staff
//     rebuild (Build now re-arms a fresh kick), and its end kick neither
//     restarts nor posts "ended". Never a restart loop.

import { EventsAzuraCastError, type PlaylistScope } from '../../azuracast/client'
import { RESTART_CONFIRM_MAX_S, RESTART_CONFIRM_POLL_S, RESTART_CONFIRM_SPAN_S, RESTART_CONFIRM_STATUS_TIMEOUT_S } from '../../contract/rules'
import type { EventsCtx } from '../ctx'
import type { BuildRow, EventRow, RegistryRow } from '../store'
import { postToTicket, whenLine } from './tickets'

export const errText = (e: unknown) => (e instanceof EventsAzuraCastError ? `${e.code}${e.detail ? ` ${JSON.stringify(e.detail).slice(0, 200)}` : ''}` : e instanceof Error ? e.message : 'error')

// ------------------------------------------------------------- scopes ---

export function playlistScope(ev: EventRow, rows: readonly RegistryRow[]): PlaylistScope {
  const registry = new Map<number, string>()
  for (const r of rows) if (r.playlistId !== null && r.deletedAt === null) registry.set(r.playlistId, r.intentName)
  return { eventId: ev.id, window: { startsAt: ev.startsAt.getTime(), endsAt: ev.endsAt.getTime() }, registry, intentNames: new Set(rows.filter((r) => r.deletedAt === null).map((r) => r.intentName)) }
}

// ------------------------------------------------ liquidsoap log check ---

// Only the part of the log written by the most recent Liquidsoap start is
// judged: everything after the last start banner ("[main:3] Liquidsoap
// 2.2.5", "Liquidsoap version …", "Liquidsoap … starting"). Timestamps are not
// used — Liquidsoap writes them in the container's local time, which may be
// UTC or the station's zone. A log with no banner is judged on its last
// LOG_FALLBACK_LINES lines.
export const LIQUIDSOAP_BANNER_RE = /\bLiquidsoap (?:v?\d+\.\d+|.*\b(?:start|version))/i
// What a config that did not load cleanly leaves in the log: Liquidsoap
// 2.x reports a script it cannot load as a position line ("At line 12, char
// 4-5:" or "Unknown position:") followed by "Error <n>: <kind>" — e.g. the
// 2026-09-29 outage's "Error 2: Parse error" for `playlist_~evt1_s1`.
export const LIQUIDSOAP_CONFIG_ERROR_RE = /Error while loading|Parse error|Script error|\bError \d+:|At line \d+, char|Unknown position/i
const LOG_FALLBACK_LINES = 200

/** The most recent Liquidsoap start banner line (with its timestamp), or null. */
export function lastLiquidsoapBanner(contents: string): string | null {
  const lines = contents.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (LIQUIDSOAP_BANNER_RE.test(lines[i]!) && !LIQUIDSOAP_CONFIG_ERROR_RE.test(lines[i]!)) return lines[i]!.trim()
  }
  return null
}

/** Config-load errors logged after the most recent Liquidsoap start banner. */
export function liquidsoapConfigErrors(contents: string): string[] {
  const lines = contents.split(/\r?\n/)
  let from = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    // an error line that happens to mention Liquidsoap is never the banner
    if (LIQUIDSOAP_BANNER_RE.test(lines[i]!) && !LIQUIDSOAP_CONFIG_ERROR_RE.test(lines[i]!)) {
      from = i + 1
      break
    }
  }
  if (from < 0) from = Math.max(0, lines.length - LOG_FALLBACK_LINES)
  const out: string[] = []
  for (const line of lines.slice(from)) {
    if (LIQUIDSOAP_CONFIG_ERROR_RE.test(line)) out.push(line.trim().slice(0, 200))
    if (out.length >= 10) break
  }
  return out
}

/** Station 14's liquidsoap log contents through the wrapper's read routes (null: no such log). */
export async function readLiquidsoapLog(ctx: EventsCtx): Promise<string | null> {
  const keys = (await ctx.az.listLogs()).map((l) => l.key)
  const key = keys.includes('liquidsoap_log') ? 'liquidsoap_log' : keys.find((k) => /^liquidsoap[a-z0-9_]*log$/.test(k))
  if (!key) return null
  return (await ctx.az.getLog(key)).contents
}

// What the liquidsoap log says about a restart (alert detail only; the
// decision is backend_running). `newStart`: a start banner newer than the
// one logged before the restart (false: Liquidsoap never got going).
export async function liquidsoapDiagnostics(ctx: EventsCtx, bannerBefore: string | null | undefined): Promise<Record<string, unknown>> {
  try {
    const contents = await readLiquidsoapLog(ctx)
    if (contents === null) return { liquidsoapLog: 'none' }
    const banner = lastLiquidsoapBanner(contents)
    return { liquidsoapErrors: liquidsoapConfigErrors(contents), newStart: bannerBefore === undefined ? null : banner !== null && banner !== bannerBefore }
  } catch (e) {
    return { liquidsoapLog: `unreadable (${errText(e)})` }
  }
}

/** The last start banner now (undefined: no log / unreadable). */
export async function bannerNow(ctx: EventsCtx): Promise<string | null | undefined> {
  try {
    const contents = await readLiquidsoapLog(ctx)
    return contents === null ? undefined : lastLiquidsoapBanner(contents)
  } catch {
    return undefined
  }
}

// ------------------------------------------------ restart + confirmation --

export type RestartOutcome =
  | { ok: true; reads: number }
  // stage 'restart': POST /backend/restart failed; 'not_running': it
  // answered, but GET /status never showed the backend running (stably);
  // 'after_start': a later check (verify) found it not running.
  | { ok: false; stage: 'restart' | 'not_running' | 'after_start'; error: string; backend: string }
export type RestartFailure = Extract<RestartOutcome, { ok: false }>

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * GET /status until the backend has reported running on consecutive reads
 * whose first and last lie at least RESTART_CONFIRM_SPAN_S apart (a
 * Liquidsoap that dies a few seconds in is caught). One read every
 * RESTART_CONFIRM_POLL_S, each with a RESTART_CONFIRM_STATUS_TIMEOUT_S
 * timeout; the loop ends when RESTART_CONFIRM_MAX_S have ELAPSED (ctx.now)
 * or after a fixed number of reads, whichever comes first. A read that
 * fails counts as "not running".
 */
export async function confirmBackendRunning(ctx: EventsCtx): Promise<RestartOutcome> {
  const sleep = ctx.sleep ?? defaultSleep
  const t0 = ctx.now()
  const deadline = t0 + RESTART_CONFIRM_MAX_S * 1000
  const maxReads = Math.ceil(RESTART_CONFIRM_MAX_S / RESTART_CONFIRM_POLL_S) + 1
  let runningSince: number | null = null
  let backend = 'unknown'
  for (let i = 1; i <= maxReads; i++) {
    await sleep(RESTART_CONFIRM_POLL_S * 1000)
    try {
      const st = await ctx.az.getStatus(RESTART_CONFIRM_STATUS_TIMEOUT_S * 1000)
      backend = st.backend_running ? 'running' : 'not running'
      if (st.backend_running) runningSince ??= ctx.now()
      else runningSince = null
    } catch (e) {
      backend = `unknown (${errText(e)})`
      runningSince = null
    }
    if (runningSince !== null && ctx.now() - runningSince >= RESTART_CONFIRM_SPAN_S * 1000) return { ok: true, reads: i }
    if (ctx.now() >= deadline) break
  }
  return { ok: false, stage: 'not_running', error: `backend ${backend} ${Math.round((ctx.now() - t0) / 1000)} s after the restart`, backend }
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
      backend = (await ctx.az.getStatus(RESTART_CONFIRM_STATUS_TIMEOUT_S * 1000)).backend_running ? 'running' : 'not running'
    } catch {
      // stays unknown
    }
    return { ok: false, stage: 'restart', error: `restart failed (${errText(e)})`, backend }
  }
  return confirmBackendRunning(ctx)
}

// --------------------------------------------------------------- rollback --

/** The lastError prefix that marks a build a start kick rolled back. */
export const ROLLED_BACK = 'rolled back:'

export const isRolledBackBuild = (b: Pick<BuildRow, 'status' | 'lastError'>) => b.status === 'failed' && (b.lastError ?? '').startsWith(ROLLED_BACK)

/**
 * Whether the event's station setup was rolled back and not rebuilt since:
 * no applied build is left and a rolled-back one exists. Start kicks skip
 * such an event (quietly: staff were paged by the rollback), its end kick
 * neither restarts nor posts "ended". Build now clears it (a new applied
 * build + a fresh start kick).
 */
export async function eventRolledBack(ctx: EventsCtx, eventId: number): Promise<boolean> {
  if (await ctx.store.latestAppliedBuild(eventId)) return false
  return (await ctx.store.builds(eventId)).some(isRolledBackBuild)
}

/**
 * The event's restart failed, its backend did not come up, or it died after
 * the start: take the event's playlists out and bring the station back
 * without it. In this order: every registry playlist of the event is
 * disabled (each tried, failures noted) → station 14's queue is purged (a
 * song the AutoDJ already queued from an event playlist would otherwise
 * still play — seen in the outage) → the backend is restarted ONCE more and
 * confirmed. Then every applied build of the event is marked failed
 * (ROLLED_BACK), staff are alerted and the ticket told. A rollback restart
 * that does not bring the backend back pages "EVENT STATION DOWN" once and
 * nothing else is tried.
 */
export async function rollbackEvent(ctx: EventsCtx, ev: EventRow, build: BuildRow, failure: RestartFailure, bannerBefore: string | null | undefined): Promise<void> {
  const wasLive = ev.status === 'live'
  const diag = await liquidsoapDiagnostics(ctx, bannerBefore)
  await ctx.store.audit('events.kick.start_failed', 'event', ev.id, { buildId: build.id, stage: failure.stage, error: failure.error, backend: failure.backend, live: wasLive, ...diag })
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
  await ctx.store.audit('events.playlists.disabled', 'event', ev.id, { playlists: disabled, errors: disableErrors, reason: 'rollback' })
  let queueError: string | null = null
  try {
    await ctx.az.clearQueue()
  } catch (e) {
    queueError = errText(e).slice(0, 300)
    await ctx.store.audit('events.kick.queue_clear_failed', 'event', ev.id, { error: queueError, reason: 'rollback' })
  }
  let restored: RestartOutcome
  try {
    restored = await restartAndConfirm(ctx)
  } catch (e) {
    restored = { ok: false, stage: 'restart', error: `rollback restart refused (${errText(e)})`, backend: 'unknown' }
  }
  // Durable: every applied build of the event (not only this one) is failed
  // with the marker, so no other queued start kick restarts into it again.
  const mark = `${ROLLED_BACK} ${failure.error}${restored.ok ? '' : ' — station still down'}`.slice(0, 300)
  for (const b of await ctx.store.builds(ev.id)) if (b.status === 'applied' || b.id === build.id) await ctx.store.setBuild(b.id, { status: 'failed', lastError: mark })
  const detail = { eventId: ev.id, buildId: build.id, when: whenLine(ev), stage: failure.stage, error: failure.error, disabled, disableErrors, queueError, ...diag }
  await ctx.store.audit('events.kick.rolled_back', 'event', ev.id, { buildId: build.id, restored: restored.ok, live: wasLive, queueError, ...(restored.ok ? {} : { rollbackError: restored.error }) })
  const idem = `rolled_back:${ev.id}:b${build.id}`
  if (!restored.ok) {
    await ctx.alert(`EVENT STATION DOWN — manual action needed: ${wasLive ? `live event ${ev.id} taken off air` : `start of event ${ev.id} failed`} and the rollback restart did not bring station 14 back (${restored.error}; backend ${restored.backend})`, { ...detail, rollbackError: restored.error, backend: restored.backend })
    await postToTicket(ctx, ev.id, 'failed', 'The Events station could not play this event and is off the air. Staff have been alerted.', idem)
    return
  }
  const what = wasLive ? `live event ${ev.id} taken off air — rolled back` : `start of event ${ev.id} failed — rolled back`
  const title = queueError ? `${what}, Event station restarted but its queue could not be purged (an event song may still play) — check the station` : wasLive ? `${what}, Event station restarted without it` : `${what}, Event station restored`
  await ctx.alert(title, detail)
  await postToTicket(
    ctx,
    ev.id,
    'failed',
    wasLive
      ? 'The Events station could not load a change to this event, so the event was taken off the air. Staff have been alerted and will look at it.'
      : 'The Events station could not start this event, so its playlists were switched off and the station was put back as it was. Staff have been alerted and will look at it.',
    idem,
  )
}
