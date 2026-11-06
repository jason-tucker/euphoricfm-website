// Bundles the non-Next entry points (worker, events worker, probe,
// music-metadata child, migrator) into single ESM files under dist/. Next
// builds the web app. The worker stage ships dist/worker/*.mjs, so the events
// worker lands at /app/events-worker.mjs.
import { build } from 'esbuild'

const banner = {
  js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
}

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  banner,
  alias: { '@': './src' },
  logLevel: 'info',
}

await build({ ...common, entryPoints: { worker: 'src/worker/cli.ts', migrate: 'src/migrate/cli.ts', 'legacy-import': 'src/worker/legacy-cli.ts', 'events-worker': 'src/events/worker/cli.ts' }, outdir: 'dist/worker', outExtension: { '.js': '.mjs' } })
await build({ ...common, entryPoints: { probe: 'src/probe/cli.ts', 'mm-child': 'src/probe/mm-child.ts' }, outdir: 'dist/probe', outExtension: { '.js': '.mjs' } })
