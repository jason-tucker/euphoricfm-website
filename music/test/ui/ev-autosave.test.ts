import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftSaver, type SaveStatus, sortSaves, WAITING_FOR_UPLOAD } from '@/events/components/autosave'
import type { FullView } from '@/events/components/types'

// DraftSaver on its own: an upload that never becomes usable does not keep
// the saver retrying forever.

afterEach(() => vi.unstubAllGlobals())

describe('DraftSaver: audio_not_ready', () => {
  it('waits and retries by itself, then (bounded) asks for the upload to be checked or removed', async () => {
    let puts = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        puts++
        return { ok: false, status: 400, headers: { get: () => 'application/json' }, json: async () => ({ error: 'audio_not_ready' }) }
      }),
    )
    const statuses: SaveStatus[] = []
    const view = { id: 42, version: 3, status: 'draft' } as FullView
    const saver = new DraftSaver({
      initial: view,
      plan: () => ({ key: 'k', create: null, missing: [], patch: {}, playlist: { tracks: [], announcements: [], playlistOrder: 'shuffle' }, blocked: [] }),
      onView: () => {},
      adopt: async () => {},
      onStatus: (s) => statuses.push(s),
      onSynced: () => {},
      retryBaseMs: 1,
      retryMaxMs: 2,
    })
    void saver.kick()
    await vi.waitFor(() => expect(statuses.at(-1)).toMatchObject({ kind: 'error', retrying: false }), { timeout: 5000 })
    expect(puts).toBe(21)
    expect(statuses.filter((s) => s.kind === 'error' && s.retrying && s.reason === WAITING_FOR_UPLOAD)).toHaveLength(20)
    expect((statuses.at(-1) as { reason: string }).reason).toMatch(/still being checked/)
    saver.stop()
  })
})

describe('sortSaves: what became of saves sent from a base (one rule for a reopened page and the live tab)', () => {
  const rec = (saveId: string, baseVersion: number) => ({ saveId, baseVersion })
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `other-${i}`)

  it('a listed save made on the base landed: the base version moves by its audit rows', () => {
    const f = sortSaves([rec('ka-1', 4)], 4, { version: 8, recentSaveIds: ['p2', 'p1', 'ka-1', 'ka-1'] })
    expect(f).toMatchObject({ landed: [rec('ka-1', 4)], unknown: [], lost: [], pending: [], version: 6 })
  })
  it('an unlisted save, the list not full, the server past its version: lost (its changes are still unsaved)', () => {
    expect(sortSaves([rec('ka-1', 4)], 4, { version: 5, recentSaveIds: ['p1'] })).toMatchObject({ landed: [], lost: [rec('ka-1', 4)], unknown: [], version: 4 })
  })
  it('an unlisted save the server is not past yet: pending (it may still land)', () => {
    expect(sortSaves([rec('ka-1', 4)], 4, { version: 4, recentSaveIds: ['p1'] })).toMatchObject({ pending: [rec('ka-1', 4)], lost: [], unknown: [] })
  })
  it('an unlisted save from a FULL list (or no list): unknown — it may have scrolled out', () => {
    expect(sortSaves([rec('ka-1', 4)], 4, { version: 30, recentSaveIds: ids(20) })).toMatchObject({ unknown: [rec('ka-1', 4)], landed: [], lost: [] })
    expect(sortSaves([rec('ka-1', 4)], 4, { version: 30 })).toMatchObject({ unknown: [rec('ka-1', 4)] })
    // a full list that lists it is still decided
    expect(sortSaves([rec('ka-1', 4)], 4, { version: 30, recentSaveIds: ['ka-1', ...ids(19)] })).toMatchObject({ landed: [rec('ka-1', 4)], version: 5 })
  })
  it('two saves on one base: only one can land; the other (same base) can then never land', () => {
    const f = sortSaves([rec('a', 4), rec('b', 4)], 4, { version: 6, recentSaveIds: ['x', 'b'] })
    expect(f).toMatchObject({ landed: [rec('b', 4)], lost: [rec('a', 4)], version: 5 })
    const g = sortSaves([rec('a', 4), rec('b', 4)], 4, { version: 6, recentSaveIds: ['x', 'a'] })
    expect(g).toMatchObject({ landed: [rec('a', 4)], lost: [rec('b', 4)], version: 5 })
  })
  it('a listed save on a base this side does not describe: unknown', () => {
    expect(sortSaves([rec('a', 7)], 4, { version: 9, recentSaveIds: ['a'] })).toMatchObject({ unknown: [rec('a', 7)], landed: [] })
  })
})
