import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { addComment, listComments } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route<{ id: string }>(async (_req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(200, await listComments(getDb(), v, parseId(p.id)))
})

export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  return jsonResponse(201, await addComment(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})
