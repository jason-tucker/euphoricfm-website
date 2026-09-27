// Contract drift probe (plan §3.7): hash the OpenAPI shapes of the paths the
// portal uses and compare them with the P0d baseline
// (/mnt/user/Backup/euphoricfm/portal-contract-baseline/, hashes copied into
// ./contract-baseline.json). The slicing below reproduces the baseline files
// byte for byte (verified against its SHA256SUMS when the fixture was made).
// On drift the worker pauses the ingest and move queues and alerts.

import { createHash } from 'node:crypto'
import baseline from './contract-baseline.json'

export type ContractBaseline = {
  paths: Record<string, string>
  schemasBundleSha256: string
  schemas: Record<string, string>
}

export const BASELINE = baseline as ContractBaseline

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function sliceFrom(lines: string[], start: number, indent: number): string {
  let j = start + 1
  while (j < lines.length) {
    const m = /^( *)\S/.exec(lines[j]!)
    if (m && m[1]!.length <= indent) break
    j++
  }
  return lines.slice(start, j).join('\n') + '\n'
}

export function pathSlice(lines: string[], path: string): string | null {
  const re = new RegExp(`^  '${esc(path)}':$`)
  const i = lines.findIndex((l) => re.test(l))
  return i < 0 ? null : sliceFrom(lines, i, 2)
}

export function schemaSlice(lines: string[], name: string): string | null {
  const compStart = lines.findIndex((l) => l === '  schemas:')
  if (compStart < 0) return null
  const i = lines.findIndex((l, idx) => idx > compStart && l === `    ${name}:`)
  return i < 0 ? null : sliceFrom(lines, i, 4)
}

const REF = /#\/components\/schemas\/([A-Za-z0-9_]+)/g

export type DriftReport = { ok: boolean; drift: { name: string; expected: string; actual: string | null }[] }

export function checkContract(openapiYaml: string, base: ContractBaseline = BASELINE): DriftReport {
  const lines = openapiYaml.replace(/\r\n/g, '\n').split('\n')
  const drift: DriftReport['drift'] = []
  const slices: string[] = []
  for (const [p, expected] of Object.entries(base.paths)) {
    const s = pathSlice(lines, p)
    const actual = s === null ? null : sha(s)
    if (actual !== expected) drift.push({ name: `path ${p}`, expected, actual })
    if (s) slices.push(s)
  }
  const seen = new Set<string>()
  const queue: string[] = []
  for (const s of slices) for (const m of s.matchAll(REF)) queue.push(m[1]!)
  let guard = 0
  while (queue.length && guard++ < 1000) {
    const n = queue.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    const s = schemaSlice(lines, n)
    if (s) for (const m of s.matchAll(REF)) queue.push(m[1]!)
  }
  const names = [...seen].sort()
  const bundle = names.map((n) => schemaSlice(lines, n) ?? '').join('')
  const bundleSha = sha(bundle)
  if (bundleSha !== base.schemasBundleSha256) {
    drift.push({ name: 'schemas bundle', expected: base.schemasBundleSha256, actual: bundleSha })
    for (const [n, expected] of Object.entries(base.schemas)) {
      const s = schemaSlice(lines, n)
      const actual = s === null ? null : sha(s)
      if (actual !== expected) drift.push({ name: `schema ${n}`, expected, actual })
    }
    for (const n of names) if (!(n in base.schemas)) drift.push({ name: `schema ${n} (new ref)`, expected: '', actual: sha(schemaSlice(lines, n) ?? '') })
  }
  return { ok: drift.length === 0, drift }
}
