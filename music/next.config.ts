import type { NextConfig } from 'next'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string }

// Static security headers on EVERY response (pages, API, _next/static).
// The per-request nonce CSP is set by src/middleware.ts.
const securityHeaders = [
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
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
