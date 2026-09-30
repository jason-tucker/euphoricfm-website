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
  // v0.5.3: the events request form autosaves a draft (PATCH details + PUT
  // playlist, debounced), which under steady editing is more than 30/min.
  // Only those edits (and the form's combined keepalive save, POST /draft)
  // use this bucket; each is still authenticated, CSRF-checked and
  // version-checked by its route.
  eventEdit: { name: 'event-edit', max: 120, windowMs: 60_000 },
} as const satisfies Record<string, Limit>

const EVENT_EDIT = /^\/api\/ev\/events\/\d+(\/playlist|\/draft)?$/
const EDIT_METHOD: Record<string, string> = { '': 'PATCH', '/playlist': 'PUT', '/draft': 'POST' }

/** The bucket for a request (null = not limited here). */
export function limitFor(pathname: string, method: string, unsafe: boolean, isHook: boolean): Limit | null {
  if (pathname.startsWith('/api/auth/')) return LIMITS.auth
  if (!unsafe || isHook) return null
  const edit = EVENT_EDIT.exec(pathname)
  if (edit && EDIT_METHOD[edit[1] ?? ''] === method) return LIMITS.eventEdit
  return LIMITS.mutation
}

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

// IPv6 clients are bucketed per /64 (one host normally controls a whole
// /64); IPv4-mapped IPv6 addresses are keyed as the IPv4 address.
function expandV6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  let tail: number[] = []
  const v4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s)
  if (v4) {
    const b = v4.slice(1).map(Number)
    if (b.some((x) => x > 255)) return null
    tail = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!]
    s = s.slice(0, v4.index) + (s.slice(0, v4.index).endsWith(':') ? '' : ':') + '0:0'
  }
  const parts = s.split('::')
  if (parts.length > 2) return null
  const head = parts[0] ? parts[0].split(':') : []
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':') : []
  const fill = 8 - head.length - rest.length
  if ((parts.length === 1 && fill !== 0) || fill < 0) return null
  const all = [...head, ...Array(parts.length === 2 ? fill : 0).fill('0'), ...rest]
  if (all.length !== 8 || all.some((h) => !/^[0-9a-f]{1,4}$/.test(h))) return null
  const words = all.map((h) => parseInt(h, 16))
  if (tail.length) words.splice(6, 2, ...tail)
  return words
}

export function clientKey(headers: { get(name: string): string | null }): string {
  const ip = headers.get('cf-connecting-ip')?.trim()
  if (!ip || ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(ip)) return 'no-cf-ip'
  if (!ip.includes(':')) return ip
  const w = expandV6(ip)
  if (!w) return 'no-cf-ip'
  // ::ffff:a.b.c.d → a.b.c.d
  if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) return `${w[6]! >> 8}.${w[6]! & 255}.${w[7]! >> 8}.${w[7]! & 255}`
  return `${w.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`
}
