// v0.4.1: where the "Open in portal" button of an edit / removal ticket
// (worker/requests/jobs.ts: <portal>/requests/<id>) takes each viewer. The
// visibility rule is GET /api/requests/[id]'s (owner or reviewer, else 404).
//   owner    → the song page (it lists "Your requests for this song"), or
//              Archived songs once the song has left the library (an applied
//              removal, an archive in progress, a row no longer on the surface)
//   reviewer → the requests queue, at this request
import { and, eq, inArray } from 'drizzle-orm'
import { canViewOwned, isOwner, type Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { archive, libraryCache, requests } from '../db/schema'
import { notFound } from '../http/errors'
import { onLibrarySurface } from './library'

export async function requestLinkTarget(db: DB, v: Viewer, id: number): Promise<string> {
  const r = await db.query.requests.findFirst({ where: eq(requests.id, id) })
  if (!r || !canViewOwned(v, r)) throw notFound()
  if (!isOwner(v, r)) return `/review/requests#request-${r.id}`
  if (r.kind === 'removal' && r.status === 'done') return '/library/archived'
  const [lib, gone] = await Promise.all([
    db.query.libraryCache.findFirst({ where: eq(libraryCache.mediaId, r.mediaId) }),
    db.query.archive.findFirst({ where: and(eq(archive.mediaId, r.mediaId), inArray(archive.status, ['archiving', 'archived'])) }),
  ])
  return lib && onLibrarySurface(lib.path) && !gone ? `/library/${r.mediaId}` : '/library/archived'
}
