import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { buildIcs } from '@/events/server/ics'
import { evRoute } from '@/events/server/http'
import { icsViews } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Public ICS feed: anonymous projections only, whoever asks (ics.ts).
export const GET = evRoute(async () => {
  const body = buildIcs(await icsViews(getDb()), { now: new Date(), origin: webEnv().PORTAL_ORIGIN })
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': 'inline; filename="euphoricfm-events.ics"',
      'cache-control': 'public, max-age=300',
    },
  })
})
