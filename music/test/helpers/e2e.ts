// Shared setup for the e2e files (they talk to the running containers): ids,
// the seeded reviewer role, the rights attestation, tickets membership, page
// HTML, item / ingest waits and ffprobe. One place for what used to be
// copy-pasted into up to 12 files.
import { execFileSync } from 'node:child_process'
import { expect } from 'vitest'
import { ownerSql } from './db'
import { control, type Jar, req } from './http'
import { waitFor } from './wait'

// Seeded review + manage role (compose.test.yml SEED_REVIEW_ROLE_IDS).
export const REVIEWER_ROLE = '1144462744456794153'

// The rights attestation a submit sends (the version the e2e runs attest to).
export const ATTEST = { attest: true, attestVersion: '2026-09-27' } as const

// A per-file id maker: `<digit><last 9 digits of now><8-digit sequence>`, a
// 18-digit Discord-snowflake-shaped id. Each file keeps its own leading
// digit and sequence.
export function idMaker(digit: string): () => string {
  let seq = 0
  return () => `${digit}${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`
}

// The member is in the Discord server per the tickets mock.
export const memberOf = (id: string) => control('/__mock/tickets/member', { id, member: true })

// A page's HTML (200 asserted), with React's text-split comments removed.
export async function html(jar: Jar, path: string): Promise<string> {
  const r = await req(jar, path)
  expect(r.status, path).toBe(200)
  return (await r.text()).replace(/<!-- -->/g, '')
}

// GET /api/items/<id> until it leaves `probing`.
export function settledItem<T extends { status: string }>(jar: Jar, id: number, ms: number, stepMs = 500): Promise<T> {
  return waitFor(
    async () => {
      const x = (await (await req(jar, `/api/items/${id}`)).json()) as T
      return x.status !== 'probing' ? x : null
    },
    ms,
    stepMs,
  )
}

// After approval: the item reaches `verifying` or `live` (an ingest failure
// throws at once with the run's last_error).
export function waitIngested(itemId: number, ms: number) {
  return waitFor(
    async () => {
      const r = (await ownerSql()`SELECT status, target_path, media_id, final_sha256 FROM items WHERE id = ${itemId}`)[0]!
      if (r.status === 'failed') throw new Error(`ingest failed: ${JSON.stringify((await ownerSql()`SELECT last_error FROM ingest_runs WHERE item_id = ${itemId}`)[0])}`)
      return r.status === 'verifying' || r.status === 'live' ? r : null
    },
    ms,
    1000,
  )
}

// ffprobe's JSON for a file (format + streams).
export function ffprobe(file: string) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString()) as {
    format: { format_name: string; duration: string }
    streams: { codec_type: string; codec_name: string; bit_rate?: string; sample_rate?: string; channels?: number }[]
  }
}
