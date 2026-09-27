// Route wrapper: CSRF re-check for unsafe methods (independent of middleware),
// HttpError → JSON, anything else → opaque 500.

import { webEnv } from '../env'
import { checkCsrf, SAFE_METHODS } from './csrf'
import { HttpError } from './errors'

type Ctx<P> = { params: Promise<P> }

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  })
}

export function route<P = Record<string, string>>(fn: (req: Request, params: P) => Promise<Response>) {
  return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
    try {
      if (!SAFE_METHODS.has(req.method.toUpperCase())) {
        const v = checkCsrf(req.method, new URL(req.url).pathname, req.headers, webEnv().PORTAL_ORIGIN)
        if (!v.ok) throw new HttpError(403, `csrf_${v.reason}`)
      }
      return await fn(req, (await ctx.params) ?? ({} as P))
    } catch (err) {
      if (err instanceof HttpError) {
        return jsonResponse(err.status, { error: err.code, ...(err.extra ?? {}) }, err.headers)
      }
      console.error('[route] unhandled', req.method, new URL(req.url).pathname, err instanceof Error ? err.name + ': ' + err.message : err)
      return jsonResponse(500, { error: 'internal' })
    }
  }
}

export function parseId(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d{0,9}$/.test(raw)) throw new HttpError(404, 'not_found')
  const n = Number(raw)
  if (n > 2_147_483_647) throw new HttpError(404, 'not_found')
  return n
}
