// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const site = process.env.PUBLIC_BASE_URL || 'https://info.euphoric.fm';

export default defineConfig({
  site,
  build: { inlineStylesheets: 'auto' },
  server: { host: '0.0.0.0', port: 3000 },
  vite: {
    plugins: [tailwindcss()],
    server: { allowedHosts: true },
  },
});
