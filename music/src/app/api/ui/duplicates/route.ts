// GET /api/ui/duplicates?title=…&artist=…[&item=id] — read-only duplicate
// hints: same title + artist already in the library (Music/Artists/**), or
// in a live/pending portal item (the viewer's own; all items for reviewers).

import { z } from 'zod'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { badRequest } from '@/server/http/errors'
import { jsonResponse, route } from '@/server/http/route'
import { findDuplicates } from '@/server/ui/library'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const query = z.object({
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().min(1).max(300),
  item: z
    .string()
    .regex(/^[1-9]\d{0,9}$/)
    .transform(Number)
    .optional(),
})

export const GET = route(async (req) => {
  const v = await requirePermission('submit')
  const u = new URL(req.url)
  const p = query.safeParse({ title: u.searchParams.get('title') ?? '', artist: u.searchParams.get('artist') ?? '', item: u.searchParams.get('item') ?? undefined })
  if (!p.success) throw badRequest('invalid_query')
  return jsonResponse(200, { results: await findDuplicates(getDb(), v, p.data.title, p.data.artist, p.data.item) })
})
