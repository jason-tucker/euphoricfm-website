import { getDb } from '@/server/db/client'
import { CalendarQuery } from '@/events/contract/api'
import { optionalActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseQuery } from '@/events/server/http'
import { calendar } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Public: pending + approved|built|live|ended, projected per viewer (view.ts).
export const GET = evRoute(async (req) => {
  const q = parseQuery(req, CalendarQuery)
  return jsonResponse(200, await calendar(getDb(), await optionalActor(), q))
})
