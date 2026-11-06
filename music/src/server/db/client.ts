import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

export type DB = PostgresJsDatabase<typeof schema>

// Small pools: music-db runs with max_connections=20 on a 2 GB host
// (plan changelog, P2 memory budget). web uses 5, worker 3, migrate 1.
const g = globalThis as unknown as { __efmMusicDb?: { db: DB; sql: postgres.Sql } }

export function getDb(url = process.env.DATABASE_URL, max = Number(process.env.DB_POOL_MAX ?? 5)): DB {
  if (!g.__efmMusicDb) {
    if (!url) throw new Error('DATABASE_URL is not set')
    const sql = postgres(url, { max, idle_timeout: 60, connect_timeout: 10, prepare: true })
    g.__efmMusicDb = { sql, db: drizzle(sql, { schema }) }
  }
  return g.__efmMusicDb.db
}

export function getSql(): postgres.Sql {
  getDb()
  return g.__efmMusicDb!.sql
}

export async function closeDb(): Promise<void> {
  if (g.__efmMusicDb) {
    await g.__efmMusicDb.sql.end({ timeout: 5 })
    g.__efmMusicDb = undefined
  }
}

export { schema }
