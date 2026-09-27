import { sql } from 'drizzle-orm'
import { getDb } from '@/server/db/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await getDb().execute(sql`select 1`)
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } })
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
