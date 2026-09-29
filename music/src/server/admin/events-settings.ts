// v0.5.0: the events_* settings (contract "Settings"). Kept apart from the
// music admin form (admin/settings.ts SETTING_SCHEMAS is admin-only and PUTs
// one whole key at a time): these are edited by `manage` through
// GET/PUT /api/ev/admin/settings. Rows live in the shared `settings` table;
// a missing or invalid row means the code default (resolveEventsSettings).
// Every change is audited with its before/after, like the music settings.

import { inArray } from 'drizzle-orm'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { settings } from '../db/schema'
import { badRequest, forbidden } from '../http/errors'
import {
  EVENTS_SETTING_KEYS,
  EventsSettingsPatchSchema,
  resolveEventsSettings,
  type EventsSettings,
} from '../../events/contract/settings'

type Reader = Pick<DB, 'select'>

export async function loadEventsSettings(db: Reader): Promise<EventsSettings> {
  const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(inArray(settings.key, EVENTS_SETTING_KEYS))
  return resolveEventsSettings(rows)
}

export function requireManage(v: Viewer) {
  if (!v.perms.has('manage')) throw forbidden()
}

/** GET /api/ev/admin/settings (manage). */
export async function getEventsSettings(db: DB, v: Viewer): Promise<EventsSettings> {
  requireManage(v)
  return loadEventsSettings(db)
}

/**
 * PUT /api/ev/admin/settings (manage): a strict partial patch of events_*
 * keys. Returns the resolved settings after the write. Cross-key rule: the
 * resulting warning threshold may not be below the minimum notice.
 */
export async function putEventsSettings(db: DB, v: Viewer, input: unknown): Promise<EventsSettings> {
  requireManage(v)
  const p = EventsSettingsPatchSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_setting', { issues: p.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) })
  const patch = p.data as Partial<EventsSettings>
  return db.transaction(async (tx) => {
    const before = await loadEventsSettings(tx)
    const after = { ...before, ...patch }
    if (after.events_warn_notice_h < after.events_min_notice_h) throw badRequest('warn_below_min_notice')
    for (const [key, value] of Object.entries(patch)) {
      await tx
        .insert(settings)
        .values({ key, value: value as never, updatedBy: v.discordId })
        .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date(), updatedBy: v.discordId } })
    }
    const changed = Object.fromEntries(Object.keys(patch).map((k) => [k, { before: before[k as keyof EventsSettings], after: after[k as keyof EventsSettings] }]))
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'events.settings.update', targetType: 'setting', targetId: 'events', detail: changed })
    return resolveEventsSettings(Object.entries(after).map(([key, value]) => ({ key, value })))
  })
}
