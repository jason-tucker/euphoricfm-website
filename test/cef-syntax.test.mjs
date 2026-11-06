// Build-output regression guard for Astro's client environment target.
// Run through pnpm test:site after pnpm build (also runs in PR CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parse } from 'acorn';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

test('built client modules and inline scripts parse at the ES2020 CEF syntax floor', () => {
  const output = files(dist);
  const modules = output.filter(path => path.endsWith('.js'));
  assert.ok(modules.length > 0, 'build must emit client JavaScript');
  for (const path of modules) {
    assert.doesNotThrow(() => parse(readFileSync(path, 'utf8'), {
      ecmaVersion: 2020, sourceType: 'module',
    }), path);
  }
  let scripts = 0;
  for (const path of output.filter(path => path.endsWith('.html'))) {
    for (const [, attrs, code] of readFileSync(path, 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (/\bsrc\s*=/i.test(attrs) || !code.trim()) continue;
      const type = attrs.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
      if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
      scripts++;
      assert.doesNotThrow(() => parse(code, {
        ecmaVersion: 2020, sourceType: type === 'module' ? 'module' : 'script',
      }), `${path}: inline script ${scripts}`);
    }
  }
  assert.ok(scripts > 0, 'build must include the inline scripts under test');
});
