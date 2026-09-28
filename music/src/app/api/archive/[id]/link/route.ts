import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { linkArchive, unlinkArchive } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// v0.3.6: link a portal user to an archived song ({userId}), so that member
// sees it under Archived songs; DELETE unlinks. Manage only, audited.
export const PUT = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(200, await linkArchive(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})

export const DELETE = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(200, await unlinkArchive(getDb(), v, parseId(p.id)))
})
