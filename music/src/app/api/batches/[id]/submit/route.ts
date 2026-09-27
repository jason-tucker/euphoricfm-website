import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { submitBatch } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const body = (await readJsonLimited(req)) as { attest?: unknown; attestVersion?: unknown }
  return jsonResponse(200, await submitBatch(getDb(), v, parseId(p.id), body?.attest, body?.attestVersion))
})
