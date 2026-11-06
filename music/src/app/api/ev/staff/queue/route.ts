import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse } from '@/events/server/http'
import { staffQueue } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = evRoute(async () => {
  const { actor } = await requireActor('review')
  return jsonResponse(200, await staffQueue(getDb(), actor))
})
