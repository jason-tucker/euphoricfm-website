import { describe, expect, it } from 'vitest'
import { DBENV } from './helpers/env'
import { appSql, ownerSql } from './helpers/db'

describe.skipIf(!DBENV())('music-db: least privilege + append-only audit_log', () => {
  it('the runtime role is not a superuser and owns nothing', async () => {
    const [r] = await appSql()`SELECT rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user`
    expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false })
    const owned = await ownerSql()`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'music_app'`
    expect(owned).toHaveLength(0)
  })

  it('music_app can INSERT and SELECT audit rows but never UPDATE / DELETE / TRUNCATE / disable the trigger', async () => {
    const [row] = await appSql()`INSERT INTO audit_log (action) VALUES ('test.append') RETURNING id`
    expect(Number(row!.id)).toBeGreaterThan(0)
    await expect(appSql()`UPDATE audit_log SET action = 'x' WHERE id = ${row!.id}`).rejects.toThrow(/permission denied|append-only/)
    await expect(appSql()`DELETE FROM audit_log WHERE id = ${row!.id}`).rejects.toThrow(/permission denied|append-only/)
    await expect(appSql()`TRUNCATE audit_log`).rejects.toThrow(/permission denied|append-only/)
    await expect(appSql().unsafe('ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update_delete')).rejects.toThrow(/owner|permission/)
  })

  it('even the owner is stopped by the trigger', async () => {
    const [row] = await ownerSql()`INSERT INTO audit_log (action) VALUES ('test.owner') RETURNING id`
    await expect(ownerSql()`UPDATE audit_log SET action = 'x' WHERE id = ${row!.id}`).rejects.toThrow(/append-only/)
    await expect(ownerSql()`DELETE FROM audit_log WHERE id = ${row!.id}`).rejects.toThrow(/append-only/)
    await expect(ownerSql()`TRUNCATE audit_log`).rejects.toThrow(/append-only/)
  })

  it('reviewer roles were seeded once with review + manage; settings defaults exist', async () => {
    const rb = await ownerSql()`SELECT role_id, permission FROM role_bindings WHERE note = 'seed' ORDER BY role_id, permission`
    expect(new Set(rb.map((r) => `${r.role_id}:${r.permission}`))).toEqual(
      new Set(['1144462744456794153', '917525862696489001', '1145243342620327947'].flatMap((id) => [`${id}:review`, `${id}:manage`])),
    )
    expect(rb).toHaveLength(6)
    const s = Object.fromEntries((await ownerSql()`SELECT key, value FROM settings`).map((r) => [r.key, r.value]))
    expect(s.assignable_playlist_ids).toEqual([2])
    expect(s.default_playlist_ids).toEqual([2])
    expect(s.auto_close_days).toBe(7)
    expect(s.role_bindings_seeded).toBe(true)
    expect(s).not.toHaveProperty('station_id')
  })

  it('a staff comment cannot be stored as ticket-sourced or as forwarded', async () => {
    const [u] = await ownerSql()`INSERT INTO "user" (id, discord_id) VALUES (gen_random_uuid()::text, ${'9' + String(Date.now()).padStart(17, '0')}) RETURNING id`
    const [b] = await ownerSql()`INSERT INTO batches (owner_user_id) VALUES (${u!.id}) RETURNING id`
    await expect(appSql()`INSERT INTO comments (batch_id, source, visibility, body) VALUES (${b!.id}, 'ticket', 'staff', 'x')`).rejects.toThrow(/comments_staff_local/)
    await expect(appSql()`INSERT INTO comments (batch_id, source, visibility, body, ticket_message_id) VALUES (${b!.id}, 'portal', 'staff', 'x', 'm1')`).rejects.toThrow(/comments_staff_local/)
  })
})
