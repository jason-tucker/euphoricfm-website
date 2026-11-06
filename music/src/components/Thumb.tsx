'use client'

// Album-art thumbnail with a clear placeholder when there is none or the
// image fails to load (CSP, 404).
//
// v0.4.1: a signed cover URL (/api/media/cover|art/<itemId>?…, 5-min TTL)
// that failed is renewed ONCE through GET /api/items/:id/preview (the same
// pattern AudioPreview uses), so a lazy thumb scrolled into view after the
// signature expired still shows its art. Library art (AzuraCast) is loaded
// with decoding=async and a low fetch priority.

import { useState } from 'react'

const SIZE = { xs: 'size-10', sm: 'size-12', md: 'size-16', lg: 'size-24', xl: 'size-32' } as const

// The item id of a signed item-cover URL, or null.
export function signedCoverItem(src: string): number | null {
  const m = /^\/api\/media\/cover\/(\d{1,10})\?/.exec(src)
  return m ? Number(m[1]) : null
}

export function Thumb({ src: initial, alt, size = 'sm' }: { src: string | null | undefined; alt: string; size?: keyof typeof SIZE }) {
  const [renewed, setRenewed] = useState<{ from: string; to: string | null } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const src = renewed && renewed.from === initial ? renewed.to : initial
  const onError = async () => {
    const itemId = initial && !renewed ? signedCoverItem(initial) : null
    if (itemId === null || !initial) return setFailed(src ?? null)
    try {
      const r = await fetch(`/api/items/${itemId}/preview`, { headers: { accept: 'application/json' } })
      const j = r.ok ? ((await r.json()) as { coverUrl?: string | null }) : null
      setRenewed({ from: initial, to: j?.coverUrl ?? null })
    } catch {
      setRenewed({ from: initial, to: null })
    }
  }
  if (!src || failed === src) {
    return (
      <span role="img" aria-label="No album art" className={`${SIZE[size]} flex shrink-0 items-center justify-center rounded-lg border border-dashed border-cream/20 bg-cream/[0.03] text-cream/35`}>
        <svg aria-hidden="true" viewBox="0 0 24 24" className="size-1/2 fill-current">
          <path d="M9 18.5a2.5 2.5 0 1 1-2-2.45V6l11-2v11.5a2.5 2.5 0 1 1-2-2.45V7.3L9 8.6v9.9Z" />
        </svg>
      </span>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      fetchPriority="low"
      onError={() => (src === initial ? void onError() : setFailed(src))}
      className={`${SIZE[size]} shrink-0 rounded-lg border border-cream/10 object-cover`}
    />
  )
}
