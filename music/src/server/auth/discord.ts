// Discord REST calls made with the USER's OAuth token (scope
// guilds.members.read) plus the refresh-token grant. No bot token here.

import { z } from 'zod'

const memberSchema = z.object({
  roles: z.array(z.string().regex(/^\d{17,20}$/)).max(250),
  pending: z.boolean().optional(),
  user: z.object({ id: z.string() }).optional(),
})

export type DiscordMemberResult =
  | { kind: 'ok'; roleIds: string[]; pending: boolean }
  | { kind: 'not_member' } // 404: not in the guild
  | { kind: 'unauthorized' } // 401: token revoked/expired
  | { kind: 'error'; status?: number } // 403 (scope), 429, 5xx, network, bad JSON

const TIMEOUT_MS = 8000

export async function fetchGuildMember(opts: {
  apiBase: string
  guildId: string
  accessToken: string
  expectedUserId: string
  fetchImpl?: typeof fetch
}): Promise<DiscordMemberResult> {
  const f = opts.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(`${opts.apiBase}/users/@me/guilds/${opts.guildId}/member`, {
      headers: { Authorization: `Bearer ${opts.accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    return { kind: 'error' }
  }
  if (res.status === 404) return { kind: 'not_member' }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status !== 200) return { kind: 'error', status: res.status }
  try {
    const body = memberSchema.parse(await res.json())
    // The member object must be about the user whose token we used.
    if (body.user && body.user.id !== opts.expectedUserId) return { kind: 'error', status: 200 }
    return { kind: 'ok', roleIds: body.roles, pending: body.pending === true }
  } catch {
    return { kind: 'error', status: 200 }
  }
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
})

export type RefreshedTokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope?: string }

export async function refreshDiscordToken(opts: {
  tokenUrl: string
  clientId: string
  clientSecret: string
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<RefreshedTokens | null> {
  const f = opts.fetchImpl ?? fetch
  try {
    const res = await f(opts.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${encodeURIComponent(opts.clientId)}:${encodeURIComponent(opts.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: opts.refreshToken }),
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return null
    const t = tokenSchema.parse(await res.json())
    return {
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: t.expires_in ? Math.floor(Date.now() / 1000) + t.expires_in : null,
      scope: t.scope,
    }
  } catch {
    return null
  }
}
