import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { Calendar } from '@/events/components/Calendar'
import { EventViewCard } from '@/events/components/EventViewCard'
import { TzProvider } from '@/events/components/tz'
import type { EventView } from '@/events/contract/types'
import { stubFetch } from './fetch'

const pub: EventView = {
  kind: 'public',
  id: 1,
  startsAt: '2026-10-18T00:00:00.000Z',
  endsAt: '2026-10-18T03:00:00.000Z',
  status: 'approved',
  title: 'Vespucci Motors grand opening',
  hostName: 'Vespucci Motors',
  description: 'Free coffee',
  location: 'Del Perro',
  eventType: 'grand_opening',
}
// A server bug that leaks details into a private/pending projection must
// still never reach the page.
const priv = {
  kind: 'private',
  id: 2,
  startsAt: '2026-10-20T00:00:00.000Z',
  endsAt: '2026-10-20T02:00:00.000Z',
  status: 'approved',
  label: 'Booked · Private event',
  title: 'SECRET PARTY',
  hostName: 'Secret Host',
  description: 'secret description',
  location: 'Secret Place',
} as unknown as EventView
const pend = {
  kind: 'pending',
  id: 3,
  startsAt: '2026-10-22T00:00:00.000Z',
  endsAt: '2026-10-22T01:00:00.000Z',
  status: 'pending',
  label: 'Pending',
  title: 'HIDDEN REQUEST',
  location: 'Hidden Place',
} as unknown as EventView

const LEAKS = /SECRET|Secret|secret|HIDDEN|Hidden/

const wrap = (ui: React.ReactNode) => render(<TzProvider>{ui}</TzProvider>)

describe('EventViewCard renders projections exactly', () => {
  it('public: title, host, place, description, linked', () => {
    wrap(<EventViewCard view={pub} showDescription />)
    const a = screen.getByRole('link')
    expect(a.getAttribute('href')).toBe('/events/1')
    expect(a.textContent).toContain('Vespucci Motors grand opening')
    expect(a.textContent).toContain('Hosted by Vespucci Motors')
    expect(a.textContent).toContain('Del Perro')
    expect(a.textContent).toContain('Free coffee')
    expect(a.textContent).toContain('ET')
  })

  it('private: only "Booked · Private event" and the time, no link', () => {
    const { container } = wrap(<EventViewCard view={priv} showDescription />)
    expect(container.textContent).toContain('Booked · Private event')
    expect(container.textContent).not.toMatch(LEAKS)
    expect(screen.queryByRole('link')).toBeNull()
    expect(container.querySelector('time')).not.toBeNull()
  })

  it('pending: only "Pending" and the time', () => {
    const { container } = wrap(<EventViewCard view={pend} showDescription />)
    expect(screen.getByTestId('ev-heading').textContent).toBe('Pending')
    expect(container.textContent).not.toMatch(LEAKS)
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('calendar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.history.replaceState(null, '', '/calendar')
  })

  it('month grid + list both show the three projections and never leak fields', async () => {
    const calls = stubFetch({ 'GET /api/ev/calendar': { status: 200, body: [pub, priv, pend] } })
    const { container } = wrap(<Calendar initialMonth="2026-10" initialView="grid" />)
    await screen.findAllByText(/Vespucci Motors grand opening/)
    const q = new URL(calls[0]!.url, 'http://x')
    expect(q.pathname).toBe('/api/ev/calendar')
    expect(Date.parse(q.searchParams.get('from')!)).toBeLessThan(Date.parse('2026-10-01T04:00:00Z'))
    expect(Date.parse(q.searchParams.get('to')!)).toBeGreaterThan(Date.parse('2026-11-01T04:00:00Z'))
    // grid chips (ET): the public event is on Oct 17 ET
    const grid = screen.getByRole('group', { name: 'October 2026 month view' })
    expect(within(grid).getByRole('button', { name: /^Saturday, October 17: 8:00 PM Vespucci Motors grand opening$/ })).toBeTruthy()
    expect(within(grid).getByRole('button', { name: /^Monday, October 19: 8:00 PM Booked · Private event$/ })).toBeTruthy()
    expect(within(grid).getByRole('button', { name: /^Wednesday, October 21: 8:00 PM Pending$/ })).toBeTruthy()
    expect(container.textContent).not.toMatch(LEAKS)

    fireEvent.click(screen.getByRole('button', { name: 'List' }))
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('region', { name: 'Saturday, October 17' }).textContent).toContain('Vespucci Motors grand opening')
    expect(screen.getByRole('region', { name: 'Monday, October 19' }).textContent).toContain('Booked · Private event')
    expect(screen.getByRole('region', { name: 'Wednesday, October 21' }).textContent).toContain('Pending')
    expect(container.textContent).not.toMatch(LEAKS)
    expect(window.location.search).toContain('view=list')
    expect(window.location.search).toContain('m=2026-10')
  })

  it('moves between months', async () => {
    const calls = stubFetch({ 'GET /api/ev/calendar': { status: 200, body: [] } })
    wrap(<Calendar initialMonth="2026-10" initialView="list" />)
    await screen.findByText(/Nothing booked in October 2026/)
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }))
    await screen.findByText(/Nothing booked in November 2026/)
    expect(calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('calendar touch targets on phones', () => {
  it('month buttons and day cells are at least 48 px tall below 768 px, and the grid cannot overflow', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const css = readFileSync(join(process.cwd(), 'src/events/components/events.css'), 'utf8')
    const phone = (max: number) => css.slice(css.indexOf(`@media (max-width: ${max}px)`))
    const px = (block: string, sel: string, prop: string) => Number(new RegExp(`\\${sel} \\{[^}]*\\b${prop}: (\\d+)px`).exec(block)?.[1] ?? 0)
    expect(px(phone(767), '.ev-iconbtn', 'min-height')).toBeGreaterThanOrEqual(48)
    expect(px(phone(767), '.ev-iconbtn', 'min-width')).toBeGreaterThanOrEqual(48)
    expect(px(phone(639), '.ev-cal-day', 'min-height')).toBeGreaterThanOrEqual(48)
    expect(phone(639)).toMatch(/\.ev-cal \{[^}]*repeat\(7, minmax\(0, 1fr\)\)/)
  })
})
