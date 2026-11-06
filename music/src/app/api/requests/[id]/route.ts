import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { getRequest } from '@/server/requests/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('request')
  return jsonResponse(200, await getRequest(getDb(), v, parseId(p.id)))
})
