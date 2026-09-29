import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse, parseEmpty } from '@/events/server/http'
import { buildNow } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// manage: enqueue build_now (bypasses events_autobuild_enabled for this id).
export const POST = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor('manage')
  const id = eventId(p.id)
  await parseEmpty(req)
  return jsonResponse(200, await buildNow(getDb(), actor, id))
})
