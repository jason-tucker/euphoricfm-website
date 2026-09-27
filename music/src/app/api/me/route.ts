import { requirePermission } from '@/server/authz/viewer'
import { jsonResponse, route } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = route(async () => {
  const v = await requirePermission('submit')
  return jsonResponse(200, { userId: v.userId, discordId: v.discordId, name: v.name, perms: [...v.perms].sort() })
})
