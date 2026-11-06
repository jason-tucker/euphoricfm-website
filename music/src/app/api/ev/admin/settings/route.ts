import { getEventsSettings, putEventsSettings } from '@/server/admin/events-settings'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// manage: the events_* settings (strict partial patch, audited).
export const GET = evRoute(async () => {
  const { viewer } = await requireActor('manage')
  return jsonResponse(200, await getEventsSettings(getDb(), viewer))
})

export const PUT = evRoute(async (req) => {
  const { viewer } = await requireActor('manage')
  return jsonResponse(200, await putEventsSettings(getDb(), viewer, await readJsonLimited(req)))
})
