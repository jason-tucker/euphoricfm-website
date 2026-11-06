import { getDb } from '@/server/db/client'
import { LibraryQuery } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseQuery } from '@/events/server/http'
import { searchLibrary } from '@/events/server/repo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Library songs an event may use: Music/Artists/<artist>/<file>, not archived.
export const GET = evRoute(async (req) => {
  await requireActor()
  const { q } = parseQuery(req, LibraryQuery)
  if (q.length < 2) return jsonResponse(200, [])
  return jsonResponse(200, await searchLibrary(getDb(), q))
})
