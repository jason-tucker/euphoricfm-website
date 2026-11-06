import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// UI component + route tests (jsdom, no database, no stack). Separate from
// vitest.config.ts, whose global setup generates ffmpeg fixtures for the
// Docker harness. Run: pnpm test:ui
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    include: ['test/ui/**/*.test.{ts,tsx}'],
    setupFiles: ['test/ui/setup.ts'],
  },
})
