import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { directEdit } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Manager direct edit {title?, artist?, album?, genre?} → worker apply_edit.
export const PATCH = route<{ mediaId: string }>(async (req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await directEdit(getDb(), v, webEnv().PORTAL_TEST_PREFIX, parseId(p.mediaId), await readJsonLimited(req)))
})
