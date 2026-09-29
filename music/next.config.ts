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

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  env: { NEXT_PUBLIC_APP_VERSION: version },
  images: { unoptimized: true },
  serverExternalPackages: ['@tus/server', '@tus/file-store', 'postgres'],
  experimental: {
    serverActions: { bodySizeLimit: '1mb', allowedOrigins: ['music.euphoric.fm'] },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
