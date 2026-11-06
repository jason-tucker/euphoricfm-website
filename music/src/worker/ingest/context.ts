// The worker context the P3 jobs need on top of the P2 WorkerCtx. main.ts
// builds it once; tests build it with a fixed clock, temp spool dirs and the
// mocks.

import type { WorkerCtx } from '../handlers'

export type P3Ctx = WorkerCtx & {
  // PORTAL_TEST_PREFIX ('' in production). Every station path is built on it.
  root: string
  // /spool/probe/in-worker (rw): finalize + cleanup_final requests
  spoolInDir: string
  // /staging/final (ro): the probe's finalized files
  finalDir: string
  // Wall clock in ms. Injected so tests can pin the scan window.
  now: () => number
  kumaDiskPushUrl?: string
  contractFixture?: string
  fetchImpl?: typeof fetch
}

export function isP3Ctx(ctx: WorkerCtx): ctx is P3Ctx {
  return typeof (ctx as Partial<P3Ctx>).finalDir === 'string' && typeof (ctx as Partial<P3Ctx>).now === 'function'
}
