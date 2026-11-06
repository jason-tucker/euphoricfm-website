import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse } from '@/events/server/http'
import { myEvents } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = evRoute(async () => {
  const { actor } = await requireActor()
  return jsonResponse(200, await myEvents(getDb(), actor))
})
