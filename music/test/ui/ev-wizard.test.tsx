import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { resetConfigCache } from '@/events/components/hooks'
import { RequestWizard } from '@/events/components/RequestWizard'
import { HOUR, MIN, dateKey, timeKey } from '@/events/components/time'
import { TzProvider } from '@/events/components/tz'
import { DEFAULT_CONFIG, type Busy } from '@/events/components/types'
import { checkDetails, checkTime, withoutSelf } from '@/events/components/wizard'
import { stubFetch } from './fetch'

const NOW = Date.parse('2026-10-01T16:00:00Z') // Oct 1, 12:00 PM ET
const cfg = { ...DEFAULT_CONFIG, eventsEnabled: true }
const et = (ms: number) => ({ date: dateKey(ms, 'America/New_York'), time: timeKey(ms, 'America/New_York') })
const check = (startMs: number, lengthMin = 120, opts: { staff?: boolean; busy?: Busy[] } = {}) =>
  checkTime({ when: { ...et(startMs), lengthMin }, mode: 'et', now: NOW, config: cfg, staff: !!opts.staff, busy: opts.busy ?? [] })

describe('wizard rules', () => {
  it('details: title and kind required, limits enforced', () => {
    const e = checkDetails({ title: '  ', hostName: 'x'.repeat(81), description: '', location: '', eventType: '' })
    expect(e.title).toMatch(/title/i)
    expect(e.eventType).toMatch(/kind/i)
    expect(e.hostName).toMatch(/80 characters/)
    expect(checkDetails({ title: 'Party', hostName: '', description: '', location: '', eventType: 'club_night' })).toEqual({})
  })

  it('under 24 h is an error that names the earliest start, in ET', () => {
    const r = check(NOW + 20 * HOUR)
    expect(r.errors.join(' ')).toMatch(/at least 24 hours from now\. The earliest start is .*ET/)
  })

  it('24–48 h is allowed with a short-notice warning', () => {
    const r = check(NOW + 30 * HOUR)
    expect(r.errors).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/Short notice/)
    expect(r.startsAt).toBe(new Date(NOW + 30 * HOUR).toISOString())
    expect(r.endsAt).toBe(new Date(NOW + 32 * HOUR).toISOString())
  })

  it('length, horizon and past times', () => {
    expect(check(NOW + 72 * HOUR, 25 * 60).errors.join(' ')).toMatch(/up to 24 hours long/)
    expect(check(NOW + 181 * 24 * HOUR).errors.join(' ')).toMatch(/180 days ahead/)
    expect(check(NOW - HOUR).errors.join(' ')).toMatch(/already passed/)
  })

  it('clashes with an event or its gap', () => {
    const s = NOW + 72 * HOUR
    const busy: Busy[] = [
      { startsAt: new Date(s + 60 * MIN).toISOString(), endsAt: new Date(s + 180 * MIN).toISOString(), kind: 'event' },
      { startsAt: new Date(s + 180 * MIN).toISOString(), endsAt: new Date(s + 190 * MIN).toISOString(), kind: 'gap' },
    ]
    expect(check(s, 120, { busy }).errors.join(' ')).toMatch(/clashes with another booking/)
    expect(check(s + 185 * MIN, 60, { busy }).errors.join(' ')).toMatch(/10 minutes between them/)
    expect(check(s + 190 * MIN, 60, { busy }).errors).toEqual([])
    // staff: the gap is a warning, an overlap stays an error
    expect(check(s + 185 * MIN, 60, { busy, staff: true }).errors).toEqual([])
    expect(check(s, 120, { busy, staff: true }).errors.length).toBe(1)
    // editing: the event's own slot and gaps do not clash with itself
    expect(withoutSelf(busy, { startsAt: busy[0]!.startsAt, endsAt: busy[0]!.endsAt })).toEqual([])
  })

  it('staff are exempt from notice/length/horizon but see them as warnings', () => {
    const r = check(NOW + 2 * HOUR, 30 * 60, { staff: true })
    expect(r.errors).toEqual([])
    expect(r.warnings.filter((w) => w.startsWith('Staff override')).length).toBe(2)
  })

  it('warns about the nightly restart window', () => {
    const s = Date.parse('2026-10-10T05:00:00Z') // 1:00 AM ET
    expect(check(s, 120).warnings.join(' ')).toMatch(/restarts every night/)
  })
})

describe('request wizard', () => {
  beforeEach(() => resetConfigCache())

  it('blocks Continue with readable messages and sends nothing', async () => {
    const calls = stubFetch({ 'GET /api/ev/config': { status: 200, body: cfg }, 'GET /api/ev/availability': { status: 200, body: [] } })
    render(
      <TzProvider>
        <RequestWizard staff={false} />
      </TzProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(screen.getByText('Give your event a title.')).toBeTruthy()
    expect(screen.getByText('Pick the kind of event.')).toBeTruthy()
    expect(screen.getByTestId('ev-step-error').textContent).toMatch(/Fix the fields/)

    fireEvent.change(screen.getByLabelText(/Event title/), { target: { value: 'Club night' } })
    fireEvent.change(screen.getByLabelText(/Kind of event/), { target: { value: 'club_night' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(await screen.findByRole('heading', { name: '2. Time' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    expect(screen.getByTestId('ev-time-errors').textContent).toMatch(/Pick a date and a start time/)
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('tells members requests are not open yet while events are disabled', async () => {
    stubFetch({ 'GET /api/ev/config': { status: 200, body: { ...cfg, eventsEnabled: false } } })
    render(
      <TzProvider>
        <RequestWizard staff={false} />
      </TzProvider>,
    )
    expect(await screen.findByText(/Event requests open soon/)).toBeTruthy()
  })
})
