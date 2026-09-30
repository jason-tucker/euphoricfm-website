import { describe, expect, it } from 'vitest'
import { builderKey, describeChanges, type FormState, mergeForm, mergeNote, restoreConflicts, undoRestore } from '@/events/components/merge'
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
    expect(mergeNote(describeChanges(form({ location: 'The Pier' }), r), r.kept)).toBe('Merged changes made in another tab or device: host name → "Host From A".')
  })
  it('both sides changed a field to different values: this side wins and it is named', () => {
    const r = mergeForm(form(), form({ hostName: 'Mine', title: 'My title' }), form({ hostName: 'Theirs', title: 'Their title', description: 'x' }))
    expect(r.draft).toMatchObject({ hostName: 'Mine', title: 'My title', description: 'x' })
    expect(r.kept).toEqual(['title', 'host name'])
    expect(mergeNote(describeChanges(form({ hostName: 'Mine', title: 'My title' }), r), r.kept)).toBe(
      'Merged changes made in another tab or device: description → "x". Kept this tab\'s title and host name.',
    )
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
    expect(mergeNote(describeChanges(local, r), r.kept)).toBeNull()
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

describe('describeChanges / mergeNote (0.5.3 fix round 2)', () => {
  it('names fields, removals, additions, pins, order and announcements', () => {
    const from = form({ hostName: 'Old' }, { tracks: [song(1), song(2)], anns: [ann(9, T1)] })
    const to = form({ hostName: 'PC host', location: '' }, { tracks: [song(1, T2), song(3)], anns: [ann(9, T1), ann(9, T2)], order: 'sequential' })
    expect(describeChanges(from, to)).toEqual([
      'host name → "PC host"',
      'removed "Song 2"',
      'pin of "Song 1" changed',
      'added "Song 3"',
      'play order → in your order',
      'added announcement "ID"',
    ])
    expect(describeChanges(to, to)).toEqual([])
  })
  it("this tab's own keepalive arriving (the server now equals the form) gives no note", () => {
    const base = form()
    const local = form({ hostName: 'Mine' }, { tracks: [song(1), song(2)] })
    const r = mergeForm(base, local, local)
    expect(mergeNote(describeChanges(local, r), r.kept)).toBeNull()
  })
})

describe('restoreConflicts: a device copy onto a newer server copy', () => {
  it('a field the server also changed (fd2: the host) is a conflict', () => {
    expect(restoreConflicts(form(), form({ hostName: 'PC host' }), form({ hostName: 'Phone host' }), false)).toBe(true)
  })
  it('removing a song the server has (fd2: Charlie) is a conflict', () => {
    const base = form({}, { tracks: [song(1), song(3)] })
    expect(restoreConflicts(base, form({}, { tracks: [song(1)] }), form({ title: 'Other' }, { tracks: [song(1), song(3)] }), false)).toBe(true)
  })
  it('removing an announcement the server has is a conflict', () => {
    const base = form({}, { anns: [ann(9, T1)] })
    expect(restoreConflicts(base, form(), form({ title: 'x' }, { anns: [ann(9, T1)] }), false)).toBe(true)
  })
  it('an addition the server lacks is a conflict only when a keepalive may have sent it', () => {
    const local = form({}, { tracks: [song(1), song(4)] })
    const server = form({ title: 'Theirs' })
    expect(restoreConflicts(form(), local, server, false)).toBe(false)
    expect(restoreConflicts(form(), local, server, true)).toBe(true)
  })
  it('independent changes are not a conflict', () => {
    expect(restoreConflicts(form(), form({ location: 'Pier' }, { tracks: [song(1), song(5)] }), form({ hostName: 'Other' }), false)).toBe(false)
  })
  it('an order only this side changed is not a conflict; a pin both changed differently is', () => {
    expect(restoreConflicts(form({}, { order: 'shuffle' }), form({}, { order: 'sequential' }), form({ title: 'x' }, { order: 'shuffle', tracks: [song(1, T1)] }), false)).toBe(false)
    expect(restoreConflicts(form(), form({}, { tracks: [song(1, T1)] }), form({}, { tracks: [song(1, T2)] }), false)).toBe(true)
  })
  it('unconfirmed: a field, date/time, pin, song order or play order the server holds at the base value may have been undone there (a conflict)', () => {
    const server = form({ location: 'Phone place' }, { tracks: [song(1), song(2)] })
    const b = form({}, { tracks: [song(1), song(2)] })
    const cases: FormState[] = [
      form({ hostName: 'PC host' }, { tracks: [song(1), song(2)] }),
      form({ time: '21:00' }, { tracks: [song(1), song(2)] }),
      form({}, { tracks: [song(1, T1), song(2)] }),
      form({}, { tracks: [song(2), song(1)] }),
      form({}, { tracks: [song(1), song(2)], order: 'sequential' }),
    ]
    for (const local of cases) {
      expect(restoreConflicts(b, local, server, false)).toBe(false)
      expect(restoreConflicts(b, local, server, true)).toBe(true)
    }
    // the server holds this side's value (it landed): nothing to ask
    expect(restoreConflicts(b, form({ hostName: 'PC host' }, { tracks: [song(1), song(2)] }), form({ hostName: 'PC host' }, { tracks: [song(1), song(2)] }), true)).toBe(false)
  })
})

describe('undoRestore: "Use the saved version instead" undoes only what nothing changed since', () => {
  it('fields and the date/time go back where the form still holds the restored value; changed ones are kept', () => {
    const before = form()
    const after = form({ hostName: 'PC host', location: 'PC loc', time: '21:00' })
    const r = undoRestore(before, after, form({ hostName: 'Phone host', location: 'PC loc', time: '21:00', description: 'typed later' }))
    expect(r.draft).toMatchObject({ hostName: 'Phone host', location: '', time: '20:00', description: 'typed later' })
    expect(r.kept).toEqual(['host name'])
    expect(r.undone).toEqual(['place', 'date and time'])
  })

  it('a field set back elsewhere is neither undone nor kept; nothing left gives an empty undone list', () => {
    const r = undoRestore(form(), form({ hostName: 'PC host' }), form())
    expect(r.undone).toEqual([])
    expect(r.kept).toEqual([])
  })

  it('songs: added ones go if unchanged, removed ones come back at their place, pins and the order go back', () => {
    const [a, b, c] = [song(1), song(2), song(3)]
    const before: FormState = form({}, { tracks: [a, b, c], order: 'shuffle' })
    const d = song(4)
    const after: FormState = form({}, { tracks: [c, { ...a, pinAt: T1 }, d], order: 'sequential' })
    const r = undoRestore(before, after, form({}, { tracks: [c, { ...a, pinAt: T1 }, d, song(5)], order: 'sequential' }))
    expect(ids(r.builder)).toEqual([1, 2, 3, 5])
    expect(r.builder.tracks[0]!.pinAt).toBe(null)
    expect(r.builder.order).toBe('shuffle')
    expect(r.kept).toEqual([])
  })

  it('songs changed since stay: a pin moved elsewhere, an added song pinned elsewhere, a reorder elsewhere', () => {
    const [a, b, c] = [song(1), song(2), song(3)]
    const before: FormState = form({}, { tracks: [a, b, c] })
    const after: FormState = form({}, { tracks: [b, { ...a, pinAt: T1 }, c, song(4)] })
    const now: FormState = form({}, { tracks: [c, { ...a, pinAt: T2 }, b, song(4, T2)], order: 'sequential' })
    const r = undoRestore(before, after, now)
    expect(ids(r.builder)).toEqual([3, 1, 2, 4])
    expect(r.builder.tracks[1]!.pinAt).toBe(T2)
    expect(r.builder.tracks[3]!.pinAt).toBe(T2)
    expect(r.builder.order).toBe('sequential')
    expect(r.kept).toEqual(['"Song 4"', 'pin of "Song 1"', 'song order'])
  })

  it('announcements: copies it added or removed, only while the count is what it left', () => {
    const [x, y] = [ann(9, T1), ann(9, T2)]
    const before: FormState = form({}, { anns: [x] })
    const after: FormState = form({}, { anns: [y] })
    expect(undoRestore(before, after, form({}, { anns: [y] })).builder.anns.map((a) => a.at)).toEqual([T1])
    const r = undoRestore(before, after, form({}, { anns: [y, y] }))
    expect(r.builder.anns.map((a) => a.at)).toEqual([T2, T2, T1])
    expect(r.kept).toEqual(['announcement "ID"'])
  })
})
