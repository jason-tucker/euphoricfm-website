import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse, parseEmpty } from '@/events/server/http'
import { transition } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor('review')
  const id = eventId(p.id)
  await parseEmpty(req)
  return jsonResponse(200, { event: await transition(getDb(), actor, id, 'approve') })
})
