import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, route } from '@/server/http/route'
import { legacyImport, legacyImportState } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// v0.3.6: "Archive the UNRELEASED folder". GET: the current dry-run plan,
// the import jobs still queued and the imported rows by status.
// POST {action:'dry_run'} queues the worker's read-only listing;
// POST {action:'run', planId} confirms that plan (409 plan_not_ready,
// plan_stale, plan_already_run, import_in_progress, nothing_to_import).
// Manage only.
export const GET = route(async () => {
  const v = await requirePermission('manage')
  return jsonResponse(200, await legacyImportState(getDb(), v))
})

export const POST = route(async (req) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await legacyImport(getDb(), v, await readJsonLimited(req)))
})
