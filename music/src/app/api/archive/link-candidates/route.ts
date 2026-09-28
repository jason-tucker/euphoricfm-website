import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { jsonResponse, route } from '@/server/http/route'
import { linkCandidates } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// v0.3.6: portal users (signed in at least once) by name or Discord id, for
// linking a member to an archived song. Manage only; read-only.
export const GET = route(async (req) => {
  const v = await requirePermission('manage')
  const q = new URL(req.url).searchParams.get('q') ?? ''
  return jsonResponse(200, { users: await linkCandidates(getDb(), v, q) })
})
