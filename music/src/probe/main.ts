// music-probe: network_mode none, no env_file, read-only rootfs. Polls the
// two inboxes and processes ONE request at a time.
//
// Inbox rules (enforced here, on top of the mounts): in-web may carry only
// 'probe' | 'art' | 'art_release'; in-worker only 'finalize' | 'cover' |
// 'probe_fetch' | 'cleanup_final'. A request of
// the wrong type is answered {ok:false, error:'type_not_allowed_in_inbox'}
// and never executed. Every result records its source inbox.

import { lstat, mkdir, readdir, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { assertProbeEnvClean } from '../server/env'
import {
  INBOX_TYPES,
  listSpoolIds,
  readSmallFileNoFollow,
  spoolRequest,
  UUID_RE,
  writeSpoolResultNoClobber,
  type Inbox,
  type SpoolResult,
} from '../server/spool/protocol'
import { findStraysAfterGrace, killAll, snapshotBaseline, type ProcInfo } from './containment'
import { runArt, runArtRelease } from './art'
import { runFinalize } from './finalize'
import { releaseUpload, runProbe } from './probe'

export const DIRS = {
  spool: '/spool/probe',
  uploads: '/staging/uploads',
  final: '/staging/final',
  work: '/staging/work',
  artIn: '/staging/art-in',
  art: '/staging/art',
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
      return fail(id, inbox, req.type, 'not_implemented') // P5 SoundCloud types
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
        const req = inbox === 'in-web' ? await readClaimedRequest(path) : null
        if (req?.type === 'probe' && req.id === id) {
          // runProbe publishes the cover last, just before its result
          await unlink(join(dirs.uploads, `cover-${id}.jpg`)).catch(() => {})
          const released = await releaseUpload(dirs.uploads, req.upload)
          result = { v: 1, id, source: inbox, type: 'probe', ok: false, error: 'interrupted', released }
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

// Per-job work dirs (runProbe p-, runFinalize f-, runArt a-) left behind by a
// restart mid-job hold a private copy of the input (a WAV: up to 250 MB, plus
// its MP3) on the persistent staging disk, outside the staging quota. Only
// the probe writes /staging/work and no job runs at start-up, so every job
// dir there is stale. rm removes a symlink itself, never its target.
const WORK_DIR_RE = /^[pfa]-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9]{6}$/

export async function clearStaleWork(work = DIRS.work): Promise<number> {
  let n = 0
  for (const name of await readdir(work)) {
    if (!WORK_DIR_RE.test(name)) continue
    await rm(join(work, name), { recursive: true, force: true })
    n++
  }
  return n
}

export async function main() {
  assertProbeEnvClean()
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
  while (!stopping) {
    let did = false
    for (const inbox of INBOXES) {
      let ids: string[] = []
      try {
        ids = await listSpoolIds(join(DIRS.spool, inbox))
      } catch {
        ids = []
      }
      if (ids.length > 0) {
        try {
          did = (await processOne(inbox, ids[0]!, DIRS, strayCheck)) || did
        } catch (e) {
          if (e instanceof ContainmentBreach) {
            console.error(`[probe] SECURITY: ${e.message}; killed them, refused the result, exiting so the container restarts`)
            process.exit(70)
          }
          throw e
        }
      }
    }
    if (!did) await new Promise((r) => setTimeout(r, 1000))
  }
  process.exit(0)
}
