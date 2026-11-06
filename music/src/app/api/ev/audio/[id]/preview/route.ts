import { getDb } from '@/server/db/client'
import { previewUrl, servePreview } from '@/events/server/audio'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Without a signature: { url } (signed, viewer-bound, 5 min). With one: the
// probed bytes (audio/mpeg, sandbox CSP from the middleware).
export const GET = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor()
  const id = eventId(p.id)
  if (new URL(req.url).searchParams.has('sig')) return servePreview(getDb(), actor, id, req)
  return jsonResponse(200, await previewUrl(getDb(), actor, id))
})
