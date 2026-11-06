import { requirePermission } from '@/server/authz/viewer'
import { getDb } from '@/server/db/client'
import { readJsonLimited } from '@/server/http/body'
import { jsonResponse, parseId, route } from '@/server/http/route'
import { addSoundCloudToBatch } from '@/server/soundcloud'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// POST /api/batches/:id/soundcloud {url} (v0.4.0): records the link as a
// 'probing' item and queues the worker's music-fetch request. The web never
// contacts SoundCloud or music-fetch itself.
export const POST = route<{ id: string }>(async (req, p) => {
  const v = await requirePermission('submit')
  const body = (await readJsonLimited(req)) as { url?: unknown } | null
  return jsonResponse(201, await addSoundCloudToBatch(getDb(), v, parseId(p.id), body?.url))
})
