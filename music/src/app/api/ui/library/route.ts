// GET /api/ui/library?field=artist|album&q=… — read-only autocomplete over
// the Music/Artists/** library (active artists, and library_cache albums).

import { z } from 'zod'
import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { badRequest } from '@/server/http/errors'
import { jsonResponse, route } from '@/server/http/route'
import { searchAlbums, searchArtists } from '@/server/ui/library'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const query = z.object({ field: z.enum(['artist', 'album']), q: z.string().trim().min(2).max(100) })

export const GET = route(async (req) => {
  await requirePermission('submit')
  const u = new URL(req.url)
  const p = query.safeParse({ field: u.searchParams.get('field'), q: u.searchParams.get('q') ?? '' })
  if (!p.success) throw badRequest('invalid_query')
  const db = getDb()
  if (p.data.field === 'artist') {
    const hits = await searchArtists(db, p.data.q)
    return jsonResponse(200, { results: hits.map((a) => ({ value: a.name, hint: a.folder !== a.name ? `Folder: ${a.folder}` : undefined })) })
  }
  const hits = await searchAlbums(db, p.data.q)
  return jsonResponse(200, { results: hits.map((a) => ({ value: a.album, hint: a.artist ?? undefined })) })
})
