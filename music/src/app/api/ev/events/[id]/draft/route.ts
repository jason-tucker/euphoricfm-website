import { getDb } from '@/server/db/client'
import { SaveDraftRequest } from '@/events/contract/api'
import { requireActor } from '@/events/server/authz'
import { eventId, evRoute, jsonResponse, parseBody } from '@/events/server/http'
import { saveDraft } from '@/events/server/service'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The autosave form's keepalive save: details + playlist in one transaction.
export const POST = evRoute<{ id: string }>(async (req, p) => {
  const { actor } = await requireActor()
  const id = eventId(p.id)
  const input = await parseBody(req, SaveDraftRequest)
  return jsonResponse(200, { event: await saveDraft(getDb(), actor, id, input) })
})
