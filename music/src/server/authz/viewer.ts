// requirePermission(): the single server-side entry point every page, route
// and action calls. Session (DB-backed) → fresh-enough membership (10 min for
// member actions, 60 s for review/manage/admin) → role bindings → perms.
// The returned Viewer never carries review/manage/admin computed from
// membership data older than 60 s (see below).

import { eq } from 'drizzle-orm'
import { auth } from '../auth/config'
import { ensureFreshMembership, TTL_MS, type Membership } from '../auth/membership'
import { membershipDeps } from '../auth/config'
import { getDb } from '../db/client'
import { roleBindings, users } from '../db/schema'
import { webEnv } from '../env'
import { forbidden, HttpError, unauthorized, unavailable } from '../http/errors'
import { computePerms, ELEVATED, type Perm } from './permissions'
import type { Viewer } from './predicates'

export type { Viewer }

export async function currentUser(): Promise<{ id: string; discordId: string; name: string | null } | null> {
  const session = await auth()
  const id = (session?.user as { id?: string } | undefined)?.id
  if (!id) return null
  const row = await getDb().query.users.findFirst({ where: eq(users.id, id) })
  return row ? { id: row.id, discordId: row.discordId, name: row.name } : null
}

// review / manage / admin are only ever granted from membership data that is
// at most TTL_MS.elevated (60 s) old and did not come from the stale
// fallback (plan §3.2; §6 P2 "a demoted user loses review within 60 s").
function elevatedFresh(m: Membership, now: number): boolean {
  return !m.source.endsWith(':stale') && now - m.checkedAt.getTime() < TTL_MS.elevated
}

function withoutElevated(perms: Set<Perm>): Set<Perm> {
  return new Set([...perms].filter((p) => !ELEVATED.has(p)))
}

export async function requirePermission(perm: Perm): Promise<Viewer> {
  const user = await currentUser()
  if (!user) throw unauthorized()
  const deps = membershipDeps()
  const now = () => deps.now?.() ?? Date.now()
  const privileged = ELEVATED.has(perm)
  let m = await ensureFreshMembership(deps, user, privileged ? 'elevated' : 'member')
  // Privileged check: never from anything older than 60 s or from the stale
  // fallback, whatever the membership layer returned (fail closed, 503).
  if (privileged && !elevatedFresh(m, now())) throw unavailable('membership_unverifiable', 30)
  const bindings = await getDb().select({ roleId: roleBindings.roleId, permission: roleBindings.permission }).from(roleBindings)
  const compute = (mm: Membership) =>
    computePerms({ member: mm.member, pending: mm.pending, roleIds: mm.roleIds, discordId: user.discordId, bindings, ownerIds: webEnv().PORTAL_OWNER_IDS })
  let perms = compute(m)
  // A member-level check may return data up to 10 min old (60 min via the
  // stale fallback). The Viewer it returns is also used by the reviewer
  // predicates (canViewOwned, canSeeComment, canComment, reviewer fields),
  // so review/manage/admin computed from that data must be re-verified at
  // the elevated level, or stripped when that cannot be done.
  if (!privileged && [...perms].some((p) => ELEVATED.has(p)) && !elevatedFresh(m, now())) {
    try {
      m = await ensureFreshMembership(deps, user, 'elevated')
      perms = elevatedFresh(m, now()) ? compute(m) : withoutElevated(compute(m))
    } catch (e) {
      if (e instanceof HttpError && e.status === 503) perms = withoutElevated(perms)
      else throw e // 401: the re-check revoked the sessions
    }
  }
  if (!perms.has(perm)) throw forbidden()
  return { userId: user.id, discordId: user.discordId, name: user.name, perms }
}

// For pages that render differently per viewer without requiring a perm.
export async function optionalViewer(): Promise<Viewer | null> {
  try {
    return await requirePermission('submit')
  } catch {
    return null
  }
}
