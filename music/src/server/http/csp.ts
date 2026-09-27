// Content-Security-Policy (plan §3.2) — exactly these directives, plus
// https://euphoric.fm in img-src (album-art amendment 2026-09-27).

export function buildCsp(nonce: string): string {
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    // https://euphoric.fm: AzuraCast's public album art (art contract).
    `img-src 'self' data: blob: https://cdn.discordapp.com https://euphoric.fm`,
    `media-src 'self' blob:`,
    `connect-src 'self'`,
    `form-action 'self' https://discord.com`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
  ].join('; ')
}

// Served media (audio preview, cover) is never a document.
export const MEDIA_CSP = `sandbox; default-src 'none'`

export const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
}
