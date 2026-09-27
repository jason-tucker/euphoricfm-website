// Auth.js v5: Discord OAuth, DATABASE sessions (7 days), Drizzle adapter,
// __Host- cookies, tokens encrypted at rest, guild-member gate at sign-in.

import NextAuth, { type NextAuthConfig } from 'next-auth'
import type { Adapter, AdapterAccount } from 'next-auth/adapters'
import { DrizzleAdapter } from '@auth/drizzle-adapter'
import { getDb } from '../db/client'
import { accounts, sessions, users, verificationTokens } from '../db/schema'
import { webEnv } from '../env'
import { audit } from '../audit'
import { checkMembershipAtSignIn, type MembershipDeps } from './membership'
import { encryptAccountTokens, storeDiscordTokens } from './tokens'

export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60
export const DISCORD_SCOPES = 'identify guilds.members.read'

const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true }

export function membershipDeps(): MembershipDeps {
  const env = webEnv()
  return {
    db: getDb(),
    apiBase: env.DISCORD_API_BASE,
    tokenUrl: env.DISCORD_TOKEN_URL,
    guildId: env.DISCORD_GUILD_ID,
    clientId: env.AUTH_DISCORD_ID,
    clientSecret: env.AUTH_DISCORD_SECRET,
    ticketsApiBase: env.TICKETS_API_BASE,
    ticketsKey: env.TICKETS_GUILD_READ_KEY,
  }
}

type DiscordProfile = { id: string; username: string; global_name?: string | null; avatar?: string | null }

function buildConfig(): NextAuthConfig {
  const env = webEnv()
  const db = getDb()
  const base = DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  } as never) as Adapter
  const adapter: Adapter = {
    ...base,
    // Tokens never touch the DB in plaintext.
    linkAccount: (account: AdapterAccount) => base.linkAccount!(encryptAccountTokens(account)),
  }

  return {
    adapter,
    secret: env.AUTH_SECRET,
    trustHost: true,
    useSecureCookies: true,
    session: { strategy: 'database', maxAge: SESSION_MAX_AGE_S, updateAge: 24 * 60 * 60 },
    pages: { signIn: '/', error: '/denied' },
    cookies: {
      sessionToken: { name: '__Host-authjs.session-token', options: cookieOpts },
      callbackUrl: { name: '__Host-authjs.callback-url', options: cookieOpts },
      csrfToken: { name: '__Host-authjs.csrf-token', options: cookieOpts },
      pkceCodeVerifier: { name: '__Host-authjs.pkce.code_verifier', options: { ...cookieOpts, maxAge: 900 } },
      state: { name: '__Host-authjs.state', options: { ...cookieOpts, maxAge: 900 } },
      nonce: { name: '__Host-authjs.nonce', options: cookieOpts },
    },
    providers: [
      {
        id: 'discord',
        name: 'Discord',
        type: 'oauth',
        clientId: env.AUTH_DISCORD_ID,
        clientSecret: env.AUTH_DISCORD_SECRET,
        checks: ['pkce', 'state'],
        authorization: { url: env.DISCORD_AUTHORIZE_URL, params: { scope: DISCORD_SCOPES } },
        token: env.DISCORD_TOKEN_URL,
        userinfo: `${env.DISCORD_API_BASE}/users/@me`,
        profile(p: DiscordProfile) {
          if (!/^\d{17,20}$/.test(String(p.id))) throw new Error('bad discord id')
          const image =
            p.avatar && /^(a_)?[0-9a-f]{32}$/.test(p.avatar)
              ? `https://cdn.discordapp.com/avatars/${p.id}/${p.avatar}.${p.avatar.startsWith('a_') ? 'gif' : 'png'}`
              : null
          return { id: String(p.id), discordId: String(p.id), name: (p.global_name ?? p.username ?? '').slice(0, 100), email: null, image }
        },
      },
    ],
    callbacks: {
      async signIn({ account, profile }) {
        if (account?.provider !== 'discord' || !account.access_token || !profile?.id) return false
        const verdict = await checkMembershipAtSignIn(membershipDeps(), String(profile.id), account.access_token)
        if (!verdict.allowed) {
          await audit(db, { actorDiscordId: String(profile.id), action: 'auth.sign_in_denied', detail: { reason: verdict.reason } })
          return `/denied?reason=${verdict.reason}`
        }
        return true
      },
      async session({ session, user }) {
        const u = user as unknown as { id: string; discordId: string }
        const s = session as unknown as { user: Record<string, unknown> }
        s.user.id = u.id
        s.user.discordId = u.discordId
        return session
      },
    },
    events: {
      // Re-sign-ins do not re-run linkAccount, so persist the fresh tokens
      // (encrypted) on every sign-in.
      async signIn({ user, account }) {
        if (account?.provider === 'discord' && account.access_token) {
          await storeDiscordTokens(db, account.providerAccountId, {
            accessToken: account.access_token,
            refreshToken: account.refresh_token ?? null,
            expiresAt: account.expires_at ?? null,
            scope: account.scope,
          })
          await audit(db, { actorUserId: user.id ?? null, actorDiscordId: account.providerAccountId, action: 'auth.sign_in' })
        }
      },
    },
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth(() => buildConfig())
