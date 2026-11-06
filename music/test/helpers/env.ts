// Which external pieces a suite needs. Under REQUIRE_ALL=1 (test/run.sh) a
// missing piece is a hard failure, so the harness can never "pass" by
// silently skipping the security suites.
export function has(...keys: string[]): boolean {
  const missing = keys.filter((k) => !process.env[k])
  if (missing.length && process.env.REQUIRE_ALL === '1') {
    throw new Error(`REQUIRE_ALL: missing env ${missing.join(', ')}`)
  }
  return missing.length === 0
}

export const E2E = () => has('E2E_WEB_URL', 'MOCKS_CONTROL', 'TEST_OWNER_DATABASE_URL', 'TEST_DATA_DIR')
export const DBENV = () => has('TEST_OWNER_DATABASE_URL', 'TEST_APP_DATABASE_URL')
export const MOCKS = () => has('MOCKS_CONTROL', 'MOCKS_DISCORD', 'MOCKS_TICKETS', 'MOCKS_AZURACAST')
