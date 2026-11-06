import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { webEnv } from '@/server/env'
import { badRequest } from '@/server/http/errors'
import { addUploadToBatch } from '@/server/submissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const body = (await readJsonLimited(req)) as { uploadId?: unknown }
  if (typeof body?.uploadId !== 'string') throw badRequest('bad_upload_id')
  return jsonResponse(201, await addUploadToBatch(getDb(), v, parseId(p.id), body.uploadId, webEnv().SPOOL_PROBE_IN_DIR))
})
