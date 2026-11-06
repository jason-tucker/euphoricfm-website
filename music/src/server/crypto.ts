// AES-256-GCM envelope + HKDF subkeys, keyed by APP_ENC_KEY (plan §3.1:
// "Access and refresh tokens are AES-256-GCM with APP_ENC_KEY").
//
// Envelope format matches euphoric-tickets-web's integrations/crypto.ts:
//   v1:<iv b64url>:<tag b64url>:<ciphertext b64url>
// with a fresh 96-bit IV per encryption and a caller-supplied AAD that binds
// the ciphertext to its row + column, so a token copied onto another account
// row (or from access_token into refresh_token) fails to decrypt.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

export class CryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoError'
  }
}

export function parseEncKey(raw: string | undefined, name = 'APP_ENC_KEY'): Buffer {
  if (!raw) throw new CryptoError(`${name} is not set`)
  const v = raw.trim()
  let key: Buffer | null = null
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex')
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (!key || key.length !== 32) {
    throw new CryptoError(`${name} must be 32 bytes (base64 or 64 hex chars)`)
  }
  return key
}

export function encryptField(plaintext: string, aad: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`
}

export function decryptField(envelope: string, aad: string, key: Buffer): string {
  const parts = envelope.split(':')
  if (parts.length !== 4 || parts[0] !== 'v1') throw new CryptoError('bad envelope')
  const iv = Buffer.from(parts[1]!, 'base64url')
  const tag = Buffer.from(parts[2]!, 'base64url')
  const ct = Buffer.from(parts[3]!, 'base64url')
  if (iv.length !== 12 || tag.length !== 16) throw new CryptoError('bad envelope')
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch {
    throw new CryptoError('decrypt failed')
  }
}

export function isEnvelope(v: string | null | undefined): boolean {
  return typeof v === 'string' && /^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]*$/.test(v)
}

// Purpose-separated subkeys (e.g. the media-URL signing key) so one env
// secret never serves two primitives directly.
export function deriveSubkey(master: Buffer, label: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), `efm-music:${label}`, 32))
}
