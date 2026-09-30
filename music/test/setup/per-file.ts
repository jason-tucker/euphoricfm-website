// Runs before every test file of the harness config (vitest.config.ts
// setupFiles). Under REQUIRE_ALL, with the stack's env present:
//   - settings rows in RESET_SETTING_KEYS go back to the global-setup
//     baseline (EFM_SETTINGS_BASELINE; absent there = no row);
//   - the mocks' request histories (AzuraCast / tickets / Discord calls,
//     canary hits) are cleared. Mock STATE (users, members, library files,
//     tickets) is kept: the running worker and web still depend on it.
// Nothing happens outside the harness (unit runs, the jsdom config).
import postgres from 'postgres'
import { RESET_SETTING_KEYS } from './baseline'

if (process.env.REQUIRE_ALL === '1' && process.env.TEST_OWNER_DATABASE_URL && process.env.EFM_SETTINGS_BASELINE) {
  const baseline = JSON.parse(process.env.EFM_SETTINGS_BASELINE) as Record<string, unknown>
  const sql = postgres(process.env.TEST_OWNER_DATABASE_URL, { max: 1, onnotice: () => {} })
  try {
    for (const key of RESET_SETTING_KEYS) {
      if (key in baseline) {
        await sql`INSERT INTO settings (key, value, updated_by) VALUES (${key}, ${sql.json(baseline[key] as never)}, 'test-setup')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
      } else {
        await sql`DELETE FROM settings WHERE key = ${key}`
      }
    }
  } finally {
    await sql.end()
  }
}

if (process.env.REQUIRE_ALL === '1' && process.env.MOCKS_CONTROL) {
  const r = await fetch(`${process.env.MOCKS_CONTROL}/__mock/reset-history`, { method: 'POST', headers: { connection: 'close' } })
  if (!r.ok) throw new Error(`mock history reset: ${r.status}`)
}
