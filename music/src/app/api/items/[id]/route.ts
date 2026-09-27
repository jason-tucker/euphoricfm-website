import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { getItem } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await getItem(getDb(), v, parseId(p.id)))
})
