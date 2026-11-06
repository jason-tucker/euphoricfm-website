import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse } from '@/events/server/http'
import { listStingers } from '@/events/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = evRoute(async () => {
  await requireActor()
  return jsonResponse(200, await listStingers(getDb()))
})
