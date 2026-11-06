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

function refuseForeignSecrets(service: string, env: Record<string, string | undefined>, forbidden: readonly string[], forbiddenPrefix?: string) {
  const present = forbidden.filter((k) => env[k] !== undefined && env[k] !== '')
  if (forbiddenPrefix) {
    for (const k of Object.keys(env)) {
      if (k.startsWith(forbiddenPrefix) && env[k] !== undefined && env[k] !== '' && !present.includes(k)) present.push(k)
    }
  }
  if (present.length > 0) {
    throw new Error(`${service} refuses to start: env holds another service's secret(s): ${present.join(', ')}`)
  }
}

// ---------------------------------------------------------------- web -----

// v0.5.0: one web image serves two portals. 'music' (default) is
// music.euphoric.fm; 'events' is events.euphoric.fm (middleware site gate,
// uploads.site stamping, per-site sweepers). Anything else refuses to start.
export const PORTAL_SITES = ['music', 'events'] as const
export type PortalSite = (typeof PORTAL_SITES)[number]

/**
 * The site this process serves. Cheap (no full env parse) for middleware and
 * hot paths; an invalid value falls back to 'music' here, but loadWebEnv
 * refuses it, so a misconfigured container never gets that far.
 */
export function portalSite(env: Record<string, string | undefined> = process.env): PortalSite {
  return env.PORTAL_SITE === 'events' ? 'events' : 'music'
}

const webSchema = z.object({
  PORTAL_SITE: z.enum(PORTAL_SITES).default('music'),
  DATABASE_URL: z.string().startsWith('postgres'),
  AUTH_SECRET: z.string().min(32),
  AUTH_DISCORD_ID: z.string().min(1),
  AUTH_DISCORD_SECRET: z.string().min(1),
  // Discord's OAuth issuer, compared against the `iss` Discord has sent on its
  // authorization redirect since 2026-10 (RFC 9207). Never fetched. Auth.js
  // reads the same env name itself (AUTH_<PROVIDER>_ISSUER).
  AUTH_DISCORD_ISSUER: z.string().url().default('https://discord.com'),
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
  // Album art: raw uploads (web rw) and the probe's JPEGs (web ro).
  STAGING_ART_IN_DIR: z.string().default('/staging/art-in'),
  STAGING_ART_DIR: z.string().default('/staging/art'),
  SPOOL_PROBE_IN_DIR: z.string().default('/spool/probe/in-web'),
  SPOOL_PROBE_OUT_DIR: z.string().default('/spool/probe/out'),
  // Required: with trustHost, Auth.js would otherwise derive its base URL
  // (redirect_uri, callback checks) from request headers.
  AUTH_URL: z.string().url(),
  // Library root the portal surfaces (requests, search): '' in production,
  // the worker's PORTAL_TEST_PREFIX in the prefix profile. Same format rule.
  PORTAL_TEST_PREFIX: z
    .string()
    .default('')
    .refine((v) => v === '' || /^Portal-Test[A-Za-z0-9-]*\/$/.test(v), 'PORTAL_TEST_PREFIX invalid'),
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

// The events services' own secrets (v0.5.0). No music service may hold any
// EVENTS_* key; the events web holds neither portal's write keys.
export const EVENTS_SECRET_KEYS = ['EVENTS_AZURACAST_API_KEY', 'EVENTS_TICKETS_WRITE_KEY'] as const
export const EVENTS_KEY_PREFIX = 'EVENTS_'
export const EVENTS_WEB_FORBIDDEN_KEYS = [...WEB_FORBIDDEN_KEYS, ...EVENTS_SECRET_KEYS] as const

let webCache: WebEnv | null = null

export function loadWebEnv(env: Record<string, string | undefined> = process.env): WebEnv {
  if (env.PORTAL_SITE === 'events') refuseForeignSecrets('events-web', env, EVENTS_WEB_FORBIDDEN_KEYS)
  else refuseForeignSecrets('music-web', env, WEB_FORBIDDEN_KEYS, EVENTS_KEY_PREFIX)
  const parsed = webSchema.parse(env)
  assertHttps('DISCORD_API_BASE', parsed.DISCORD_API_BASE, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('DISCORD_AUTHORIZE_URL', parsed.DISCORD_AUTHORIZE_URL, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('DISCORD_TOKEN_URL', parsed.DISCORD_TOKEN_URL, parsed.ALLOW_TEST_ENDPOINTS)
  assertHttps('PORTAL_ORIGIN', parsed.PORTAL_ORIGIN, parsed.ALLOW_TEST_ENDPOINTS)
  if (new URL(parsed.AUTH_URL).origin !== parsed.PORTAL_ORIGIN) {
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
  // Optional Kuma push monitor for staging disk use (up < 85 %, down ≥ 85 %).
  KUMA_DISK_PUSH_URL: z.string().url().optional(),
  // Optional: a media file under PORTAL_TEST_PREFIX used for the daily
  // behavioural /files/batch contract check (no-op playlist re-apply).
  PORTAL_CONTRACT_FIXTURE: z.string().max(1024).optional(),
  SPOOL_PROBE_IN_DIR: z.string().default('/spool/probe/in-worker'),
  SPOOL_PROBE_OUT_DIR: z.string().default('/spool/probe/out'),
  STAGING_FINAL_DIR: z.string().default('/staging/final'),
  // v0.4.0: the music-fetch spool (in rw: requests + release markers; out ro).
  SPOOL_FETCH_IN_DIR: z.string().default('/spool/fetch/in'),
  SPOOL_FETCH_OUT_DIR: z.string().default('/spool/fetch/out'),
  // The probe's album-art JPEGs (read-only mount); uploadArt reads only here.
  STAGING_ART_DIR: z.string().default('/staging/art'),
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

// The wrapper validates a path and appends it to this base: the base must
// be a bare origin (no path, query or fragment) so the two cannot differ.
function bareOrigin(value: string): string {
  const base = new URL(value)
  if (base.pathname !== '/' || base.search !== '' || base.hash !== '' || base.username || base.password) {
    throw new Error('AZURACAST_BASE_URL must be a bare origin (no path, query, fragment or credentials)')
  }
  return base.origin
}

export function loadWorkerEnv(env: Record<string, string | undefined> = process.env): WorkerEnv {
  refuseForeignSecrets('music-worker', env, WORKER_FORBIDDEN_KEYS, EVENTS_KEY_PREFIX)
  const parsed = workerSchema.parse(env)
  assertHttps('AZURACAST_BASE_URL', parsed.AZURACAST_BASE_URL, parsed.ALLOW_TEST_ENDPOINTS)
  parsed.AZURACAST_BASE_URL = bareOrigin(parsed.AZURACAST_BASE_URL)
  return parsed
}

// ------------------------------------------------------ events worker -----
// v0.5.0 (events-worker.mjs): the Events station's own AzuraCast key and the
// efm-events tickets integration key; claims only event_jobs. It must never
// hold the music portal's keys, and it only ever drives station 14.

const eventsWorkerSchema = z.object({
  DATABASE_URL: z.string().startsWith('postgres'),
  EVENTS_AZURACAST_API_KEY: z.string().min(16),
  EVENTS_STATION_ID: z.literal('14', { message: 'EVENTS_STATION_ID must be 14' }),
  AZURACAST_BASE_URL: endpoint('https://euphoric.fm'),
  EVENTS_TICKETS_WRITE_KEY: z.string().min(1),
  TICKETS_API_BASE: endpoint('http://tickets-web:3000'),
  PORTAL_ORIGIN: z
    .string()
    .url()
    .default('https://events.euphoric.fm')
    .transform((v) => new URL(v).origin),
  // Stations the events key must NOT reach (startup self-check expects 403).
  // Default 7 only: since 2026-09-29 the events worker uses the SAME
  // AzuraCast account as the music portal (music-portal@euphoric.fm, role 9,
  // which manages stations 1 and 14), so station 1 answers 200 and cannot be
  // a canary. Key isolation is code-level (the events wrapper only ever
  // drives station 14); station 7 still proves the key is not a superadmin.
  EVENTS_CANARY_STATION_IDS: z
    .string()
    .default('7')
    .refine((v) => /^\d+(,\d+)*$/.test(v), 'must be comma-separated station ids')
    .transform((v) => v.split(',').map(Number))
    .refine((ids) => ids.length > 0 && !ids.includes(14), 'must not include the Events station (14)'),
  // Optional, like the music worker's: alerts (start-kick failures, dead
  // jobs, self-check failures) are also posted to this Discord webhook.
  ALERT_DISCORD_WEBHOOK: z.string().url().optional(),
  SPOOL_PROBE_IN_DIR: z.string().default('/spool/probe/in-worker'),
  SPOOL_PROBE_OUT_DIR: z.string().default('/spool/probe/out'),
  STAGING_FINAL_DIR: z.string().default('/staging/final'),
  ALLOW_TEST_ENDPOINTS: boolFlag,
})

export type EventsWorkerEnv = z.infer<typeof eventsWorkerSchema>

export const EVENTS_WORKER_FORBIDDEN_KEYS = [...WORKER_FORBIDDEN_KEYS, 'AZURACAST_API_KEY', 'TICKETS_WRITE_KEY'] as const

export function loadEventsWorkerEnv(env: Record<string, string | undefined> = process.env): EventsWorkerEnv {
  refuseForeignSecrets('events-worker', env, EVENTS_WORKER_FORBIDDEN_KEYS)
  const parsed = eventsWorkerSchema.parse(env)
  assertHttps('AZURACAST_BASE_URL', parsed.AZURACAST_BASE_URL, parsed.ALLOW_TEST_ENDPOINTS)
  parsed.AZURACAST_BASE_URL = bareOrigin(parsed.AZURACAST_BASE_URL)
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
