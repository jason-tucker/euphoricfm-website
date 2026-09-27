import { eq } from 'drizzle-orm'
import { z } from 'zod'
import type { DB } from './db/client'
import { settings } from './db/schema'
import { DEFAULT_SETTINGS } from './settings-defaults'

const intList = z.array(z.number().int().positive()).max(64)

export async function getSetting(db: DB, key: string): Promise<unknown> {
  const row = await db.query.settings.findFirst({ where: eq(settings.key, key) })
  return row ? row.value : DEFAULT_SETTINGS[key]
}

export async function getIntList(db: DB, key: string): Promise<number[]> {
  const r = intList.safeParse(await getSetting(db, key))
  return r.success ? r.data : []
}
