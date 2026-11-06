Shared React components for the portal UI (added by the UI pass).

`SiteBar.tsx` is the shared EuphoricFM top bar (the same as info.euphoric.fm's
`src/components/Header.astro`), rendered from `src/shared/nav.json` with
`src/shared/efm-bar.css`. Both are byte-for-byte copies of the repo's
`shared/` files: edit those and run `node shared/sync.mjs` from the repo root.
`Header.tsx` = SiteBar + the portal's second row (tabs by permission + account).
Server-only helpers live in `src/server/*`; import them only from server
components, route handlers and server actions.
