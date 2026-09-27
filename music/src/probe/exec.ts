// Runs an untrusted-input tool under `timeout` and `ulimit -v`, with a
// minimal environment (PATH, HOME=/tmp), no shell interpolation of inputs
// (arguments are passed positionally to `sh -c '... "$@"'`), and bounded
// output capture.
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
  opts: { timeoutS: number; vmemKb: number; maxStdout?: number; cwd?: string; stdin?: Buffer },
): Promise<ExecResult> {
  const maxOut = opts.maxStdout ?? 1024 * 1024
  const timeoutS = Math.max(1, Math.floor(opts.timeoutS))
  return new Promise((resolve) => {
    // busybox timeout signals only its direct child (and its watcher runs in
    // its own session; see containment.ts); -k is moot with KILL but kept so
    // a switch to TERM stays bounded. The group kill below covers the rest of
    // the job's process group, and node's own timer covers a stuck watcher.
    const script = `ulimit -v ${Math.floor(opts.vmemKb)} && ulimit -c 0 && exec timeout -s KILL -k 1 ${timeoutS} "$@"`
    const child = spawn('/bin/sh', ['-c', script, 'probe-exec', cmd, ...args], {
      env: CHILD_ENV as unknown as NodeJS.ProcessEnv,
      cwd: opts.cwd ?? '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
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
