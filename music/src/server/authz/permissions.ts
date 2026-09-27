// Permission model (plan §3.3). Pure; covered by unit tests.
//
//   submit, request  — any non-pending guild member
//   review           — member holding a role bound to 'review' or 'manage'
//   manage           — member holding a role bound to 'manage'
//   admin            — member whose Discord id is in PORTAL_OWNER_IDS (only
//                      source; no role can grant it). Admin implies all.

export type Perm = 'submit' | 'request' | 'review' | 'manage' | 'admin'

export const ELEVATED: ReadonlySet<Perm> = new Set(['review', 'manage', 'admin'])

export type RoleBinding = { roleId: string; permission: 'review' | 'manage' }

export function computePerms(input: {
  member: boolean
  pending: boolean
  roleIds: readonly string[]
  discordId: string
  bindings: readonly RoleBinding[]
  ownerIds: readonly string[]
}): Set<Perm> {
  const perms = new Set<Perm>()
  if (!input.member || input.pending) return perms
  perms.add('submit')
  perms.add('request')
  const roles = new Set(input.roleIds)
  for (const b of input.bindings) {
    if (!roles.has(b.roleId)) continue
    perms.add('review')
    if (b.permission === 'manage') perms.add('manage')
  }
  if (input.ownerIds.includes(input.discordId)) {
    perms.add('review')
    perms.add('manage')
    perms.add('admin')
  }
  return perms
}
