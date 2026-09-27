// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.PUBLIC_BASE_URL || 'https://info.euphoric.fm';

export default defineConfig({
  site,
  // Keep v6 whitespace semantics: Astro 7's default 'jsx' drops spaces between inline elements.
  compressHTML: true,
  build: { inlineStylesheets: 'auto' },
  server: { host: '0.0.0.0', port: 3000 },
  vite: {
    plugins: [tailwindcss()],
    // Keep v6's esbuild CSS minifier: Vite 8's default (lightningcss) drops -webkit- prefixes and
    // rewrites min-width queries to range syntax (Chromium 104+ / Safari 16.4+), changing output
    // for the outdated in-game CEF and older Safari.
    build: { cssMinify: 'esbuild' },
    server: { allowedHosts: true },
  },
});
