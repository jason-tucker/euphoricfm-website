// build / build_now / verify / recheck (plan §4 "AzuraCast compile").
//
// A build resolves every song and announcement to a LIVE station media id
// (exact path per source; custom audio must be the event owner's, live and
// not deleted), compiles the plan, then applies it idempotently:
//
//   1. one registry INTENT row per playlist is committed before its create,
//      and a create-attempt marker (build id + the highest station-14 id
//      before the POST) right before the POST; a crash between the create
//      and recording its id is healed by adopting the single disabled,
//      never-registered playlist with exactly that name and an id above the
//      marker — only for an intent row left by an EARLIER attempt. Any
//      other same-named disabled, never-registered playlist (e.g. a staff
//      playlist a member title matches) fails the build and pages staff;
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
import { buildInputKey } from '../../contract/build-key'
import type { EventJobPayload } from '../../contract/jobs'
import { isCurrentPlaylistName, mainName, parseAnyInternalName } from '../../contract/paths'
import { RECHECK_BEFORE_MIN, START_KICK_DELAY_S } from '../../contract/rules'
import type { EventStatus } from '../../contract/types'
import type { EventsCtx } from '../ctx'
import { Permanent, Wait } from '../errors'
import type { AnnouncementRow, BuildRow, EventRow, RegistryRow, TrackRow } from '../store'
import { postToTicket, whenLine } from './tickets'

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
  // contract/build-key.ts of exactly the rows resolved here
  inputKey: string
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

const inputKeyOf = (ev: EventRow, tracks: readonly TrackRow[], anns: readonly AnnouncementRow[]) =>
  buildInputKey(ev, tracks, anns.map((a) => ({ ...a, from: a.fromAt, until: a.untilAt })))

/** The build-input key of the event as it is now (its current rows). */
export async function currentInputKey(ctx: EventsCtx, ev: EventRow): Promise<string> {
  return inputKeyOf(ev, await ctx.store.tracks(ev.id), await ctx.store.announcements(ev.id))
}

/**
 * Whether an applied build still is the event's build: same version, or
 * compiled from the same build inputs (a details-only edit — description,
 * host, location, type — bumps the version but changes nothing on the
 * station).
 */
export async function buildIsCurrent(ctx: EventsCtx, ev: EventRow, build: BuildRow): Promise<boolean> {
  // A plan that still names a pre-0.5.2 '~' helper playlist would put that
  // name into the Liquidsoap config on the next restart (the 2026-09-29
  // outage): it is never current, whatever its version — it needs a rebuild,
  // which supersedes (creates the new names, deletes the old playlists).
  if (planHasLegacyNames(planOf(build))) return false
  if (build.version === ev.version) return true
  const key = planOf(build)?.inputKey
  return typeof key === 'string' && key === (await currentInputKey(ctx, ev))
}

export async function resolveEvent(ctx: EventsCtx, ev: EventRow): Promise<Resolved | { wait: string }> {
  const trackRows = await ctx.store.tracks(ev.id)
  const annRows = await ctx.store.announcements(ev.id)
  const out: Resolved = { tracks: [], announcements: [], paths: new Map(), dropped: [], inputKey: inputKeyOf(ev, trackRows, annRows) }
  for (const t of trackRows) {
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
  for (const a of annRows) {
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

// event_registry.schedule_ids: AzuraCast's ids of the playlist's schedule
// rows (station 14 answers them on GET /playlist as schedule_items[].id).
// Taken from the create response when it carries one per row sent, else
// from a fresh GET. A full-body PUT sends the rows without ids, which
// AzuraCast's setScheduleItems replaces with new rows (new ids), so every
// such PUT is followed by a fresh GET too.
async function scheduleIdsAfterWrite(ctx: EventsCtx, playlistId: number, rowsSent: number, response: PlaylistRead | null): Promise<number[]> {
  const fromResponse = response ? scheduleIdsOf(response) : []
  if (response && fromResponse.length === rowsSent) return fromResponse
  const fresh = await ctx.az.getPlaylist(playlistId)
  return scheduleIdsOf(fresh)
}

export function planOf(b: BuildRow | null): CompiledPlan | null {
  const p = b?.plan as CompiledPlan | undefined
  return p && p.v === 1 && Array.isArray(p.playlists) ? p : null
}

/** Whether a plan names any playlist the current contract no longer emits (a legacy '~' name). */
export function planHasLegacyNames(plan: CompiledPlan | null): boolean {
  return !!plan && plan.playlists.some((p) => typeof p.name !== 'string' || !isCurrentPlaylistName(p.name))
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
    plan = { ...plan, inputKey: resolved.inputKey }
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
  // An applied build is re-applied only when forced, or when its plan still
  // names legacy '~' playlists (a name change is a supersede: step 5 deletes
  // the old registry playlists once the new ones are in place).
  if (build && build.status === 'applied' && !opts.force && !planHasLegacyNames(planOf(build))) return
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
  // A details-only edit meanwhile (same build inputs) does not make it stale.
  const fresh = await ctx.store.getEvent(ev.id)
  if (!fresh || !BUILDABLE.includes(fresh.status) || (fresh.version !== ev.version && (await currentInputKey(ctx, fresh)) !== resolved.inputKey)) {
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

// Same-named station-14 playlists no registry row ever held, above the
// floor, not legacy, disabled: what a crash between a create and recording
// its id would leave behind — but also what a member-chosen title could
// collide with (a disabled staff playlist kept for later).
function orphanCandidates(station: readonly PlaylistRead[], name: string, ever: ReadonlySet<number>): PlaylistRead[] {
  return station.filter((s) => s.name === name && s.id > PLAYLIST_ID_FLOOR && !LEGACY_PLAYLIST_IDS.includes(s.id) && !ever.has(s.id) && s.is_enabled === false)
}

/**
 * Whether the intent row's playlist may be adopted instead of created, and
 * which one. Adoption needs PROOF that this worker created it: the row
 * existed before this build attempt (never one inserted just now), it
 * carries a create-attempt marker for this event and name, and exactly one
 * candidate has an id above the highest id that existed right before that
 * attempt. A same-named candidate without that proof fails the build (and
 * pages staff) — it is never adopted, never duplicated.
 */
async function adoptableOrphan(ctx: EventsCtx, ev: EventRow, row: RegistryRow, preexisting: boolean, candidates: readonly PlaylistRead[]): Promise<PlaylistRead | null> {
  const marker = preexisting ? await ctx.store.createAttempt(row.id) : null
  const proven = marker && marker.eventId === ev.id && marker.name === row.intentName ? candidates.filter((c) => c.id > marker.maxIdBefore) : []
  const unproven = candidates.filter((c) => !proven.includes(c))
  if (unproven.length > 0) throw new BuildFailure('playlist_name_collision', { name: row.intentName, ids: unproven.map((c) => c.id) })
  if (proven.length > 1) throw new BuildFailure('ambiguous_orphan_playlists', { name: row.intentName, ids: proven.map((o) => o.id) })
  return proven[0] ?? null
}

async function applyPlan(ctx: EventsCtx, ev: EventRow, build: BuildRow, plan: CompiledPlan, resolved: Resolved, previous: readonly BuildRow[]): Promise<void> {
  const live = ev.status === 'live'
  let rows = await ctx.store.registry(ev.id)
  // Intent rows that existed before this attempt (the only ones a crash
  // can have left without a recorded id).
  const preexisting = new Set(rows.map((r) => r.id))
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
      const orphan = await adoptableOrphan(ctx, ev, row, preexisting.has(row.id), orphanCandidates(station, p.name, ever))
      let id: number
      let made: PlaylistRead | null = null
      if (orphan) {
        id = orphan.id
        await ctx.store.audit('events.registry.adopted', 'event', ev.id, { name: p.name, playlistId: id, rowId: row.id })
        await ctx.alert(`events build #${build.id}: adopted orphan playlist ${id} (${p.name})`, { eventId: ev.id, playlistId: id })
      } else {
        // The create-attempt marker commits before the POST (with the
        // highest id on the station right now), then the create names the
        // intent row that is already committed.
        const before = await ctx.az.listPlaylists()
        await ctx.store.markCreateAttempt(row.id, { eventId: ev.id, buildId: build.id, name: p.name, maxIdBefore: before.reduce((m, x) => Math.max(m, x.id), 0) })
        made = await ctx.az.createPlaylist({ ...p.body, is_enabled: live }, playlistScope(ev, rows))
        id = made.id
      }
      // The id is recorded first (crash safety: never an unrecorded
      // playlist), with whatever schedule ids the create answered.
      const firstIds = made ? scheduleIdsOf(made) : []
      await ctx.store.setRegistryPlaylist(row.id, id, firstIds)
      row = { ...row, playlistId: id, scheduleIds: firstIds }
      byName.set(p.name, row)
      rows = rows.map((r) => (r.id === row!.id ? row! : r))
      if (orphan) await ctx.az.updatePlaylist(id, { ...p.body, is_enabled: live }, playlistScope(ev, rows))
      const scheduleIds = await scheduleIdsAfterWrite(ctx, id, p.body.schedule_items.length, made)
      if (JSON.stringify(scheduleIds) !== JSON.stringify(firstIds)) {
        await ctx.store.setRegistryPlaylist(row.id, id, scheduleIds)
        row = { ...row, scheduleIds }
        byName.set(p.name, row)
        rows = rows.map((r) => (r.id === row!.id ? row! : r))
      }
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
  if (!live) {
    for (const p of plan.playlists) {
      const id = idOf.get(p.name)!
      await ctx.az.updatePlaylist(id, { ...p.body, is_enabled: true }, scope)
      await ctx.store.setRegistryPlaylist(byName.get(p.name)!.id, id, await scheduleIdsAfterWrite(ctx, id, p.body.schedule_items.length, null))
    }
  }
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

// A staff edit changed build inputs while events_autobuild_enabled is off
// (service.ts editJobs). Nothing rebuilds by itself then, and the start
// kick refuses a stale build: page staff and note the ticket — only when
// the applied build really is stale by now (a later edit may have reverted
// it, or someone pressed Build now meanwhile).
export async function rebuildNeededJob(ctx: EventsCtx, p: EventJobPayload<'rebuild_needed'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  if (!BUILDABLE.includes(ev.status)) {
    await staleJob(ctx, 'rebuild_needed', ev, { jobVersion: p.version })
    return
  }
  const build = await ctx.store.latestAppliedBuild(ev.id)
  if (!build || (await buildIsCurrent(ctx, ev, build))) {
    await ctx.store.audit('events.build.rebuild_not_needed', 'event', ev.id, { jobVersion: p.version, version: ev.version, buildId: build?.id ?? null })
    return
  }
  await ctx.store.audit('events.build.rebuild_needed', 'event', ev.id, { jobVersion: p.version, version: ev.version, buildId: build.id, buildVersion: build.version })
  await ctx.alert(`events event #${ev.id} (${whenLine(ev)}) needs rebuild — press Build now: a staff edit changed what the station airs and autobuild is off`, { eventId: ev.id, version: ev.version, buildVersion: build.version })
  await postToTicket(ctx, ev.id, 'note', 'Staff changed this event. It needs a rebuild on the Events station before it airs; staff have been alerted.', `rebuild_needed:${ev.id}:v${ev.version}`)
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
      const order = await ctx.az
        .playlistMediaOrder(row.playlistId)
        .then((o) => o.map((e) => e.mediaId))
        .catch((e: unknown) => (e instanceof EventsAzuraCastError && e.code.startsWith('order_') ? null : Promise.reject(e)))
      if (!order || JSON.stringify(order) !== JSON.stringify(p.mediaIds)) problems.push(`${p.key}: order`)
    }
  }
  // Orphans: station-14 playlists carrying this event's helper name (current
  // `EVT<id> …` or legacy `~EVT<id> …`) that the registry does not know.
  const known = new Set(rows.map((r) => r.playlistId).filter((x): x is number => x !== null))
  for (const s of await ctx.az.listPlaylists()) {
    if (parseAnyInternalName(s.name)?.eventId === ev.id && !known.has(s.id)) problems.push(`orphan playlist ${s.id}`)
  }
  // A registry playlist still carrying a legacy '~' name is a broken
  // Liquidsoap identifier waiting for the next restart.
  for (const r of rows) if (r.playlistId !== null && !isCurrentPlaylistName(r.intentName)) problems.push(`legacy playlist name ${r.playlistId} (${r.intentName}): rebuild to supersede it`)
  return problems
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

// Reads station 14's liquidsoap log. A log that cannot be read is recorded,
// not a verify failure. `banner`: whether any start banner is in the log.
async function liquidsoapLogCheck(ctx: EventsCtx): Promise<{ state: string; errors: string[]; banner: boolean | null }> {
  try {
    const contents = await readLiquidsoapLog(ctx)
    if (contents === null) return { state: 'no liquidsoap log', errors: [], banner: null }
    const errors = liquidsoapConfigErrors(contents)
    return { state: errors.length ? 'config errors' : 'clean', errors, banner: lastLiquidsoapBanner(contents) !== null }
  } catch (e) {
    return { state: `unreadable (${e instanceof EventsAzuraCastError ? e.code : e instanceof Error ? e.name : 'error'})`, errors: [], banner: null }
  }
}

export async function verifyJob(ctx: EventsCtx, p: EventJobPayload<'verify'>): Promise<void> {
  const ev = await ctx.store.getEvent(p.eventId)
  if (!ev) throw new Permanent('event missing')
  const build = await ctx.store.getBuild(p.buildId)
  if (!build || build.eventId !== ev.id) throw new Permanent('build missing')
  if (build.status !== 'applied' || !BUILDABLE.includes(ev.status) || !(await buildIsCurrent(ctx, ev, build))) {
    await staleJob(ctx, 'verify', ev, { buildId: build.id, buildVersion: build.version, buildStatus: build.status })
    return
  }
  const problems = await verifyBuild(ctx, ev, build)
  let backend = 'n/a'
  let liquidsoapLog = 'n/a'
  if (ev.status === 'live') {
    try {
      const st = await ctx.az.getStatus()
      backend = st.backend_running ? 'running' : 'not running'
      if (!st.backend_running) problems.push('backend not running after the kick')
    } catch {
      backend = 'unknown'
    }
    // After a kick: the regenerated config must have loaded cleanly.
    const since = await ctx.store.lastStartKickMs(ev.id)
    if (since !== null) {
      const log = await liquidsoapLogCheck(ctx)
      liquidsoapLog = log.state
      for (const e of log.errors) problems.push(`liquidsoap: ${e}`)
      if (log.banner === false && backend === 'not running') problems.push('liquidsoap: did not start (no start banner, backend not running)')
    }
  }
  await ctx.store.audit('events.build.verified', 'event', ev.id, { buildId: build.id, problems, backend, liquidsoapLog })
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
  if (!build || !plan || !(await buildIsCurrent(ctx, ev, build))) {
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
