// Guild-membership gate (plan §3.2).
//
// * Sign-in: GET /users/@me/guilds/{guild}/member with the fresh user token.
//   404 or pending → denied. Other failures fall back to the tickets API
//   (guild:read); if that fails too, sign-in is denied (fail closed).
// * Re-check: member-level actions re-check when the cache is older than
//   10 min; review/manage/admin when older than 60 s.
// * A 404 or 401 from Discord, a pending member, or a failed token refresh
//   deletes ALL of the user's sessions.
// * If Discord and the fallback are both unavailable: member-level actions may
//   use a cache entry younger than 60 min; review+ actions fail closed (503).

import { eq } from 'drizzle-orm'
import type { DB } from '../db/client'
import { memberCache, sessions } from '../db/schema'
import { audit } from '../audit'
import { unauthorized, unavailable } from '../http/errors'
import { fetchGuildMember, refreshDiscordToken, type DiscordMemberResult } from './discord'
import { loadDiscordTokens, storeDiscordTokens } from './tokens'
import { fetchMemberViaTickets } from '../tickets/members'

export type Level = 'member' | 'elevated'

export const TTL_MS: Record<Level, number> = { member: 10 * 60_000, elevated: 60_000 }
export const STALE_FALLBACK_MS = 60 * 60_000

export type MembershipDeps = {
  db: DB
  apiBase: string
  tokenUrl: string
  guildId: string
  clientId: string
  clientSecret: string
  ticketsApiBase: string
  ticketsKey: string
  fetchImpl?: typeof fetch
  now?: () => number
}

export type Membership = { member: true; pending: false; roleIds: string[]; checkedAt: Date; source: string }

export type SignInVerdict = { allowed: true; roleIds: string[] } | { allowed: false; reason: 'not_member' | 'pending' | 'unverifiable' }

async function upsertCache(db: DB, discordId: string, v: { member: boolean; pending: boolean; roleIds: string[]; source: string }, at: Date) {
  await db
    .insert(memberCache)
    .values({ discordId, member: v.member, pending: v.pending, roleIds: v.roleIds, source: v.source, checkedAt: at })
    .onConflictDoUpdate({
      target: memberCache.discordId,
      set: { member: v.member, pending: v.pending, roleIds: v.roleIds, source: v.source, checkedAt: at },
    })
}

export async function checkMembershipAtSignIn(deps: MembershipDeps, discordId: string, accessToken: string): Promise<SignInVerdict> {
  const now = new Date(deps.now?.() ?? Date.now())
  const r = await fetchGuildMember({
    apiBase: deps.apiBase,
    guildId: deps.guildId,
    accessToken,
    expectedUserId: discordId,
    fetchImpl: deps.fetchImpl,
  })
  if (r.kind === 'ok') {
    await upsertCache(deps.db, discordId, { member: true, pending: r.pending, roleIds: r.roleIds, source: 'discord' }, now)
    return r.pending ? { allowed: false, reason: 'pending' } : { allowed: true, roleIds: r.roleIds }
  }
  if (r.kind === 'not_member') {
    await upsertCache(deps.db, discordId, { member: false, pending: false, roleIds: [], source: 'discord' }, now)
    return { allowed: false, reason: 'not_member' }
  }
  if (r.kind === 'unauthorized') return { allowed: false, reason: 'unverifiable' }
  const fb = await fetchMemberViaTickets({ apiBase: deps.ticketsApiBase, key: deps.ticketsKey, discordId, fetchImpl: deps.fetchImpl })
  if (!fb) return { allowed: false, reason: 'unverifiable' }
  await upsertCache(deps.db, discordId, { ...fb, source: 'tickets' }, now)
  if (!fb.member) return { allowed: false, reason: 'not_member' }
  if (fb.pending) return { allowed: false, reason: 'pending' }
  return { allowed: true, roleIds: fb.roleIds }
}

export async function revokeAllSessions(db: DB, userId: string, discordId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.userId, userId))
    await tx
      .insert(memberCache)
      .values({ discordId, member: false, pending: false, roleIds: [], source: 'revoked', checkedAt: new Date() })
      .onConflictDoUpdate({
        target: memberCache.discordId,
        set: { member: false, pending: false, roleIds: [], source: 'revoked', checkedAt: new Date() },
      })
    await audit(tx, { actorUserId: userId, actorDiscordId: discordId, action: 'auth.sessions_revoked', targetType: 'user', targetId: userId, detail: { reason } })
  })
}

const inflight = new Map<string, Promise<Membership>>()

export async function ensureFreshMembership(deps: MembershipDeps, user: { id: string; discordId: string }, level: Level): Promise<Membership> {
  const now = deps.now?.() ?? Date.now()
  const cached = await deps.db.query.memberCache.findFirst({ where: eq(memberCache.discordId, user.discordId) })
  if (cached && cached.member && !cached.pending && now - cached.checkedAt.getTime() < TTL_MS[level]) {
    return { member: true, pending: false, roleIds: cached.roleIds, checkedAt: cached.checkedAt, source: cached.source }
  }
  const key = user.id
  const existing = inflight.get(key)
  if (existing) return existing
  const p = recheck(deps, user, level, cached ?? null).finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

async function recheck(
  deps: MembershipDeps,
  user: { id: string; discordId: string },
  level: Level,
  cached: { member: boolean; pending: boolean; roleIds: string[]; checkedAt: Date; source: string } | null,
): Promise<Membership> {
  const nowMs = deps.now?.() ?? Date.now()
  const revoke = async (reason: string): Promise<never> => {
    await revokeAllSessions(deps.db, user.id, user.discordId, reason)
    throw unauthorized()
  }

  const tokens = await loadDiscordTokens(deps.db, user.id)
  if (!tokens) return revoke('no_tokens')

  let accessToken = tokens.accessToken
  if (tokens.expiresAt !== null && tokens.expiresAt * 1000 < nowMs + 60_000) {
    if (!tokens.refreshToken) return revoke('refresh_failed')
    const fresh = await refreshDiscordToken({
      tokenUrl: deps.tokenUrl,
      clientId: deps.clientId,
      clientSecret: deps.clientSecret,
      refreshToken: tokens.refreshToken,
      fetchImpl: deps.fetchImpl,
    })
    if (!fresh) return revoke('refresh_failed')
    await storeDiscordTokens(deps.db, tokens.providerAccountId, {
      ...fresh,
      refreshToken: fresh.refreshToken ?? tokens.refreshToken,
    })
    accessToken = fresh.accessToken
  }

  const r: DiscordMemberResult = await fetchGuildMember({
    apiBase: deps.apiBase,
    guildId: deps.guildId,
    accessToken,
    expectedUserId: user.discordId,
    fetchImpl: deps.fetchImpl,
  })
  const at = new Date(nowMs)
  if (r.kind === 'ok') {
    if (r.pending) return revoke('pending')
    await upsertCache(deps.db, user.discordId, { member: true, pending: false, roleIds: r.roleIds, source: 'discord' }, at)
    return { member: true, pending: false, roleIds: r.roleIds, checkedAt: at, source: 'discord' }
  }
  if (r.kind === 'not_member') return revoke('not_member')
  if (r.kind === 'unauthorized') return revoke('token_unauthorized')

  const fb = await fetchMemberViaTickets({
    apiBase: deps.ticketsApiBase,
    key: deps.ticketsKey,
    discordId: user.discordId,
    fetchImpl: deps.fetchImpl,
  })
  if (fb) {
    if (!fb.member) return revoke('not_member')
    if (fb.pending) return revoke('pending')
    await upsertCache(deps.db, user.discordId, { ...fb, source: 'tickets' }, at)
    return { member: true, pending: false, roleIds: fb.roleIds, checkedAt: at, source: 'tickets' }
  }
  if (level === 'member' && cached && cached.member && !cached.pending && nowMs - cached.checkedAt.getTime() < STALE_FALLBACK_MS) {
    return { member: true, pending: false, roleIds: cached.roleIds, checkedAt: cached.checkedAt, source: `${cached.source}:stale` }
  }
  throw unavailable('membership_unverifiable', 30)
}
