import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { editItemMetadata, getItem } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await getItem(getDb(), v, parseId(p.id)))
})

// {title?, artist?, album?, genre?}: owner while the batch is a draft, or a
// reviewer before the decision; 409 once the item is no longer pending.
export const PATCH = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await editItemMetadata(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})
