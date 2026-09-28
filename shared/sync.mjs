// Copy the shared top-bar files into the portal. The portal's Docker build
// context is music/ only, so it cannot read shared/ at build time; it keeps a
// byte-for-byte copy under music/src/shared/. Run after editing anything here:
//
//   node shared/sync.mjs
//
// test/shared-drift.test.mjs (pnpm test:site, run in CI) fails when a copy
// differs from its canonical file.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_FILES = ['nav.json', 'efm-bar.css'];

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'music', 'src', 'shared');

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(dest, { recursive: true });
  for (const f of SHARED_FILES) {
    copyFileSync(join(here, f), join(dest, f));
    console.log(`shared/${f} -> music/src/shared/${f}`);
  }
}
