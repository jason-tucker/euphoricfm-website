// OAuth tokens at rest: AES-256-GCM envelopes (APP_ENC_KEY), AAD bound to
// provider + account + column, so a ciphertext cannot be replayed onto
// another row or swapped between access and refresh columns.

import { and, eq } from 'drizzle-orm'
import { decryptField, encryptField, isEnvelope, parseEncKey } from '../crypto'
import type { DB } from '../db/client'
import { accounts } from '../db/schema'

type TokenCol = 'access_token' | 'refresh_token' | 'id_token'

function aad(provider: string, providerAccountId: string, col: TokenCol) {
  return `account:${provider}:${providerAccountId}:${col}`
}

let keyCache: Buffer | null = null
export function encKey(): Buffer {
  if (!keyCache) keyCache = parseEncKey(process.env.APP_ENC_KEY)
  return keyCache
}

export function encryptAccountTokens<T extends Record<string, unknown>>(account: T, key = encKey()): T {
  const provider = String(account.provider)
  const pid = String(account.providerAccountId)
  const out: Record<string, unknown> = { ...account }
  for (const col of ['access_token', 'refresh_token', 'id_token'] as const) {
    const v = out[col]
    if (typeof v === 'string' && v.length > 0) out[col] = encryptField(v, aad(provider, pid, col), key)
  }
  return out as T
}

export type DiscordTokens = { accessToken: string; refreshToken: string | null; expiresAt: number | null }

export async function loadDiscordTokens(db: DB, userId: string, key = encKey()): Promise<(DiscordTokens & { providerAccountId: string }) | null> {
  const row = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, userId), eq(accounts.provider, 'discord')),
  })
  if (!row?.access_token || !isEnvelope(row.access_token)) return null
  return {
    providerAccountId: row.providerAccountId,
    accessToken: decryptField(row.access_token, aad('discord', row.providerAccountId, 'access_token'), key),
    refreshToken:
      row.refresh_token && isEnvelope(row.refresh_token)
        ? decryptField(row.refresh_token, aad('discord', row.providerAccountId, 'refresh_token'), key)
        : null,
    expiresAt: row.expires_at ?? null,
  }
}

export async function storeDiscordTokens(
  db: DB,
  providerAccountId: string,
  t: { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope?: string },
  key = encKey(),
): Promise<void> {
  await db
    .update(accounts)
    .set({
      access_token: encryptField(t.accessToken, aad('discord', providerAccountId, 'access_token'), key),
      refresh_token: t.refreshToken ? encryptField(t.refreshToken, aad('discord', providerAccountId, 'refresh_token'), key) : null,
      expires_at: t.expiresAt,
      ...(t.scope ? { scope: t.scope } : {}),
    })
    .where(and(eq(accounts.provider, 'discord'), eq(accounts.providerAccountId, providerAccountId)))
}
