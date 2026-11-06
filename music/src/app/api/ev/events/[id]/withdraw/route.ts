import { getDb } from '@/server/db/client'
import { requireActor } from '@/events/server/authz'
import { WithdrawRequest } from '@/events/contract/api'
import { eventId, evRoute, jsonResponse, parseOptionalBody } from '@/events/server/http'
import { transition } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor('submit')
  const id = eventId(p.id)
  // {} or { expectStatus } (the draft form: never withdraw a request that
  // was submitted in another tab meanwhile).
  const { expectStatus } = await parseOptionalBody(req, WithdrawRequest)
  return jsonResponse(200, { event: await transition(getDb(), actor, id, 'withdraw', { expectStatus }) })
})
