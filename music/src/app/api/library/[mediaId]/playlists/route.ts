import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { changePlaylists } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// {playlistIds}: the wanted ASSIGNABLE memberships. The worker merges:
// memberships outside the assignable set (and other stations') are kept.
export const PUT = route<{ mediaId: string }>(async (req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await changePlaylists(getDb(), v, webEnv().PORTAL_TEST_PREFIX, parseId(p.mediaId), await readJsonLimited(req)))
})
