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
    // Already run by the jsdom config (pnpm test:ui, the CI 'UI tests' step)
    // and nothing in them differs under the harness. The other test/ui/*.ts
    // files stay: portal-routing checks the REAL next/navigation digests here.
    exclude: ['test/ui/pure.test.ts', 'test/ui/routes.test.ts', '**/node_modules/**'],
    globalSetup: ['test/setup/global.ts'],
    // Resets the shared settings rows + mock histories before each file.
    setupFiles: ['test/setup/per-file.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})
