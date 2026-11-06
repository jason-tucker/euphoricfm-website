import { getDb } from '@/server/db/client'
import { PutPlaylistRequest } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse, parseBody } from '@/events/server/http'
import { putPlaylist } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const PUT = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor()
  const id = eventId(p.id)
  const input = await parseBody(req, PutPlaylistRequest)
  return jsonResponse(200, { event: await putPlaylist(getDb(), actor, id, input) })
})
