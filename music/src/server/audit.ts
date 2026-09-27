// Append-only audit trail. Writers pass the transaction they are in, so the
// audit row commits or rolls back with the change it describes.

import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { auditLog } from './db/schema'

type Writer = Pick<PgDatabase<PgQueryResultHKT, Record<string, never>>, 'insert'>

export type AuditEntry = {
  actorUserId?: string | null
  actorDiscordId?: string | null
  action: string
  targetType?: string | null
  targetId?: string | number | null
  detail?: Record<string, unknown> | null
  ip?: string | null
}

export async function audit(db: Writer, e: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: e.actorUserId ?? null,
    actorDiscordId: e.actorDiscordId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId === undefined || e.targetId === null ? null : String(e.targetId),
    detail: e.detail ?? null,
    ip: e.ip ?? null,
  })
}
