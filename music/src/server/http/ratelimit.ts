// Fixed-window per-key limiter, bounded in memory (oldest bucket evicted).
// Keys are `cf-connecting-ip` (plan §3.2): the portal is reachable publicly
// only through the Cloudflare tunnel, which overwrites that header, so the
// client cannot choose its own bucket. Requests without it (hooks network,
// local health checks) share one 'no-cf-ip' bucket.

export type Limit = { name: string; max: number; windowMs: number }

export const LIMITS = {
  auth: { name: 'auth', max: 20, windowMs: 60_000 },
  mutation: { name: 'mutation', max: 30, windowMs: 60_000 },
  // tus PATCH chunks are data transfer, not state changes; they get their own
  // bucket (a 35 MB file is 5 chunks) bounded by the per-user upload caps.
  uploadChunk: { name: 'upload-chunk', max: 240, windowMs: 60_000 },
} as const satisfies Record<string, Limit>

type Bucket = { windowStart: number; count: number }

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  constructor(private readonly maxKeys = 10_000) {}

  hit(limit: Limit, key: string, now = Date.now()): { ok: boolean; retryAfterS: number } {
    const k = `${limit.name}|${key}`
    let b = this.buckets.get(k)
    if (!b || now - b.windowStart >= limit.windowMs) {
      b = { windowStart: now, count: 0 }
    }
    // Re-insert to keep Map order ≈ recency for eviction.
    this.buckets.delete(k)
    this.buckets.set(k, b)
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value
      if (oldest !== undefined) this.buckets.delete(oldest)
    }
    b.count += 1
    if (b.count > limit.max) {
      return { ok: false, retryAfterS: Math.max(1, Math.ceil((b.windowStart + limit.windowMs - now) / 1000)) }
    }
    return { ok: true, retryAfterS: 0 }
  }
}

export function clientKey(headers: { get(name: string): string | null }): string {
  const ip = headers.get('cf-connecting-ip')?.trim()
  if (ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip)) return ip
  return 'no-cf-ip'
}
