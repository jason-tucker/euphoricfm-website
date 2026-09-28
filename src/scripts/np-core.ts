// np-core.ts — the now-playing data source shared by every page that shows
// the live station: the home PlayerCard (nowplaying.ts) and the Web Player
// (player.ts). One poller per page, fanned out to subscribers.
//
// Polls AzuraCast's public `/api/nowplaying/<station>` every `pollMs`
// (`cache: 'no-store'`; never set Cache-Control/Pragma request headers — the
// CORS preflight would reject them), pauses while the tab is hidden and
// refreshes immediately when it becomes visible again.

import type { AzuraNowPlayingResponse, AzuraSong } from '../lib/azuracast';

export interface EfmConfig {
  apiBase: string;
  stationId: string;
  pollMs: number;
  mode: 'poll' | 'sse';
  // Editable live-event copy (site.config.ts → BaseLayout clientConfig).
  liveEvents: {
    pill: string;
    idlePill: string;
    label: string;
    fallbackName: string;
    elapsedPrefix: string;
  };
}

export interface EfmAudioBridge {
  play: () => void;
  pause: () => void;
  el: HTMLAudioElement;
}

declare global {
  interface Window {
    __EFM_CONFIG__: EfmConfig;
    __efmAudio?: EfmAudioBridge;
  }
}

export const getConfig = (): EfmConfig | null => window.__EFM_CONFIG__ || null;

type Listener = (data: AzuraNowPlayingResponse) => void;
const listeners: Listener[] = [];
let started = false;
let pollHandle: number | null = null;

const refresh = async (cfg: EfmConfig) => {
  try {
    const r = await fetch(`${cfg.apiBase}/nowplaying/${cfg.stationId}`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = (await r.json()) as AzuraNowPlayingResponse;
    for (const fn of listeners) {
      try { fn(data); } catch (err) { console.warn('[efm] now-playing subscriber failed', err); }
    }
  } catch (err) {
    console.warn('[efm] refresh failed', err);
  }
};

// Register a now-playing listener. The first call boots the poller (one
// immediate fetch, then every cfg.pollMs).
export const subscribeNowPlaying = (fn: Listener): void => {
  listeners.push(fn);
  const cfg = getConfig();
  if (started || !cfg) return;
  started = true;

  const startPolling = () => {
    if (pollHandle != null) return;
    pollHandle = window.setInterval(() => refresh(cfg), cfg.pollMs);
  };
  const stopPolling = () => {
    if (pollHandle != null) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  };
  // Pause polling when the iframe/page is hidden; snap back when visible.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refresh(cfg);
      startPolling();
    } else {
      stopPolling();
    }
  });
  refresh(cfg);
  startPolling();
};

// Rewrite euphoric.fm album-art URLs to our own origin (/efm-art/...) so the
// effects module can read the image onto a <canvas> for colour extraction
// without tainting it — Caddy reverse-proxies /efm-art/* back to euphoric.fm.
// data: URIs and anything already same-origin pass through untouched.
export const toSameOriginArt = (raw: string): string => {
  try {
    const u = new URL(raw, location.href);
    return u.origin === 'https://euphoric.fm' ? '/efm-art' + u.pathname + u.search : raw;
  } catch {
    return raw;
  }
};

// ---- Media Session API ------------------------------------------------
// Exposes title/artist/album/artwork to the OS (lock screen, system tray,
// hardware media keys, bluetooth headphone controls).
export const setMediaMetadata = (song: Partial<AzuraSong>, artist: string): void => {
  if (!('mediaSession' in navigator)) return;
  try {
    const art = song.art || '';
    navigator.mediaSession.metadata = new MediaMetadata({
      title: song.title || song.text || 'EuphoricFM',
      artist,
      album: song.album || 'EuphoricFM',
      artwork: art
        ? [
            { src: art, sizes: '96x96',   type: 'image/jpeg' },
            { src: art, sizes: '192x192', type: 'image/jpeg' },
            { src: art, sizes: '512x512', type: 'image/jpeg' },
          ]
        : [],
    });
  } catch (err) {
    console.warn('[efm] mediaSession metadata failed', err);
  }
};

// Play/pause/stop handlers go through window.__efmAudio (stream-audio.ts).
// Seek doesn't apply to a live stream; prev/next are skipped intentionally.
export const bindMediaSessionActions = (): void => {
  if (!('mediaSession' in navigator)) return;
  const bridge = () => window.__efmAudio;
  navigator.mediaSession.setActionHandler('play', () => bridge()?.play());
  navigator.mediaSession.setActionHandler('pause', () => bridge()?.pause());
  navigator.mediaSession.setActionHandler('stop', () => bridge()?.pause());
};
