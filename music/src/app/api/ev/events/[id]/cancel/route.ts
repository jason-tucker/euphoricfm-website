import { getDb } from '@/server/db/client'
import { badRequest } from '@/server/http/errors'
import { readJsonLimited } from '@/server/http/body'
import { ReasonRequest } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse } from '@/events/server/http'
import { transition } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor('review')
  const id = eventId(p.id)
  const r = ReasonRequest.safeParse(await readJsonLimited(req))
  if (!r.success) throw badRequest('reason_required')
  return jsonResponse(200, { event: await transition(getDb(), actor, id, 'cancel', { reason: r.data.reason }) })
})
