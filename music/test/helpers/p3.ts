// P3 test helpers: a worker context with a pinned clock, temp spool / final
// dirs (the test plays the probe), the AzuraCast mock under the Portal-Test/
// prefix, and row factories.
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AzuraCastClient } from '@/server/azuracast/client'
import { resolveProfile } from '@/server/azuracast/guard'
import { getDb } from '@/server/db/client'
import { TicketsClient } from '@/server/tickets/client'
import type { P3Ctx } from '@/worker/ingest/context'
import { ownerSql } from './db'

export const ROOT = 'Portal-Test/'
export const PREFIX_ENV = { MUSIC_PROFILE: 'prod', STATION_ID: '1', PORTAL_TEST_PREFIX: ROOT }
export const ORIGIN = 'https://music.euphoric.fm'

// A distinct far-future day per test keeps the pacing windows apart and
// keeps every run_after the tests create out of the running worker's reach.
// Default time of day: :01:40 → 40 s after a scan start, window open.
export function slot(day: number, minute = 1, second = 40): number {
  return Date.UTC(2031, 0, 1 + day, 3, minute, second)
}

export type TestCtx = P3Ctx & { clock: { t: number }; alerts: { title: string; detail: Record<string, unknown> }[]; cleanup: () => void }

export function makeCtx(t0: number, opts: { az?: AzuraCastClient; root?: string; tickets?: TicketsClient; fetchImpl?: typeof fetch; kumaDiskPushUrl?: string; contractFixture?: string } = {}): TestCtx {
  const base = mkdtempSync(join(tmpdir(), 'p3-'))
  const dirs = { in: join(base, 'in'), out: join(base, 'out'), final: join(base, 'final') }
  for (const d of Object.values(dirs)) mkdirSync(d)
  const clock = { t: t0 }
  const alerts: TestCtx['alerts'] = []
  const root = opts.root ?? ROOT
  const env = root ? PREFIX_ENV : { MUSIC_PROFILE: 'prod', STATION_ID: '1' }
  return {
    db: getDb(process.env.TEST_APP_DATABASE_URL, 2),
    azuracast: opts.az ?? new AzuraCastClient({ baseUrl: process.env.MOCKS_AZURACAST!, apiKey: process.env.AZURACAST_API_KEY!, profile: resolveProfile(env), canaryStationId: 7, env }),
    tickets: opts.tickets ?? new TicketsClient({ baseUrl: process.env.MOCKS_TICKETS!, key: process.env.TICKETS_WRITE_KEY!, portalOrigin: ORIGIN }),
    portalOrigin: ORIGIN,
    spoolOutDir: dirs.out,
    spoolInDir: dirs.in,
    finalDir: dirs.final,
    root,
    now: () => clock.t,
    alert: async (title, detail) => {
      alerts.push({ title, detail })
    },
    kumaDiskPushUrl: opts.kumaDiskPushUrl,
    contractFixture: opts.contractFixture,
    fetchImpl: opts.fetchImpl,
    clock,
    alerts,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let seq = 0
export const uniq = () => `${Date.now().toString(36)}${(++seq).toString(36)}`
const snowflake = () => `5${String(Date.now()).slice(-9)}${String(++seq).padStart(8, '0')}`

export async function mkUser(): Promise<{ id: string; discordId: string }> {
  const discordId = snowflake()
  const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (${randomUUID()}, ${discordId}) RETURNING id`
  return { id: u!.id as string, discordId }
}

export async function mkArtist(name: string, status = 'active', folder = name): Promise<number> {
  const [a] = await ownerSql()`INSERT INTO artists (name, folder, status) VALUES (${name}, ${folder}, ${status}::artist_status) RETURNING id`
  return a!.id as number
}

export async function mkBatch(ownerId: string, fields: { status?: string; ticketId?: number | null } = {}): Promise<number> {
  // A batch past draft was submitted WITH the rights attestation (the
  // foundation's BATCH_DECIDABLE_SQL requires attested_at for decisions).
  const status = fields.status ?? 'submitted'
  const attestedAt = status === 'draft' ? null : new Date().toISOString()
  const [b] = await ownerSql()`INSERT INTO batches (owner_user_id, status, ticket_id, attested_at) VALUES (${ownerId}, ${status}::batch_status, ${fields.ticketId ?? null}, ${attestedAt}::timestamptz) RETURNING id`
  return b!.id as number
}

export async function mkItem(f: {
  batchId: number
  ownerId: string
  status?: string
  kind?: string
  title?: string | null
  artist?: string | null
  artistId?: number | null
  newArtistName?: string | null
  playlistIds?: number[]
  probeSha?: string | null
}): Promise<number> {
  const sha = f.probeSha === undefined ? 'a'.repeat(64) : f.probeSha
  const status = f.status ?? 'approved'
  const [it] = await ownerSql()`
    INSERT INTO items (batch_id, owner_user_id, kind, status, upload_id, probe_sha256, approved_sha256, title, artist, album, genre, artist_id, new_artist_name, playlist_ids)
    VALUES (${f.batchId}, ${f.ownerId}, ${f.kind ?? 'song'}::item_kind, ${status}::item_status, ${f.kind === 'new_artist' ? null : randomUUID().replace(/-/g, '')},
            ${f.kind === 'new_artist' ? null : sha}, ${status === 'approved' && f.kind !== 'new_artist' ? sha : null},
            ${f.title === undefined ? 'Song' : f.title}, ${f.artist === undefined ? 'Artist' : f.artist}, 'Album', 'Pop',
            ${f.artistId ?? null}, ${f.newArtistName ?? null}, ${f.playlistIds ?? [2]})
    RETURNING id`
  return it!.id as number
}

export async function run(itemId: number) {
  return (await ownerSql()`SELECT * FROM ingest_runs WHERE item_id = ${itemId}`)[0]
}

export async function item(itemId: number) {
  return (await ownerSql()`SELECT * FROM items WHERE id = ${itemId}`)[0]!
}

// Plays the probe for the pending finalize request: returns the request it
// read and publishes `bytes` as the final file (or a failure result).
export async function actAsProbe(
  ctx: TestCtx,
  itemId: number,
  opts: { bytes?: Buffer; fail?: string; reportedSha?: string; source?: 'in-worker' | 'in-web' } = {},
): Promise<Record<string, unknown>> {
  const r = await run(itemId)
  const id = r!.finalize_request_id as string
  const req = JSON.parse(readFileSync(join(ctx.spoolInDir, `${id}.json`), 'utf8'))
  const base = { v: 1, id, source: opts.source ?? 'in-worker', type: 'finalize' }
  if (opts.fail) {
    writeFileSync(join(ctx.spoolOutDir, `${id}.json`), JSON.stringify({ ...base, ok: false, error: opts.fail }))
    return req
  }
  const bytes = opts.bytes ?? Buffer.from(`final bytes ${id}`)
  const file = `${id}.mp3`
  writeFileSync(join(ctx.finalDir, file), bytes)
  const finalSha256 = opts.reportedSha ?? createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(ctx.spoolOutDir, `${id}.json`), JSON.stringify({ ...base, ok: true, file, finalSha256, size: bytes.length }))
  return req
}
