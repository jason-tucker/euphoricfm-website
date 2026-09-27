import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Runs inside the `test` image (test/run.sh). Suites that need Postgres, the
// mocks or the running containers skip when their env is absent, EXCEPT under
// REQUIRE_ALL=1 (the harness), where a missing dependency fails the suite.
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/setup/global.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
