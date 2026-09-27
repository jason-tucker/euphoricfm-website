import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { withdrawRequest } from '@/server/requests/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('request')
  return jsonResponse(200, await withdrawRequest(getDb(), v, parseId(p.id)))
})
