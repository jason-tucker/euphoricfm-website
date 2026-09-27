// Environment loading for every music service. Each service has its own
// env_file (compose) and its own schema here; a service refuses to start when
// it sees another service's secret in its env, so a copy-paste mistake in an
// env_file cannot silently widen what a container holds (plan §3 "Secrets").
//
// All loaders are lazy: `next build` imports route modules, and nothing here
// may run (or throw) at build time.

import { z } from 'zod'

const SNOWFLAKE = /^\d{17,20}$/

// Endpoints that default to the real third-party hosts. Tests point them at
// the mocks, which requires ALLOW_TEST_ENDPOINTS=1; production env files never
// set it, so a stray override to a non-HTTPS host fails closed.
function endpoint(defaultUrl: string) {
  return z
    .string()
    .url()
    .default(defaultUrl)
    .transform((v) => v.replace(/\/+$/, ''))
}

function assertHttps(name: string, value: string, allowTest: boolean) {
  const u = new URL(value)
  if (u.protocol !== 'https:' && !allowTest) {
    throw new Error(`${name} must be https (set ALLOW_TEST_ENDPOINTS=1 only in test stacks)`)
  }
}

const csvSnowflakes = z
  .string()
  .default('')
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
  .refine((ids) => ids.every((id) => SNOWFLAKE.test(id)), 'must be comma-separated Discord ids')

const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true')

function refuseForeignSecrets(service: string, env: Record<string, string | undefined>, forbidden: readonly string[]) {
  const present = forbidden.filter((k) => env[k] !== undefined && env[k] !== '')
  if (present.length > 0) {
    throw new Error(`${service} refuses to start: env holds another service's secret(s): ${present.join(', ')}`)
  }
}

// ---------------------------------------------------------------- web -----

const webSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  AUTH_SECRET: z.string().min(32),
  AUTH_DISCORD_ID: z.string().min(1),
  AUTH_DISCORD_SECRET: z.string().min(1),
  APP_ENC_KEY: z.string().min(43),
  PORTAL_ORIGIN: z
    .string()
    .url()
    .default('https://music.euphoric.fm')
    .transform((v) => new URL(v).origin),
  DISCORD_GUILD_ID: z.string().regex(SNOWFLAKE).default('915830850694815765'),
  PORTAL_OWNER_IDS: csvSnowflakes,
  DISCORD_API_BASE: endpoint('https://discord.com/api/v10'),
  DISCORD_AUTHORIZE_URL: endpoint('https://discord.com/oauth2/authorize'),
  DISCORD_TOKEN_URL: endpoint('https://discord.com/api/oauth2/token'),
  TICKETS_API_BASE: endpoint('http://tickets-web:3000'),
  TICKETS_GUILD_READ_KEY: z.string().default(''),
  TICKETS_WEBHOOK_SECRET: z.string().min(32),
  STAGING_UPLOADS_DIR: z.string().default('/staging/uploads'),
  SPOOL_PROBE_IN_DIR: z.string().default('/spool/probe/in-web'),
  SPOOL_PROBE_OUT_DIR: z.string().default('/spool/probe/out'),
  ALLOW_TEST_ENDPOINTS: boolFlag,
})

export type WebEnv = z.infer<typeof webSchema>

// Keys that only the worker, the migrator or the DB may hold.
export const WEB_FORBIDDEN_KEYS = [
  'AZURACAST_API_KEY',
  'TICKETS_WRITE_KEY',
  'DATABASE_OWNER_URL',
  'POSTGRES_PASSWORD',
  'MUSIC_APP_DB_PASSWORD',
] as const

let webCache: WebEnv | null = null

export function loadWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  refuseForeignSecrets('music-web', env, WEB_FORBIDDEN_KEYS)
  const parsed = webSchema.parse(env)
  assertHttps('DISCORD_API_BASE', parsed.DISCORD_API_BASE, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('DISCORD_AUTHORIZE_URL', parsed.DISCORD_AUTHORIZE_URL, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('DISCORD_TOKEN_URL', parsed.DISCORD_TOKEN_URL, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('PORTAL_ORIGIN', parsed.PORTAL_ORIGIN, parsed.ALLOW_TEST_ENDPOINTS)
  if (env.AUTH_URL && new URL(env.AUTH_URL).origin !== parsed.PORTAL_ORIGIN) {
    throw new Error('AUTH_URL must have the same origin as PORTAL_ORIGIN')
  }
  return parsed
}

export function webEnv(): WebEnv {
  if (!webCache) webCache = loadWebEnv()
  return webCache
}

// ------------------------------------------------------------- worker -----

const workerSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  // Profile guard inputs (plan §3.7 + the 2026-09-27 amendments). Validated
  // separately in src/server/azuracast/guard.ts so the refusal reasons are
  // explicit; kept as raw strings here.
  MUSIC_PROFILE: z.string().optional(),
  STATION_ID: z.string().optional(),
  PORTAL_TEST_PREFIX: z.string().optional(),
  AZURACAST_BASE_URL: endpoint('https://euphoric.fm'),
  AZURACAST_API_KEY: z.string().min(16),
  // The station the portal key must NOT reach (startup self-check expects 403).
  AZURACAST_CANARY_STATION_ID: z.string().regex(/^\d+$/).default('7'),
  // Further stations the key must not reach (comma-separated), e.g. Events.
  AZURACAST_EXTRA_CANARY_STATION_IDS: z.string().regex(/^(\d+(,\d+)*)?$/).default('14'),
  TICKETS_API_BASE: endpoint('http://tickets-web:3000'),
  TICKETS_WRITE_KEY: z.string().min(1),
  PORTAL_ORIGIN: z
    .string()
    .url()
    .default('https://music.euphoric.fm')
    .transform((v) => new URL(v).origin),
  KUMA_PUSH_URL: z.string().url().optional(),
  ALERT_DISCORD_WEBHOOK: z.string().url().optional(),
  SPOOL_PROBE_IN_DIR: z.string().default('/spool/probe/in-worker'),
  SPOOL_PROBE_OUT_DIR: z.string().default('/spool/probe/out'),
  STAGING_FINAL_DIR: z.string().default('/staging/final'),
  ALLOW_TEST_ENDPOINTS: boolFlag,
})

export type WorkerEnv = z.infer<typeof workerSchema>

export const WORKER_FORBIDDEN_KEYS = [
  'AUTH_SECRET',
  'AUTH_DISCORD_SECRET',
  'APP_ENC_KEY',
  'TICKETS_GUILD_READ_KEY',
  'TICKETS_WEBHOOK_SECRET',
  'DATABASE_OWNER_URL',
  'POSTGRES_PASSWORD',
  'MUSIC_APP_DB_PASSWORD',
] as const

export function loadWorkerEnv(env: Record<string, string | undefined> = process.env): WorkerEnv {
  refuseForeignSecrets('music-worker', env, WORKER_FORBIDDEN_KEYS)
  const parsed = workerSchema.parse(env)
  assertHttps('AZURACAST_BASE_URL', parsed.AZURACAST_BASE_URL, parsed.ALLOW_TEST_ENDPOINTS)
  // The wrapper validates a path and appends it to this base: the base must
  // be a bare origin (no path, query or fragment) so the two cannot differ.
  const base = new URL(parsed.AZURACAST_BASE_URL)
  if (base.pathname !== '/' || base.search !== '' || base.hash !== '' || base.username || base.password) {
    throw new Error('AZURACAST_BASE_URL must be a bare origin (no path, query, fragment or credentials)')
  }
  parsed.AZURACAST_BASE_URL = base.origin
  return parsed
}

// -------------------------------------------------------------- probe -----

// The probe gets NO env_file. Anything that smells like a credential in its
// environment means the compose file was edited wrongly: refuse to start.
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|DATABASE|AUTH|COOKIE|WEBHOOK)/i

export function assertProbeEnvClean(env: Record<string, string | undefined> = process.env): void {
  const bad = Object.keys(env).filter((k) => SECRETISH.test(k))
  if (bad.length > 0) {
    throw new Error(`music-probe refuses to start: unexpected secret-like env keys: ${bad.join(', ')}`)
  }
}

export const SNOWFLAKE_RE = SNOWFLAKE
