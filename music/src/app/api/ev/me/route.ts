import { currentUser, requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { HttpError } from '@/server/http/errors'
import { userById } from '@/events/server/repo'
import { evRoute, jsonResponse } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Public: who is signed in and what they may do. A signed-in account that is
// not (or no longer) a guild member answers signedIn with no permissions.
export const GET = evRoute(async () => {
  const user = await currentUser()
  if (!user) return jsonResponse(200, { signedIn: false })
  let perms = { review: false, manage: false, admin: false }
  try {
    const v = await requirePermission('submit')
    perms = { review: v.perms.has('review'), manage: v.perms.has('manage'), admin: v.perms.has('admin') }
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) return jsonResponse(200, { signedIn: false })
    if (!(e instanceof HttpError) || e.status !== 403) throw e
  }
  const u = await userById(getDb(), user.id)
  return jsonResponse(200, { signedIn: true, userId: user.id, discordId: user.discordId, name: user.name ?? 'Member', avatarUrl: u?.image ?? null, perms })
})
