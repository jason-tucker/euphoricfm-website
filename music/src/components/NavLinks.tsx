'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export type NavItem = { href: string; label: string }

export function NavLinks({ items }: { items: NavItem[] }) {
  const path = usePathname() ?? '/'
  return (
    <nav aria-label="Main" className="flex flex-wrap items-center gap-1">
      {items.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`)
        return (
          <Link key={i.href} href={i.href} className="nav-link" aria-current={active ? 'page' : undefined}>
            {i.label}
          </Link>
        )
      })}
    </nav>
  )
}
