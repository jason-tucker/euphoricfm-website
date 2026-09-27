// Post-job process-table check for the probe (review finding "probe
// containment").
//
// Every parser runs as the probe's own uid (1000) in the probe container, so
// a parser that is compromised could leave a process behind that outlives
// its job (setsid / double fork escapes runLimited's process-group kill) and
// later tampers with /staging/final, /spool/probe/out or another member's
// upload. After every job, with no parser supposed to be running, the probe
// lists /proc: any live process that was not there at start-up (PID 1 = tini
// and the probe itself) is a containment breach. The probe then SIGKILLs
// every such process, refuses the job's result, logs loudly, and EXITS, so
// Docker restarts the container and the kernel tears down the whole PID
// namespace (nothing a stray process did can survive the restart).
//
// Residual (documented in README): during the job itself (≤ ~45 s; a WAV
// conversion job up to ~6 min) a
// compromised parser has the probe uid's write access to the probe mounts.
// Dropping parsers to a second uid needs CAP_SETUID/SETGID in the probe
// (today: cap_drop ALL + no-new-privileges), and Landlock is not available
// on the test host (ENOSYS), so neither is done here.

import { readdir, readFile } from 'node:fs/promises'

export type ProcInfo = { pid: number; state: string; cmd: string }

export async function listProcesses(procDir = '/proc'): Promise<ProcInfo[]> {
  const out: ProcInfo[] = []
  for (const name of await readdir(procDir)) {
    if (!/^\d+$/.test(name)) continue
    const pid = Number(name)
    try {
      const stat = await readFile(`${procDir}/${name}/stat`, 'utf8')
      // pid (comm) state …; comm may contain spaces/parens: take the LAST ')'
      const close = stat.lastIndexOf(')')
      const comm = stat.slice(stat.indexOf('(') + 1, close)
      const state = stat.slice(close + 2, close + 3)
      out.push({ pid, state, cmd: comm })
    } catch {
      // exited between readdir and read
    }
  }
  return out
}

// Live (non-zombie) processes that are neither in `baseline` nor ourselves.
export async function findStrays(baseline: ReadonlySet<number>, procDir = '/proc'): Promise<ProcInfo[]> {
  return (await listProcesses(procDir)).filter((p) => p.pid !== process.pid && !baseline.has(p.pid) && p.state !== 'Z' && p.state !== 'X')
}

// busybox `timeout` forks a watcher that calls setsid() (its own session,
// so the group kill cannot reach it) and exits within ~1 s of its parent's
// exit. So a stray only counts once it is still alive after a short grace
// period; a real escapee gets those few seconds, nothing more.
export async function findStraysAfterGrace(baseline: ReadonlySet<number>, graceMs = 3000, procDir = '/proc'): Promise<ProcInfo[]> {
  const until = Date.now() + graceMs
  for (;;) {
    const strays = await findStrays(baseline, procDir)
    if (strays.length === 0 || Date.now() >= until) return strays
    await new Promise((r) => setTimeout(r, 100))
  }
}

export function killAll(ps: readonly ProcInfo[]): void {
  for (const p of ps) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      // gone already
    }
  }
}

export async function snapshotBaseline(procDir = '/proc'): Promise<Set<number>> {
  return new Set((await listProcesses(procDir)).map((p) => p.pid))
}
