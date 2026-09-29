'use client'

import { useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

/** A portal tab. `also` lists other path prefixes that belong to it; `staff` tints it. */
export type NavItem = { href: string; label: string; also?: string[]; staff?: boolean }

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`)

export function isActive(path: string, i: NavItem): boolean {
  if (i.href === '/') return path === '/'
  return under(path, i.href) || (i.also ?? []).some((a) => under(path, a))
}

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname() ?? '/'
  const ref = useRef<HTMLElement>(null)
  // Phones: the tabs are a sideways-scrolling strip; bring the current one
  // into view (horizontally only, so the page itself never jumps).
  useEffect(() => {
    const nav = ref.current
    const cur = nav?.querySelector<HTMLElement>('[aria-current]')
    if (!nav || !cur || nav.scrollWidth <= nav.clientWidth) return
    nav.scrollLeft = Math.max(0, cur.offsetLeft - nav.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2)
  }, [path])
  return (
    <nav ref={ref} aria-label="Music Portal" className="efms-tabs">
      {items.map((i) => (
        <Link
          key={i.href}
          href={i.href}
          className={i.staff ? 'efms-tab efms-staff' : 'efms-tab'}
          aria-current={isActive(path, i) ? 'page' : undefined}
        >
          {i.label}
        </Link>
      ))}
    </nav>
  )
}
