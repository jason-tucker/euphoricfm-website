// Who is asking, for the events API. Reuses the portal's session +
// membership + role_bindings (server/authz/viewer.ts): review/manage come
// from role bindings, admin from PORTAL_OWNER_IDS. Staff = review.

import { optionalViewer, requirePermission, type Viewer } from '../../server/authz/viewer'
import type { Perm } from '../../server/authz/permissions'
import type { Actor } from './rules'

export function actorOf(v: Viewer): Actor {
  return { userId: v.userId, discordId: v.discordId, name: v.name, staff: v.perms.has('review'), manage: v.perms.has('manage') }
}

/** A signed-in guild member (401 / 403 otherwise). */
export async function requireActor(perm: Extract<Perm, 'submit' | 'review' | 'manage'> = 'submit'): Promise<{ viewer: Viewer; actor: Actor }> {
  const viewer = await requirePermission(perm)
  return { viewer, actor: actorOf(viewer) }
}

/** Public routes: the member's actor when signed in, else null. */
export async function optionalActor(): Promise<Actor | null> {
  const v = await optionalViewer()
  return v ? actorOf(v) : null
}
