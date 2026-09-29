// Portal header (Release 3): the shared EuphoricFM top bar (SiteBar, identical
// on info.euphoric.fm and for every role), then the portal's own second row:
// bordered tabs (Home · My music · Submit · Library · Review · Admin, by
// permission) and the account menu / sign-in. The second row scrolls away;
// on phones its tabs are one sideways-scrolling strip.
// Server component; the tab highlight and the menu closing are the client parts.

import { signInWithDiscord, signOutAction } from '@/app/actions'
import type { Viewer } from '@/server/authz/predicates'
import { NavLinks, type NavItem } from './NavLinks'
import { SiteBar } from './SiteBar'

export function navFor(perms: ReadonlySet<string>): NavItem[] {
  const items: NavItem[] = [{ href: '/', label: 'Home' }]
  if (perms.has('submit')) {
    // A batch page belongs to My music.
    items.push({ href: '/dashboard', label: 'My music', also: ['/batches'] })
    items.push({ href: '/submit', label: 'Submit' })
    // The library is where edit and removal requests start (v0.3.4: always
    // labelled "Library"; the home page's action cards name the requests).
    items.push({ href: '/library', label: 'Library' })
  }
  if (perms.has('review')) items.push({ href: '/review', label: 'Review', staff: true })
  if (perms.has('admin')) items.push({ href: '/admin', label: 'Admin', staff: true })
  return items
}

const ROLE_LABEL = (perms: ReadonlySet<string>) =>
  perms.has('admin') ? 'Admin' : perms.has('manage') ? 'Manager' : perms.has('review') ? 'Reviewer' : 'Member'

function Caret() {
  return (
    <svg className="efmh-caret" viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function PortalRow({ viewer }: { viewer: Viewer | null }) {
  const name = viewer?.name ?? 'Account'
  return (
    <div className="efms">
      <div className="efms-in">
        <span className="efms-label">Music Portal</span>
        <NavLinks items={navFor(viewer?.perms ?? new Set())} />
        <div className="efms-end">
          {viewer ? (
            <details className="efms-acct" data-efmh-menu="">
              <summary className="efms-btn" aria-label="Account menu">
                <span className="efms-avatar" aria-hidden="true">
                  {name.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span className="efms-name">{name}</span>
                <Caret />
              </summary>
              <div className="efms-panel">
                <p className="efms-who">
                  Signed in as <b>{viewer.name ?? viewer.discordId}</b>
                  <br />
                  {ROLE_LABEL(viewer.perms)}
                </p>
                <form action={signOutAction}>
                  <button type="submit" className="efms-btn efms-signout">
                    Sign out
                  </button>
                </form>
              </div>
            </details>
          ) : (
            <form action={signInWithDiscord}>
              <button type="submit" className="efms-btn">
                Sign in
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

export function Header({ viewer }: { viewer: Viewer | null }) {
  return (
    <>
      <SiteBar />
      <PortalRow viewer={viewer} />
    </>
  )
}
