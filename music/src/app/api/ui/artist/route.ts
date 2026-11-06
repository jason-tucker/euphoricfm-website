// GET /api/ui/artist?name=…            known artist, or NEW with the folder the
//                                      path builder would create
// GET /api/ui/artist?folder=…          live sanitizer preview (reviewers)
// Read-only.

import { z } from 'zod'
import { isReviewer } from '@/server/authz/predicates'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { badRequest, forbidden } from '@/server/http/errors'
import { jsonResponse, route } from '@/server/http/route'
import { lookupArtist, previewFolder } from '@/server/ui/library'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const text = z.string().max(300)

export const GET = route(async (req) => {
  const v = await requirePermission('submit')
  const u = new URL(req.url)
  const folder = u.searchParams.get('folder')
  const name = u.searchParams.get('name')
  if (folder !== null) {
    if (!isReviewer(v)) throw forbidden()
    const f = text.safeParse(folder)
    if (!f.success) throw badRequest('invalid_query')
    return jsonResponse(200, { known: null, ...(await previewFolder(getDb(), f.data)) })
  }
  const n = text.safeParse(name ?? '')
  if (!n.success || n.data.trim() === '') throw badRequest('invalid_query')
  return jsonResponse(200, await lookupArtist(getDb(), n.data))
})
