// Release 3: the shared EuphoricFM top bar on the portal, and the portal's
// second row. The bar must be exactly what src/shared/nav.json says, resolved
// to absolute URLs; the site's test/shared-drift.test.mjs checks the built
// info pages against the SAME expected list (and that this nav.json is a
// byte-for-byte copy of the repo's shared/nav.json), so the two bars cannot
// drift apart.
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Header, navFor, PortalRow } from '@/components/Header'
import { isActive } from '@/components/NavLinks'
import { SiteBar } from '@/components/SiteBar'
import nav from '@/shared/nav.json'

vi.mock('@/app/actions', () => ({ signInWithDiscord: vi.fn(), signOutAction: vi.fn() }))

const PORTAL = nav.origins.portal

type L = { label: string; desc?: string; site?: string; path?: string }
/** What both sites must render, from nav.json alone (same as the site test). */
function expectedBar(): [string, string][] {
  const abs = (l: L) => new URL(l.path!, nav.origins[l.site as 'info' | 'portal']).href
  const row = (l: L): [string, string] => [l.desc ? `${l.label} ${l.desc}` : l.label, abs(l)]
  const menu = [nav.musicMenu.submit, ...nav.musicMenu.items].map(row)
  const plain = nav.items.filter((i) => !('menu' in i && i.menu)) as L[]
  return [
    ['Euphoric FM', abs(nav.brand)],
    ...(nav.items as L[]).flatMap((i) => ('menu' in i ? menu : [row(i)])),
    row(nav.webPlayer),
    ...[...plain, nav.webPlayer].map(row),
    ...menu,
  ]
}

/** Every link in the bar as [text, absolute URL], exactly as the site test reads its HTML. */
function barLinks(header: Element, base: string): [string, string][] {
  return Array.from(header.querySelectorAll('a')).map((a) => [
    a.innerHTML.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
    new URL(a.getAttribute('href') ?? '', base).href,
  ])
}

const viewer = (perms: string[], name = 'Jay') => ({ userId: 'u1', discordId: '1', name, perms: new Set(perms) as never })

describe('shared top bar (SiteBar)', () => {
  it('src/shared/nav.json is the repo copy (when the repo root is present)', () => {
    // vitest runs from music/ (import.meta.url is not a file: URL under jsdom).
    const root = resolve(process.cwd(), '../shared/nav.json')
    if (!existsSync(root)) return // Docker test image: build context is music/ only
    const mine = resolve(process.cwd(), 'src/shared/nav.json')
    expect(readFileSync(mine, 'utf8')).toBe(readFileSync(root, 'utf8'))
  })

  it('renders exactly the nav.json bar with absolute info links and same-origin music links', () => {
    const { container } = render(<SiteBar />)
    const header = container.querySelector('header.efmh')!
    expect(barLinks(header, `${PORTAL}/`)).toEqual(expectedBar())
    // Info items leave the portal; the Music menu stays same-origin.
    expect(screen.getAllByRole('link', { name: 'Listen' })[0]!.getAttribute('href')).toBe('https://info.euphoric.fm/#listen')
    expect(screen.getAllByRole('link', { name: 'Web Player' })[0]!.getAttribute('href')).toBe('https://info.euphoric.fm/player/')
    expect(screen.getAllByRole('link', { name: 'Submit music' })[0]!.getAttribute('href')).toBe('/submit')
    expect(screen.getByRole('link', { name: 'EuphoricFM home' }).getAttribute('href')).toBe('https://info.euphoric.fm/')
    expect(header.textContent).not.toMatch(/discord|\b(review|admin|schedule)\b/i)
  })

  it('is identical for every role (the bar takes no viewer)', () => {
    const html = (perms: string[] | null) =>
      render(<Header viewer={perms ? viewer(perms) : null} />).container.querySelector('header.efmh')!.outerHTML
    const out = html(null)
    expect(html(['submit'])).toBe(out)
    expect(html(['submit', 'review', 'manage', 'admin'])).toBe(out)
  })

  it('menus are <details>/<summary> (no JavaScript needed); Music is the current section', () => {
    const { container } = render(<SiteBar />)
    const music = container.querySelector('details.efmh-dd')!
    expect(music.querySelector(':scope > summary')!.getAttribute('aria-current')).toBe('true')
    expect(container.querySelector('details.efmh-burger > summary')).toBeTruthy()
  })

  it('JS enhancement: outside click and Escape close an open menu', () => {
    const { container } = render(
      <div>
        <SiteBar />
        <p>outside</p>
      </div>,
    )
    const music = container.querySelector<HTMLDetailsElement>('details.efmh-dd')!
    music.open = true
    fireEvent.click(screen.getByText('outside'))
    expect(music.open).toBe(false)
    music.open = true
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(music.open).toBe(false)
  })
})

describe('portal second row', () => {
  it('signed out: Home tab and Sign in', () => {
    render(<PortalRow viewer={null} />)
    const tabs = screen.getByRole('navigation', { name: 'Music portal' })
    expect(within(tabs).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home'])
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('member: Home · My music · Submit · Library, account menu with sign out, no staff tabs', () => {
    render(<PortalRow viewer={viewer(['submit', 'request'])} />)
    const tabs = screen.getByRole('navigation', { name: 'Music portal' })
    expect(within(tabs).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Home', '/'],
      ['My music', '/dashboard'],
      ['Submit', '/submit'],
      ['Library', '/library'],
    ])
    // usePathname() is '/' in these tests.
    expect(within(tabs).getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByText(/Signed in as/).textContent).toContain('Member')
    expect(screen.getByRole('button', { name: 'Sign out' }).closest('details')).toBeTruthy()
  })

  it('manager and admin: Review and Admin join the second row', () => {
    render(<PortalRow viewer={viewer(['submit', 'review', 'manage'])} />)
    const tabs = within(screen.getByRole('navigation', { name: 'Music portal' }))
    expect(tabs.getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'My music', 'Submit', 'Library', 'Review'])
    expect(tabs.getByRole('link', { name: 'Review' }).className).toContain('efms-staff')
    expect(navFor(new Set(['submit', 'review', 'admin'])).map((i) => i.label)).toContain('Admin')
  })

  it('tab highlight: exact Home, section prefixes, batches count as My music', () => {
    const [home, mine, , lib] = navFor(new Set(['submit']))
    expect(isActive('/', home!)).toBe(true)
    expect(isActive('/dashboard', home!)).toBe(false)
    expect(isActive('/batches/12', mine!)).toBe(true)
    expect(isActive('/library/archived', lib!)).toBe(true)
    expect(isActive('/libraryx', lib!)).toBe(false)
  })
})
