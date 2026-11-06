// Short-lived signed preview URLs (plan §3.3 "Signed short-lived URL"),
// bound to (kind, item, viewer, expiry). The serving route ALSO requires the
// session and the owner-or-review predicate; the signature additionally stops
// a URL from being replayed by another account or after expiry.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { deriveSubkey, parseEncKey } from '../crypto'

export const MEDIA_URL_TTL_S = 300
export type MediaKind = 'audio' | 'cover' | 'art'

let key: Buffer | null = null
function mediaKey(): Buffer {
  if (!key) key = deriveSubkey(parseEncKey(process.env.APP_ENC_KEY), 'media-url-v1')
  return key
}

// `itemId` is an item id, or an art upload id (uuid) for kind 'art'.
function mac(kind: MediaKind, itemId: number | string, userId: string, exp: number, k: Buffer) {
  return createHmac('sha256', k).update(`${kind}|${itemId}|${userId}|${exp}`).digest()
}

export function signMediaUrl(kind: MediaKind, itemId: number | string, userId: string, nowS = Math.floor(Date.now() / 1000), k = mediaKey()): string {
  const exp = nowS + MEDIA_URL_TTL_S
  return `/api/media/${kind}/${itemId}?exp=${exp}&sig=${mac(kind, itemId, userId, exp, k).toString('base64url')}`
}

export function verifyMediaSig(
  kind: MediaKind,
  itemId: number | string,
  userId: string,
  expRaw: string | null,
  sigRaw: string | null,
  nowS = Math.floor(Date.now() / 1000),
  k = mediaKey(),
): boolean {
  if (!expRaw || !sigRaw || !/^\d{1,12}$/.test(expRaw) || !/^[A-Za-z0-9_-]{43}$/.test(sigRaw)) return false
  const exp = Number(expRaw)
  if (exp < nowS || exp > nowS + MEDIA_URL_TTL_S) return false
  return timingSafeEqual(mac(kind, itemId, userId, exp, k), Buffer.from(sigRaw, 'base64url'))
}
