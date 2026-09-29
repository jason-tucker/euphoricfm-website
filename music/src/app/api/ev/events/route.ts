import { getDb } from '@/server/db/client'
import { CreateEventRequest } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseBody } from '@/events/server/http'
import { createEvent } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Create a draft (members; staff also while events_enabled is off).
export const POST = evRoute(async (req) => {
  const { actor } = await requireActor()
  const input = await parseBody(req, CreateEventRequest)
  return jsonResponse(201, { event: await createEvent(getDb(), actor, input) })
})
