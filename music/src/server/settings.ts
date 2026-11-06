import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { DB } from './db/client'
import { settings } from './db/schema'
import { DEFAULT_CAPS, DEFAULT_SETTINGS, type Caps } from './settings-defaults'

const intList = z.array(z.number().int().positive()).max(64)

export async function getSetting(db: DB, key: string): Promise<unknown> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) })
  return row ? row.value : DEFAULT_SETTINGS[key]
}

// v0.4.1: several keys in ONE query (a page used to issue one SELECT per
// key: 12 for an anonymous GET /). Missing keys get DEFAULT_SETTINGS.
export async function getSettings<K extends string>(db: DB, keys: readonly K[]): Promise<Record<K, unknown>> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, [...keys]))
  const found = new Map(rows.map((r) => [r.key, r.value]))
  return Object.fromEntries(keys.map((k) => [k, found.has(k) ? found.get(k) : DEFAULT_SETTINGS[k]])) as Record<K, unknown>
}

export function intListOf(v: unknown): number[] {
  const r = intList.safeParse(v)
  return r.success ? r.data : []
}

export async function getIntList(db: DB, key: string): Promise<number[]> {
  return intListOf(await getSetting(db, key))
}

const capsOverride = z
  .object({
    maxInflightBytesPerUser: z.number().int().positive(),
    maxConcurrentUploadsPerUser: z.number().int().positive(),
    maxStagingBytes: z.number().int().positive(),
    diskPausePercent: z.number().int().min(1).max(99),
    maxItemsPerBatch: z.number().int().positive(),
    ingestPerHour: z.number().int().positive(),
    ingestSpacingS: z.number().int().positive(),
    artUploadsPerUserPerDay: z.number().int().positive(),
    artBytesPerUserPerDay: z.number().int().positive(),
    maxArtBytes: z.number().int().positive(),
    maxWavUploadBytes: z.number().int().positive().max(DEFAULT_CAPS.maxWavUploadBytes),
    maxMp3UploadBytes: z.number().int().positive().max(DEFAULT_CAPS.maxMp3UploadBytes),
    fetchesPerUserPerDay: z.number().int().positive().max(DEFAULT_CAPS.fetchesPerUserPerDay),
  })
  .partial()

// Admin-editable quota caps (settings.caps) over DEFAULT_CAPS. The hard
// per-file limits (maxUploadBytes = the final-file cap, chunkBytes) are NOT
// editable: finalize, the tus PATCH cap and the probe all enforce the
// defaults, and a stored value is ignored here AND in the UI (ui/settings.ts
// reads caps through this function). maxWavUploadBytes (v0.3.0) and
// maxMp3UploadBytes (v0.3.5) may be LOWERED: the tus admission and the probe
// request carry the loaded value, and the compiled 250 MB / 100 MB stay the
// ceiling everywhere. An invalid value falls back to the default for that
// field.
export async function loadCaps(db: DB): Promise<Caps> {
  return capsOf(await getSetting(db, 'caps'))
}

// loadCaps on an already-read settings value.
export function capsOf(raw: unknown): Caps {
  const out: Record<string, number> = { ...DEFAULT_CAPS }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k === 'maxUploadBytes' || k === 'chunkBytes') continue
      const r = capsOverride.shape[k as keyof typeof capsOverride.shape]?.safeParse(v)
      if (r?.success && r.data !== undefined) out[k] = r.data
    }
  }
  return out as unknown as Caps
}

// v0.4.0: the SoundCloud kill switch. Only a stored `false` turns it off; a
// missing or malformed value means the default (on).
export async function soundcloudEnabled(db: DB): Promise<boolean> {
  return soundcloudEnabledOf(await getSetting(db, 'soundcloud_fetch_enabled'))
}

export const soundcloudEnabledOf = (v: unknown): boolean => v !== false
