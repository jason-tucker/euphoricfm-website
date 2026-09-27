import { getDb } from '@/server/db/client'
import { webEnv } from '@/server/env'
import { handleTicketsHook } from '@/server/hooks/tickets'
import { jsonResponse } from '@/server/http/route'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// HMAC-only (CSRF-exempt by exact path). Reachable only on efm-music-hooks;
// the tunnel edge answers 404 for /api/hooks/*.
export async function POST(req: Request): Promise<Response> {
  try {
    const env = webEnv()
    const secrets = [env.TICKETS_WEBHOOK_SECRET, process.env.TICKETS_WEBHOOK_SECRET_PREVIOUS ?? ''].filter((s) => s.length >= 32)
    const r = await handleTicketsHook(req, { db: getDb(), secrets })
    return jsonResponse(r.status, r.body)
  } catch (err) {
    console.error('[hooks] unhandled', err instanceof Error ? err.name : 'error')
    return jsonResponse(500, { error: 'internal' })
  }
}
