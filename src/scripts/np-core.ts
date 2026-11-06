// np-core.ts — the now-playing data source shared by every page that shows
// the live station: the home PlayerCard (nowplaying.ts) and the Web Player
// (player.ts). One poller per page, fanned out to subscribers.
//
// Polls AzuraCast's public `/api/nowplaying/<station>` every `pollMs`
// (`cache: 'no-store'`; never set Cache-Control/Pragma request headers — the
// CORS preflight would reject them), pauses while the tab is hidden and
// refreshes immediately when it becomes visible again.
//
// Failures (network error, timeout, non-2xx, unparsable body) are counted and
// fanned out to error listeners, so the pages can show "Station offline —
// retrying" instead of a live-looking "Loading…" forever. Each request times
// out after NP_TIMEOUT_MS, only one is ever in flight, and after
// SLOW_RETRY_AFTER misses in a row the poller retries every SLOW_RETRY_MS.

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
/** Called after every failed poll with the number of misses in a row. */
type ErrorListener = (failures: number) => void;

export const NP_TIMEOUT_MS = 8000;
export const SLOW_RETRY_AFTER = 3;
export const SLOW_RETRY_MS = 30000;
/** Misses in a row before a page that already shows data calls the station offline. */
export const UNAVAILABLE_AFTER = 2;

/**
 * Should the page show the offline state? Straight away when nothing has
 * loaded yet (no live-looking "Loading…" forever), otherwise after
 * UNAVAILABLE_AFTER misses in a row so one dropped poll does not flicker.
 */
export const stationUnavailable = (failures: number, hasData: boolean): boolean =>
  failures >= (hasData ? UNAVAILABLE_AFTER : 1);

export interface NowPlayingPoller {
  /** Fetch now (skipped while a request is still in flight). */
  poll: () => Promise<void>;
  /** Interval tick: like poll(), but slowed to SLOW_RETRY_MS after repeated misses. */
  tick: () => Promise<void>;
  failures: () => number;
}

export const createNowPlayingPoller = (opts: {
  url: string;
  onData: Listener;
  onError: ErrorListener;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}): NowPlayingPoller => {
  const fetchFn = opts.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = opts.now ?? Date.now;
  let inFlight = false;
  let failures = 0;
  let lastAttempt = 0;

  const poll = async () => {
    if (inFlight) return;
    inFlight = true;
    lastAttempt = now();
    let data: AzuraNowPlayingResponse;
    try {
      const r = await fetchFn(opts.url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(opts.timeoutMs ?? NP_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = (await r.json()) as AzuraNowPlayingResponse;
    } catch (err) {
      failures += 1;
      console.warn('[efm] now-playing refresh failed', err);
      opts.onError(failures);
      return;
    } finally {
      inFlight = false;
    }
    failures = 0;
    opts.onData(data);
  };

  const tick = async () => {
    if (failures >= SLOW_RETRY_AFTER && now() - lastAttempt < SLOW_RETRY_MS) return;
    await poll();
  };

  return { poll, tick, failures: () => failures };
};

const listeners: Listener[] = [];
const errorListeners: ErrorListener[] = [];
let started = false;
let pollHandle: number | null = null;

const fanOut = <T>(fns: ((v: T) => void)[], v: T) => {
  for (const fn of fns) {
    try { fn(v); } catch (err) { console.warn('[efm] now-playing subscriber failed', err); }
  }
};

// Register a now-playing listener (and optionally a failure listener). The
// first call boots the poller (one immediate fetch, then every cfg.pollMs).
export const subscribeNowPlaying = (fn: Listener, onError?: ErrorListener): void => {
  listeners.push(fn);
  if (onError) errorListeners.push(onError);
  const cfg = getConfig();
  if (started || !cfg) return;
  started = true;

  const poller = createNowPlayingPoller({
    url: `${cfg.apiBase}/nowplaying/${cfg.stationId}`,
    onData: (data) => fanOut(listeners, data),
    onError: (failures) => fanOut(errorListeners, failures),
  });
  const startPolling = () => {
    if (pollHandle != null) return;
    pollHandle = window.setInterval(() => { void poller.tick(); }, cfg.pollMs);
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
      void poller.poll();
      startPolling();
    } else {
      stopPolling();
    }
  });
  void poller.poll();
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
