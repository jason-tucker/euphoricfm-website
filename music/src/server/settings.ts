import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DB } from './db/client'
import { settings } from './db/schema'
import { DEFAULT_CAPS, DEFAULT_SETTINGS, type Caps } from './settings-defaults'

const intList = z.array(z.number().int().positive()).max(64)

export async function getSetting(db: DB, key: string): Promise<unknown> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) })
  return row ? row.value : DEFAULT_SETTINGS[key]
}

export async function getIntList(db: DB, key: string): Promise<number[]> {
  const r = intList.safeParse(await getSetting(db, key))
  return r.success ? r.data : []
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
  })
  .partial()

// Admin-editable quota caps (settings.caps) over DEFAULT_CAPS. The hard
// per-file limits (maxUploadBytes, chunkBytes) are NOT editable: tus maxSize,
// the header checks and the probe all enforce the defaults. maxWavUploadBytes
// (v0.3.0) may be LOWERED: the tus admission and the probe request carry the
// loaded value, and the compiled 250 MB stays the ceiling everywhere. An
// invalid value falls back to the default for that field.
export async function loadCaps(db: DB): Promise<Caps> {
  const raw = await getSetting(db, 'caps')
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
