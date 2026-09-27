// Page-level permission gate for server components. Every page calls this
// itself (never relying on middleware): it wraps requirePermission() and
// turns its HttpErrors into navigation — sign-in for 401, /denied for a
// member-level 403, and a plain 404 for elevated pages (no probing).

import { eq } from 'drizzle-orm'
import { notFound, redirect } from 'next/navigation'
import { cache } from 'react'
import type { Perm } from '../authz/permissions'
import { currentUser, optionalViewer, requirePermission, type Viewer } from '../authz/viewer'
import { getDb } from '../db/client'
import { memberCache } from '../db/schema'
import { HttpError } from '../http/errors'

async function denyReason(): Promise<'pending' | 'not_member'> {
  try {
    const u = await currentUser()
    if (!u) return 'not_member'
    const m = await getDb().query.memberCache.findFirst({ where: eq(memberCache.discordId, u.discordId) })
    return m?.member && m.pending ? 'pending' : 'not_member'
  } catch {
    return 'not_member'
  }
}

export async function pageViewer(perm: Perm): Promise<Viewer> {
  let status = 0
  try {
    return await requirePermission(perm)
  } catch (e) {
    if (!(e instanceof HttpError)) throw e
    status = e.status
  }
  // redirect()/notFound() throw; keep them outside the try above.
  if (status === 401) redirect('/')
  if (status === 403 && (perm === 'submit' || perm === 'request')) redirect(`/denied?reason=${await denyReason()}`)
  notFound()
}

// Runs a read that may throw the API's HttpError 404 and renders Next's 404.
export async function orNotFound<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) notFound()
    throw e
  }
}

// The header needs the viewer on every page; dedupe within one render.
export const headerViewer = cache(async (): Promise<Viewer | null> => optionalViewer())
