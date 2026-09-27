import { removeRoleBinding } from '@/server/admin/settings'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, parseId, route } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('admin')
  return jsonResponse(200, await removeRoleBinding(getDb(), v, parseId(p.id)))
})
