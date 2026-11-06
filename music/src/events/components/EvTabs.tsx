'use client'

// The events second-row tabs (efms-tab) and the menu outside-click/Escape
// closing shared with the portal bar.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef } from 'react'
import { useMenuDismiss } from '@/components/SiteBar'

export type EvTab = { href: string; label: string; also?: string[]; staff?: boolean }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

/** Events pages are served at /x but live under app/ev; accept either form. */
export const sitePath = (p: string) => (p === '/ev' ? '/' : p.startsWith('/ev/') ? p.slice(3) : p)

export function isTabActive(rawPath: string, t: EvTab): boolean {
  const path = sitePath(rawPath)
  if (t.href === '/') return path === '/' || (t.also ?? []).some((a) => under(path, a))
  return under(path, t.href) || (t.also ?? []).some((a) => under(path, a))
}

export function EvTabs({ items }: { items: EvTab[] }) {
  const path = usePathname() ?? '/'
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const nav = ref.current
    const cur = nav?.querySelector<HTMLElement>('[aria-current]')
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return
    nav.scrollLeft = Math.max(0, cur.offsetLeft - nav.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2)
  }, [path])
  return (
    <nav ref={ref} aria-label="Events" className="efms-tabs">
      {items.map((t) => (
        <Link key={t.href} href={t.href} className={t.staff ? 'efms-tab efms-staff' : 'efms-tab'} aria-current={isTabActive(path, t) ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}

export function EvMenuDismiss() {
  useMenuDismiss()
  return null
}
