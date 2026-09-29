// Content-Security-Policy (plan §3.2) — exactly these directives, plus
// https://euphoric.fm in img-src (album-art amendment 2026-09-27).
// v0.5.0: the events site (PORTAL_SITE=events) also lets the browser reach
// https://euphoric.fm for the Event station stream (media-src) and its
// public now-playing API (connect-src). The music site is unchanged.

export function buildCsp(nonce: string, site: 'music' | 'events' = 'music'): string {
  const station = site === 'events' ? ' https://euphoric.fm' : ''
  return [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}'`,
    // https://euphoric.fm: AzuraCast's public album art (art contract).
    `img-src 'self' data: blob: https://cdn.discordapp.com https://euphoric.fm`,
    `media-src 'self' blob:${station}`,
    `connect-src 'self'${station}`,
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
