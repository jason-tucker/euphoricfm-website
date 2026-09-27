// Thin client for the P4 routes (edit/removal requests and the manager
// library actions). Routes marked CONFIRMED match feat/music-requests
// (58587c9); anything still GUESSED is marked so. Pages and components never
// build these URLs themselves.
//
// Plan contract this follows:
//   - any member files an edit or a removal for a song under Music/Artists/**;
//     each request opens its own ticket;
//   - edits are `proposed: {title?, artist?, album?, genre?}` (exactly those
//     keys, zod-typed server-side);
//   - reviewers approve or deny (a deny needs a reason); approved edits are
//     applied automatically; removal = archive to Removed/<media_id>/;
//   - managers edit directly, change playlists (MERGE: memberships outside
//     the assignable set are kept), archive and restore.

import { api } from '@/components/api'

export type ArtId = string | number
export type Proposed = Partial<Record<'title' | 'artist' | 'album' | 'genre', string>> & {
  // Album art contract: an edit may propose new art (a ready art upload).
  // P4's ProposedSchema is strict and does not accept it yet (GUESSED shape).
  artId?: ArtId
}

// CONFIRMED: POST /api/requests {kind:'edit', mediaId, proposed, reason?} → {id}
export function fileEditRequest(mediaId: number, proposed: Proposed, reason: string) {
  return api<{ id: number }>('/api/requests', { json: { kind: 'edit', mediaId, proposed, ...(reason ? { reason } : {}) } })
}

// CONFIRMED: POST /api/requests {kind:'removal', mediaId, reason (non-blank)} → {id}
export function fileRemovalRequest(mediaId: number, reason: string) {
  return api<{ id: number }>('/api/requests', { json: { kind: 'removal', mediaId, reason } })
}

// CONFIRMED: POST /api/requests/:id/withdraw → {id, status}
export function withdrawRequest(id: number) {
  return api<{ id: number; status: string }>(`/api/requests/${id}/withdraw`, { method: 'POST' })
}

// CONFIRMED: POST /api/requests/:id/decision {decision:'approve'} | {decision:'deny', reason}
export function decideRequest(id: number, d: { decision: 'approve' } | { decision: 'deny'; reason: string }) {
  return api<{ id: number; status: string }>(`/api/requests/${id}/decision`, { json: d })
}

// CONFIRMED: POST /api/requests/artists/:artistId/decision — approve or deny
// the new artist an approved edit is parked on (request.awaitingArtistId).
export function decideRequestArtist(artistId: number, d: { decision: 'approve' } | { decision: 'deny'; reason: string }) {
  return api<{ id: number; status: string; folder: string }>(`/api/requests/artists/${artistId}/decision`, { json: d })
}

// ---- manager library routes (manage permission) ----

// CONFIRMED: PATCH /api/library/:mediaId {title?, artist?, album?, genre?} → 202
// (409 artist_not_active for an unknown artist; 400 no_change)
export function directEdit(mediaId: number, fields: Proposed) {
  return api(`/api/library/${mediaId}`, { method: 'PATCH', json: fields })
}

// CONFIRMED: PUT /api/library/:mediaId/playlists {playlistIds} — the ASSIGNABLE
// memberships wanted; the server merges (keeps non-assignable memberships).
export function setPlaylists(mediaId: number, playlistIds: number[]) {
  return api(`/api/library/${mediaId}/playlists`, { method: 'PUT', json: { playlistIds } })
}

// CONFIRMED: POST /api/library/:mediaId/archive {reason?} → 202
export function archiveSong(mediaId: number, reason: string) {
  return api(`/api/library/${mediaId}/archive`, { json: reason ? { reason } : {} })
}

// CONFIRMED: POST /api/archive/:archiveId/restore (409 not_archived)
export function restoreSong(archiveId: number) {
  return api(`/api/archive/${archiveId}/restore`, { method: 'POST' })
}

// Album art contract: PUT /api/library/:mediaId/art {artId} (manage, audited,
// enqueues apply_art). P4 owns it; not on any branch yet (GUESSED from the
// contract text).
export function setLibraryArt(mediaId: number, artId: ArtId) {
  return api(`/api/library/${mediaId}/art`, { method: 'PUT', json: { artId } })
}
