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

import { NextResponse, type NextRequest } from 'next/server'
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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl
  const method = req.method.toUpperCase()
  const unsafe = !SAFE_METHODS.has(method)
  const isHook = pathname === '/api/hooks/tickets'

  if (unsafe && readBodyLimitHeaderOnly(req.headers) === 'too_large') {
    return json(413, 'payload_too_large')
  }

  const key = clientKey(req.headers)
  const limit = pathname.startsWith('/api/auth/') ? LIMITS.auth : unsafe && !isHook ? LIMITS.mutation : null
  if (limit) {
    const r = limiter.hit(limit, key)
    if (!r.ok) return json(429, 'rate_limited', { 'Retry-After': String(r.retryAfterS) })
  }

  const csrf = checkCsrf(method, pathname, req.headers, portalOrigin())
  if (!csrf.ok) return json(403, `csrf_${csrf.reason}`)

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
