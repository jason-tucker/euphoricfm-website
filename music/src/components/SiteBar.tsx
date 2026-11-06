'use client'

// The shared EuphoricFM top bar (Release 3): the same items, markup and
// stylesheet as info.euphoric.fm's src/components/Header.astro. Everything
// comes from src/shared/nav.json (a byte-for-byte copy of the repo's
// shared/nav.json; the site's test/shared-drift.test.mjs and
// test/ui/site-bar.test.tsx fail when either drifts). Identical for every
// role: staff and account items live in the portal's second row (Header.tsx).
//
// Menus are <details>/<summary>, so they work with JavaScript off; the effect
// below only adds outside-click / Escape / follow-a-link closing.

import { useEffect } from 'react'
import { usePathname } from 'next/navigation'
import nav from '@/shared/nav.json'

type Link = { site?: string; path?: string }

const icons = nav.icons as Record<string, string[]>
// On music.euphoric.fm, portal paths stay relative; info paths get the origin.
export const barHref = (l: Link) => (l.site === 'info' ? nav.origins.info + l.path : (l.path ?? '/'))

function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      {(icons[name] ?? []).map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** Close every open top-bar / second-row menu except `keep`. */
function closeMenus(keep?: Element | null) {
  document.querySelectorAll<HTMLDetailsElement>('details[data-efmh-menu]').forEach((d) => {
    if (d !== keep && d.open) d.open = false
  })
}

export function useMenuDismiss() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t?.closest) return
      const inMenu = t.closest<HTMLDetailsElement>('details[data-efmh-menu]')
      closeMenus(inMenu)
      if (inMenu && t.closest('a')) inMenu.open = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const open = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-efmh-menu][open]'))
      if (!open.length) return
      closeMenus()
      open[0]!.querySelector('summary')?.focus()
    }
    const onToggle = (e: Event) => {
      const d = e.target as HTMLDetailsElement
      if (d.matches?.('details[data-efmh-menu]') && d.open) closeMenus(d)
    }
    document.addEventListener('click', onClick)
    document.addEventListener('keydown', onKey)
    document.addEventListener('toggle', onToggle, true)
    return () => {
      document.removeEventListener('click', onClick)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('toggle', onToggle, true)
    }
  }, [])
}

export function SiteBar() {
  const path = usePathname() ?? '/'
  useMenuDismiss()
  const menu = nav.musicMenu
  const items = nav.items.filter((i) => !('menu' in i && i.menu))
  const here = (l: Link) => (l.site === 'portal' && (path === l.path || path.startsWith(`${l.path}/`)) ? 'page' : undefined)
  const menuRows = menu.items.map((m) => (
    <li key={m.id}>
      <a className="efmh-mi" href={barHref(m)} aria-current={here(m)}>
        <Icon name={m.id} />
        <span className="efmh-mi-txt">
          <span className="efmh-mi-t">{m.label}</span>
          <span className="efmh-mi-d">{m.desc}</span>
        </span>
      </a>
    </li>
  ))
  const submit = (
    <a className="efmh-gold efmh-submit" href={barHref(menu.submit)} aria-current={here(menu.submit)}>
      <Icon name="submit" />
      {menu.submit.label}
    </a>
  )

  return (
    <header className="efmh" data-efmh="">
      <div className="efmh-in">
        <a className="efmh-brand" href={barHref(nav.brand)} aria-label={nav.brand.label}>
          <span className="efmh-euph">Euphoric</span>
          <span className="efmh-fm">FM</span>
        </a>

        <nav className="efmh-nav" aria-label="EuphoricFM">
          <ul className="efmh-list">
            {nav.items.map((i) =>
              'menu' in i && i.menu ? (
                <li key={i.id}>
                  <details className="efmh-dd" data-efmh-menu="">
                    {/* Every portal page is in the Music section. */}
                    <summary className="efmh-link" data-efmh-id={i.id} aria-current="true">
                      {i.label}
                      <Icon name="caret" className="efmh-caret" />
                    </summary>
                    <div className="efmh-menu">
                      <div className="efmh-menu-h">
                        <span className="efmh-menu-ic">
                          <Icon name="music" />
                        </span>
                        <span>
                          <span className="efmh-menu-t">{menu.title}</span>
                          <span className="efmh-menu-d">{menu.blurb}</span>
                        </span>
                      </div>
                      {submit}
                      <ul className="efmh-rows">{menuRows}</ul>
                    </div>
                  </details>
                </li>
              ) : (
                <li key={i.id}>
                  <a className="efmh-link" href={barHref(i)} data-efmh-id={i.id}>
                    {i.label}
                  </a>
                </li>
              ),
            )}
          </ul>
        </nav>

        <a className="efmh-gold efmh-player" href={barHref(nav.webPlayer)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path className="efmh-fill" d={icons.play![0]} />
          </svg>
          {nav.webPlayer.label}
        </a>

        <details className="efmh-burger" data-efmh-menu="">
          <summary aria-label={nav.sheet.open}>
            <Icon name="menu" className="efmh-m" />
            <Icon name="close" className="efmh-x" />
            <span className="efmh-lbl-open">{nav.sheet.open}</span>
            <span className="efmh-lbl-close">{nav.sheet.close}</span>
          </summary>
          <div className="efmh-sheet">
            <div className="efmh-sheet-in">
              <section className="efmh-grp" aria-label={nav.sheet.stationHeading}>
                <h2 className="efmh-gh">{nav.sheet.stationHeading}</h2>
                <ul className="efmh-grid">
                  {[...items, nav.webPlayer].map((i) => (
                    <li key={i.id}>
                      <a className="efmh-mi" href={barHref(i)} data-efmh-id={i.id}>
                        <Icon name={i.id} />
                        <span className="efmh-mi-txt">
                          <span className="efmh-mi-t">{i.label}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
              <section className="efmh-grp" aria-label={nav.sheet.musicHeading}>
                <h2 className="efmh-gh">{nav.sheet.musicHeading}</h2>
                {submit}
                <ul className="efmh-rows">{menuRows}</ul>
              </section>
            </div>
          </div>
        </details>
      </div>
    </header>
  )
}
