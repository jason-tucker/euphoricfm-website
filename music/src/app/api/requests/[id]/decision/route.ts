import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { decideRequest } from '@/server/requests/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// {decision:'approve'} | {decision:'deny', reason}. 409 when already decided.
export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('review')
  return jsonResponse(200, await decideRequest(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})
