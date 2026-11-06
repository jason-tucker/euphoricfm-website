// Pure, DOM-free helpers shared by the now-playing scripts and the Web Player
// (/player/). Kept free of runtime imports and non-erasable TypeScript so the
// node:test suite in test/ can import this file directly (Node strips types).

import type { AzuraMount, AzuraNowPlayingEntry } from './azuracast';

export const fmtTime = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

// Broadcast elapsed — like fmtTime but grows an hours segment past 1h, since
// live sets routinely run longer than any single track.
export const fmtElapsed = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const ss = Math.floor(sec % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export const fmtAgo = (sec: number): string => {
  if (sec < 60) return 'just now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
};

export const escapeHtml = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

// Ads, imaging and station IDs are not songs. Mirrors the stats sidecar
// (server/stats.mjs isBlankSong + DEFAULT_EXCLUDE_PLAYLISTS): an entry with no
// title/artist and a blank or " - " text, or one from an excluded playlist.
export const isBreakEntry = (
  entry: Pick<AzuraNowPlayingEntry, 'song' | 'playlist'> | null | undefined,
  excludedPlaylists: readonly string[],
): boolean => {
  if (!entry || !entry.song) return true;
  const song = entry.song;
  const hasTags = String(song.title ?? '').trim() || String(song.artist ?? '').trim();
  if (!hasTags) {
    const text = String(song.text ?? '').trim();
    if (text === '' || text === '-') return true;
  }
  const pl = String(entry.playlist ?? '').trim().toLowerCase();
  return !!pl && excludedPlaylists.some((p) => p.trim().toLowerCase() === pl);
};

export interface StreamOption {
  url: string;
  label: string; // short, for the picker button: "MP3 · 128k"
  name: string; // mount name from AzuraCast: "EuphoricFM Radio"
  isDefault: boolean;
}

// Station mounts → stream-picker options. Only https URLs on the stream's own
// origin are kept (the CSP's media-src allows exactly that origin), the default
// mount goes first, and duplicates are dropped.
export const streamOptions = (
  mounts: readonly AzuraMount[] | null | undefined,
  allowedOrigin: string,
): StreamOption[] => {
  const out: StreamOption[] = [];
  const seen = new Set<string>();
  for (const m of mounts || []) {
    if (!m || typeof m.url !== 'string') continue;
    let u: URL;
    try { u = new URL(m.url); } catch { continue; }
    if (u.protocol !== 'https:' || u.origin !== allowedOrigin || seen.has(u.href)) continue;
    seen.add(u.href);
    const fmt = (m.format || 'stream').toUpperCase();
    out.push({
      url: u.href,
      label: m.bitrate ? `${fmt} · ${m.bitrate}k` : fmt,
      name: String(m.name || fmt),
      isDefault: !!m.is_default,
    });
  }
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return out;
};

// Playlist files for external players (VLC, Winamp, iTunes…), built from the
// same mount list the picker shows. Titles are sanitised to one line so a
// mount name can't inject extra playlist lines.
const oneLine = (s: string) => String(s).replace(/[\r\n]+/g, ' ').trim();

export const buildPls = (stationName: string, opts: readonly StreamOption[]): string => {
  const lines = ['[playlist]', `NumberOfEntries=${opts.length}`];
  opts.forEach((o, i) => {
    const n = i + 1;
    lines.push(`File${n}=${o.url}`, `Title${n}=${oneLine(`${stationName} – ${o.name} (${o.label})`)}`, `Length${n}=-1`);
  });
  lines.push('Version=2', '');
  return lines.join('\n');
};

export const buildM3u = (stationName: string, opts: readonly StreamOption[]): string => {
  const lines = ['#EXTM3U'];
  for (const o of opts) {
    lines.push(`#EXTINF:-1,${oneLine(`${stationName} – ${o.name} (${o.label})`)}`, o.url);
  }
  lines.push('');
  return lines.join('\n');
};

export const dataUri = (mime: string, body: string): string =>
  `data:${mime};charset=utf-8,${encodeURIComponent(body)}`;
