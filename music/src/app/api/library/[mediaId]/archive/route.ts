import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { archiveSong } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// {reason?} → worker archive (playlists cleared, file to Removed/<id>/).
export const POST = route<{ mediaId: string }>(async (req, p) => {
  const v = await requirePermission('manage')
  const body = req.headers.get('content-type') ? await readJsonLimited(req) : {}
  return jsonResponse(202, await archiveSong(getDb(), v, webEnv().PORTAL_TEST_PREFIX, parseId(p.mediaId), body))
})
