// build / build_now / verify / recheck (plan §4 "AzuraCast compile").
//
// A build resolves every song and announcement to a LIVE station media id
// (exact path per source; custom audio must be the event owner's, live and
// not deleted), compiles the plan, then applies it idempotently:
//
//   1. one registry INTENT row per playlist is committed before its create;
//      a crash between the create and recording its id is healed by
//      adopting the single disabled, never-registered station-14 playlist
//      with exactly that name (more than one: the build fails);
//   2. playlists are created (or updated) DISABLED unless the event is live;
//   3. membership: one serialized read-merge-write per file under the
//      membership lock (membership.ts), covering the plan's files and every
//      file an earlier build of this event used;
//   4. a sequential main playlist gets its order set explicitly;
//   5. playlists are enabled; superseded ones (keys no longer in the plan)
//      are deleted;
//   6. the event becomes `built`; start/end kicks, the T−60 recheck and a
//      verify are scheduled.
//
// Everything a build writes goes through the events wrapper (allowlist.ts),
// which re-checks each write against fresh reads.

import { compile, CompileError, type CompileAnnouncement, type CompiledPlan, type CompiledPlaylist, type CompileTrack } from '../../azuracast/compiler'
import { ARCHIVED_FILE_RE, eventUploadPathFor, LEGACY_PLAYLIST_IDS, LIBRARY_FILE_RE, PLAYLIST_ID_FLOOR, STINGER_FILE_RE, type ScheduleItem } from '../../azuracast/allowlist'
import { backendOptionsOf, EventsAzuraCastError, type MediaRead, type PlaylistRead, type PlaylistScope } from '../../azuracast/client'
import { applyFileMembership } from '../../azuracast/membership'
import type { EventJobPayload } from '../../contract/jobs'
import { mainName } from '../../contract/paths'
import { RECHECK_BEFORE_MIN, START_KICK_DELAY_S } from '../../contract/rules'
import type { EventStatus } from '../../contract/types'
import type { EventsCtx } from '../ctx'
import { Permanent, Wait } from '../errors'
import type { BuildRow, EventRow, RegistryRow } from '../store'
import { postToTicket } from './tickets'

const BUILDABLE: readonly EventStatus[] = ['approved', 'built', 'live']
export const START_KICK_MAX_ATTEMPTS = 2

/**
 * A job whose event moved on (an edit sent it back to pending, bumped its
 * version, or it was withdrawn / cancelled) does nothing: the job ends done
 * and this note says why. The edit that moved it enqueued whatever the new
 * state needs (a teardown, a rebuild with its own kicks).
 */
export async function staleJob(ctx: EventsCtx, kind: string, ev: Pick<EventRow, 'id' | 'status' | 'version'>, detail: Record<string, unknown>): Promise<void> {
  await ctx.store.audit('events.job.stale', 'event', ev.id, { kind, status: ev.status, version: ev.version, ...detail })
}

export class BuildFailure extends Error {
  constructor(
    readonly code: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(code)
    this.name = 'BuildFailure'
  }
}

// ------------------------------------------------------------- resolve --

export type Resolved = {
  tracks: CompileTrack[]
  announcements: CompileAnnouncement[]
  // media id → the exact live path the wrapper will see
  paths: Map<number, string>
  dropped: { position: number; mediaId: number | null; reason: string }[]
}

async function fileOrNull(ctx: EventsCtx, id: number): Promise<MediaRead | null> {
  return ctx.az.getFileOrNull(id)
}

// Custom audio of the event owner, live, not deleted, at its exact path.
async function resolveUpload(ctx: EventsCtx, ev: EventRow, audioId: number): Promise<{ mediaId: number; path: string; lengthS: number } | { wait: string } | { drop: string }> {
  const a = await ctx.store.getAudio(audioId)
  if (!a) return { drop: 'audio_missing' }
  if (a.ownerUserId !== ev.ownerUserId || a.ownerDiscordId !== ev.ownerDiscordId) throw new BuildFailure('audio_not_owned', { audioId })
  if (a.deletedAt) return { drop: 'audio_deleted' }
  if (a.status === 'probing' || a.status === 'ready' || a.status === 'ingesting') return { wait: `audio ${a.id} is ${a.status}` }
  if (a.status !== 'live' || a.mediaId === null) return { drop: `audio_${a.status}` }
  const path = eventUploadPathFor(a.ownerDiscordId, a.id)
  const f = await fileOrNull(ctx, a.mediaId)
  if (!f || f.path !== path) return { drop: 'audio_file_missing' }
  return { mediaId: f.id, path, lengthS: typeof f.length === 'number' && f.length > 0 ? f.length : (a.durationS ?? 0) }
}

export async function resolveEvent(ctx: EventsCtx, ev: EventRow): Promise<Resolved | { wait: string }> {
  const out: Resolved = { tracks: [], announcements: [], paths: new Map(), dropped: [] }
  for (const t of await ctx.store.tracks(ev.id)) {
    if (t.source === 'library') {
      const f = t.mediaId ? await fileOrNull(ctx, t.mediaId) : null
      if (!f || !LIBRARY_FILE_RE.test(f.path)) {
        out.dropped.push({ position: t.position, mediaId: t.mediaId, reason: f ? 'not_in_library' : 'missing' })
        continue
      }
      out.paths.set(f.id, f.path)
      out.tracks.push({ position: t.position, mediaId: f.id, pinAt: t.pinAt })
    } else {
      if (!t.audioId) continue
      const r = await resolveUpload(ctx, ev, t.audioId)
      if ('wait' in r) return r
      if ('drop' in r) {
        out.dropped.push({ position: t.position, mediaId: null, reason: r.drop })
        continue
      }
      out.paths.set(r.mediaId, r.path)
      out.tracks.push({ position: t.position, mediaId: r.mediaId, pinAt: t.pinAt })
    }
  }
  for (const a of await ctx.store.announcements(ev.id)) {
    let mediaId: number
    let lengthS: number
    if (a.source === 'stinger') {
      const s = a.mediaId ? await ctx.store.stinger(a.mediaId) : null
      const f = s ? await fileOrNull(ctx, s.mediaId) : null
      if (!s || !f || f.path !== s.path || !STINGER_FILE_RE.test(f.path)) throw new BuildFailure('stinger_unavailable', { mediaId: a.mediaId })
      mediaId = f.id
      lengthS = typeof f.length === 'number' && f.length > 0 ? f.length : s.lengthS
      out.paths.set(f.id, f.path)
    } else {
      if (!a.audioId) continue
      const r = await resolveUpload(ctx, ev, a.audioId)
      if ('wait' in r) return r
      if ('drop' in r) throw new BuildFailure('announcement_audio_unavailable', { audioId: a.audioId, reason: r.drop })
      mediaId = r.mediaId
      lengthS = r.lengthS
      out.paths.set(r.mediaId, r.path)
    }
    if (!(lengthS > 0)) throw new BuildFailure('announcement_length_unknown', { mediaId })
    out.announcements.push({ mediaId, durationS: lengthS, mode: a.mode, at: a.at, everyMin: a.everyMin, from: a.fromAt, until: a.untilAt })
  }
  return out
}

// ------------------------------------------------------------- scopes ---

export function playlistScope(ev: EventRow, rows: readonly RegistryRow[]): PlaylistScope {
  const registry = new Map<number, string>()
  for (const r of rows) if (r.playlistId !== null && r.deletedAt === null) registry.set(r.playlistId, r.intentName)
  return { eventId: ev.id, window: { startsAt: ev.startsAt.getTime(), endsAt: ev.endsAt.getTime() }, registry, intentNames: new Set(rows.filter((r) => r.deletedAt === null).map((r) => r.intentName)) }
}

function scheduleIdsOf(p: PlaylistRead): number[] {
  return (p.schedule_items ?? []).map((s) => s.id).filter((x): x is number => typeof x === 'number')
}

export function planOf(b: BuildRow | null): CompiledPlan | null {
  const p = b?.plan as CompiledPlan | undefined
  return p && p.v === 1 && Array.isArray(p.playlists) ? p : null
}

// --------------------------------------------------------------- apply ---

async function markFailed(ctx: EventsCtx, ev: EventRow, build: BuildRow | null, code: string, detail: Record<string, unknown>): Promise<void> {
  if (build) await ctx.store.setBuild(build.id, { status: 'failed', lastError: code })
  await ctx.store.audit('events.build.failed', 'event', ev.id, { code, ...detail })
  await ctx.alert(`events build failed for event #${ev.id}: ${code}`, { eventId: ev.id, code, ...detail })
  await postToTicket(ctx, ev.id, 'failed', `The Events station could not be set up for this event (${code}). Staff will look at it.`, `build_failed:${ev.id}:${ev.version}:${code.slice(0, 40)}`)
}

export async function applyBuild(ctx: EventsCtx, ev: EventRow, opts: { force: boolean }): Promise<void> {
  const settings = await ctx.store.settings()
  const resolved = await resolveEvent(ctx, ev).catch(async (e) => {
    if (e instanceof BuildFailure) {
      await markFailed(ctx, ev, await ctx.store.buildFor(ev.id, ev.version), e.code, e.detail)
      return null
    }
    throw e
  })
  if (!resolved) return
  if ('wait' in resolved) {
    // Custom audio still on its way in: wait for it, but never past the
    // start (the build fails then, and staff are told).
    if (ctx.now() >= ev.startsAt.getTime()) {
      await markFailed(ctx, ev, await ctx.store.buildFor(ev.id, ev.version), 'audio_not_ready', { wait: resolved.wait })
      return
    }
    throw new Wait(120, resolved.wait, { maxAgeS: 400 * 24 * 3600 })
  }

  let plan: CompiledPlan
  try {
    plan = compile({
      event: { id: ev.id, version: ev.version, startsAt: ev.startsAt, endsAt: ev.endsAt, mainName: mainName({ visibility: ev.visibility, title: ev.title }), playlistOrder: ev.playlistOrder },
      tracks: resolved.tracks,
      announcements: resolved.announcements,
      settings: { maxRows: settings.events_max_rows, pinStrategy: settings.events_pin_strategy, announceStrategy: settings.events_announce_strategy },
      now: new Date(ctx.now()),
    })
  } catch (e) {
    if (e instanceof CompileError) {
      let b = await ctx.store.buildFor(ev.id, ev.version)
      if (!b) b = await ctx.store.createBuild(ev.id, ev.version, { v: 0, error: e.code, detail: e.detail })
      await markFailed(ctx, ev, b, e.code, e.detail)
      return
    }
    throw e
  }

  let build = await ctx.store.buildFor(ev.id, ev.version)
  if (build && build.status === 'applied' && !opts.force) return
  const previous = await ctx.store.builds(ev.id)
  if (build) await ctx.store.setBuild(build.id, { status: 'applying', plan, lastError: null })
  else build = await ctx.store.createBuild(ev.id, ev.version, plan)
  const prevApplied = previous.filter((b) => b.id !== build!.id && b.status === 'applied').at(-1) ?? null
  await ctx.store.audit('events.build.applying', 'event', ev.id, { buildId: build.id, version: ev.version, rows: plan.rowCount, warnings: plan.warnings, dropped: resolved.dropped })

  try {
    await applyPlan(ctx, ev, build, plan, resolved, previous)
  } catch (e) {
    if (e instanceof BuildFailure) {
      await markFailed(ctx, ev, build, e.code, e.detail)
      return
    }
    await ctx.store.setBuild(build.id, { lastError: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error' })
    throw e
  }

  await ctx.store.setBuild(build.id, { status: 'applied', lastError: null })
  // The web may have moved the event while the build ran (an edit back to
  // pending, a withdraw / cancel, a newer version). Then this build must not
  // mark it built or schedule kicks for the old version: the edit enqueued
  // its teardown or rebuild, which runs next.
  const fresh = await ctx.store.getEvent(ev.id)
  if (!fresh || fresh.version !== ev.version || !BUILDABLE.includes(fresh.status)) {
    await staleJob(ctx, 'build', fresh ?? ev, { buildId: build.id, buildVersion: ev.version, reason: 'event changed during the build' })
    return
  }
  await ctx.store.setEventStatus(ev.id, ['approved'], 'built')
  await ctx.store.audit('events.build.applied', 'event', ev.id, { buildId: build.id, version: ev.version })
  await scheduleKicks(ctx, ev, build, plan, planOf(prevApplied))
  if (resolved.dropped.length > 0) {
    await postToTicket(
      ctx,
      ev.id,
      'note',
      `${resolved.dropped.length} song(s) are no longer available on the station and were left out of the event playlist.`,
      `build_dropped:${ev.id}:${ev.version}`,
    )
  }
}

function rowsKey(plan: CompiledPlan | null): string {
  if (!plan) return ''
  return JSON.stringify(plan.playlists.map((p) => [p.name, p.body.schedule_items.map((r) => [r.start_date, r.start_time, r.end_time])]).sort())
}

async function scheduleKicks(ctx: EventsCtx, ev: EventRow, build: BuildRow, plan: CompiledPlan, prev: CompiledPlan | null): Promise<void> {
  const v = `v${ev.version}`
  const now = ctx.now()
  await ctx.store.enqueue('verify', { eventId: ev.id, buildId: build.id })
  await ctx.store.enqueue('start_kick', { eventId: ev.id }, { dedupeExtra: v, runAfter: new Date(ev.startsAt.getTime() + START_KICK_DELAY_S * 1000), maxAttempts: START_KICK_MAX_ATTEMPTS })
  await ctx.store.enqueue('end_kick', { eventId: ev.id }, { dedupeExtra: v, runAfter: new Date(ev.endsAt.getTime()) })
  const recheckAt = ev.startsAt.getTime() - RECHECK_BEFORE_MIN * 60_000
  if (recheckAt > now) await ctx.store.enqueue('recheck', { eventId: ev.id }, { dedupeExtra: v, runAfter: new Date(recheckAt) })
  // Staff-confirmed schedule change of a live event: the new rows only load
  // on a restart (plan §3 "While live").
  if (ev.status === 'live' && prev && rowsKey(prev) !== rowsKey(plan)) {
    await ctx.store.enqueue('start_kick', { eventId: ev.id }, { dedupeExtra: `${v}:live`, maxAttempts: START_KICK_MAX_ATTEMPTS })
  }
}

async function applyPlan(ctx: EventsCtx, ev: EventRow, build: BuildRow, plan: CompiledPlan, resolved: Resolved, previous: readonly BuildRow[]): Promise<void> {
  const live = ev.status === 'live'
  let rows = await ctx.store.registry(ev.id)
  const byName = new Map(rows.map((r) => [r.intentName, r]))
  const station = await ctx.az.listPlaylists()
  const ever = await ctx.store.everRegisteredPlaylistIds()
  const idOf = new Map<string, number>()

  // 1–2: intent rows, then create / adopt / update.
  for (const p of plan.playlists) {
    let row = byName.get(p.name)
    if (!row) {
      row = await ctx.store.insertIntent(ev.id, build.id, p.role, p.name)
      byName.set(p.name, row)
      rows = [...rows, row]
    }
    if (row.playlistId === null) {
      const orphans = station.filter((s) => s.name === p.name && s.id > PLAYLIST_ID_FLOOR && !LEGACY_PLAYLIST_IDS.includes(s.id) && !ever.has(s.id) && s.is_enabled === false)
      if (orphans.length > 1) throw new BuildFailure('ambiguous_orphan_playlists', { name: p.name, ids: orphans.map((o) => o.id) })
      let id: number
      let scheduleIds: number[] = []
      if (orphans.length === 1) {
        id = orphans[0]!.id
        await ctx.store.audit('events.registry.adopted', 'event', ev.id, { name: p.name, playlistId: id })
        await ctx.alert(`events build #${build.id}: adopted orphan playlist ${id} (${p.name})`, { eventId: ev.id, playlistId: id })
      } else {
        // The create names the intent row that is already committed.
        const made = await ctx.az.createPlaylist({ ...p.body, is_enabled: live }, playlistScope(ev, rows))
        id = made.id
        scheduleIds = scheduleIdsOf(made)
      }
      await ctx.store.setRegistryPlaylist(row.id, id, scheduleIds)
      row = { ...row, playlistId: id, scheduleIds }
      byName.set(p.name, row)
      rows = rows.map((r) => (r.id === row!.id ? row! : r))
      if (orphans.length === 1) await ctx.az.updatePlaylist(id, { ...p.body, is_enabled: live }, playlistScope(ev, rows))
    } else {
      await ctx.az.updatePlaylist(row.playlistId, { ...p.body, is_enabled: live }, playlistScope(ev, rows))
      const fresh = await ctx.az.getPlaylist(row.playlistId)
      await ctx.store.setRegistryPlaylist(row.id, row.playlistId, scheduleIdsOf(fresh))
    }
    idOf.set(p.name, row.playlistId!)
  }
  const scope = playlistScope(ev, rows)
  const planNames = new Set(plan.playlists.map((p) => p.name))
  const superseded = rows.filter((r) => r.playlistId !== null && !planNames.has(r.intentName))

  // 3: membership (serialized read-merge-write per file).
  const eventIds = new Set(rows.filter((r) => r.playlistId !== null).map((r) => r.playlistId!))
  const want = new Map<number, Set<number>>()
  for (const p of plan.playlists) for (const m of p.mediaIds) (want.get(m) ?? want.set(m, new Set()).get(m)!).add(idOf.get(p.name)!)
  const earlier = new Set<number>()
  for (const b of previous) for (const p of planOf(b)?.playlists ?? []) for (const m of p.mediaIds) earlier.add(m)
  await ctx.store.withMembershipLock(async () => {
    const station14 = new Set((await ctx.az.listPlaylists()).map((p) => p.id))
    for (const [mediaId, ids] of want) {
      const path = resolved.paths.get(mediaId)
      if (!path) throw new BuildFailure('internal_path_missing', { mediaId })
      await applyFileMembership(ctx.az, { mediaId, path, eventIds, want: ids, station14Ids: station14 })
    }
    for (const mediaId of earlier) {
      if (want.has(mediaId)) continue
      const f = await ctx.az.getFileOrNull(mediaId)
      if (!f || !f.playlists.some((x) => eventIds.has(x.id))) continue
      const removalOnly = ARCHIVED_FILE_RE.test(f.path)
      await applyFileMembership(ctx.az, { mediaId, path: f.path, eventIds, want: new Set(), station14Ids: station14, removalOnly })
    }
  })

  // 4: explicit order for a sequential main playlist.
  for (const p of plan.playlists) if (p.sequential && p.mediaIds.length > 1) await ctx.az.setOrder(idOf.get(p.name)!, p.mediaIds, scope)

  // 5: enable, then drop superseded playlists.
  if (!live) for (const p of plan.playlists) await ctx.az.updatePlaylist(idOf.get(p.name)!, { ...p.body, is_enabled: true }, scope)
  for (const r of superseded) {
    try {
      await ctx.az.deletePlaylist(r.playlistId!, scope)
    } catch (e) {
      if (!(e instanceof EventsAzuraCastError && e.code === 'not_found')) throw e
    }
    await ctx.store.markRegistryDeleted(r.id)
  }
}

// --------------------------------------------------------------- jobs ---

export async function buildJob(ctx: EventsCtx, p: EventJobPayload<'build'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const s = await ctx.store.settings()
  if (!s.events_autobuild_enabled) {
    await ctx.store.audit('events.build.skipped', 'event', ev.id, { reason: 'autobuild_disabled', version: p.version })
    return
  }
  if (ev.version !== p.version || !BUILDABLE.includes(ev.status)) {
    await staleJob(ctx, 'build', ev, { jobVersion: p.version })
    return
  }
  await applyBuild(ctx, ev, { force: false })
}

// Staff "build this event now" (manage): bypasses the autobuild flag for this
// one event id, current version.
export async function buildNowJob(ctx: EventsCtx, p: EventJobPayload<'build_now'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  if (!BUILDABLE.includes(ev.status)) {
    await staleJob(ctx, 'build_now', ev, {})
    return
  }
  await applyBuild(ctx, ev, { force: true })
}

// ------------------------------------------------------------- verify ---

// Differences between a fresh playlist read and the compiled playlist.
export function diffPlaylist(read: PlaylistRead, p: CompiledPlaylist, expectEnabled: boolean): string[] {
  const out: string[] = []
  const b = p.body
  if (read.name !== p.name) out.push('name')
  if (read.source !== undefined && read.source !== 'songs') out.push('source')
  if (read.include_in_on_demand !== undefined && read.include_in_on_demand !== false) out.push('include_in_on_demand')
  if (read.include_in_requests !== undefined && read.include_in_requests !== false) out.push('include_in_requests')
  if (read.remote_url) out.push('remote_url')
  if (read.is_enabled !== undefined && read.is_enabled !== expectEnabled) out.push('is_enabled')
  if (read.order !== undefined && read.order !== b.order) out.push('order')
  if (read.weight !== undefined && read.weight !== b.weight) out.push('weight')
  if (JSON.stringify(backendOptionsOf(read)) !== JSON.stringify([...b.backend_options].sort())) out.push('backend_options')
  const items = read.schedule_items ?? []
  for (const it of items) {
    if (!it.start_date || !it.end_date) out.push('date-less row')
    else if (it.start_date !== it.end_date) out.push('cross-date row')
    if (!(it.start_time < it.end_time)) out.push('cross-midnight or empty row')
  }
  const key = (r: Pick<ScheduleItem, 'start_date' | 'start_time' | 'end_time'> & { loop_once?: boolean }) => `${r.start_date}|${r.start_time}|${r.end_time}|${r.loop_once === true}`
  const got = items.map((i) => key({ start_date: i.start_date ?? '', start_time: i.start_time, end_time: i.end_time, loop_once: i.loop_once })).sort()
  const want = b.schedule_items.map(key).sort()
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push('schedule_items')
  return [...new Set(out)]
}

export async function verifyBuild(ctx: EventsCtx, ev: EventRow, build: BuildRow): Promise<string[]> {
  const plan = planOf(build)
  if (!plan) return ['no plan']
  const problems: string[] = []
  const rows = await ctx.store.registry(ev.id)
  const byName = new Map(rows.map((r) => [r.intentName, r]))
  const expectEnabled = ev.status === 'built' || ev.status === 'live'
  for (const p of plan.playlists) {
    const row = byName.get(p.name)
    if (!row?.playlistId) {
      problems.push(`${p.key}: not created`)
      continue
    }
    const read = await ctx.az.getPlaylistOrNull(row.playlistId)
    if (!read) {
      problems.push(`${p.key}: missing on the station`)
      continue
    }
    for (const d of diffPlaylist(read, p, expectEnabled)) problems.push(`${p.key}: ${d}`)
    for (const m of p.mediaIds) {
      const f = await ctx.az.getFileOrNull(m)
      if (!f || !f.playlists.some((x) => x.id === row.playlistId)) problems.push(`${p.key}: media ${m} not in the playlist`)
    }
    if (p.sequential && p.mediaIds.length > 1) {
      const order = (await ctx.az.getPlaylistOrder(row.playlistId)).map((e) => e.media?.id)
      if (JSON.stringify(order) !== JSON.stringify(p.mediaIds)) problems.push(`${p.key}: order`)
    }
  }
  // Orphans: station-14 playlists carrying this event's marker that the
  // registry does not know.
  const known = new Set(rows.map((r) => r.playlistId).filter((x): x is number => x !== null))
  for (const s of await ctx.az.listPlaylists()) {
    if (s.name.startsWith(`~EVT${ev.id} `) && !known.has(s.id)) problems.push(`orphan playlist ${s.id}`)
  }
  return problems
}

export async function verifyJob(ctx: EventsCtx, p: EventJobPayload<'verify'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const build = await ctx.store.getBuild(p.buildId)
  if (!build || build.eventId !== ev.id) throw new Permanent('build missing')
  if (build.status !== 'applied' || build.version !== ev.version || !BUILDABLE.includes(ev.status)) {
    await staleJob(ctx, 'verify', ev, { buildId: build.id, buildVersion: build.version, buildStatus: build.status })
    return
  }
  const problems = await verifyBuild(ctx, ev, build)
  let backend = 'n/a'
  if (ev.status === 'live') {
    try {
      const st = await ctx.az.getStatus()
      backend = st.backend_running ? 'running' : 'not running'
      if (!st.backend_running) problems.push('backend not running after the kick')
    } catch {
      backend = 'unknown'
    }
  }
  await ctx.store.audit('events.build.verified', 'event', ev.id, { buildId: build.id, problems, backend })
  if (problems.length > 0) {
    await ctx.store.setBuild(build.id, { status: 'failed', lastError: `verify: ${problems.slice(0, 5).join('; ')}` })
    await ctx.alert(`events build #${build.id} (event #${ev.id}) failed verification`, { problems: problems.slice(0, 20) })
    await postToTicket(ctx, ev.id, 'failed', 'The Events station check found a problem with this event’s setup. Staff will look at it.', `verify_failed:${ev.id}:b${build.id}:${ev.status}`)
    return
  }
  if (ev.status === 'built') {
    const plan = planOf(build)!
    const songs = plan.playlists.filter((x) => x.role !== 'announce').reduce((n, x) => n + x.mediaIds.length, 0)
    const pins = plan.playlists.filter((x) => x.role === 'pin').length
    const slots = plan.playlists.filter((x) => x.role === 'announce').reduce((n, x) => n + x.body.schedule_items.length, 0)
    await postToTicket(
      ctx,
      ev.id,
      'built',
      `Set up on the Events station: ${songs} song(s)${pins ? `, ${pins} pinned` : ''}${slots ? `, ${slots} announcement slot(s)` : ''}. It starts automatically at the event time.`,
      `built:${ev.id}:b${build.id}`,
    )
  }
}

// ------------------------------------------------------------ recheck ---

// T−60: every file of the applied plan must still be where it was (library
// songs on Music/Artists, stingers in EFM Stingers, custom audio at its
// exact path). A file that is gone or was archived is dropped from this
// event's playlists (a removal-only membership write) and the ticket is
// told. Nothing is ever added here.
export async function recheckJob(ctx: EventsCtx, p: EventJobPayload<'recheck'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  if (ev.status !== 'built') {
    await staleJob(ctx, 'recheck', ev, {})
    return
  }
  const build = await ctx.store.latestAppliedBuild(ev.id)
  const plan = planOf(build)
  if (!build || !plan || build.version !== ev.version) {
    await staleJob(ctx, 'recheck', ev, { buildVersion: build?.version ?? null })
    return
  }
  const rows = await ctx.store.registry(ev.id)
  const eventIds = new Set(rows.filter((r) => r.playlistId !== null).map((r) => r.playlistId!))
  const ownerPrefix = `Events/Uploads/${ev.ownerDiscordId}/`
  const dropped: number[] = []
  await ctx.store.withMembershipLock(async () => {
    const station14 = new Set((await ctx.az.listPlaylists()).map((x) => x.id))
    for (const pl of plan.playlists) {
      for (const m of pl.mediaIds) {
        const f = await ctx.az.getFileOrNull(m)
        const ok = f && (LIBRARY_FILE_RE.test(f.path) || STINGER_FILE_RE.test(f.path) || f.path.startsWith(ownerPrefix))
        if (ok) continue
        dropped.push(m)
        if (f && ARCHIVED_FILE_RE.test(f.path) && f.playlists.some((x) => eventIds.has(x.id))) {
          await applyFileMembership(ctx.az, { mediaId: m, path: f.path, eventIds, want: new Set(), station14Ids: station14, removalOnly: true })
        } else if (f && f.playlists.some((x) => eventIds.has(x.id))) {
          await ctx.alert(`events recheck: media ${m} of event #${ev.id} moved to ${f.path}; not removed automatically`, { eventId: ev.id, mediaId: m })
        }
      }
    }
  })
  await ctx.store.audit('events.recheck', 'event', ev.id, { dropped })
  if (dropped.length > 0) {
    await postToTicket(ctx, ev.id, 'recheck', `Pre-show check: ${dropped.length} song(s) are no longer on the station and were dropped from this event.`, `recheck:${ev.id}:v${ev.version}`)
  }
}
