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

export async function processOne(inbox: Inbox, id: string, dirs = DIRS): Promise<boolean> {
  const claimedDir = join(dirs.spool, 'claimed')
  const claimed = join(claimedDir, `${inbox}-${id}.json`)
  try {
    // rename moves a symlink itself, never its target
    await rename(join(dirs.spool, inbox, `${id}.json`), claimed)
  } catch {
    return false
  }
  const result = await handleClaimed(inbox, id, claimed, dirs)
  const written = await writeSpoolResultNoClobber(join(dirs.spool, 'out'), result)
  if (!written) console.warn(`[probe] result for ${id} already exists; not overwritten`)
  await unlink(claimed).catch(() => {})
  console.log(`[probe] ${inbox} ${id} ${result.type} ${result.ok ? 'ok' : `fail:${(result as { error: string }).error}`}`)
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
        did = (await processOne(inbox, ids[0]!)) || did
      }
    }
    if (!did) await new Promise((r) => setTimeout(r, 1000))
  }
  process.exit(0)
}
