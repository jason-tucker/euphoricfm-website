// Fallback membership lookup through the tickets Integration API
// (GET /api/v1/members/:discordId, scope guild:read), reached over the
// efm-music-hooks network with the web-only key. Web holds no tickets:* key.

import { z } from 'zod'

const memberSchema = z.object({
  member: z.boolean(),
  pending: z.boolean(),
  roleIds: z.array(z.string().regex(/^\d{17,20}$/)).max(250),
})

export type TicketsMember = z.infer<typeof memberSchema>

export async function fetchMemberViaTickets(opts: {
  apiBase: string
  key: string
  discordId: string
  fetchImpl?: typeof fetch
}): Promise<TicketsMember | null> {
  if (!opts.key || !/^\d{17,20}$/.test(opts.discordId)) return null
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(`${opts.apiBase}/api/v1/members/${opts.discordId}`, {
      headers: { Authorization: `Bearer ${opts.key}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    if (res.status !== 200) return null
    return memberSchema.parse(await res.json())
  } catch {
    return null
  }
}
