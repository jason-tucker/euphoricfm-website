import { getDb } from '@/server/db/client'
import { AudioListQuery, CreateAudioRequest } from '@/events/contract/api'
import { createAudio, listAudio } from '@/events/server/audio'
import { requireActor } from '@/events/server/authz'
import { evRoute, jsonResponse, parseBody, parseQuery } from '@/events/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Own audio; staff (review) may pass ?owner=<userId> to see an event owner's.
export const GET = evRoute(async (req) => {
  const { actor } = await requireActor()
  const { owner } = parseQuery(req, AudioListQuery)
  return jsonResponse(200, await listAudio(getDb(), actor, owner))
})

export const POST = evRoute(async (req) => {
  const { actor } = await requireActor()
  const input = await parseBody(req, CreateAudioRequest)
  return jsonResponse(201, { audio: await createAudio(getDb(), actor, input) })
})
