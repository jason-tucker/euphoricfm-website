import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { restoreSong } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await restoreSong(getDb(), v, parseId(p.id)))
})
