// requirePermission(): the single server-side entry point every page, route
// and action calls. Session (DB-backed) → fresh-enough membership (10 min for
// member actions, 60 s for review/manage/admin) → role bindings → perms.

import { eq } from 'drizzle-orm'
import { auth } from '../auth/config'
import { ensureFreshMembership, type Level } from '../auth/membership'
import { membershipDeps } from '../auth/config'
import { getDb } from '../db/client'
import { roleBindings, users } from '../db/schema'
import { webEnv } from '../env'
import { forbidden, unauthorized } from '../http/errors'
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

export async function requirePermission(perm: Perm): Promise<Viewer> {
  const user = await currentUser()
  if (!user) throw unauthorized()
  const level: Level = ELEVATED.has(perm) ? 'elevated' : 'member'
  const m = await ensureFreshMembership(membershipDeps(), user, level)
  const bindings = await getDb().select({ roleId: roleBindings.roleId, permission: roleBindings.permission }).from(roleBindings)
  const perms = computePerms({
    member: m.member,
    pending: m.pending,
    roleIds: m.roleIds,
    discordId: user.discordId,
    bindings,
    ownerIds: webEnv().PORTAL_OWNER_IDS,
  })
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
