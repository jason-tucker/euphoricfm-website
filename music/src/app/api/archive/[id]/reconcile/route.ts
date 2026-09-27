import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { reconcileArchiveRow } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// An archive or restore that stopped part way ('archiving' / 'restoring'):
// queue the worker's reconciler for it now (manage; 409 not_in_progress,
// archive_job_pending).
export const POST = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await reconcileArchiveRow(getDb(), v, parseId(p.id)))
})
