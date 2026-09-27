import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, route } from '@/server/http/route'
import { fileRequest, listOwnRequests } from '@/server/requests/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// File an edit {kind:'edit', mediaId, proposed, reason?} or a removal
// {kind:'removal', mediaId, reason}. One ticket per request.
export const POST = route(async (req) => {
  const v = await requirePermission('request')
  return jsonResponse(201, await fileRequest(getDb(), v, webEnv().PORTAL_TEST_PREFIX, await readJsonLimited(req)))
})

export const GET = route(async () => {
  const v = await requirePermission('request')
  return jsonResponse(200, await listOwnRequests(getDb(), v))
})
