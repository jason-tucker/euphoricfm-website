// Site header: wordmark, permission-aware nav, user menu with sign-out.
// Server component; the nav highlight is the only client part.

import Link from 'next/link'
import { signInWithDiscord, signOutAction } from '@/app/actions'
import type { Viewer } from '@/server/authz/predicates'
import { NavLinks, type NavItem } from './NavLinks'

export function navFor(perms: ReadonlySet<string>): NavItem[] {
  const items: NavItem[] = []
  if (perms.has('submit')) {
    items.push({ href: '/dashboard', label: 'My music' })
    items.push({ href: '/submit', label: 'Submit' })
    // The library is where edit and removal requests start.
    items.push({ href: '/library', label: perms.has('request') ? 'Edit or remove a song' : 'Library' })
  }
  if (perms.has('review')) items.push({ href: '/review', label: 'Review' })
  if (perms.has('admin')) items.push({ href: '/admin', label: 'Admin' })
  return items
}

const ROLE_LABEL = (perms: ReadonlySet<string>) =>
  perms.has('admin') ? 'Admin' : perms.has('manage') ? 'Manager' : perms.has('review') ? 'Reviewer' : 'Member'

export function Header({ viewer }: { viewer: Viewer | null }) {
  return (
    <header className="border-b border-cream/10 bg-ink/60 backdrop-blur">
      <div className="mx-auto flex max-w-frame flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-baseline gap-2 rounded-lg px-1" aria-label="EFM Music Portal home">
          <span className="font-euphoric text-3xl leading-none text-sunburst">Euphoric</span>
          <span className="font-fm text-3xl leading-none text-ruby">FM</span>
          <span className="ml-1 text-xs font-semibold uppercase tracking-[0.2em] text-cream/60">Music</span>
        </Link>
        {viewer ? (
          <div className="flex flex-wrap items-center gap-2">
            <NavLinks items={navFor(viewer.perms)} />
            <details className="relative">
              <summary className="btn btn-secondary btn-sm list-none" aria-label="Account menu">
                <span className="max-w-[10rem] truncate">{viewer.name ?? 'Account'}</span>
                <span aria-hidden="true">▾</span>
              </summary>
              <div className="menu-panel">
                <p className="px-3 py-2 text-xs text-cream/60">
                  Signed in as <span className="text-cream">{viewer.name ?? viewer.discordId}</span>
                  <br />
                  {ROLE_LABEL(viewer.perms)}
                </p>
                <form action={signOutAction}>
                  <button type="submit" className="menu-item">
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          </div>
        ) : (
          <form action={signInWithDiscord}>
            <button type="submit" className="btn btn-secondary btn-sm">
              Sign in
            </button>
          </form>
        )}
      </div>
    </header>
  )
}
