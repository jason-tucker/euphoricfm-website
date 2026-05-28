// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

const site = process.env.PUBLIC_BASE_URL || 'https://info.euphoric.fm';

export default defineConfig({
  site,
  integrations: [tailwind({ applyBaseStyles: false })],
  build: { inlineStylesheets: 'auto' },
  server: { host: '0.0.0.0', port: 3000 },
  vite: { server: { allowedHosts: true } },
});
