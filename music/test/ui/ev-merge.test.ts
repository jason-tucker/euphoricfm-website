import { describe, expect, it } from 'vitest'
import { builderKey, type FormState, mergeForm, mergeNote } from '@/events/components/merge'
import type { BAnn, BTrack, Builder } from '@/events/components/playlist'
import { EMPTY_DRAFT, type Draft } from '@/events/components/wizard'

// The request form's three-way merge (0.5.3): this tab's changes against the
// base both tabs started from, on top of what the server has now.

const song = (mediaId: number, pinAt: string | null = null): BTrack => ({ key: `k${mediaId}-${Math.random()}`, source: 'library', mediaId, audioId: null, title: `Song ${mediaId}`, artist: null, lengthS: 200, pinAt })
const up = (audioId: number): BTrack => ({ key: `u${audioId}`, source: 'upload', mediaId: null, audioId, title: `Upload ${audioId}`, artist: null, lengthS: 100, pinAt: null })
const ann = (mediaId: number, at: string): BAnn => ({ key: `a${mediaId}${at}`, source: 'stinger', mediaId, audioId: null, title: 'ID', lengthS: 10, mode: 'at', at, everyMin: null, from: null, until: null })
const draft = (over: Partial<Draft> = {}): Draft => ({ ...EMPTY_DRAFT, title: 'Club night', eventType: 'club_night', date: '2026-10-10', time: '20:00', lengthMin: 120, visibility: 'public', ...over })
const form = (d: Partial<Draft> = {}, b: Partial<Builder> = {}): FormState => ({ draft: draft(d), builder: { tracks: [song(1)], anns: [], order: 'shuffle', ...b } })
const ids = (b: Builder) => b.tracks.map((t) => (t.source === 'library' ? t.mediaId : `u${t.audioId}`))

const T1 = '2026-10-11T00:30:00.000Z'
const T2 = '2026-10-11T01:00:00.000Z'

describe('mergeForm: details', () => {
  it('fields this side did not change take the server value; its own changes stay', () => {
    const base = form()
    const r = mergeForm(base, form({ location: 'The Pier' }), form({ hostName: 'Host From A' }))
    expect(r.draft).toMatchObject({ hostName: 'Host From A', location: 'The Pier' })
    expect(r).toMatchObject({ merged: true, kept: [], local: true })
    expect(mergeNote(r)).toBe('Merged changes made in another tab.')
  })
  it('both sides changed a field to different values: this side wins and it is named', () => {
    const r = mergeForm(form(), form({ hostName: 'Mine', title: 'My title' }), form({ hostName: 'Theirs', title: 'Their title', description: 'x' }))
    expect(r.draft).toMatchObject({ hostName: 'Mine', title: 'My title', description: 'x' })
    expect(r.kept).toEqual(['title', 'host name'])
    expect(mergeNote(r)).toBe("Merged changes made in another tab. Kept this tab's title and host name.")
  })
  it('the same change on both sides is not a conflict; the date/time moves as one unit', () => {
    const same = mergeForm(form(), form({ hostName: 'X' }), form({ hostName: 'X' }))
    expect(same).toMatchObject({ merged: false, kept: [], local: false })
    const moved = mergeForm(form(), form({ location: 'Pier' }), form({ date: '2026-10-12', time: '21:00', lengthMin: 90 }))
    expect(moved.draft).toMatchObject({ date: '2026-10-12', time: '21:00', lengthMin: 90, location: 'Pier' })
    const both = mergeForm(form(), form({ time: '22:00' }), form({ lengthMin: 60 }))
    expect(both.draft).toMatchObject({ time: '22:00', lengthMin: 120 })
    expect(both.kept).toEqual(['date and time'])
  })
  it('no server changes: nothing merged, the local form as is', () => {
    const local = form({ title: 'New' }, { tracks: [song(1), song(2)] })
    const r = mergeForm(form(), local, form())
    expect(r).toMatchObject({ merged: false, local: true })
    expect(r.draft.title).toBe('New')
    expect(r.builder).toBe(local.builder)
    expect(mergeNote(r)).toBeNull()
  })
})

describe('mergeForm: playlist', () => {
  it('only this side changed the playlist: it is kept (order and all)', () => {
    const local = form({}, { tracks: [song(2), song(1)], order: 'sequential' })
    const r = mergeForm(form(), local, form({ hostName: 'A' }))
    expect(r.builder).toBe(local.builder)
    expect(r.local).toBe(true)
  })
  it('only the server changed the playlist: the server playlist is taken', () => {
    const server = form({}, { tracks: [song(1), song(2)], anns: [ann(9, T1)], order: 'sequential' })
    const r = mergeForm(form(), form({ location: 'Pier' }), server)
    expect(r.builder).toBe(server.builder)
    expect(r.merged).toBe(true)
  })
  it('both changed: server songs minus this side\'s removals plus its additions (event 15: Alpha, Bravo, Charlie)', () => {
    const base = form({}, { tracks: [song(701)] })
    const r = mergeForm(base, form({}, { tracks: [song(701), song(703)] }), form({}, { tracks: [song(701), song(702)] }))
    expect(ids(r.builder)).toEqual([701, 702, 703])
    expect(r).toMatchObject({ merged: true, local: true })
  })
  it('both changed with a removal on each side and a pin', () => {
    const base = form({}, { tracks: [song(1), song(2), song(3)] })
    // this side: removed 2, added upload 7, pinned 3
    const local = form({}, { tracks: [song(1), song(3, T1), up(7)] })
    // the server: removed 1, added 4
    const server = form({}, { tracks: [song(2), song(3), song(4)] })
    const r = mergeForm(base, local, server)
    expect(ids(r.builder)).toEqual([3, 4, 'u7'])
    expect(r.builder.tracks.find((t) => t.mediaId === 3)!.pinAt).toBe(T1)
  })
  it('a song both sides added is there once (the server refuses duplicates); this side\'s pin wins', () => {
    const r = mergeForm(form(), form({}, { tracks: [song(1), song(5, T2)] }), form({}, { tracks: [song(1), song(5)] }))
    expect(ids(r.builder)).toEqual([1, 5])
    expect(r.builder.tracks[1]!.pinAt).toBe(T2)
  })
  it('announcements: removals and additions by content, never doubled; playlist order from the side that changed it', () => {
    const base = form({}, { anns: [ann(9, T1), ann(9, T2)] })
    const local = form({}, { anns: [ann(9, T1), ann(8, T1)], order: 'sequential' }) // removed 9@T2, added 8@T1
    const server = form({}, { anns: [ann(9, T1), ann(9, T2), ann(6, T2), ann(8, T1)] }) // added 6@T2 and (also) 8@T1
    const r = mergeForm(base, local, server)
    expect(r.builder.anns.map((a) => `${a.mediaId}@${a.at}`).sort()).toEqual([`6@${T2}`, `8@${T1}`, `9@${T1}`].sort())
    expect(r.builder.order).toBe('sequential')
    const serverOrder = mergeForm(base, local, form({}, { anns: [ann(9, T1), ann(9, T2), ann(6, T2)], order: 'shuffle' }))
    expect(serverOrder.builder.order).toBe('sequential')
    const theirsOrder = mergeForm(form({}, { tracks: [song(1)] }), form({}, { tracks: [song(1), song(2)] }), form({}, { tracks: [song(1)], anns: [ann(6, T1)], order: 'sequential' }))
    expect(theirsOrder.builder.order).toBe('sequential')
  })
  it('merging the same changes twice changes nothing more (a device copy applied after its save arrived)', () => {
    const base = form({}, { tracks: [song(1)], anns: [ann(9, T1)] })
    const local = form({ location: 'Pier' }, { tracks: [song(1), song(2)], anns: [ann(9, T1), ann(8, T2)] })
    const once = mergeForm(base, local, form({ hostName: 'A' }, { tracks: [song(1), song(3)], anns: [ann(9, T1)] }))
    const twice = mergeForm(base, local, once)
    expect(builderKey(twice.builder)).toBe(builderKey(once.builder))
    expect(twice.draft).toEqual(once.draft)
    expect(twice.local).toBe(false)
  })
})
