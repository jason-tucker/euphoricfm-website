import { getDb } from '@/server/db/client'
import { StaffBookRequest } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseBody } from '@/events/server/http'
import { staffBook } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = evRoute(async (req) => {
  const { actor } = await requireActor('review')
  const input = await parseBody(req, StaffBookRequest)
  return jsonResponse(201, { event: await staffBook(getDb(), actor, input) })
})
