import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

// Static security headers on EVERY response (pages, API, _next/static).
// The per-request nonce CSP is set by src/middleware.ts. This is the only
// copy (v0.4.1 removed the unused duplicate in src/server/http/csp.ts).
// Permissions-Policy (v0.4.1): the same value as info.euphoric.fm (Caddyfile),
// so a future XSS or third-party script cannot use these browser features.
const PERMISSIONS_POLICY =
  'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()'
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
]

// Server Actions (sign-in/out) accept both portal hosts. The standalone
// build freezes this config into server.js, so PORTAL_ORIGIN is only seen
// when set at BUILD time (dev/test builds); events.euphoric.fm is listed
// explicitly for the shared production image (events-web).
function actionOrigins(): string[] {
  const hosts = new Set(['music.euphoric.fm', 'events.euphoric.fm'])
  try {
    if (process.env.PORTAL_ORIGIN) hosts.add(new URL(process.env.PORTAL_ORIGIN).host)
  } catch {
    // invalid PORTAL_ORIGIN: the env loader refuses to start anyway
  }
  return [...hosts]
}

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: version },
  images: { unoptimized: true },
  serverExternalPackages: ['@tus/server', '@tus/file-store', 'postgres'],
  experimental: {
    serverActions: { bodySizeLimit: '1mb', allowedOrigins: actionOrigins() },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
