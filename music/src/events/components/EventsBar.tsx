// The events site's top bar: the EuphoricFM brand row (efmh-*, links out to
// info.euphoric.fm and music.euphoric.fm, gold Listen button, phone Menu
// sheet) and the events second row (efms-*): Home · Calendar · Listen ·
// Request · My events · Staff (review perm only), the ET | Local toggle and
// the account menu. Same stylesheet (efm-bar.css) and chrome as the portal.
// Server component; tab highlight, menu closing and the toggle are client parts.

import { evSignIn, evSignOut } from '@/app/ev/actions'
import nav from '@/shared/nav.json'
import { EvMenuDismiss, EvTabs, type EvTab } from './EvTabs'
import { TzToggle } from './tz'

export type BarViewer = { name: string | null; discordId: string; review: boolean; manage: boolean; admin: boolean } | null

export const INFO_ORIGIN = nav.origins.info
export const MUSIC_ORIGIN = nav.origins.portal

export function tabsFor(v: BarViewer): EvTab[] {
  const t: EvTab[] = [
    { href: '/', label: 'Home', also: ['/how-it-works'] },
    { href: '/calendar', label: 'Calendar', also: ['/events'] },
    { href: '/listen', label: 'Listen' },
    { href: '/request', label: 'Request' },
  ]
  if (v) t.push({ href: '/my', label: 'My events' })
  if (v?.review) t.push({ href: '/staff', label: 'Staff', staff: true })
  return t
}

const icons = nav.icons as Record<string, string[]>
function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {(icons[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

const OUT = [
  { id: 'about', label: 'EuphoricFM', desc: 'The station: listen, about, stats', href: `${INFO_ORIGIN}/` },
  { id: 'music', label: 'Music portal', desc: 'Get your songs played on EuphoricFM', href: `${MUSIC_ORIGIN}/` },
]

const roleLabel = (v: NonNullable<BarViewer>) => (v.admin ? 'Admin' : v.manage ? 'Manager' : v.review ? 'Staff' : 'Member')

export function EventsBar({ viewer }: { viewer: BarViewer }) {
  const tabs = tabsFor(viewer)
  const name = viewer?.name ?? 'Account'
  return (
    <>
      <EvMenuDismiss />
      <header className="efmh" data-efmh="">
        <div className="efmh-in">
          <a className="efmh-brand" href={`${INFO_ORIGIN}/`} aria-label="EuphoricFM home">
            <span className="efmh-euph">Euphoric</span>
            <span className="efmh-fm">FM</span>
          </a>
          <nav className="efmh-nav" aria-label="EuphoricFM">
            <ul className="efmh-list">
              {OUT.map((o) => (
                <li key={o.id}>
                  <a className="efmh-link" href={o.href}>
                    {o.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <a className="efmh-gold efmh-player" href="/listen">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path className="efmh-fill" d={icons.play![0]} />
            </svg>
            Listen
          </a>
          <details className="efmh-burger" data-efmh-menu="">
            <summary aria-label="Menu">
              <Icon name="menu" className="efmh-m" />
              <Icon name="close" className="efmh-x" />
              <span className="efmh-lbl-open">Menu</span>
              <span className="efmh-lbl-close">Close</span>
            </summary>
            <div className="efmh-sheet">
              <div className="efmh-sheet-in">
                <section className="efmh-grp" aria-label="EuphoricFM Events">
                  <h2 className="efmh-gh">EuphoricFM Events</h2>
                  <a className="efmh-gold efmh-submit" href="/request">
                    <Icon name="events" />
                    Request an event
                  </a>
                  <ul className="efmh-rows">
                    {tabs
                      .filter((t) => t.href !== '/request')
                      .map((t) => (
                        <li key={t.href}>
                          <a className="efmh-mi" href={t.href}>
                            <span className="efmh-mi-txt">
                              <span className="efmh-mi-t">{t.label}</span>
                            </span>
                          </a>
                        </li>
                      ))}
                  </ul>
                </section>
                <section className="efmh-grp" aria-label="More EuphoricFM">
                  <h2 className="efmh-gh">More EuphoricFM</h2>
                  <ul className="efmh-rows">
                    {OUT.map((o) => (
                      <li key={o.id}>
                        <a className="efmh-mi" href={o.href}>
                          <Icon name={o.id} />
                          <span className="efmh-mi-txt">
                            <span className="efmh-mi-t">{o.label}</span>
                            <span className="efmh-mi-d">{o.desc}</span>
                          </span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            </div>
          </details>
        </div>
      </header>
      <div className="efms">
        <div className="efms-in">
          <span className="efms-label">Events</span>
          <EvTabs items={tabs} />
          <div className="efms-end ev-bar-end">
            <TzToggle />
            {viewer ? (
              <details className="efms-acct" data-efmh-menu="">
                <summary className="efms-btn" aria-label="Account menu">
                  <span className="efms-avatar" aria-hidden="true">
                    {name.trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <span className="efms-name">{name}</span>
                  <Icon name="caret" className="efmh-caret" />
                </summary>
                <div className="efms-panel">
                  <p className="efms-who">
                    Signed in as <b>{viewer.name ?? viewer.discordId}</b>
                    <br />
                    {roleLabel(viewer)}
                  </p>
                  <a className="efms-btn ev-panel-link" href="/my">
                    My events
                  </a>
                  <a className="efms-btn ev-panel-link" href="/my/audio">
                    My audio
                  </a>
                  <form action={evSignOut}>
                    <button type="submit" className="efms-btn efms-signout">
                      Sign out
                    </button>
                  </form>
                </div>
              </details>
            ) : (
              <form action={evSignIn}>
                <button type="submit" className="efms-btn">
                  Sign in
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
