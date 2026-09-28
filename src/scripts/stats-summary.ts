// One shared fetch of the stats sidecar's /stats/summary (same-origin, Caddy
// proxies it to efm-requests). The About section's station facts
// (station-facts.ts) and the Stats section (stats.ts, loaded lazily) both
// read it, so the ~26 KB payload is fetched once per page view.
//
// Resolves to null when the sidecar is unreachable or has recorded nothing
// yet (fresh store) — callers degrade gracefully.

import type { StatsSummary } from '../lib/stats';

let pending: Promise<StatsSummary | null> | null = null;

export const loadSummary = (): Promise<StatsSummary | null> =>
  (pending ??= fetch('/stats/summary')
    .then((r) => (r.ok ? (r.json() as Promise<StatsSummary>) : null))
    .then((d) => (d && d.ok && d.totals && (d.totals.plays > 0 || d.totals.songs > 0) ? d : null))
    .catch((err) => {
      console.warn('[efm] /stats/summary fetch failed', err);
      return null;
    }));
