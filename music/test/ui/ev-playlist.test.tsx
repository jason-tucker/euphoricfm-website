import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { PlaylistBuilder } from '@/events/components/PlaylistBuilder'
import {
  addTrack,
  type BAnn,
  type BTrack,
  type Builder,
  checkAnnouncement,
  checkPin,
  estimateRows,
  everyOccurrences,
  moveTrack,
  pinSlots,
  toPayload,
} from '@/events/components/playlist'
import { MIN } from '@/events/components/time'
import { TzProvider } from '@/events/components/tz'
import { stubFetch } from './fetch'

const START = '2026-10-18T00:00:00.000Z' // Oct 17, 8:00 PM ET
const END = '2026-10-18T03:00:00.000Z' // 11:00 PM ET
const at = (min: number) => new Date(Date.parse(START) + min * MIN).toISOString()
const t = (mediaId: number, title = `Song ${mediaId}`): BTrack => ({ key: `k${mediaId}`, source: 'library', mediaId, audioId: null, title, artist: 'A', lengthS: 200, pinAt: null })
const ann = (p: Partial<BAnn>): BAnn => ({ key: 'a', source: 'stinger', mediaId: 9, audioId: null, title: 'Welcome', lengthS: 20, mode: 'at', at: null, everyMin: null, from: null, until: null, ...p })

describe('playlist rules', () => {
  it('refuses duplicate songs (library and upload ids are separate)', () => {
    const one = addTrack([], t(1)).list
    const dup = addTrack(one, { ...t(1), key: 'other' })
    expect(dup.error).toMatch(/already in the playlist/)
    expect(dup.list).toHaveLength(1)
    const up = addTrack(one, { ...t(1), source: 'upload', mediaId: null, audioId: 1 })
    expect(up.error).toBeNull()
    expect(up.list).toHaveLength(2)
  })

  it('moves with Up/Down and keeps positions contiguous in the payload', () => {
    const list = [t(1), t(2), t(3)]
    expect(moveTrack(list, 0, -1)).toBe(list)
    const m = moveTrack(list, 2, -1)
    expect(m.map((x) => x.mediaId)).toEqual([1, 3, 2])
    const p = toPayload({ tracks: m, anns: [], order: 'sequential' })
    expect(p.tracks.map((x) => [x.position, x.mediaId, x.audioId])).toEqual([
      [0, 1, null],
      [1, 3, null],
      [2, 2, null],
    ])
    expect(p.playlistOrder).toBe('sequential')
  })

  it('pins: 5-minute grid, inside the event, not later than end − 15 min', () => {
    expect(checkPin(at(0), START, END)).toBeNull()
    expect(checkPin(at(165), START, END)).toBeNull()
    expect(checkPin(at(170), START, END)).toMatch(/15 minutes before it ends/)
    expect(checkPin(at(-5), START, END)).toMatch(/inside the event/)
    expect(checkPin(new Date(Date.parse(START) + 7 * MIN).toISOString(), START, END)).toMatch(/5-minute grid/)
    const slots = pinSlots(START, END)
    expect(slots[0]).toBe(Date.parse(START))
    expect(slots.at(-1)).toBe(Date.parse(at(165)))
  })

  it('pins and announcements refuse 01:55–02:05 ET', () => {
    const s = '2026-10-18T05:00:00.000Z' // 1:00 AM ET
    const e = '2026-10-18T08:00:00.000Z'
    const two = '2026-10-18T06:00:00.000Z' // 2:00 AM ET
    expect(checkPin(two, s, e)).toMatch(/1:55 and 2:05/)
    expect(checkPin('2026-10-18T05:45:00.000Z', s, e)).toMatch(/1:55 and 2:05/) // window 1:45–2:00 touches it
    expect(pinSlots(s, e)).not.toContain(Date.parse(two))
    expect(checkAnnouncement(ann({ at: two }), s, e)).toMatch(/1:55 and 2:05/)
  })

  it('announcements: at a grid time inside the event, or every N min between two times', () => {
    expect(checkAnnouncement(ann({ at: at(5) }), START, END)).toBeNull()
    expect(checkAnnouncement(ann({ at: at(180) }), START, END)).toMatch(/inside the event/)
    expect(checkAnnouncement(ann({ at: null }), START, END)).toMatch(/Pick a time/)
    const every = ann({ mode: 'every', everyMin: 30, from: at(0), until: at(120) })
    expect(checkAnnouncement(every, START, END)).toBeNull()
    expect(everyOccurrences(at(0), at(120), 30)).toHaveLength(4)
    expect(checkAnnouncement({ ...every, until: at(0) }, START, END)).toMatch(/after the "from" time/)
    expect(checkAnnouncement({ ...every, everyMin: 45 as never }, START, END)).toMatch(/15, 20, 30 or 60/)
    expect(checkAnnouncement({ ...every, until: at(200) }, START, END)).toMatch(/inside the event/)
  })

  it('estimates schedule rows per ET date', () => {
    const b: Builder = { tracks: [{ ...t(1), pinAt: at(30) }, t(2)], anns: [ann({ at: at(5) }), ann({ mode: 'every', everyMin: 60, from: at(0), until: at(180) })], order: 'shuffle' }
    // main 1 (one ET date) + 1 pin + 1 at + 3 every
    expect(estimateRows(b, START, END)).toBe(6)
    // crossing ET midnight: main needs 2 rows
    expect(estimateRows({ tracks: [], anns: [] }, '2026-10-18T03:00:00.000Z', '2026-10-18T06:00:00.000Z')).toBe(2)
  })
})

function Harness({ initial }: { initial: Builder }) {
  const [b, setB] = useState(initial)
  return (
    <TzProvider>
      <PlaylistBuilder value={b} onChange={setB} start={START} end={END} maxRows={150} uploadsEnabled={false} />
    </TzProvider>
  )
}

describe('playlist builder', () => {
  it('adds from search once, marks it Added, reorders with Up/Down and offers pin slots up to end − 15', async () => {
    stubFetch({
      'GET /api/ev/library': { status: 200, body: [{ mediaId: 11, title: 'Night Drive', artist: 'Neon', lengthS: 240, artUrl: null }, { mediaId: 12, title: 'Skyline', artist: 'Neon', lengthS: 180, artUrl: null }] },
      'GET /api/ev/audio': { status: 200, body: [] },
      'GET /api/ev/stingers': { status: 200, body: [{ mediaId: 90, path: 'EFM Stingers/welcome.mp3', title: 'Welcome', lengthS: 12 }] },
    })
    render(<Harness initial={{ tracks: [], anns: [], order: 'shuffle' }} />)
    fireEvent.change(screen.getByLabelText('Search the EuphoricFM library'), { target: { value: 'neon' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Add Night Drive' }, { timeout: 2000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Add Skyline' }))
    const added = screen.getByRole('button', { name: 'Night Drive is added' })
    expect((added as HTMLButtonElement).disabled).toBe(true)
    let rows = screen.getAllByTestId('pb-track')
    expect(rows.map((r) => r.textContent?.includes('Night Drive'))).toEqual([true, false])
    expect(screen.getByTestId('pb-length').textContent).toMatch(/Songs: 7 min/)

    fireEvent.click(screen.getByRole('button', { name: 'Move Skyline up' }))
    rows = screen.getAllByTestId('pb-track')
    expect(rows[0]!.textContent).toContain('Skyline')
    expect((screen.getByRole('button', { name: 'Move Skyline up' }) as HTMLButtonElement).disabled).toBe(true)

    const pin = within(rows[0]!).getByLabelText(/Pin to a time/) as HTMLSelectElement
    const opts = [...pin.options].map((o) => o.value).filter(Boolean)
    expect(Number(opts[0])).toBe(Date.parse(START))
    expect(Number(opts.at(-1))).toBe(Date.parse(at(165)))
    expect(pin.options[1]!.textContent).toMatch(/8:00 PM ET/)
    fireEvent.change(pin, { target: { value: String(Date.parse(at(30))) } })
    expect(within(screen.getAllByTestId('pb-track')[0]!).getByText(/first song break/)).toBeTruthy()
  })

  it('refuses an announcement without a time and adds a valid one', async () => {
    stubFetch({
      'GET /api/ev/audio': { status: 200, body: [] },
      'GET /api/ev/stingers': { status: 200, body: [{ mediaId: 90, path: 'EFM Stingers/welcome.mp3', title: 'Welcome', lengthS: 12 }] },
    })
    render(<Harness initial={{ tracks: [], anns: [], order: 'shuffle' }} />)
    await screen.findByRole('option', { name: /Welcome/ })
    fireEvent.change(screen.getByLabelText('Announcement'), { target: { value: 'stinger:90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add announcement' }))
    expect(screen.getByRole('alert').textContent).toMatch(/Pick a time/)
    fireEvent.change(screen.getByLabelText('Plays at'), { target: { value: String(Date.parse(at(5))) } })
    fireEvent.click(screen.getByRole('button', { name: 'Add announcement' }))
    const row = screen.getByTestId('pb-ann')
    expect(row.textContent).toMatch(/Welcome/)
    expect(row.textContent).toMatch(/at Oct 17, 8:05 PM ET/)
  })
})
