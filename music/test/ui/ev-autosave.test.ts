import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftSaver, type SaveStatus, WAITING_FOR_UPLOAD } from '@/events/components/autosave'
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
