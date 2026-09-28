import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { releaseSong } from '@/server/requests/manage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// v0.3.6: release a legacy (UNRELEASED) archived song into an artist folder
// with explicitly chosen playlists: {artist, newArtist?, playlistIds} →
// worker restore (manage; 409 not_a_release, artist_unknown,
// artist_folder_taken, artist_pending, archive_in_progress, …).
export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('manage')
  return jsonResponse(202, await releaseSong(getDb(), v, parseId(p.id), await readJsonLimited(req)))
})
