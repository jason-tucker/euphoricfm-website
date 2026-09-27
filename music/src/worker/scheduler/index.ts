// Periodic worker duties (P3). Scheduler.tick() is called from the job loop;
// the first tick runs everything, so "at worker start" is covered.
//
//   library_sync      enqueue every 10 min (and after ingest goes live)
//   summary sweep     every 60 s: submitted batches with every item decided
//   auto-close sweep  hourly
//   final cleanup     hourly: /staging/final/<id>.mp3 for items live (or
//                     failed) for 7 days, via the probe (worker mount is ro)
//   disk push         every 5 min, only if KUMA_DISK_PUSH_URL is set
//   batch contract    at start and daily: behavioural /files/batch check

import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { and, eq, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../../server/audit'
import { ingestRuns, items, settings } from '../../server/db/schema'
import { enqueue } from '../../server/jobs'
import { dirname, patterns } from '../../server/paths/builder'
import { getSetting } from '../../server/settings'
import { writeSpoolRequest } from '../../server/spool/protocol'
import type { P3Ctx } from '../ingest/context'
import { getCaps } from '../ingest/window'
import { stationIdsOf } from '../library/recovery'
import { stationPlaylistIds } from '../library/playlists'
import { autoCloseSweep, summarySweep } from './tickets'

const MIN = 60_000
const DAY = 86_400_000

export async function pauseQueues(ctx: P3Ctx, reason: string, detail: Record<string, unknown>) {
  const value = { reason, at: new Date(ctx.now()).toISOString(), ...detail }
  await ctx.db
    .insert(settings)
    .values({ key: 'queues_paused', value, updatedBy: 'worker' })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date(), updatedBy: 'worker' } })
  await audit(ctx.db, { action: `contract.${reason}`, detail: value })
  await ctx.alert(`AzuraCast ${reason.replace(/_/g, ' ')}: ingest and move queues paused`, value)
}

// ------------------------------------------------------- final cleanup --

export async function finalCleanup(ctx: P3Ctx): Promise<number> {
  const cutoff = new Date(ctx.now() - 7 * DAY)
  const rows = await ctx.db
    .select({ itemId: ingestRuns.itemId, file: ingestRuns.finalFile })
    .from(ingestRuns)
    .innerJoin(items, eq(items.id, ingestRuns.itemId))
    .where(
      and(
        isNotNull(ingestRuns.finalFile),
        isNull(ingestRuns.finalRemovedAt),
        or(and(eq(items.status, 'live'), lt(items.liveAt, cutoff)), and(eq(ingestRuns.stage, 'failed'), lt(ingestRuns.updatedAt, cutoff))),
      ),
    )
    .limit(50)
  for (const r of rows) {
    await writeSpoolRequest(ctx.spoolInDir, { v: 1, id: randomUUID(), type: 'cleanup_final', file: r.file! })
    await ctx.db.update(ingestRuns).set({ finalRemovedAt: new Date(ctx.now()) }).where(eq(ingestRuns.itemId, r.itemId))
  }
  return rows.length
}

// ---------------------------------------------------------- disk push ---

export async function diskUsagePercent(dir: string): Promise<number> {
  const s = await statfs(dir)
  if (!s.blocks) return 0
  return Math.round((1 - s.bavail / s.blocks) * 1000) / 10
}

// Kuma push monitor: up below the pause threshold (85 %), down at or above.
// No URL configured → no-op.
export async function diskPush(ctx: P3Ctx): Promise<{ pushed: boolean; percent?: number }> {
  if (!ctx.kumaDiskPushUrl) return { pushed: false }
  const percent = await diskUsagePercent(ctx.finalDir)
  const limit = (await getCaps(ctx.db)).diskPausePercent
  const u = new URL(ctx.kumaDiskPushUrl)
  u.searchParams.set('status', percent >= limit ? 'down' : 'up')
  u.searchParams.set('msg', `music staging disk ${percent}%`)
  await (ctx.fetchImpl ?? fetch)(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) })
  return { pushed: true, percent }
}

// ------------------------------------------------ batch contract check --

const batchReply = z.object({ success: z.boolean(), errors: z.array(z.string()), files: z.array(z.string()).optional() }).passthrough()

// PUT /files/batch has no requestBody schema in the spec (P0d-A), so the
// hash probe cannot see its drift. This re-applies the fixture's CURRENT
// station memberships (a no-op replace) and checks the documented reply
// {success:true, errors:[], files:[<path>]} and that path + memberships are
// unchanged afterwards. Only under PORTAL_TEST_PREFIX, on a configured
// fixture; otherwise it logs and skips.
export async function batchContractCheck(ctx: P3Ctx): Promise<'ok' | 'skipped' | 'drift'> {
  const fixture = ctx.contractFixture
  if (!ctx.root || !fixture) {
    console.log(`[worker] batch contract check skipped (${!ctx.root ? 'no PORTAL_TEST_PREFIX' : 'no PORTAL_CONTRACT_FIXTURE'})`)
    return 'skipped'
  }
  if (!fixture.startsWith(ctx.root) || !patterns(ctx.root).artistFile.test(fixture)) {
    console.log('[worker] batch contract check skipped (PORTAL_CONTRACT_FIXTURE is not a file under PORTAL_TEST_PREFIX/Music/Artists/)')
    return 'skipped'
  }
  const entry = (await ctx.azuracast.listDirectory(dirname(fixture))).find((e) => e.path === fixture)
  if (!entry?.media) {
    console.log(`[worker] batch contract check skipped (fixture not found: ${fixture})`)
    return 'skipped'
  }
  if (await getSetting(ctx.db, 'queues_paused')) {
    console.log('[worker] batch contract check skipped (queues paused)')
    return 'skipped'
  }
  const stationIds = await stationPlaylistIds(ctx.db)
  const current = stationIdsOf(entry.media, stationIds)
  const res = await ctx.azuracast.setPlaylistsReply(fixture, current, new Set(current))
  const problems: string[] = []
  let parsed: z.infer<typeof batchReply> | null = null
  const r = batchReply.safeParse(res.reply)
  if (r.success) parsed = r.data
  else problems.push(res.reply === null ? 'reply is not JSON' : 'reply shape changed')
  if (res.status !== 200) problems.push(`HTTP ${res.status}`)
  if (parsed && (!parsed.success || parsed.errors.length > 0)) problems.push('reply reports errors')
  if (parsed && (parsed.files?.length !== 1 || parsed.files[0] !== fixture)) problems.push('files echo changed')
  const after = await ctx.azuracast.getFile(entry.media.id).catch(() => null)
  if (!after || after.path !== fixture) problems.push('fixture path changed')
  else if (JSON.stringify(stationIdsOf(after, stationIds)) !== JSON.stringify(current)) problems.push('memberships changed')
  if (problems.length === 0) return 'ok'
  await pauseQueues(ctx, 'batch_contract_drift', { problems, fixture })
  return 'drift'
}

// ------------------------------------------------------------ scheduler --

type Task = { name: string; everyMs: number; run: (ctx: P3Ctx) => Promise<unknown> }

export const TASKS: readonly Task[] = [
  {
    name: 'library_sync',
    everyMs: 10 * MIN,
    run: (ctx) => enqueue(ctx.db, 'library_sync', {}, { dedupeKey: `library_sync:${Math.floor(ctx.now() / (10 * MIN))}` }),
  },
  { name: 'summary', everyMs: MIN, run: summarySweep },
  { name: 'autoclose', everyMs: 60 * MIN, run: autoCloseSweep },
  { name: 'final_cleanup', everyMs: 60 * MIN, run: finalCleanup },
  { name: 'disk_push', everyMs: 5 * MIN, run: diskPush },
  { name: 'batch_contract', everyMs: DAY, run: batchContractCheck },
]

export class Scheduler {
  private readonly last = new Map<string, number>()
  constructor(private readonly tasks: readonly Task[] = TASKS) {}

  async tick(ctx: P3Ctx): Promise<void> {
    const now = ctx.now()
    for (const t of this.tasks) {
      const prev = this.last.get(t.name)
      if (prev !== undefined && now - prev < t.everyMs) continue
      this.last.set(t.name, now)
      try {
        await t.run(ctx)
      } catch (e) {
        console.error(`[worker] scheduled ${t.name} failed:`, e instanceof Error ? `${e.name}: ${e.message}` : e)
      }
    }
  }
}
