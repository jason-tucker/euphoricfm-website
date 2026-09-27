// music-probe: network_mode none, no env_file, read-only rootfs. Polls the
// two inboxes and processes ONE request at a time.
//
// Inbox rules (enforced here, on top of the mounts): in-web may carry only
// 'probe'; in-worker only 'finalize' | 'cover' | 'probe_fetch'. A request of
// the wrong type is answered {ok:false, error:'type_not_allowed_in_inbox'}
// and never executed. Every result records its source inbox.

import { mkdir, readdir, rename, unlink } from 'node:fs/promises'
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
import { runFinalize } from './finalize'
import { runProbe } from './probe'

export const DIRS = {
  spool: '/spool/probe',
  uploads: '/staging/uploads',
  final: '/staging/final',
  work: '/staging/work',
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
      return runFinalize(req, { uploads: dirs.uploads, work: dirs.work, final: dirs.final })
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

async function recoverInterrupted(dirs = DIRS) {
  const claimedDir = join(dirs.spool, 'claimed')
  for (const name of await readdir(claimedDir)) {
    const m = /^(in-web|in-worker)-(.+)\.json$/.exec(name)
    if (m && UUID_RE.test(m[2]!)) {
      await writeSpoolResultNoClobber(join(dirs.spool, 'out'), fail(m[2]!, m[1] as Inbox, 'unknown', 'interrupted')).catch(() => {})
    }
    await unlink(join(claimedDir, name)).catch(() => {})
  }
}

export async function main() {
  assertProbeEnvClean()
  for (const d of [join(DIRS.spool, 'claimed'), join(DIRS.spool, 'out'), DIRS.work, DIRS.final]) await mkdir(d, { recursive: true, mode: 0o750 })
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
