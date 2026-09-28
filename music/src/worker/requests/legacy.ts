// v0.3.6: the READ-ONLY half of the UNRELEASED import: list the folder,
// build the plan (every planned move, the playlists each file loses, what is
// refused or skipped), format it for the dry run, and the legacy_import_plan
// job that stores it for the manager's confirm. The writes are the
// import_legacy_archive job (requests/jobs.ts importLegacyArchive).

import { and, inArray, sql } from 'drizzle-orm'
import type { AzuraCastClient, ListEntry, StationMedia } from '../../server/azuracast/client'
import { audit } from '../../server/audit'
import { archive } from '../../server/db/schema'
import { archiveDirPath, basename, isLegacySource, LEGACY_UNRELEASED_DIR } from '../../server/paths/builder'
import {
  PLAN_KEY,
  SLOT_MS,
  summarize,
  type LegacyPlan,
  type LegacyPlanFile,
  type LegacyPlanOther,
} from '../../server/requests/legacy-import'
import { getSetting } from '../../server/settings'
import { DEFAULT_SETTINGS } from '../../server/settings-defaults'
import type { WorkerCtx } from '../handlers'
import { stationPlaylistSet } from './media'

// The folder and everything below it (the live one has Music/KOKORO/), at
// most 4 levels and 100 folders. Every listing flushes AzuraCast's cache.
export async function listLegacyFolder(az: Pick<AzuraCastClient, 'listDirectory'>, root: string): Promise<ListEntry[]> {
  const out: ListEntry[] = []
  const queue: { dir: string; depth: number }[] = [{ dir: `${root}${LEGACY_UNRELEASED_DIR}`, depth: 0 }]
  let dirs = 0
  while (queue.length) {
    const { dir, depth } = queue.shift()!
    if (++dirs > 100) throw new Error('legacy folder: more than 100 folders')
    for (const e of await az.listDirectory(dir)) {
      if (e.type === 'directory') {
        if (depth < 3) queue.push({ dir: e.path, depth: depth + 1 })
        else out.push(e)
      } else out.push(e)
    }
  }
  return out
}

const ids = (m: Pick<StationMedia, 'playlists'> | null | undefined) => [...new Set((m?.playlists ?? []).map((p) => p.id))].sort((a, b) => a - b)

// Pure: the plan from the listed entries and each media's current row (GET,
// the authoritative memberships). `open`: media ids with an open archive
// row; `queued`: media ids with a queued/running import job.
export function buildLegacyPlan(opts: {
  root: string
  entries: readonly ListEntry[]
  rows: ReadonlyMap<number, StationMedia>
  station: ReadonlySet<number>
  open: ReadonlyMap<number, string>
  queued: ReadonlySet<number>
  playlistNames?: Record<string, string>
}): LegacyPlan {
  const files: LegacyPlanFile[] = []
  const others: LegacyPlanOther[] = []
  for (const e of opts.entries) {
    const id = e.media?.id
    if (e.type !== 'media' || !id) {
      others.push({ path: e.path, type: e.type, reason: e.text === 'File Processing' ? 'not_scanned' : 'not_a_media_row' })
      continue
    }
    const m = opts.rows.get(id) ?? e.media!
    if (m.path !== e.path || !isLegacySource(opts.root, m.path)) {
      others.push({ path: e.path, type: e.type, reason: 'unsupported_path' })
      continue
    }
    const all = ids(m)
    const station = all.filter((p) => opts.station.has(p))
    const foreign = all.filter((p) => !opts.station.has(p))
    const openStatus = opts.open.get(id)
    const action: LegacyPlanFile['action'] = openStatus ? 'skip_archived' : opts.queued.has(id) ? 'skip_queued' : foreign.length ? 'refuse_events' : 'archive'
    files.push({
      mediaId: id,
      path: m.path,
      dest: `${archiveDirPath(opts.root, id)}/${basename(m.path)}`,
      artist: m.artist ?? null,
      title: m.title ?? null,
      lengthS: typeof m.length === 'number' ? Math.round(m.length) : null,
      playlistIds: station,
      foreignPlaylistIds: foreign,
      action,
      ...(openStatus ? { note: `archive row ${openStatus}` } : {}),
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { root: opts.root, folder: `${opts.root}${LEGACY_UNRELEASED_DIR}/`, files, others, playlistNames: opts.playlistNames ?? {}, summary: summarize(files, others) }
}

export async function planLegacyImport(ctx: Pick<WorkerCtx, 'db' | 'azuracast'> & { root: string }): Promise<LegacyPlan> {
  const station = await stationPlaylistSet(ctx.db)
  const entries = await listLegacyFolder(ctx.azuracast, ctx.root)
  const rows = new Map<number, StationMedia>()
  for (const e of entries) {
    const id = e.media?.id
    if (e.type === 'media' && id) rows.set(id, await ctx.azuracast.getFile(id))
  }
  const mediaIds = [...rows.keys()]
  const open = new Map<number, string>()
  if (mediaIds.length) {
    const rs = await ctx.db
      .select({ mediaId: archive.mediaId, status: archive.status })
      .from(archive)
      .where(and(inArray(archive.mediaId, mediaIds), inArray(archive.status, ['archiving', 'archived', 'restoring'])))
    for (const r of rs) open.set(r.mediaId, r.status)
  }
  const q = await ctx.db.execute<{ id: string }>(sql`SELECT payload->>'mediaId' AS id FROM jobs WHERE kind = 'import_legacy_archive' AND status IN ('queued', 'running')`)
  const queued = new Set((q as unknown as { id: string }[]).map((r) => Number(r.id)))
  const names = await getSetting(ctx.db, 'playlist_names')
  const playlistNames = { ...(DEFAULT_SETTINGS.playlist_names as Record<string, string>), ...(names && typeof names === 'object' ? (names as Record<string, string>) : {}) }
  return buildLegacyPlan({ root: ctx.root, entries, rows, station, open, queued, playlistNames })
}

const plName = (plan: LegacyPlan, id: number) => (plan.playlistNames[String(id)] ? `${id} (${plan.playlistNames[String(id)]})` : String(id))

// The dry run, as text (CLI; the admin page renders the same plan as a table).
export function formatPlan(plan: LegacyPlan): string {
  const s = plan.summary
  const lines = [
    'Legacy UNRELEASED import: DRY RUN (nothing was written)',
    `Folder: ${plan.folder}`,
    `${plan.files.length} media file(s): ${s.archive} to archive (${s.offAir} of them leave rotation), ${s.refused} refused (Events playlists), ${s.skipped} skipped; ${s.others} other entr${s.others === 1 ? 'y' : 'ies'} not moved`,
    '',
  ]
  for (const f of plan.files) {
    const what =
      f.action === 'archive'
        ? f.playlistIds.length
          ? `clear playlists ${f.playlistIds.map((id) => plName(plan, id)).join(', ')} (comes off the air)`
          : 'no playlists'
        : f.action === 'refuse_events'
          ? `REFUSED: in Events playlist(s) ${f.foreignPlaylistIds.join(', ')} (station 14); nothing is changed`
          : `SKIPPED: ${f.action === 'skip_archived' ? f.note ?? 'already archived' : 'an import job is already queued'}`
    lines.push(`#${f.mediaId}  ${f.path}`, `        → ${f.dest}`, `        ${f.artist ?? '?'} — ${f.title ?? '?'} · ${what}`)
  }
  if (plan.others.length) {
    lines.push('', 'Not moved (not a scanned .mp3/.m4a media row):')
    for (const o of plan.others) lines.push(`  ${o.path} (${o.reason})`)
  }
  const n = s.archive + s.refused
  if (n) lines.push('', `Pacing: one file per scan window (5 min): about ${Math.ceil((n * SLOT_MS) / 60_000)} min for ${n} file(s).`)
  return lines.join('\n')
}

// Job: compute the plan the manager asked for and store it under its id
// (only while that request is still the current one). Read-only towards
// AzuraCast; a failure is stored as the plan's state and alerted.
export async function legacyImportPlanJob(ctx: WorkerCtx & { root: string }, payload: { planId?: unknown }): Promise<void> {
  const planId = typeof payload.planId === 'string' ? payload.planId : ''
  if (!/^[0-9a-f-]{36}$/.test(planId)) return
  const at = new Date().toISOString()
  let value: Record<string, unknown>
  try {
    const plan = await planLegacyImport(ctx)
    value = { status: 'ready', readyAt: at, plan }
  } catch (e) {
    const error = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error'
    value = { status: 'failed', failedAt: at, error }
    await ctx.alert('legacy import dry run failed', { planId, error })
  }
  const rows = await ctx.db.execute(sql`
    UPDATE settings SET value = value || ${JSON.stringify(value)}::jsonb, updated_at = now(), updated_by = 'worker'
    WHERE key = ${PLAN_KEY} AND value->>'id' = ${planId} AND value->>'status' = 'queued'
    RETURNING key`)
  if ((rows as unknown as unknown[]).length) {
    const p = value.plan as LegacyPlan | undefined
    await audit(ctx.db, { action: 'legacy_import.planned', targetType: 'legacy_import', targetId: planId, detail: { status: value.status, summary: p?.summary ?? null } })
  }
}
