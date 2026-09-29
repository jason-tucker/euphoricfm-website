// Route plumbing for /api/ev/**: the portal's route() wrapper (CSRF
// re-check, HttpError → {error}) plus a defensive site check (the
// middleware's site gate already 404s /api/ev/** on the music host), and
// zod parsing with the UI's error codes.

import type { z } from 'zod'
import { portalSite } from '../../server/env'
import { readJsonLimited } from '../../server/http/body'
import { badRequest, notFound } from '../../server/http/errors'
import { route } from '../../server/http/route'

export { jsonResponse } from '../../server/http/route'

export function evRoute<P = Record<string, string>>(fn: (req: Request, params: P) => Promise<Response>) {
  return route<P>(async (req, params) => {
    if (portalSite() !== 'events') throw notFound()
    return fn(req, params)
  })
}

const issuesOf = (e: z.ZodError) => e.issues.slice(0, 10).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)

/** Parse a JSON body (1 MB cap, application/json) with a contract schema. */
export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  const raw = await readJsonLimited(req)
  const r = schema.safeParse(raw ?? {})
  if (!r.success) throw badRequest('invalid_body', { issues: issuesOf(r.error) })
  return r.data
}

/** An empty body ({} or none) for the action routes. */
export async function parseEmpty(req: Request): Promise<void> {
  const len = req.headers.get('content-length')
  if (!req.body || len === '0') return
  const ct = req.headers.get('content-type') ?? ''
  if (!/^application\/json/i.test(ct)) return
  const raw = await readJsonLimited(req)
  if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw as object).length > 0)) throw badRequest('invalid_body')
}

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.infer<S> {
  const u = new URL(req.url)
  const r = schema.safeParse(Object.fromEntries(u.searchParams))
  if (!r.success) throw badRequest('invalid_query', { issues: issuesOf(r.error) })
  return r.data
}

/** Event id path param (bigserial; the contract's IdParam range). */
export function eventId(raw: string | undefined): number {
  if (!raw || !/^[1-9]\d{0,15}$/.test(raw)) throw notFound()
  const n = Number(raw)
  if (!Number.isSafeInteger(n)) throw notFound()
  return n
}
