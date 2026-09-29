// events-worker (bundled to /app/events-worker.mjs by scripts/bundle.mjs;
// compose runs it with `command: ["node", "/app/events-worker.mjs"]`).
//
// The only holder of the Events AzuraCast key (station 14) and the efm-events
// tickets key. Start-up refuses unless: the env is clean (no music keys, no
// web secrets; loadEventsWorkerEnv); EVENTS_STATION_ID is 14; the key reads
// station 14 (200) and every canary station answers 403. The folder-link
// check blocks ingest (not the worker) while a station-14 folder link
// covers Events/Uploads. The same key self-check re-runs daily; a failure
// exits (the container restart then refuses to start: fail closed).

import { closeDb, getDb } from '../../server/db/client'
import { loadEventsWorkerEnv, type EventsWorkerEnv } from '../../server/env'
import { TicketsClient } from '../../server/tickets/client'
import { makeAlert } from '../../worker/alert'
import { EVENTS_STATION_ID } from '../azuracast/allowlist'
import { EventsAzuraCastClient } from '../azuracast/client'
import { folderLinkCheck, keySelfCheck, type FolderLinkReport } from '../azuracast/selfcheck'
import type { EventsCtx } from './ctx'
import { EVENTS_MUTATING_KINDS, runEventJob, tickPeriodic, type PeriodicState } from './loop'
import { PgEventsStore } from './store-pg'

export type EventsStartupDeps = { env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }

export async function eventsStartupChecks(deps: EventsStartupDeps = {}): Promise<{ env: EventsWorkerEnv; az: EventsAzuraCastClient; links: FolderLinkReport }> {
  const env = loadEventsWorkerEnv(deps.env ?? process.env)
  const stationId = Number(env.EVENTS_STATION_ID)
  if (stationId !== EVENTS_STATION_ID) throw new Error(`events-worker refuses to start: EVENTS_STATION_ID must be ${EVENTS_STATION_ID}`)
  const az = new EventsAzuraCastClient({
    baseUrl: env.AZURACAST_BASE_URL,
    apiKey: env.EVENTS_AZURACAST_API_KEY,
    stationId,
    canaryStationIds: env.EVENTS_CANARY_STATION_IDS,
    fetchImpl: deps.fetchImpl,
  })
  await keySelfCheck(az)
  const links = await folderLinkCheck(az)
  return { env, az, links }
}

/**
 * Alerts: the music worker's makeAlert (stderr, plus the optional
 * ALERT_DISCORD_WEBHOOK so a failed start kick can page), then an audit row.
 */
export async function eventsAlerter(store: Pick<PgEventsStore, 'audit'>, env: Pick<EventsWorkerEnv, 'ALERT_DISCORD_WEBHOOK'>) {
  const page = await makeAlert({ ALERT_DISCORD_WEBHOOK: env.ALERT_DISCORD_WEBHOOK }, 'EFM Events Portal')
  return async (title: string, detail: Record<string, unknown>) => {
    await page(title, detail)
    try {
      await store.audit('events.alert', 'events_worker', 0, { title: title.slice(0, 300), detail })
    } catch {
      // the log line written by makeAlert is the fallback
    }
  }
}

export async function main(): Promise<void> {
  const { env, az, links } = await eventsStartupChecks()
  console.log(`[events-worker] station=${EVENTS_STATION_ID} canaries=${az.canaryStationIds.join(',')} self-check ok; ingest ${links.ok ? 'open' : 'BLOCKED (folder link)'}`)
  const db = getDb(env.DATABASE_URL, 3)
  const store = new PgEventsStore(db)
  az.setWriteGate(async () => {
    if (await store.queuesPaused()) throw new Error('queues paused')
  })
  const ctx: EventsCtx = {
    store,
    az,
    tickets: new TicketsClient({ baseUrl: env.TICKETS_API_BASE, key: env.EVENTS_TICKETS_WRITE_KEY, portalOrigin: env.PORTAL_ORIGIN }),
    origin: env.PORTAL_ORIGIN,
    spoolInDir: env.SPOOL_PROBE_IN_DIR,
    spoolOutDir: env.SPOOL_PROBE_OUT_DIR,
    finalDir: env.STAGING_FINAL_DIR,
    now: Date.now,
    alert: await eventsAlerter(store, env),
    ingestBlocked: links.ok ? null : `folder link covers ${links.linked.map((l) => l.folder).join(', ')}`,
  }
  if (!links.ok) await ctx.alert('events ingest blocked at start-up: a station-14 folder link covers Events/Uploads', { linked: links.linked })

  let stopping = false
  process.on('SIGTERM', () => (stopping = true))
  process.on('SIGINT', () => (stopping = true))
  const periodic: PeriodicState = {}
  let lastKeyCheck = Date.now()
  while (!stopping) {
    try {
      if (Date.now() - lastKeyCheck > 24 * 3600_000) {
        lastKeyCheck = Date.now()
        try {
          await keySelfCheck(az)
        } catch (e) {
          await ctx.alert('events AzuraCast key self-check failed: events-worker stops', { error: e instanceof Error ? e.message : 'error' })
          await closeDb()
          process.exit(1)
        }
      }
      await tickPeriodic(ctx, periodic)
      const job = await store.claimJob(EVENTS_MUTATING_KINDS)
      if (job) {
        await runEventJob(ctx, job)
        continue
      }
    } catch (e) {
      console.error('[events-worker] loop error', e instanceof Error ? e.message : e)
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  await closeDb()
  process.exit(0)
}
