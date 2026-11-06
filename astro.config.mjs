// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.PUBLIC_BASE_URL || 'https://info.euphoric.fm';

// Keep the client JS syntax floor at ES2020 like the Astro 6 build. Vite 8's Oxc minifier emits
// ES2021+ (e.g. `??=`) at Astro 7's client target, 'esnext', which older CEF can't parse. Astro
// hard-codes that client target and ignores vite.build.target, so it has to be set per environment.
// cssTarget stays 'esnext' (the value it already resolved to) so the CSS output is unchanged.
const clientEs2020 = {
  name: 'efm-client-es2020',
  /** @param {string} name */
  configEnvironment(name) {
    if (name === 'client') return { build: { target: 'es2020', cssTarget: 'esnext' } };
  },
};

export default defineConfig({
  site,
  // Keep v6 whitespace semantics: Astro 7's default 'jsx' drops spaces between inline elements.
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  server: { host: '0.0.0.0', port: 3000 },
  vite: {
    plugins: [tailwindcss(), clientEs2020],
    // Keep v6's esbuild CSS minifier: Vite 8's default (lightningcss) drops -webkit- prefixes and
    // rewrites min-width queries to range syntax (Chromium 104+ / Safari 16.4+), changing output
    // for the outdated in-game CEF and older Safari.
    build: { cssMinify: 'esbuild' },
    server: { allowedHosts: true },
  },
});
