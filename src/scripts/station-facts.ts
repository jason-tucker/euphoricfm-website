// About section: live station facts (#about-facts) from the stats sidecar's
// summary — on air since, all-time listens, tracks/artists, requests played
// and the all-time listener peak. A fact with no data is hidden rather than
// shown as zero; the static "24/7" fact always stays. Every value reaches the
// DOM through textContent.

import { site } from '../site.config';
import { loadSummary } from './stats-summary';

const root = document.getElementById('about-facts');

if (root) {
  const f = site.home.about.facts;
  const fact = (key: string) => root.querySelector<HTMLElement>(`[data-fact="${key}"]`);
  const set = (key: string, value: string | null, sub?: string) => {
    const el = fact(key);
    if (!el) return;
    if (!value) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const v = el.querySelector('[data-v]');
    const s = el.querySelector('[data-s]');
    if (v) v.textContent = value;
    if (s && sub !== undefined) s.textContent = sub;
  };

  const compact = (n: number): string => {
    if (n < 1000) return new Intl.NumberFormat('en-US').format(n);
    const [div, unit] = n >= 1e6 ? [1e6, 'M'] : [1e3, 'K'];
    const x = n / div;
    return (x < 100 ? x.toFixed(1).replace(/\.0$/, '') : String(Math.round(x))) + unit;
  };

  const run = async () => {
    const sum = await loadSummary();
    const t = sum?.totals;
    const tz = sum?.meta.timezone || 'America/New_York';
    const month = (sec: number | null | undefined) =>
      sec ? new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', year: 'numeric' }).format(new Date(sec * 1000)) : null;
    const pos = (n: number | undefined) => (typeof n === 'number' && n > 0 ? n : 0);

    set('since', month(t?.firstPlayAt ?? sum?.meta.coverage.from));
    set('listens', pos(t?.plays) ? compact(t!.plays) : null);
    set(
      'tracks',
      pos(t?.uniqueTracks) ? compact(t!.uniqueTracks) : null,
      pos(t?.uniqueArtists) ? f.tracks.replace('{artists}', compact(t!.uniqueArtists)) : f.tracksPlain,
    );
    set('requests', pos(t?.requests) ? compact(t!.requests) : null);
    const peak = t?.peakListeners;
    set('peak', peak && pos(peak.value) ? String(peak.value) : null, peak?.at ? f.peak.replace('{date}', month(peak.at) ?? '') : f.peakPlain);
    const src = root.querySelector<HTMLElement>('[data-facts-source]');
    if (src) src.hidden = !sum;
  };

  const start = () => window.setTimeout(() => void run(), 300);
  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}
