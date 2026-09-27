// Edge-of-app controls (plan §3.2): CSP nonce, CSRF, 1 MB body cap on
// non-upload routes, rate limits keyed on cf-connecting-ip.
//
// This is NOT the authorization layer: every route handler re-checks CSRF
// and does its own session + permission + ownership checks, so a middleware
// bypass cannot grant access. Runs in the Node.js runtime (stable in 15.5) so
// the limiter state lives in the server process.
//
// /api/uploads (tus) is excluded from the matcher so Next never buffers 8 MB
// chunks for middleware; the tus route applies the same CSRF + rate-limit
// helpers itself.
//
// Body integrity (CI flake "expected 400 to be 413"): Next 15.5 hands Node
// middleware a CLONE of the request body and swaps its buffered copy into the
// request only once the body has ENDED, without awaiting that swap
// (next-server.js runMiddleware: `finally { requestData.body.finalize() }`).
// A handler that started reading while the body was still arriving read the
// raw stream and missed the prefix the clone had already taken: an oversized
// chunked body looked like < 1 MB of broken JSON (400 instead of 413), and a
// slow, valid body lost its start (400). So every unsafe request that passed
// the checks above has its middleware copy read to the end here, counted
// against the 1 MB cap (413 as soon as it is exceeded, deterministically);
// the handler then always reads the complete buffered body and still applies
// its own cap.

import { NextResponse, type NextRequest } from 'next/server'
import { checkBodyLimited } from './server/http/body'
import { readBodyLimitHeaderOnly } from './server/http/body-header'
import { checkCsrf, SAFE_METHODS } from './server/http/csrf'
import { buildCsp, MEDIA_CSP } from './server/http/csp'
import { clientKey, LIMITS, RateLimiter } from './server/http/ratelimit'

const limiter = new RateLimiter()

function portalOrigin(): string {
  return new URL(process.env.PORTAL_ORIGIN ?? 'https://music.euphoric.fm').origin
}

function json(status: number, code: string, headers: Record<string, string> = {}) {
  return new NextResponse(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const method = req.method.toUpperCase()
  const unsafe = !SAFE_METHODS.has(method)
  const isHook = pathname === '/api/hooks/tickets'

  if (unsafe && readBodyLimitHeaderOnly(req.headers) === 'too_large') {
    return json(413, 'payload_too_large', { Connection: 'close' })
  }
  // The Auth.js handlers read their body without a stream cap, so on
  // /api/auth/* an unsafe request must declare its length (the header cap
  // above then applies). Browsers always send Content-Length for forms.
  if (unsafe && pathname.startsWith('/api/auth/') && (req.headers.get('content-length') === null || req.headers.has('transfer-encoding'))) {
    return json(411, 'length_required', { Connection: 'close' })
  }

  const key = clientKey(req.headers)
  const limit = pathname.startsWith('/api/auth/') ? LIMITS.auth : unsafe && !isHook ? LIMITS.mutation : null
  if (limit) {
    const r = limiter.hit(limit, key)
    if (!r.ok) return json(429, 'rate_limited', { 'Retry-After': String(r.retryAfterS) })
  }

  const csrf = checkCsrf(method, pathname, req.headers, portalOrigin())
  if (!csrf.ok) return json(403, `csrf_${csrf.reason}`)

  // After the cheap refusals, so a refused request's body is never read.
  if (unsafe && req.body) {
    const b = await checkBodyLimited(req)
    if (b === 'too_large') return json(413, 'payload_too_large', { Connection: 'close' })
    if (b === 'bad_body') return json(400, 'bad_body', { Connection: 'close' })
  }

  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  const csp = pathname.startsWith('/api/media/') ? MEDIA_CSP : buildCsp(nonce)
  const requestHeaders = new Headers(req.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', csp)
  const res = NextResponse.next({ request: { headers: requestHeaders } })
  res.headers.set('Content-Security-Policy', csp)
  return res
}

export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|api/uploads(?:/|$)).*)'],
}
