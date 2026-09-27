// music-worker: the only holder of the AzuraCast key and the tickets write key.
//
// Start-up refuses unless: env is clean of web secrets; the profile guard
// passes (MUSIC_PROFILE, STATION_ID=1, PORTAL_TEST_PREFIX rules); the key
// self-check passes (own station 200, canary station 403). Then the contract
// probe runs (drift, or a spec it cannot verify, pauses the MUTATING queues
// and alerts; it does not stop the worker), and the job loop starts. While
// paused, claimJob() skips mutating kinds and the AzuraCast write gate
// refuses every write (server/pause.ts).

import { sql } from 'drizzle-orm'
import { AzuraCastClient, AzuraCastError } from '../server/azuracast/client'
import { resolveProfile, type Profile } from '../server/azuracast/guard'
import { closeDb, getDb, type DB } from '../server/db/client'
import { loadWorkerEnv, type WorkerEnv } from '../server/env'
import { enqueue } from '../server/jobs'
import { assertQueuesNotPaused, MUTATING_JOB_KINDS, PAUSED_SQL, QueuesPausedError } from '../server/pause'
import { TicketsClient } from '../server/tickets/client'
import { isP3Ctx, type P3Ctx } from './ingest/context'
import { P3_JOBS } from './ingest/jobs'
import { Scheduler } from './scheduler'
import {
  collectProbeResults,
  contractProbe,
  Permanent,
  RetryLater,
  ticketComment,
  ticketDecision,
  ticketOpen,
  type WorkerCtx,
} from './handlers'

export type StartupDeps = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }

// Everything that must hold before the worker does any work. Exported for
// the guard tests (missing profile, wrong station, missing prefix, a key that
// can read the canary station).
export async function startupChecks(deps: StartupDeps = {}): Promise<{ env: WorkerEnv; profile: Profile; azuracast: AzuraCastClient }> {
  const raw = deps.env ?? process.env
  const env = loadWorkerEnv(raw)
  const profile = resolveProfile(env)
  const azuracast = new AzuraCastClient({
    baseUrl: env.AZURACAST_BASE_URL,
    apiKey: env.AZURACAST_API_KEY,
    profile,
    canaryStationId: Number(env.AZURACAST_CANARY_STATION_ID),
    extraCanaryStationIds: env.AZURACAST_EXTRA_CANARY_STATION_IDS.split(',').filter(Boolean).map(Number),
    artDir: env.STAGING_ART_DIR,
    fetchImpl: deps.fetchImpl,
    env: raw,
  })
  await azuracast.selfCheck()
  return { env, profile, azuracast }
}

async function makeAlert(env: WorkerEnv) {
  return async (title: string, detail: Record<string, unknown>) => {
    console.error(`[alert] ${title}`, JSON.stringify(detail).slice(0, 2000))
    const tasks: Promise<unknown>[] = []
    if (env.KUMA_PUSH_URL) {
      const u = new URL(env.KUMA_PUSH_URL)
      u.searchParams.set('status', 'down')
      u.searchParams.set('msg', title.slice(0, 200))
      tasks.push(fetch(u, { redirect: 'error', signal: AbortSignal.timeout(10_000) }))
    }
    if (env.ALERT_DISCORD_WEBHOOK) {
      tasks.push(
        fetch(env.ALERT_DISCORD_WEBHOOK, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: `⚠️ EFM Music Portal: ${title}`.slice(0, 1900), allowed_mentions: { parse: [] } }),
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        }),
      )
    }
    await Promise.allSettled(tasks)
  }
}

type JobRow = { id: number; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number; age_s?: number }

export async function claimJob(db: DB): Promise<JobRow | null> {
  // Reclaim jobs whose runner died mid-flight.
  await db.execute(sql`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`)
  // While settings.queues_paused is set, mutating kinds are never claimed.
  const mutating = sql.join(
    MUTATING_JOB_KINDS.map((k) => sql`${k}`),
    sql`, `,
  )
  const rows = await db.execute<JobRow>(sql`
    UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
        AND NOT (kind IN (${mutating}) AND ${PAUSED_SQL})
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING id, kind, payload, attempts, max_attempts, (EXTRACT(EPOCH FROM now() - created_at))::int AS age_s`)
  return (rows as unknown as JobRow[])[0] ?? null
}

export async function runJob(ctx: WorkerCtx, job: JobRow): Promise<void> {
  try {
    // The pause may have been set after the claim: re-check before a
    // mutating handler starts (each handler's AzuraCast writes are gated
    // again by the wrapper's write gate).
    if (MUTATING_JOB_KINDS.includes(job.kind)) await assertQueuesNotPaused(ctx.db)
    switch (job.kind) {
      case 'ticket_open':
        await ticketOpen(ctx, job.payload as { batchId: number })
        break
      case 'ticket_comment':
        await ticketComment(ctx, job.payload as { commentId: number })
        break
      case 'ticket_decision':
        await ticketDecision(ctx, job.payload as { itemId: number })
        break
      case 'contract_probe':
        await contractProbe(ctx)
        break
      default: {
        const handler = P3_JOBS[job.kind]
        if (!handler) throw new Permanent(`unknown job kind ${job.kind}`)
        if (!isP3Ctx(ctx)) throw new Permanent(`job kind ${job.kind} needs the P3 context`)
        await handler(ctx, job.payload)
      }
    }
    await ctx.db.execute(sql`UPDATE jobs SET status = 'done', updated_at = now(), last_error = NULL WHERE id = ${job.id}`)
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : 'error'
    if (e instanceof QueuesPausedError || (e instanceof AzuraCastError && e.code === 'refused_queues_paused')) {
      // Paused: park it without spending an attempt; claimJob skips it until
      // the pause is cleared.
      await ctx.db.execute(
        sql`UPDATE jobs SET status = 'queued', locked_at = NULL, attempts = GREATEST(attempts - 1, 0), updated_at = now(), last_error = ${msg}, run_after = now() + interval '60 seconds' WHERE id = ${job.id}`,
      )
      return
    }
    if (e instanceof RetryLater) {
      // A wait, not a failure: no attempt is spent; bounded by the job's age.
      const age = Number(job.age_s ?? 0)
      if (age > e.maxAgeS) {
        await ctx.db.execute(sql`UPDATE jobs SET status = 'dead', updated_at = now(), last_error = ${msg} WHERE id = ${job.id}`)
        await ctx.alert(`job ${job.kind} #${job.id} gave up after waiting ${Math.round(age / 3600)} h`, { error: msg })
        return
      }
      const delay = Math.max(1, Math.min(86_400, Math.ceil(Math.max(e.delayS, Math.min(1800, age / 20)))))
      await ctx.db.execute(
        sql`UPDATE jobs SET status = 'queued', locked_at = NULL, attempts = GREATEST(attempts - 1, 0), updated_at = now(), last_error = ${msg}, run_after = now() + make_interval(secs => ${delay}) WHERE id = ${job.id}`,
      )
      return
    }
    if (e instanceof Permanent || job.attempts >= job.max_attempts) {
      await ctx.db.execute(sql`UPDATE jobs SET status = 'dead', updated_at = now(), last_error = ${msg} WHERE id = ${job.id}`)
      await ctx.alert(`job ${job.kind} #${job.id} failed permanently`, { error: msg })
      return
    }
    const delay = Math.min(3600, 15 * 2 ** job.attempts)
    await ctx.db.execute(
      sql`UPDATE jobs SET status = 'queued', locked_at = NULL, updated_at = now(), last_error = ${msg}, run_after = now() + make_interval(secs => ${delay}) WHERE id = ${job.id}`,
    )
  }
}

export async function main() {
  const { env, profile, azuracast } = await startupChecks()
  console.log(`[worker] profile=${profile.profile} station=${profile.stationId} prefix=${profile.testPrefix || '(none)'} self-check ok`)
  const db = getDb(env.DATABASE_URL, 3)
  azuracast.setWriteGate(() => assertQueuesNotPaused(db))
  const ctx: P3Ctx = {
    db,
    azuracast,
    tickets: new TicketsClient({ baseUrl: env.TICKETS_API_BASE, key: env.TICKETS_WRITE_KEY, portalOrigin: env.PORTAL_ORIGIN }),
    portalOrigin: env.PORTAL_ORIGIN,
    spoolOutDir: env.SPOOL_PROBE_OUT_DIR,
    alert: await makeAlert(env),
    root: profile.testPrefix,
    spoolInDir: env.SPOOL_PROBE_IN_DIR,
    finalDir: env.STAGING_FINAL_DIR,
    now: Date.now,
    kumaDiskPushUrl: env.KUMA_DISK_PUSH_URL,
    contractFixture: env.PORTAL_CONTRACT_FIXTURE,
  }
  // Fails closed on its own (pauses the mutating queues); the catch only
  // covers a DB failure while recording that.
  const scheduler = new Scheduler()
  try {
    await contractProbe(ctx)
  } catch (e) {
    await ctx.alert('contract probe could not run at start-up; mutating jobs may not be paused', { error: e instanceof Error ? e.message : 'error' })
  }

  let stopping = false
  process.on('SIGTERM', () => (stopping = true))
  process.on('SIGINT', () => (stopping = true))
  let lastDaily = Date.now()
  while (!stopping) {
    try {
      await collectProbeResults(ctx)
      await scheduler.tick(ctx)
      if (Date.now() - lastDaily > 24 * 3600_000) {
        lastDaily = Date.now()
        await enqueue(db, 'contract_probe', {}, { dedupeKey: `contract_probe:${new Date().toISOString().slice(0, 10)}` })
      }
      const job = await claimJob(db)
      if (job) {
        await runJob(ctx, job)
        continue
      }
    } catch (e) {
      console.error('[worker] loop error', e instanceof Error ? e.message : e)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  await closeDb()
  process.exit(0)
}
