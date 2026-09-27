// Thin client for the P4 routes (edit/removal requests and the manager
// library actions). P4 is being built in parallel, so EVERY route and body
// shape below is GUESSED from plan §0/§3.3 and marked so; when P4 lands, fix
// them here only. Pages and components never build these URLs themselves.
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

export type Proposed = Partial<Record<'title' | 'artist' | 'album' | 'genre', string>>

// GUESSED: POST /api/requests {kind:'edit', mediaId, proposed, reason?} → {id}
export function fileEditRequest(mediaId: number, proposed: Proposed, reason: string) {
  return api<{ id: number }>('/api/requests', { json: { kind: 'edit', mediaId, proposed, ...(reason ? { reason } : {}) } })
}

// GUESSED: POST /api/requests {kind:'removal', mediaId, reason} → {id}
export function fileRemovalRequest(mediaId: number, reason: string) {
  return api<{ id: number }>('/api/requests', { json: { kind: 'removal', mediaId, reason } })
}

// GUESSED: POST /api/requests/:id/withdraw → {id, status}
export function withdrawRequest(id: number) {
  return api<{ id: number; status: string }>(`/api/requests/${id}/withdraw`, { method: 'POST' })
}

// GUESSED: POST /api/requests/:id/decision {decision:'approve'} | {decision:'deny', reason}
// (mirrors POST /api/items/:id/decision, which exists)
export function decideRequest(id: number, d: { decision: 'approve' } | { decision: 'deny'; reason: string }) {
  return api<{ id: number; status: string }>(`/api/requests/${id}/decision`, { json: d })
}

// ---- manager library routes (manage permission) ----

// GUESSED: PATCH /api/library/:mediaId {title?, artist?, album?, genre?}
export function directEdit(mediaId: number, fields: Proposed) {
  return api(`/api/library/${mediaId}`, { method: 'PATCH', json: fields })
}

// GUESSED: PUT /api/library/:mediaId/playlists {playlistIds} — the ASSIGNABLE
// memberships wanted; the server merges (keeps non-assignable memberships).
export function setPlaylists(mediaId: number, playlistIds: number[]) {
  return api(`/api/library/${mediaId}/playlists`, { method: 'PUT', json: { playlistIds } })
}

// GUESSED: POST /api/library/:mediaId/archive {reason?}
export function archiveSong(mediaId: number, reason: string) {
  return api(`/api/library/${mediaId}/archive`, { json: reason ? { reason } : {} })
}

// GUESSED: POST /api/archive/:archiveId/restore
export function restoreSong(archiveId: number) {
  return api(`/api/archive/${archiveId}/restore`, { method: 'POST' })
}
