import { getDb } from '@/server/db/client'
import { eventsConfig } from '@/events/server/config'
import { evRoute, jsonResponse } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = evRoute(async () => jsonResponse(200, await eventsConfig(getDb())))
