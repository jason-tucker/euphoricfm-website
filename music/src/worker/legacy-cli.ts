// v0.3.6 operator CLI for the UNRELEASED import, run INSIDE the worker
// container (it needs the worker's env: the AzuraCast key, the profile, the
// database):
//
//   docker compose -p efm-music exec music-worker node /app/legacy-import.mjs dry-run
//   docker compose -p efm-music exec music-worker node /app/legacy-import.mjs run --yes
//   docker compose -p efm-music exec music-worker node /app/legacy-import.mjs status
//
// dry-run  lists the folder READ-ONLY (same start-up checks as the worker,
//          incl. the key self-check) and prints every planned move; writes
//          nothing, queues nothing.
// run      computes the same plan and queues one import_legacy_archive job
//          per file (the running worker archives them, one per scan window,
//          with every gate of the archive machinery). Refused while import
//          jobs are still queued or running. Needs --yes.
// status   imported rows by status, and the import jobs by status.
//
// The CLI itself never writes to AzuraCast.

import { sql } from 'drizzle-orm'
import { closeDb, getDb } from '../server/db/client'
import { enqueueImportJobs, importJobsLive, newPlanId, toQueue } from '../server/requests/legacy-import'
import { startupChecks } from './main'
import { formatPlan, planLegacyImport } from './requests/legacy'

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0]
  if (cmd !== 'dry-run' && cmd !== 'run' && cmd !== 'status') {
    console.error('usage: node /app/legacy-import.mjs dry-run | run --yes | status')
    return 2
  }
  const { env, profile, azuracast } = await startupChecks()
  const db = getDb(env.DATABASE_URL, 1)
  try {
    if (cmd === 'status') {
      const a = await db.execute<{ status: string; n: number }>(sql`SELECT status::text AS status, count(*)::int AS n FROM archive WHERE origin = 'legacy_unreleased' GROUP BY status ORDER BY status`)
      const j = await db.execute<{ status: string; n: number }>(sql`SELECT status::text AS status, count(*)::int AS n FROM jobs WHERE kind = 'import_legacy_archive' GROUP BY status ORDER BY status`)
      console.log('imported archive rows:', JSON.stringify(Object.fromEntries((a as unknown as { status: string; n: number }[]).map((r) => [r.status, r.n]))))
      console.log('import jobs:', JSON.stringify(Object.fromEntries((j as unknown as { status: string; n: number }[]).map((r) => [r.status, r.n]))))
      return 0
    }
    const plan = await planLegacyImport({ db, azuracast, root: profile.testPrefix })
    console.log(formatPlan(plan))
    if (cmd === 'dry-run') return 0
    if (!argv.includes('--yes')) {
      console.error('\nrun: nothing queued. Re-run with --yes to queue exactly the files above.')
      return 2
    }
    if ((await importJobsLive(db)) > 0) {
      console.error('\nrun refused: import jobs are still queued or running (see status).')
      return 1
    }
    const files = toQueue(plan)
    if (files.length === 0) {
      console.log('\nNothing to import.')
      return 0
    }
    const planId = newPlanId()
    const n = await db.transaction((tx) => enqueueImportJobs(tx, planId, files, { actorUserId: null, actorDiscordId: null }, Date.now(), 'cli'))
    console.log(`\nQueued ${n} import job(s) (plan ${planId}); the worker archives one per scan window.`)
    return 0
  } finally {
    await closeDb()
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error('[legacy-import] failed:', err instanceof Error ? `${err.name}: ${err.message}` : err)
    process.exit(1)
  },
)
