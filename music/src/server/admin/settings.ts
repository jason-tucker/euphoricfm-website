// Admin-only runtime configuration (plan §3.1 settings, §3.3 "Admin"):
// settings edits with a zod schema per key, and role-binding edits. Every
// change is audited with its before/after. `admin` itself can never be
// granted here: it comes only from PORTAL_OWNER_IDS.

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { audit } from '../audit'
import type { Viewer } from '../authz/predicates'
import type { DB } from '../db/client'
import { roleBindings, settings } from '../db/schema'
import { badRequest, conflict, forbidden, notFound } from '../http/errors'
import { getIntList, getSetting } from '../settings'
import { DEFAULT_CAPS } from '../settings-defaults'
import { ATTEST_VERSION_RE } from '../submissions'

function requireAdmin(v: Viewer) {
  if (!v.perms.has('admin')) throw forbidden()
}

const plainText = (min: number, max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length >= min && s.length <= max, `length ${min}-${max}`)
    .refine((s) => !/[\p{Cc}]/u.test(s.replace(/[\n\t]/g, '')), 'control characters')

const playlistId = z.number().int().positive().max(2_147_483_647)
const idSet = (max: number) =>
  z
    .array(playlistId)
    .min(1)
    .max(max)
    .refine((a) => new Set(a).size === a.length, 'duplicate ids')

// Caps may be lowered, never raised past the plan's limits (35 MB uploads,
// 8 MB chunks, 1 GB/3 in flight per user, 5 GB staging, ≤6 ingests/h, ≥90 s).
const capsSchema = z
  .object({
    maxUploadBytes: z.number().int().min(1).max(DEFAULT_CAPS.maxUploadBytes),
    chunkBytes: z.number().int().min(1024 * 1024).max(DEFAULT_CAPS.chunkBytes),
    maxInflightBytesPerUser: z.number().int().min(1).max(DEFAULT_CAPS.maxInflightBytesPerUser),
    maxConcurrentUploadsPerUser: z.number().int().min(1).max(DEFAULT_CAPS.maxConcurrentUploadsPerUser),
    maxStagingBytes: z.number().int().min(1).max(DEFAULT_CAPS.maxStagingBytes),
    diskPausePercent: z.number().int().min(50).max(DEFAULT_CAPS.diskPausePercent),
    maxItemsPerBatch: z.number().int().min(1).max(50),
    ingestPerHour: z.number().int().min(1).max(DEFAULT_CAPS.ingestPerHour),
    ingestSpacingS: z.number().int().min(DEFAULT_CAPS.ingestSpacingS).max(3600),
  })
  .strict()

export const SETTING_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  assignable_playlist_ids: idSet(64),
  default_playlist_ids: idSet(16),
  // The Events station's playlist ids (P0d-B: listings mix in other
  // stations' ids on the shared storage). station_playlist_ids, which P4
  // playlist merges filter through, is derived from this by the library
  // sync and is NOT editable here.
  foreign_playlist_ids: z
    .array(playlistId)
    .max(64)
    .refine((a) => new Set(a).size === a.length, 'duplicate ids'),
  playlist_names: z
    .record(z.string().regex(/^[1-9]\d{0,9}$/), plainText(1, 100))
    .refine((r) => Object.keys(r).length <= 200, 'too many names'),
  auto_close_days: z.number().int().min(1).max(365),
  caps: capsSchema,
  // The version is echoed back by the submit call and must pass its check
  // (submissions.ts ATTEST_VERSION_RE), or every submit would be refused.
  rights_attestation: z.object({ version: z.string().regex(ATTEST_VERSION_RE), text: plainText(1, 2000) }).strict(),
  discord_invite_url: z
    .string()
    .max(200)
    .url()
    .refine((u) => /^https:\/\/(discord\.gg|discord\.com)\/[A-Za-z0-9/_-]+$/.test(u), 'discord invite link')
    .nullable(),
}

const putSchema = z.object({ key: z.string().max(64), value: z.unknown() }).strict()

export async function putSetting(db: DB, v: Viewer, input: unknown) {
  requireAdmin(v)
  const p = putSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_setting')
  const schema = SETTING_SCHEMAS[p.data.key]
  if (!schema) throw badRequest('unknown_setting')
  const r = schema.safeParse(p.data.value)
  if (!r.success) throw badRequest('invalid_setting', { issues: r.error.issues.map((i) => i.message) })
  const value = r.data
  // Cross-key rule: the defaults must stay inside the assignable set.
  if (p.data.key === 'default_playlist_ids') {
    const assignable = new Set(await getIntList(db, 'assignable_playlist_ids'))
    if ((value as number[]).some((id) => !assignable.has(id))) throw badRequest('default_not_assignable')
  }
  if (p.data.key === 'assignable_playlist_ids') {
    const set = new Set(value as number[])
    if ((await getIntList(db, 'default_playlist_ids')).some((id) => !set.has(id))) throw badRequest('default_not_assignable')
    const foreign = new Set(await getIntList(db, 'foreign_playlist_ids'))
    if ((value as number[]).some((id) => foreign.has(id))) throw badRequest('assignable_is_foreign')
  }
  if (p.data.key === 'foreign_playlist_ids') {
    // Marking an id foreign removes it from the station set at the next sync,
    // and merges then drop memberships in it. So only ids the station set
    // does not hold, or that the sync counted as station 1 only because it
    // had never seen them (unconfirmed, alerted), may be added: an admin
    // edit never shrinks the confirmed station set.
    const current = new Set(await getIntList(db, 'foreign_playlist_ids'))
    const added = (value as number[]).filter((id) => !current.has(id))
    const configured = new Set([...(await getIntList(db, 'assignable_playlist_ids')), ...(await getIntList(db, 'default_playlist_ids'))])
    if (added.some((id) => configured.has(id))) throw badRequest('foreign_is_assignable')
    const ids = (k: string) => getSetting(db, k).then((v) => (Array.isArray(v) ? v.filter((x): x is number => Number.isSafeInteger(x)) : []))
    const station = await ids('station_playlist_ids')
    const unconfirmed = new Set(await ids('unconfirmed_playlist_ids'))
    const confirmed = added.filter((id) => station.includes(id) && !unconfirmed.has(id))
    if (confirmed.length > 0) throw badRequest('foreign_is_station_playlist', { playlistIds: confirmed })
  }
  const before = await getSetting(db, p.data.key)
  return db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ key: p.data.key, value: value as never, updatedBy: v.discordId })
      .onConflictDoUpdate({ target: settings.key, set: { value: value as never, updatedAt: new Date(), updatedBy: v.discordId } })
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'settings.update', targetType: 'setting', targetId: p.data.key, detail: { before: before ?? null, after: value } })
    return { key: p.data.key, value }
  })
}

const bindingSchema = z
  .object({
    roleId: z.string().regex(/^\d{17,20}$/),
    permission: z.enum(['review', 'manage']),
    note: plainText(0, 200).optional(),
  })
  .strict()

export async function addRoleBinding(db: DB, v: Viewer, input: unknown) {
  requireAdmin(v)
  const p = bindingSchema.safeParse(input)
  if (!p.success) throw badRequest('invalid_binding', { issues: p.error.issues.map((i) => i.message) })
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(roleBindings)
      .values({ roleId: p.data.roleId, permission: p.data.permission, note: p.data.note || null, createdBy: v.discordId })
      .onConflictDoNothing()
      .returning()
    if (!row) throw conflict('binding_exists')
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'role_bindings.add', targetType: 'role_binding', targetId: row.id, detail: { roleId: row.roleId, permission: row.permission } })
    return { id: row.id, roleId: row.roleId, permission: row.permission, note: row.note }
  })
}

export async function removeRoleBinding(db: DB, v: Viewer, id: number) {
  requireAdmin(v)
  return db.transaction(async (tx) => {
    const [row] = await tx.delete(roleBindings).where(and(eq(roleBindings.id, id))).returning()
    if (!row) throw notFound()
    await audit(tx, { actorUserId: v.userId, actorDiscordId: v.discordId, action: 'role_bindings.remove', targetType: 'role_binding', targetId: row.id, detail: { roleId: row.roleId, permission: row.permission } })
    return { id: row.id, removed: true }
  })
}
