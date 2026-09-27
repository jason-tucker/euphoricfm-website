import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { createBatch } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route(async () => {
  const v = await requirePermission('submit')
  return jsonResponse(201, await createBatch(getDb(), v))
})
