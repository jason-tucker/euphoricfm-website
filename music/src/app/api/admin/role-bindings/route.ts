import { addRoleBinding } from '@/server/admin/settings'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, route } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// {roleId, permission: 'review'|'manage', note?}: admin only, audited.
export const POST = route(async (req) => {
  const v = await requirePermission('admin')
  return jsonResponse(201, await addRoleBinding(getDb(), v, await readJsonLimited(req)))
})
