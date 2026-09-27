import { putSetting } from '@/server/admin/settings'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, route } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// {key, value}: admin only, validated per key, audited.
export const PUT = route(async (req) => {
  const v = await requirePermission('admin')
  return jsonResponse(200, await putSetting(getDb(), v, await readJsonLimited(req)))
})
