// Ownership predicates (plan §3.3). Every route loads the row, applies one of
// these, and answers 404 when it fails, so ids of other users' rows cannot be
// probed. Pure functions; unit-tested.

import type { Perm } from './permissions'

export type Viewer = { userId: string; discordId: string; name: string | null; perms: ReadonlySet<Perm> }

type Owned = { ownerUserId: string }

export const isReviewer = (v: Viewer) => v.perms.has('review')

export function canViewOwned(v: Viewer, row: Owned): boolean {
  return row.ownerUserId === v.userId || isReviewer(v)
}

// Preview / cover: owner or review (plus a signed URL, see media/signing.ts).
export const canPreviewItem = canViewOwned

export function canSeeComment(v: Viewer, parent: Owned, c: { visibility: 'all' | 'staff' }): boolean {
  if (c.visibility === 'staff') return isReviewer(v)
  return canViewOwned(v, parent)
}

export function canComment(v: Viewer, parent: Owned, visibility: 'all' | 'staff'): boolean {
  if (visibility === 'staff') return isReviewer(v)
  return canViewOwned(v, parent) && (v.perms.has('submit') || isReviewer(v))
}

// Submit / withdraw act only on one's own rows (reviewers do not withdraw).
export function isOwner(v: Viewer, row: Owned): boolean {
  return row.ownerUserId === v.userId
}

export function isSelfApproval(v: Viewer, row: Owned): boolean {
  return row.ownerUserId === v.userId
}
