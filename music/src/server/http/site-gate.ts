// Site gate (v0.5.0, contract "Site gate"): one web image serves two portals.
//
// PORTAL_SITE=events (events.euphoric.fm):
//   - page paths /x are rewritten to the app/ev tree (/ → /ev, /x → /ev/x),
//     so Auth.js's pages.error '/denied' lands on /ev/denied;
//   - allowed as-is: /api/ev/**, /api/auth/**, /api/health, the tus routes
//     /api/uploads and /api/uploads/<32 hex>, /_next/**, public assets;
//   - everything else is a 404, including every other /api route
//     (/api/uploads/art/**, /api/batches/**, …) and /ev/** asked for directly.
// PORTAL_SITE=music (default): /ev/** and /api/ev/** are a 404; nothing else
// changes.
//
// Checks run on the percent-DECODED path, so an encoded segment cannot slip
// past a prefix test. Pure; unit-tested in test/events-contract.test.ts.

import type { PortalSite } from '../env'

export type GateVerdict = { kind: 'pass' } | { kind: 'rewrite'; pathname: string } | { kind: 'not_found'; api: boolean }

const PASS: GateVerdict = { kind: 'pass' }
const EV_TREE = /^\/ev(?:\/|$)/
const API = /^\/api(?:\/|$)/
const API_EV = /^\/api\/ev(?:\/|$)/
const EVENTS_API_ALLOWED = [API_EV, /^\/api\/auth(?:\/|$)/, /^\/api\/health$/, /^\/api\/uploads$/, /^\/api\/uploads\/[0-9a-f]{32}$/]
// Next internals and the files in public/ (served before the app router).
const EVENTS_STATIC = [/^\/_next\//, /^\/favicon\.(?:svg|ico)$/, /^\/fonts\/[^/]+$/]

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

export function siteGate(site: PortalSite, pathname: string): GateVerdict {
  const path = decodePath(pathname)
  if (path === null || path.includes('\\')) return { kind: 'not_found', api: API.test(pathname) }
  if (site === 'music') {
    if (API_EV.test(path)) return { kind: 'not_found', api: true }
    if (EV_TREE.test(path)) return { kind: 'not_found', api: false }
    return PASS
  }
  if (API.test(path)) return EVENTS_API_ALLOWED.some((re) => re.test(path)) ? PASS : { kind: 'not_found', api: true }
  if (EVENTS_STATIC.some((re) => re.test(path))) return PASS
  if (EV_TREE.test(path)) return { kind: 'not_found', api: false }
  return { kind: 'rewrite', pathname: pathname === '/' ? '/ev' : `/ev${pathname}` }
}

// A path no route matches: rewriting a refused page here renders the root
// not-found page with a 404 status (and the normal nonce/CSP headers).
export const NOT_FOUND_PATH = '/_efm-not-found'
