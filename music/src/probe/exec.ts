// Runs an untrusted-input tool under `timeout` and an address-space limit,
// with a minimal environment (PATH, HOME=/tmp) and bounded output capture.
//
// NO shell is involved: the argv array goes straight to execve as
//   prlimit --as=<bytes> --core=0 -- timeout -s KILL -k 1 <s> <cmd> <args...>
// prlimit (util-linux, installed in the probe and test images) sets
// RLIMIT_AS (soft = hard, the same as the former `ulimit -v`) and
// RLIMIT_CORE = 0 on itself and execs timeout, which runs the tool; no
// argument is ever parsed as shell syntax (CodeQL
// js/shell-command-injection-from-environment flagged the former
// `/bin/sh -c 'ulimit ... "$@"'` wrapper). A missing prlimit makes spawn fail
// (ENOENT), which callers see as a failed run: it fails closed.
//
// Containment (review finding "probe containment"):
//  * every child is spawned DETACHED, i.e. as the leader of its own process
//    group, and the WHOLE group is SIGKILLed on timeout, on output overflow,
//    and again as soon as the child exits (so a background grandchild that
//    stayed in the group dies with the job);
//  * a hard deadline resolves the call even if a stray process keeps the
//    stdio pipes open (the pipes are destroyed);
//  * a process that leaves the group on purpose (setsid / double fork) is
//    NOT covered by the group kill: main.ts checks the process table after
//    every job and fails closed (see containment.ts).

import { spawn } from 'node:child_process'

export const CHILD_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' }

// Fixed absolute paths (Alpine: util-linux-misc and the busybox applet).
export const PRLIMIT = '/usr/bin/prlimit'
export const TIMEOUT = '/usr/bin/timeout'
// busybox nice (v0.3.0): long CPU-bound jobs (the WAV → MP3 conversion) run
// at a lowered priority so the 1-vCPU host stays responsive. Raising the
// nice value needs no capability.
export const NICE = '/bin/nice'

// The full argv for runLimited: every element is one execve argument.
//   prlimit … -- timeout … [nice -n <n>] <cmd> <args…>
// nice execs the tool in place, so the group leader, the timeout's child and
// the process the limits apply to stay the same.
export function limitedArgv(cmd: string, args: readonly string[], vmemKb: number, timeoutS: number, nice?: number): string[] {
  const asBytes = Math.floor(vmemKb) * 1024
  const secs = Math.max(1, Math.floor(timeoutS))
  if (!Number.isSafeInteger(asBytes) || asBytes <= 0) throw new Error('runLimited: bad vmemKb')
  if (nice !== undefined && (!Number.isInteger(nice) || nice < 1 || nice > 19)) throw new Error('runLimited: bad nice')
  const niced = nice === undefined ? [] : [NICE, '-n', String(nice)]
  return [`--as=${asBytes}`, '--core=0', '--', TIMEOUT, '-s', 'KILL', '-k', '1', String(secs), ...niced, cmd, ...args]
}

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string; timedOut: boolean }

function killGroup(pid: number | undefined): void {
  if (!pid) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // ESRCH: the group is already empty
  }
}

export function runLimited(
  cmd: string,
  args: readonly string[],
  opts: { timeoutS: number; vmemKb: number; maxStdout?: number; cwd?: string; stdin?: Buffer; nice?: number },
): Promise<ExecResult> {
  const maxOut = opts.maxStdout ?? 1024 * 1024
  const timeoutS = Math.max(1, Math.floor(opts.timeoutS))
  return new Promise((resolve) => {
    // busybox timeout signals only its direct child (and its watcher runs in
    // its own session; see containment.ts); -k is moot with KILL but kept so
    // a switch to TERM stays bounded. The group kill below covers the rest of
    // the job's process group, and node's own timer covers a stuck watcher.
    // prlimit execs timeout in place (no fork), so the group leader is the
    // same process as before.
    const child = spawn(PRLIMIT, limitedArgv(cmd, args, opts.vmemKb, timeoutS, opts.nice), {
      env: CHILD_ENV as unknown as NodeJS.ProcessEnv,
      cwd: opts.cwd ?? '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      shell: false,
    })
    const pid = child.pid
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    let timedOut = false
    let done = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (done) return
      done = true
      clearTimeout(hard)
      clearTimeout(abandon)
      killGroup(pid)
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: err, timedOut: timedOut || code === 137 || code === 124 || signal === 'SIGKILL' })
    }
    child.on('error', () => finish(null, null))
    child.stdout.on('data', (c: Buffer) => {
      outLen += c.length
      if (outLen <= maxOut) out.push(c)
      else killGroup(pid)
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8192) err += c.toString('utf8')
    })
    // stdin: the given bytes, or immediate EOF (never an inherited terminal)
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin ?? undefined)
    // The child itself exited: kill whatever is left in its group now, so a
    // leftover holding the pipes cannot delay 'close'.
    child.on('exit', () => killGroup(pid))
    const hard = setTimeout(() => {
      timedOut = true
      killGroup(pid)
    }, (timeoutS + 2) * 1000)
    // Last resort: something outside the group still holds the pipes.
    const abandon = setTimeout(() => {
      timedOut = true
      child.stdout.destroy()
      child.stderr.destroy()
      finish(child.exitCode, child.signalCode)
    }, (timeoutS + 5) * 1000)
    child.on('close', (code, signal) => finish(code, signal))
  })
}
