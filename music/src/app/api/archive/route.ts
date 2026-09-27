import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, route } from '@/server/http/route'
import { listArchived } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async () => {
  const v = await requirePermission('manage')
  return jsonResponse(200, await listArchived(getDb(), v))
})
