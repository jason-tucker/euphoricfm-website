// music-probe: network_mode none, no env_file, read-only rootfs. Polls the
// two inboxes and processes ONE request at a time.
//
// Inbox rules (enforced here, on top of the mounts): in-web may carry only
// 'probe' | 'art' | 'art_release'; in-worker only 'finalize' | 'cover' |
// 'probe_fetch' | 'cleanup_final'. A request of
// the wrong type is answered {ok:false, error:'type_not_allowed_in_inbox'}
// and never executed. Every result records its source inbox.
//
// Order (v0.4.1): each inbox is taken oldest first (mtime, not the random
// UUID). An in-worker 'finalize' / 'cleanup_final' / 'cover' goes before
// anything else, so an approved song's ingest never waits behind SoundCloud
// conversions (probe_fetch, same inbox) or in-web WAV conversions; the rest
// alternates between the two inboxes.

import { lstat, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertProbeEnvClean } from '../server/env'
import { DEFAULT_MIN_DURATION_S, probeMinDurationS } from './min-duration'
import {
  INBOX_TYPES,
  listSpoolIds,
  readSmallFileNoFollow,
  spoolRequest,
  sweepSpoolDir,
  UUID_RE,
  writeSpoolResultNoClobber,
  type Inbox,
  type SpoolResult,
} from '../server/spool/protocol'
import { findStraysAfterGrace, killAll, snapshotBaseline, type ProcInfo } from './containment'
import { runArt, runArtRelease } from './art'
import { runFinalize } from './finalize'
import { runProbeFetch } from './fetched'
import { releaseUpload, runProbe } from './probe'

export const DIRS = {
  spool: '/spool/probe',
  uploads: '/staging/uploads',
  final: '/staging/final',
  work: '/staging/work',
  artIn: '/staging/art-in',
  art: '/staging/art',
  // v0.4.0: music-fetch's downloads (READ-ONLY here)
  fetch: '/staging/fetch',
  mmChild: new URL('./mm-child.mjs', import.meta.url).pathname,
}


const INBOXES: Inbox[] = ['in-web', 'in-worker']

function fail(id: string, inbox: Inbox, type: string, error: string): SpoolResult {
  return { v: 1, id, source: inbox, type: type.slice(0, 32), ok: false, error }
}

export async function handleClaimed(inbox: Inbox, id: string, claimedPath: string, dirs = DIRS): Promise<SpoolResult> {
  let text: string | null
  try {
    text = await readSmallFileNoFollow(claimedPath)
  } catch {
    return fail(id, inbox, 'unknown', 'bad_request_file')
  }
  if (text === null) return fail(id, inbox, 'unknown', 'bad_request_file')
  let req
  try {
    req = spoolRequest.parse(JSON.parse(text))
  } catch {
    return fail(id, inbox, 'unknown', 'bad_request')
  }
  if (req.id !== id) return fail(id, inbox, req.type, 'id_mismatch')
  if (!INBOX_TYPES[inbox].includes(req.type)) {
    console.warn(`[probe] refused ${req.type} request from ${inbox}`)
    return fail(id, inbox, req.type, 'type_not_allowed_in_inbox')
  }
  switch (req.type) {
    case 'probe':
      return runProbe(req, { uploads: dirs.uploads, work: dirs.work, mmChild: dirs.mmChild })
    case 'finalize':
      return runFinalize(req, { uploads: dirs.uploads, work: dirs.work, final: dirs.final, art: dirs.art })
    case 'probe_fetch':
      return runProbeFetch(req, { fetch: dirs.fetch, uploads: dirs.uploads, work: dirs.work })
    case 'art':
      return runArt(req, { artIn: dirs.artIn, art: dirs.art, work: dirs.work })
    case 'art_release':
      return runArtRelease(req, { artIn: dirs.artIn, art: dirs.art, work: dirs.work })
    case 'cleanup_final': {
      // unlink removes a symlink itself, never its target; the name is
      // pattern-checked by the schema (no separators, no dots but .mp3).
      let removed = true
      try {
        await unlink(join(dirs.final, req.file))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return fail(id, inbox, req.type, 'cleanup_failed')
        removed = false
      }
      return { v: 1, id, source: inbox, type: 'cleanup_final', ok: true, removed }
    }
    default:
      return fail(id, inbox, req.type, 'not_implemented') // 'cover' (reserved)
  }
}

export class ContainmentBreach extends Error {
  constructor(readonly strays: ProcInfo[]) {
    super(`stray process(es) after a job: ${strays.map((p) => `${p.pid}:${p.cmd}`).join(', ')}`)
    this.name = 'ContainmentBreach'
  }
}

// `strayCheck` (main loop: findStrays against the start-up baseline) runs
// after the job and BEFORE its result is published: a breach replaces the
// result with a failure, kills the strays and throws ContainmentBreach, on
// which main() exits so the container (and its PID namespace) restarts.
export async function processOne(inbox: Inbox, id: string, dirs = DIRS, strayCheck?: () => Promise<ProcInfo[]>): Promise<boolean> {
  const claimedDir = join(dirs.spool, 'claimed')
  const claimed = join(claimedDir, `${inbox}-${id}.json`)
  try {
    // rename moves a symlink itself, never its target
    await rename(join(dirs.spool, inbox, `${id}.json`), claimed)
  } catch {
    return false
  }
  let result = await handleClaimed(inbox, id, claimed, dirs)
  const strays = strayCheck ? await strayCheck() : []
  if (strays.length > 0) {
    killAll(strays)
    result = fail(id, inbox, result.type, 'containment_breach')
  }
  const written = await writeSpoolResultNoClobber(join(dirs.spool, 'out'), result)
  if (!written) console.warn(`[probe] result for ${id} already exists; not overwritten`)
  await unlink(claimed).catch(() => {})
  console.log(`[probe] ${inbox} ${id} ${result.type} ${result.ok ? 'ok' : `fail:${(result as { error: string }).error}`}`)
  if (strays.length > 0) throw new ContainmentBreach(strays)
  return true
}

// Requests claimed but never answered (the probe was restarted mid-job:
// deploy, reboot, OOM of this process) are answered 'interrupted'. An
// interrupted 'probe' from in-web is answered as a probe rejection whose
// upload is released like any other (runProbe deletes a rejected upload's
// bytes), so a WAV of up to 250 MB does not stay charged and on disk until
// retention. Nothing is done for a request that already has a result: the
// crash came after the answer, and that upload may be a converted MP3 in use.
// The upload is deleted BEFORE the result is written, so a crash in between
// only repeats this on the next start.
export async function recoverInterrupted(dirs: Pick<typeof DIRS, 'spool' | 'uploads'> = DIRS) {
  const claimedDir = join(dirs.spool, 'claimed')
  const outDir = join(dirs.spool, 'out')
  for (const name of await readdir(claimedDir)) {
    const path = join(claimedDir, name)
    const m = /^(in-web|in-worker)-(.+)\.json$/.exec(name)
    if (m && UUID_RE.test(m[2]!)) {
      const id = m[2]!
      const inbox = m[1] as Inbox
      const answered = await lstat(join(outDir, `${id}.json`)).then(
        () => true,
        () => false,
      )
      if (!answered) {
        let result: SpoolResult = fail(id, inbox, 'unknown', 'interrupted')
        const req = await readClaimedRequest(path)
        if (inbox === 'in-web' && req?.type === 'probe' && req.id === id) {
          // runProbe publishes the cover last, just before its result
          await unlink(join(dirs.uploads, `cover-${id}.jpg`)).catch(() => {})
          const released = await releaseUpload(dirs.uploads, req.upload)
          result = { v: 1, id, source: inbox, type: 'probe', ok: false, error: 'interrupted', released }
        } else if (inbox === 'in-worker' && req?.type === 'probe_fetch' && req.id === id) {
          // v0.4.0: whatever the interrupted conversion published (it
          // publishes the MP3, then the cover) is removed; the worker rejects
          // the item and releases its quota.
          await unlink(join(dirs.uploads, `cover-${id}.jpg`)).catch(() => {})
          await releaseUpload(dirs.uploads, req.upload)
          result = { v: 1, id, source: inbox, type: 'probe_fetch', ok: false, error: 'interrupted' }
        }
        await writeSpoolResultNoClobber(outDir, result).catch(() => {})
      }
    }
    await unlink(path).catch(() => {})
  }
}

async function readClaimedRequest(path: string) {
  try {
    const text = await readSmallFileNoFollow(path)
    return text === null ? null : spoolRequest.parse(JSON.parse(text))
  } catch {
    return null
  }
}

// Per-job work dirs (runProbe p-, runFinalize f-, runArt a-, runProbeFetch s-) left behind by a
// restart mid-job hold a private copy of the input (a WAV: up to 250 MB, plus
// its MP3) on the persistent staging disk, outside the staging quota. Only
// the probe writes /staging/work and no job runs at start-up, so every job
// dir there is stale. rm removes a symlink itself, never its target.
const WORK_DIR_RE = /^[pfas]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{6}$/

export async function clearStaleWork(work = DIRS.work): Promise<number> {
  let n = 0
  for (const name of await readdir(work)) {
    if (!WORK_DIR_RE.test(name)) continue
    await rm(join(work, name), { recursive: true, force: true })
    n++
  }
  return n
}

// The in-worker types an approved song's ingest waits on.
const URGENT_TYPES = new Set(['finalize', 'cleanup_final', 'cover'])

async function peekType(path: string): Promise<string | null> {
  try {
    const text = await readSmallFileNoFollow(path)
    const t = text === null ? null : (JSON.parse(text) as { type?: unknown }).type
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

async function idsOf(spool: string, inbox: Inbox): Promise<string[]> {
  try {
    return await listSpoolIds(join(spool, inbox))
  } catch {
    return []
  }
}

// The next request to run. `turn` alternates the non-urgent work between
// the inboxes (callers flip it after each job). A request that cannot be
// peeked (bad JSON, a symlink) counts as urgent: it is answered at once.
export async function nextJob(spool: string, turn: Inbox): Promise<{ inbox: Inbox; id: string } | null> {
  const worker = await idsOf(spool, 'in-worker')
  for (const id of worker) {
    const t = await peekType(join(spool, 'in-worker', `${id}.json`))
    if (t === null || URGENT_TYPES.has(t)) return { inbox: 'in-worker', id }
  }
  const web = await idsOf(spool, 'in-web')
  const order: Inbox[] = turn === 'in-web' ? ['in-web', 'in-worker'] : ['in-worker', 'in-web']
  for (const inbox of order) {
    const ids = inbox === 'in-web' ? web : worker
    if (ids.length > 0) return { inbox, id: ids[0]! }
  }
  return null
}

// v0.4.1: results older than a day (the worker collects a result within its
// poll loop; the web's art status reads one within the 24 h art retention)
// and '.tmp-*' files a crash left between create and rename, in every spool
// directory the probe can write.
export const SPOOL_SWEEP_MAX_AGE_MS = 24 * 3600_000
export const SPOOL_SWEEP_EVERY_MS = 3600_000

export async function sweepSpool(spool = DIRS.spool, now = Date.now()): Promise<number> {
  let n = await sweepSpoolDir(join(spool, 'out'), { tmpMaxAgeMs: SPOOL_SWEEP_MAX_AGE_MS, resultMaxAgeMs: SPOOL_SWEEP_MAX_AGE_MS, now })
  for (const d of ['claimed', ...INBOXES]) n += await sweepSpoolDir(join(spool, d), { tmpMaxAgeMs: SPOOL_SWEEP_MAX_AGE_MS, now })
  return n
}

export async function main() {
  assertProbeEnvClean()
  // Validates the optional PROBE_MIN_DURATION_S (throws on a bad value).
  const minS = probeMinDurationS()
  if (minS !== DEFAULT_MIN_DURATION_S) console.log(`[probe] minimum duration ${minS} s (PROBE_MIN_DURATION_S)`)
  for (const d of [join(DIRS.spool, 'claimed'), join(DIRS.spool, 'out'), DIRS.work, DIRS.final, DIRS.art]) await mkdir(d, { recursive: true, mode: 0o750 })
  const stale = await clearStaleWork()
  if (stale > 0) console.warn(`[probe] removed ${stale} job dir(s) left in ${DIRS.work} by an interrupted run`)
  await recoverInterrupted()
  // Start-up process table: tini (PID 1) and this process. Anything else
  // alive after a job is a stray (containment.ts).
  const baseline = await snapshotBaseline()
  const strayCheck = () => findStraysAfterGrace(baseline)
  let stopping = false
  process.on('SIGTERM', () => (stopping = true))
  process.on('SIGINT', () => (stopping = true))
  console.log('[probe] ready')
  let turn: Inbox = 'in-web'
  let lastSweep = 0
  while (!stopping) {
    if (Date.now() - lastSweep > SPOOL_SWEEP_EVERY_MS) {
      lastSweep = Date.now()
      const swept = await sweepSpool().catch(() => 0)
      if (swept > 0) console.log(`[probe] swept ${swept} old spool file(s)`)
    }
    let did = false
    const job = await nextJob(DIRS.spool, turn)
    if (job) {
      turn = job.inbox === 'in-web' ? 'in-worker' : 'in-web'
      try {
        did = await processOne(job.inbox, job.id, DIRS, strayCheck)
      } catch (e) {
        if (e instanceof ContainmentBreach) {
          console.error(`[probe] SECURITY: ${e.message}; killed them, refused the result, exiting so the container restarts`)
          process.exit(70)
        }
        throw e
      }
    }
    if (!did) await new Promise((r) => setTimeout(r, 1000))
  }
  process.exit(0)
}
