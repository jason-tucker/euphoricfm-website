// v0.4.1 (second pass): the portal's static security headers, read from the
// real next.config.ts (the built server is checked by e2e-web.test.ts).
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import nextConfig from '../../next.config'

describe('next.config.ts security headers', () => {
  it('every path gets HSTS, nosniff, Referrer-Policy and the info site’s Permissions-Policy', async () => {
    const rules = await nextConfig.headers!()
    expect(rules).toHaveLength(1)
    expect(rules[0]!.source).toBe('/:path*')
    const h = Object.fromEntries(rules[0]!.headers.map((x) => [x.key, x.value]))
    expect(h).toEqual({
      'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Permissions-Policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()',
    })
  })

  // The harness image holds only music/: the cross-check with the repo-root
  // Caddyfile runs where the whole repo is checked out (pnpm test:ui, CI's
  // jsdom step) and is skipped inside the image.
  it.skipIf(!existsSync('../Caddyfile'))('the value is the one info.euphoric.fm sends (repo-root Caddyfile)', async () => {
    const rules = await nextConfig.headers!()
    const pp = rules[0]!.headers.find((x) => x.key === 'Permissions-Policy')!.value
    expect(readFileSync('../Caddyfile', 'utf8')).toContain(`Permissions-Policy "${pp}"`)
  })

  it('the unused duplicate of these headers in csp.ts is gone (one source)', () => {
    expect(readFileSync('src/server/http/csp.ts', 'utf8')).not.toMatch(/STATIC_SECURITY_HEADERS/)
  })
})
