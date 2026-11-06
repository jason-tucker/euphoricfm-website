// PUT {artId} attaches a ready custom album-art upload; DELETE falls back to
// the embedded cover. Owner while the batch is a draft, or a reviewer before
// the decision; 409 once the item is no longer pending (art contract).
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { clearItemArt, setItemArt } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PUT = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await setItemArt(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})

export const DELETE = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await clearItemArt(getDb(), v, parseId(p.id)))
})
