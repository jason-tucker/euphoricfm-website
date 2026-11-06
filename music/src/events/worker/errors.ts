// Job outcomes for the events worker loop (loop.ts runEventJob).
//
//   Wait       a wait on something outside the job (the event's start, a
//              ticket not open yet, the scan window, pacing, a busy API): the
//              job is rescheduled WITHOUT spending an attempt, bounded by the
//              job's age (maxAgeS). `exact` waits run exactly when they say.
//   Retry      a failed try that spends an attempt, retried after `delayS`
//              (start kick: one retry after 30 s, then the job is dead).
//   Permanent  never retried; the job goes dead and its failure hook runs.

export const WAIT_MAX_AGE_S = 7 * 24 * 3600

export class Wait extends Error {
  readonly maxAgeS: number
  readonly exact: boolean
  constructor(
    readonly delayS: number,
    message = 'wait',
    opts: { maxAgeS?: number; exact?: boolean } = {},
  ) {
    super(message)
    this.name = 'Wait'
    this.maxAgeS = opts.maxAgeS ?? WAIT_MAX_AGE_S
    this.exact = opts.exact ?? false
  }
}

export class Retry extends Error {
  constructor(
    readonly delayS: number,
    message = 'retry',
  ) {
    super(message)
    this.name = 'Retry'
  }
}

export class Permanent extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Permanent'
  }
}

// Wait until an absolute time (ms), exactly.
export function waitUntil(nowMs: number, atMs: number, message: string, maxAgeS = 400 * 24 * 3600): Wait {
  return new Wait(Math.max(1, Math.ceil((atMs - nowMs) / 1000)), message, { exact: true, maxAgeS })
}
