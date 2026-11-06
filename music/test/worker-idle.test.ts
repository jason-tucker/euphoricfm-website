// v0.4.1 (A8): the worker's idle poll backs off 2 → 5 s and resets on work.
import { describe, expect, it } from 'vitest'
import { IDLE_POLL_MS, nextIdleDelay } from '@/worker/main'

describe('worker idle poll', () => {
  it('backs off by 1 s per empty loop up to 5 s, and drops to 2 s after any job or result', () => {
    let d: number = IDLE_POLL_MS.min
    const seen: number[] = []
    for (let i = 0; i < 6; i++) seen.push((d = nextIdleDelay(d, false)))
    expect(seen).toEqual([3000, 4000, 5000, 5000, 5000, 5000])
    expect(nextIdleDelay(d, true)).toBe(2000)
    expect(IDLE_POLL_MS).toEqual({ min: 2000, max: 5000, step: 1000 })
  })
})
