// Receiver side of the tickets webhook signature (INTEGRATION_API.md,
// "Outbound webhooks"): X-Euphoric-Signature: t=<unix>,v1=<hex HMAC-SHA256(
// secret, `${t}.${deliveryId}.${rawBody}`)>. Reject |now − t| > 300 s;
// compare with timingSafeEqual over the RAW bytes BEFORE any JSON parsing.

import { createHmac, timingSafeEqual } from 'node:crypto'

export const TOLERANCE_S = 300
export const DELIVERY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type SigVerdict = { ok: true } | { ok: false; reason: 'malformed' | 'stale' | 'mismatch' }

export function verifyTicketsSignature(opts: {
  secrets: readonly string[] // current, then optional previous (rotation)
  header: string | null
  deliveryId: string | null
  rawBody: Buffer
  nowSec: number
}): SigVerdict {
  if (!opts.deliveryId || !DELIVERY_ID_RE.test(opts.deliveryId)) return { ok: false, reason: 'malformed' }
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(opts.header ?? '')
  if (!m) return { ok: false, reason: 'malformed' }
  const t = Number(m[1])
  if (Math.abs(opts.nowSec - t) > TOLERANCE_S) return { ok: false, reason: 'stale' }
  const given = Buffer.from(m[2]!, 'hex')
  let ok = false
  for (const secret of opts.secrets) {
    if (!secret) continue
    const h = createHmac('sha256', secret)
    h.update(`${t}.${opts.deliveryId}.`, 'utf8')
    h.update(opts.rawBody)
    const expected = h.digest()
    // constant-time per candidate; no early exit on the first match either
    if (timingSafeEqual(expected, given)) ok = true
  }
  return ok ? { ok: true } : { ok: false, reason: 'mismatch' }
}
