// tus endpoint. Excluded from middleware (so 8 MB chunks are never buffered
// for it); applies the same CSRF + rate-limit helpers itself, authenticates
// the session and membership, enforces the header caps, then hands the
// request to @tus/server inside a context that carries the session user.

import { checkCsrf } from '@/server/http/csrf'
import { clientKey, LIMITS, RateLimiter } from '@/server/http/ratelimit'
import { HttpError } from '@/server/http/errors'
import { jsonResponse } from '@/server/http/route'
import { requirePermission } from '@/server/authz/viewer'
import { webEnv } from '@/server/env'
import { checkCreateHeaders, checkPatchHeaders, diskPaused, UPLOAD_ID_RE } from '@/server/uploads/caps'
import { tusContext, tusServer, TUS_PATH } from '@/server/uploads/tus'
import { DEFAULT_CAPS } from '@/server/settings-defaults'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const limiter = new RateLimiter()

function capStream(body: ReadableStream<Uint8Array> | null, max: number): ReadableStream<Uint8Array> | null {
  if (!body) return null
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > max) controller.error(new Error('chunk exceeds cap'))
        else controller.enqueue(chunk)
      },
    }),
  )
}

async function handle(req: Request): Promise<Response> {
  const method = req.method.toUpperCase()
  const url = new URL(req.url)
  const rest = url.pathname.slice(TUS_PATH.length)
  const id = rest === '' || rest === '/' ? null : rest.slice(1)
  if (id !== null && !UPLOAD_ID_RE.test(id)) return jsonResponse(404, { error: 'not_found' })

  // GET would stream staged bytes back with a client-chosen type: never.
  if (method === 'GET') return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'POST, HEAD, PATCH, DELETE, OPTIONS' })
  if (!['POST', 'HEAD', 'PATCH', 'DELETE', 'OPTIONS'].includes(method)) return jsonResponse(405, { error: 'method_not_allowed' })
  if ((method === 'POST') !== (id === null) && method !== 'OPTIONS') return jsonResponse(404, { error: 'not_found' })

  const env = webEnv()
  if (method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = checkCsrf(method, url.pathname, req.headers, env.PORTAL_ORIGIN)
    if (!csrf.ok) return jsonResponse(403, { error: `csrf_${csrf.reason}` })
    const r = limiter.hit(method === 'PATCH' ? LIMITS.uploadChunk : LIMITS.mutation, clientKey(req.headers))
    if (!r.ok) return jsonResponse(429, { error: 'rate_limited' }, { 'Retry-After': String(r.retryAfterS) })
  }

  const viewer = await requirePermission('submit')

  let body: ReadableStream<Uint8Array> | null = null
  if (method === 'POST') {
    const c = checkCreateHeaders(req.headers)
    if ('code' in c) return jsonResponse(c.status, { error: c.code })
    if (await diskPaused(env.STAGING_UPLOADS_DIR)) return jsonResponse(503, { error: 'uploads_paused' }, { 'Retry-After': '300' })
  } else if (method === 'PATCH') {
    const refusal = checkPatchHeaders(req.headers)
    if (refusal) return jsonResponse(refusal.status, { error: refusal.code })
    if (await diskPaused(env.STAGING_UPLOADS_DIR)) return jsonResponse(503, { error: 'uploads_paused' }, { 'Retry-After': '300' })
    body = capStream(req.body, DEFAULT_CAPS.chunkBytes)
  }

  const forwarded = new Request(req.url, {
    method,
    headers: req.headers,
    body,
    ...(body ? { duplex: 'half' } : {}),
  } as RequestInit)
  return tusContext.run({ userId: viewer.userId }, () => tusServer().handleWeb(forwarded))
}

async function wrapped(req: Request): Promise<Response> {
  try {
    const res = await handle(req)
    res.headers.set('Cache-Control', 'no-store')
    return res
  } catch (err) {
    if (err instanceof HttpError) return jsonResponse(err.status, { error: err.code }, err.headers)
    console.error('[uploads] unhandled', err instanceof Error ? err.message : err)
    return jsonResponse(500, { error: 'internal' })
  }
}

export { wrapped as POST, wrapped as HEAD, wrapped as PATCH, wrapped as DELETE, wrapped as OPTIONS, wrapped as GET }
