'use client'

// Album-art thumbnail with a clear placeholder when there is none or the
// image fails to load (expired signed URL, CSP, 404).

import { useState } from 'react'

const SIZE = { xs: 'size-10', sm: 'size-12', md: 'size-16', lg: 'size-24', xl: 'size-32' } as const

export function Thumb({ src, alt, size = 'sm' }: { src: string | null | undefined; alt: string; size?: keyof typeof SIZE }) {
  const [failed, setFailed] = useState<string | null>(null)
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
    <img src={src} alt={alt} loading="lazy" onError={() => setFailed(src)} className={`${SIZE[size]} shrink-0 rounded-lg border border-cream/10 object-cover`} />
  )
}
