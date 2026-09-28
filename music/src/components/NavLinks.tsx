'use client'

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
  return (
    <nav aria-label="Music portal" className="efms-tabs">
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
