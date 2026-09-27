// Runs an untrusted-input tool under `timeout -s KILL` and `ulimit -v`, with a
// minimal environment (PATH, HOME=/tmp), no shell interpolation of inputs
// (arguments are passed positionally to `sh -c '... "$@"'`), and bounded
// output capture.

import { spawn } from 'node:child_process'

export const CHILD_ENV = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/tmp' }

export type ExecResult = { code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: string; timedOut: boolean }

export function runLimited(
  cmd: string,
  args: readonly string[],
  opts: { timeoutS: number; vmemKb: number; maxStdout?: number; cwd?: string; stdin?: Buffer },
): Promise<ExecResult> {
  const maxOut = opts.maxStdout ?? 1024 * 1024
  return new Promise((resolve) => {
    const script = `ulimit -v ${Math.floor(opts.vmemKb)} && ulimit -c 0 && exec timeout -s KILL ${Math.floor(opts.timeoutS)} "$@"`
    const child = spawn('/bin/sh', ['-c', script, 'probe-exec', cmd, ...args], {
      env: CHILD_ENV as unknown as NodeJS.ProcessEnv,
      cwd: opts.cwd ?? '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const out: Buffer[] = []
    let outLen = 0
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      outLen += c.length
      if (outLen <= maxOut) out.push(c)
      else child.kill('SIGKILL')
    })
    child.stderr.on('data', (c: Buffer) => {
      if (err.length < 8192) err += c.toString('utf8')
    })
    // stdin: the given bytes, or immediate EOF (never an inherited terminal)
    child.stdin.on('error', () => {})
    child.stdin.end(opts.stdin ?? undefined)
    const hard = setTimeout(() => child.kill('SIGKILL'), (opts.timeoutS + 5) * 1000)
    child.on('close', (code, signal) => {
      clearTimeout(hard)
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: err, timedOut: code === 137 || code === 124 || signal === 'SIGKILL' })
    })
  })
}
