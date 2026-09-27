// One-shot migrator (compose service music-migrate, run from the worker image).
//
//  0. waits (≤60 s, transient connect errors only) for the database;
//  1. applies the committed SQL migrations in ./drizzle as the DB OWNER;
//  2. creates/updates the least-privilege runtime role `music_app` (web and
//     worker connect as it): DML only, no ownership, so it cannot disable the
//     audit_log triggers; audit_log gets SELECT + INSERT only;
//  3. seeds default settings (insert-if-absent) and, exactly once, the
//     reviewer role bindings from SEED_REVIEW_ROLE_IDS.
//
// Env (migrate.env): DATABASE_OWNER_URL, MUSIC_APP_DB_PASSWORD,
// SEED_REVIEW_ROLE_IDS, optional MIGRATIONS_DIR.

import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { DEFAULT_SETTINGS } from '../server/settings-defaults'

const SNOWFLAKE = /^\d{17,20}$/
const APP_ROLE = 'music_app'

export function parseSeedRoleIds(raw: string | undefined): string[] {
  const ids = (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  for (const id of ids) {
    if (!SNOWFLAKE.test(id)) throw new Error(`SEED_REVIEW_ROLE_IDS: not a Discord role id: ${JSON.stringify(id)}`)
  }
  return ids
}

// The seed runs exactly once. Seeding zero roles would mark it done with no
// reviewers and no way to bootstrap them by fixing the env, so the migrate
// one-shot fails instead (web and worker then never start).
export function assertSeedable(alreadySeeded: boolean, roles: readonly string[]): void {
  if (!alreadySeeded && roles.length === 0) throw new Error('SEED_REVIEW_ROLE_IDS must name at least one role for the first (one-time) seed')
}

// ALTER ROLE … PASSWORD takes no bind parameters, so the value is embedded as
// a literal. Restrict it to a charset that needs no escaping at all, neither
// in that SQL literal nor in the DATABASE_URL web and worker build from the
// same value: RFC 3986 unreserved characters minus '~'. A base64 value used
// to pass here and then break the URL ('/' → postgres(url): Invalid URL, so
// first boot never connected); generate it with `openssl rand -hex 24`.
export function assertSafePassword(pw: string | undefined): string {
  if (!pw || !/^[A-Za-z0-9_.-]{24,128}$/.test(pw)) {
    throw new Error('MUSIC_APP_DB_PASSWORD must be 24-128 chars of [A-Za-z0-9_.-] (URL-safe; use `openssl rand -hex 24`)')
  }
  return pw
}

// First boot (review deploy-F2): music-migrate starts once music-db is
// healthy, but the healthcheck can still race the entrypoint's initdb restart
// and the one-shot has restart: "no" (web and worker would then never
// start). So the first connect is retried for up to 60 s, but only on errors
// that mean "not reachable / not ready yet"; a bad password, a missing
// database or any SQL error fails at once.
const TRANSIENT_CONNECT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'CONNECT_TIMEOUT', 'CONNECTION_CLOSED', 'CONNECTION_ENDED', 'CONNECTION_DESTROYED', // postgres.js
  '57P03', // cannot_connect_now: the database system is starting up / shutting down
])

export function isTransientConnectError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const codes = [(e as { code?: unknown }).code]
  // net's happy-eyeballs connect reports an AggregateError of per-address errors.
  if (e instanceof AggregateError) for (const x of e.errors) codes.push((x as { code?: unknown } | null)?.code)
  return codes.some((c) => typeof c === 'string' && TRANSIENT_CONNECT_CODES.has(c))
}

export type WaitOpts = { timeoutMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>; log?: (msg: string) => void }

export async function waitForDatabase(ping: () => Promise<unknown>, o: WaitOpts = {}): Promise<number> {
  const timeoutMs = o.timeoutMs ?? 60_000
  const intervalMs = o.intervalMs ?? 2_000
  const now = o.now ?? Date.now
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = now() + timeoutMs
  for (let attempt = 1; ; attempt++) {
    try {
      await ping()
      return attempt
    } catch (e) {
      if (!isTransientConnectError(e) || now() + intervalMs > deadline) throw e
      o.log?.(`[migrate] database not ready yet (${String((e as { code?: unknown }).code ?? 'error')}), retry ${attempt}`)
      await sleep(intervalMs)
    }
  }
}

export async function runMigrate(): Promise<void> {
  const ownerUrl = process.env.DATABASE_OWNER_URL
  if (!ownerUrl) throw new Error('DATABASE_OWNER_URL is not set')
  const appPassword = assertSafePassword(process.env.MUSIC_APP_DB_PASSWORD)
  const seedRoles = parseSeedRoleIds(process.env.SEED_REVIEW_ROLE_IDS)
  const migrationsFolder = process.env.MIGRATIONS_DIR ?? new URL('./drizzle', import.meta.url).pathname

  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {}, connect_timeout: 10 })
  try {
    await waitForDatabase(() => sql`SELECT 1`, { log: (m) => console.log(m) })
    await migrate(drizzle(sql), { migrationsFolder })

    const [{ exists } = { exists: false }] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists`
    if (!exists) {
      await sql.unsafe(`CREATE ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${appPassword}'`)
    } else {
      await sql.unsafe(`ALTER ROLE ${APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${appPassword}'`)
    }
    const [{ db }] = (await sql`SELECT current_database() AS db`) as unknown as [{ db: string }]
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${db.replace(/"/g, '""')}" TO ${APP_ROLE}`)
    await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`)
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`)
    await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`)
    await sql.unsafe(`REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${APP_ROLE}`)
    await sql.unsafe(`REVOKE UPDATE, DELETE ON audit_log FROM ${APP_ROLE}`)
    await sql.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`)

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${JSON.stringify(value)}::jsonb, 'seed')
                ON CONFLICT (key) DO NOTHING`
    }

    // Seed reviewer roles exactly once: after an admin edits role_bindings,
    // a redeploy must not silently re-add a binding they removed.
    const seeded = await sql`SELECT 1 FROM settings WHERE key = 'role_bindings_seeded'`
    assertSeedable(seeded.length > 0, seedRoles)
    if (seeded.length === 0) {
      await sql.begin(async (tx) => {
        for (const roleId of seedRoles) {
          for (const permission of ['review', 'manage'] as const) {
            await tx`INSERT INTO role_bindings (role_id, permission, note, created_by)
                     VALUES (${roleId}, ${permission}, 'seed', 'seed') ON CONFLICT DO NOTHING`
          }
        }
        await tx`INSERT INTO audit_log (action, target_type, detail)
                 VALUES ('role_bindings.seed', 'role_bindings', ${JSON.stringify({ roleIds: seedRoles, permissions: ['review', 'manage'] })}::jsonb)`
        await tx`INSERT INTO settings (key, value, updated_by) VALUES ('role_bindings_seeded', 'true'::jsonb, 'seed')`
      })
    }
    console.log(`[migrate] ok (seed roles: ${seeded.length === 0 ? seedRoles.length : 'already seeded'})`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}
