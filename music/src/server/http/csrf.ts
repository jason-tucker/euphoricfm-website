// CSRF gate (plan §3.2). Unsafe methods must carry BOTH
//   Origin: <PORTAL_ORIGIN>        (exact string match)
//   Sec-Fetch-Site: same-origin
// Only the HMAC-authenticated webhook receiver is exempt. Sibling
// *.euphoric.fm hosts are same-SITE, so SameSite=Lax cookies alone would not
// stop them; the exact-origin + same-origin pair does.
//
// Used by middleware AND re-checked inside every mutating route handler, so
// the control does not depend on middleware running.

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Exact paths only; no prefix match, so /api/hooks/tickets/../x style tricks
// (already normalised by the router) cannot widen the exemption.
export const CSRF_EXEMPT_PATHS = new Set(['/api/hooks/tickets'])

export type CsrfVerdict = { ok: true } | { ok: false; reason: 'origin' | 'fetch_site' }

export function checkCsrf(
  method: string,
  pathname: string,
  headers: { get(name: string): string | null },
  portalOrigin: string,
): CsrfVerdict {
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true }
  if (CSRF_EXEMPT_PATHS.has(pathname)) return { ok: true }
  if (headers.get('origin') !== portalOrigin) return { ok: false, reason: 'origin' }
  if (headers.get('sec-fetch-site') !== 'same-origin') return { ok: false, reason: 'fetch_site' }
  return { ok: true }
}
