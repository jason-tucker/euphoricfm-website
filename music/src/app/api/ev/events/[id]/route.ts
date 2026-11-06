import { getDb } from '@/server/db/client'
import { PatchEventRequest } from '@/events/contract/api'
import { optionalActor, requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse, parseBody } from '@/events/server/http'
import { getEventView, patchEvent } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Public (projected): full for owner/staff, public/private/pending otherwise, 404 when hidden.
export const GET = evRoute<{ id: string }>(async (_req, p) => {
  return jsonResponse(200, await getEventView(getDb(), await optionalActor(), eventId(p.id)))
})

export const PATCH = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor()
  const id = eventId(p.id)
  const input = await parseBody(req, PatchEventRequest)
  return jsonResponse(200, { event: await patchEvent(getDb(), actor, id, input) })
})
