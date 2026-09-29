import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { dateKey, formatIn, timeKey, zonedToUtc, zoneLabel } from '@/events/components/time'
import { TzProvider, TzToggle, When } from '@/events/components/tz'

// 2026-10-18T00:30Z = Sat Oct 17, 8:30 PM EDT.
const AT = '2026-10-18T00:30:00.000Z'

function clearTz() {
  window.localStorage.clear()
  document.cookie = 'efm_tz=; Max-Age=0; Path=/'
}

describe('time helpers', () => {
  it('converts ET wall time to UTC across DST', () => {
    expect(zonedToUtc('2026-10-17', '20:30', 'America/New_York')!.toISOString()).toBe(AT)
    // EST in winter: UTC-5
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York')!.toISOString()).toBe('2026-12-01T14:00:00.000Z')
    // spring-forward gap (02:30 does not exist) lands after the gap, not before
    expect(Date.parse(zonedToUtc('2027-03-14', '02:30', 'America/New_York')!.toISOString())).toBeGreaterThanOrEqual(Date.parse('2027-03-14T07:00:00Z'))
    // fall-back repeat takes the first (EDT) occurrence
    expect(zonedToUtc('2026-11-01', '01:30', 'America/New_York')!.toISOString()).toBe('2026-11-01T05:30:00.000Z')
    expect(zonedToUtc('2026-13-01', '09:00', 'America/New_York')).toBeNull()
  })

  it('splits an instant into zone-local date and time keys', () => {
    expect(dateKey(AT, 'America/New_York')).toBe('2026-10-17')
    expect(timeKey(AT, 'America/New_York')).toBe('20:30')
    expect(dateKey(AT, 'UTC')).toBe('2026-10-18')
  })

  it('labels Eastern as ET', () => {
    expect(zoneLabel(AT, 'et')).toBe('ET')
    expect(formatIn(AT, 'et', 'time')).toBe('8:30 PM')
  })
})

describe('<When> and the ET | Local toggle', () => {
  beforeEach(clearTz)

  it('renders Eastern with its label by default (the SSR rendering)', () => {
    render(
      <TzProvider>
        <When at={AT} format="time" />
      </TzProvider>,
    )
    const t = document.querySelector('time')!
    expect(t.getAttribute('datetime')).toBe(AT)
    expect(t.getAttribute('data-tz')).toBe('et')
    expect(t.textContent).toBe('8:30 PM ET')
  })

  it('switches every time to the local zone and remembers the choice', () => {
    render(
      <TzProvider>
        <TzToggle />
        <When at={AT} format="time" />
        <When at={AT} end="2026-10-18T03:30:00.000Z" />
      </TzProvider>,
    )
    const local = screen.getByRole('button', { name: 'Local' })
    expect(screen.getByRole('button', { name: 'ET' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(local)
    expect(local.getAttribute('aria-pressed')).toBe('true')
    const times = [...document.querySelectorAll('time')]
    for (const t of times) expect(t.getAttribute('data-tz')).toBe('local')
    const label = zoneLabel(AT, 'local')
    expect(times[0]!.textContent).toBe(`${formatIn(AT, 'local', 'time')} ${label}`)
    expect(window.localStorage.getItem('efm_tz')).toBe('local')
    expect(document.cookie).toContain('efm_tz=local')
  })

  it('applies a saved choice after mount', async () => {
    window.localStorage.setItem('efm_tz', 'local')
    await act(async () => {
      render(
        <TzProvider>
          <When at={AT} format="time" />
        </TzProvider>,
      )
    })
    expect(document.querySelector('time')!.getAttribute('data-tz')).toBe('local')
  })
})
