import { getDb } from '@/server/db/client'
import { deleteAudio } from '@/events/server/audio'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const DELETE = evRoute<{ id: string }>(async (_req, p) => {
  const { actor } = await requireActor()
  return jsonResponse(200, await deleteAudio(getDb(), actor, eventId(p.id)))
})
