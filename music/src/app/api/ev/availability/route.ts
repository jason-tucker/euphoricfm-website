import { getDb } from '@/server/db/client'
import { AvailabilityQuery } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseQuery } from '@/events/server/http'
import { availability } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = evRoute(async (req) => {
  await requireActor()
  return jsonResponse(200, await availability(getDb(), parseQuery(req, AvailabilityQuery)))
})
