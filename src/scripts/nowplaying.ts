// Client-side driver for the now-playing card + recently-played list.
//
// Reads `window.__EFM_CONFIG__` (populated by BaseLayout.astro from site.config)
// and polls the AzuraCast `/api/nowplaying/<station>` endpoint on an interval.
// Between polls, a requestAnimationFrame loop interpolates the progress bar
// using the server-provided `played_at` + `duration` so the UI feels real-time
// even though we're polling every 5 seconds.
//
// Track changes are detected via `sh_id`; when it changes the now-playing card
// flashes and the recently-played list is re-rendered.

import type {
  AzuraNowPlayingResponse,
  AzuraNowPlayingEntry,
} from '../lib/azuracast';

interface EfmConfig {
  apiBase: string;
  stationId: string;
  pollMs: number;
  mode: 'poll' | 'sse';
}

interface EfmAudioBridge {
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

(() => {
  const cfg = window.__EFM_CONFIG__;
  if (!cfg) {
    console.warn('[efm] no __EFM_CONFIG__ on window — nowplaying script disabled');
    return;
  }

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  const elArt = $<HTMLImageElement>('np-art');
  const elTitle = $('np-title');
  const elArtist = $('np-artist');
  const elAlbum = $('np-album');
  const elListeners = $('np-listeners');
  const elBar = $('np-bar');
  const elTimes = $('np-times');
  const elCard = $('np-card');
  const elRecent = $('recent-list');
  const elStatus = $('np-status');
  // Up-next slide-down panel.
  const elUpNext = $('np-up-next');
  const elUpNextArt = $<HTMLImageElement>('up-next-art');
  const elUpNextTitle = $('up-next-title');
  const elUpNextArtist = $('up-next-artist');
  // Pending-requests card (sibling of recently-played in the sidebar).
  const elPendingSection = $('req-pending-section');
  const elPendingList = $('req-pending-list');
  const elPendingCount = $('req-pending-count');
  // REQUESTED badges — toggled from `is_request` on each entry.
  const elNpRequested = $('np-requested');
  const elUpNextRequested = $('up-next-requested');

  // Mutable state for the RAF loop.
  let lastShId = 0;
  let playedAt = 0; // ms
  let duration = 0; // seconds
  let listeners = 0;

  // Up-next reveal threshold: slide in when this many seconds (or fewer) remain
  // on the current track. 40s sits in the sweet spot the user asked for (30–45s).
  const UP_NEXT_REVEAL_SEC = 40;
  let upNextReady = false; // becomes true once we have a valid playing_next song

  const fmtTime = (sec: number) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Rewrite euphoric.fm album-art URLs to our own origin (/efm-art/...) so the
  // effects module can read the image onto a <canvas> for colour extraction
  // without tainting it — Caddy reverse-proxies /efm-art/* back to euphoric.fm.
  // data: URIs and anything already same-origin pass through untouched.
  const toSameOriginArt = (raw: string): string => {
    try {
      const u = new URL(raw, location.href);
      return u.origin === 'https://euphoric.fm' ? '/efm-art' + u.pathname + u.search : raw;
    } catch {
      return raw;
    }
  };

  const applyNowPlaying = (np: AzuraNowPlayingEntry) => {
    const song = np.song;
    if (elArt && song.art) {
      const artUrl = toSameOriginArt(song.art);
      elArt.src = artUrl;
      elArt.alt = `${song.title} — ${song.artist}`;
      // Announce the (same-origin) art URL so effects.ts can extract its
      // palette. It dedupes by URL, so firing every poll is harmless.
      document.dispatchEvent(new CustomEvent('efm:track-art', { detail: { url: artUrl } }));
    }
    if (elTitle) elTitle.textContent = song.title || song.text || 'Unknown track';
    if (elArtist) elArtist.textContent = song.artist || '—';
    if (elAlbum) elAlbum.textContent = song.album || '';
    if (elNpRequested) elNpRequested.classList.toggle('hidden', !np.is_request);
    playedAt = (np.played_at || 0) * 1000;
    duration = np.duration || 0;
  };

  // Keep the panel's content primed at all times — the actual reveal is timed
  // off the current song's remaining seconds in the RAF tick loop below.
  const applyUpNext = (next: AzuraNowPlayingEntry | null) => {
    if (!elUpNext) return;
    if (!next || !next.song || !(next.song.title || next.song.text)) {
      upNextReady = false;
      elUpNext.classList.remove('is-open');
      if (elUpNextRequested) elUpNextRequested.classList.add('hidden');
      return;
    }
    const song = next.song;
    if (elUpNextTitle) elUpNextTitle.textContent = song.title || song.text || '';
    if (elUpNextArtist) elUpNextArtist.textContent = song.artist || '';
    if (elUpNextArt && song.art) elUpNextArt.src = toSameOriginArt(song.art);
    if (elUpNextRequested) elUpNextRequested.classList.toggle('hidden', !next.is_request);
    upNextReady = true;
    // Don't add .is-open here — tick() decides based on remaining seconds.
  };

  // ---- Pending requests (your-requests sidebar card) ------------------
  //
  // Shared across all visitors via the `efm-requests` Node service Caddy
  // reverse-proxies at /requests/* (see server/index.mjs + Caddyfile). The
  // service owns the canonical list, the 6h TTL, dedupe and the 50-entry
  // cap; we just fetch + render here. v0.6.0's localStorage state is gone.
  interface PendingRequest {
    id: string;
    title: string;
    artist: string;
    art: string;
    ts: number;
  }

  let pendingCache: PendingRequest[] = [];

  const fetchPending = async (): Promise<PendingRequest[]> => {
    try {
      const r = await fetch('/requests/pending', { cache: 'no-store' });
      if (!r.ok) return pendingCache;
      const data = await r.json();
      return Array.isArray(data) ? (data as PendingRequest[]) : [];
    } catch (err) {
      console.warn('[efm] /requests/pending fetch failed', err);
      return pendingCache;
    }
  };

  const fmtAgo = (sec: number) => {
    if (sec < 60) return 'just now';
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  };

  const renderPending = (pending: PendingRequest[]) => {
    if (!elPendingSection || !elPendingList) return;
    if (!pending.length) {
      elPendingSection.classList.add('hidden');
      elPendingList.innerHTML = '';
      if (elPendingCount) elPendingCount.textContent = '';
      return;
    }
    elPendingSection.classList.remove('hidden');
    if (elPendingCount) elPendingCount.textContent = String(pending.length);
    const nowSec = Date.now() / 1000;
    // Newest first — fresher submissions belong at the top.
    const rows = [...pending].sort((a, b) => b.ts - a.ts).map((p) => {
      const ago = Math.max(0, Math.floor(nowSec - p.ts / 1000));
      const title = escape(p.title || 'Unknown');
      const artist = escape(p.artist || '');
      // `art` comes from the public, unauthenticated /requests/track endpoint,
      // so it is attacker-controlled — escape it before it lands in src="…"
      // or an attribute breakout (art = `x" onerror="…`) becomes stored XSS.
      const art = escape(p.art || '');
      return `<li class="flex items-center gap-3 py-2 border-t border-cream/5 first:border-t-0">
        <img src="${art}" alt="" class="w-10 h-10 rounded-md object-cover bg-cream/10 shrink-0" loading="lazy">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold text-cream">${title}</div>
          <div class="truncate text-xs text-cream/60">${artist}</div>
        </div>
        <div class="shrink-0 text-[10px] uppercase tracking-wider text-sunburst/80">${fmtAgo(ago)}</div>
      </li>`;
    });
    elPendingList.innerHTML = rows.join('');
  };

  const refreshPending = async () => {
    pendingCache = await fetchPending();
    renderPending(pendingCache);
  };

  // Re-render right after RequestModal POSTs a new entry — without this the
  // sidebar wouldn't update until the next 5s poll.
  document.addEventListener('efm:pending-changed', () => {
    refreshPending();
  });

  const applyRecent = (history: AzuraNowPlayingEntry[]) => {
    if (!elRecent) return;
    const nowSec = Date.now() / 1000;
    const rows = history.slice(0, 5).map((h) => {
      // "X minutes ago" should be relative to when the track *ended*, not
      // when it started. Each history entry's end = played_at + duration.
      const endedAt = (h.played_at || 0) + (h.duration || 0);
      const ago = Math.max(0, Math.floor((nowSec - endedAt) / 60));
      const agoText = ago === 0 ? 'just ended' : `${ago}m ago`;
      // Escape the art URL too — it is interpolated straight into src="…".
      const art = escape(h.song.art || '');
      const title = escape(h.song.title || h.song.text || '');
      const artist = escape(h.song.artist || '');
      return `<li class="flex items-center gap-3 py-2 border-t border-cream/5 first:border-t-0">
        <img src="${art}" alt="" class="w-10 h-10 rounded-md object-cover bg-cream/10 shrink-0" loading="lazy">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold text-cream">${title}</div>
          <div class="truncate text-xs text-cream/60">${artist}</div>
        </div>
        <div class="shrink-0 text-[10px] uppercase tracking-wider text-cream/40">${agoText}</div>
      </li>`;
    });
    elRecent.innerHTML = rows.join('');
  };

  const escape = (s: string) =>
    s.replace(/[&<>"']/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
    );

  const setOnline = (online: boolean) => {
    if (!elStatus) return;
    elStatus.textContent = online ? 'LIVE' : 'OFFLINE';
    elStatus.className = online
      ? 'inline-block rounded-full px-2 py-0.5 text-[10px] font-bold tracking-widest bg-ruby/20 text-ruby'
      : 'inline-block rounded-full px-2 py-0.5 text-[10px] font-bold tracking-widest bg-cream/10 text-cream/50';
  };

  const refresh = async () => {
    try {
      const r = await fetch(`${cfg.apiBase}/nowplaying/${cfg.stationId}`, {
        cache: 'no-store',
      });
      if (!r.ok) return;
      const data = (await r.json()) as AzuraNowPlayingResponse;
      const np = data.now_playing;
      listeners = data.listeners?.current ?? 0;
      if (elListeners) elListeners.textContent = String(listeners);
      setOnline(data.is_online !== false);

      if (np && np.sh_id !== lastShId) {
        applyNowPlaying(np);
        if (lastShId !== 0 && elCard) {
          elCard.classList.remove('np-flash');
          void elCard.offsetWidth;
          elCard.classList.add('np-flash');
        }
        lastShId = np.sh_id;
        updateMediaSession(np);
      }
      applyRecent(data.song_history || []);
      applyUpNext(data.playing_next || null);
      // Don't await — pending-list latency shouldn't gate the now-playing
      // paint. The fetch races the next poll harmlessly if it's slow.
      refreshPending();
    } catch (err) {
      console.warn('[efm] refresh failed', err);
    }
  };

  // RAF loop: paint the progress bar between polls using the server-anchored
  // playedAt timestamp + duration. This makes the UI feel real-time. The Up
  // Next panel is also toggled here so the reveal lines up smoothly with the
  // progress bar rather than only on the 5-second poll cadence.
  const tick = () => {
    if (duration > 0 && playedAt > 0) {
      const elapsedSec = (Date.now() - playedAt) / 1000;
      const pct = Math.min(100, Math.max(0, (elapsedSec / duration) * 100));
      if (elBar) elBar.style.width = `${pct}%`;
      if (elTimes) {
        elTimes.textContent = `${fmtTime(elapsedSec)} / ${fmtTime(duration)}`;
      }

      // Slide Up Next in when remaining ≤ threshold; slide out otherwise.
      // (Without `upNextReady`, the panel only animates the empty content.)
      if (elUpNext) {
        const remaining = duration - elapsedSec;
        const shouldShow = upNextReady && remaining > 0 && remaining <= UP_NEXT_REVEAL_SEC;
        if (shouldShow && !elUpNext.classList.contains('is-open')) {
          elUpNext.classList.add('is-open');
        } else if (!shouldShow && elUpNext.classList.contains('is-open')) {
          elUpNext.classList.remove('is-open');
        }
      }
    }
    requestAnimationFrame(tick);
  };

  let pollHandle: number | null = null;
  const startPolling = () => {
    if (pollHandle != null) return;
    pollHandle = window.setInterval(refresh, cfg.pollMs);
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
      refresh();
      startPolling();
    } else {
      stopPolling();
    }
  });

  // ---- Media Session API ------------------------------------------------
  // When the stream is playing, this exposes title/artist/album/artwork to
  // the OS so it appears on lock screens, in the system tray on desktop, and
  // bound to hardware media keys + bluetooth headphone controls.
  const updateMediaSession = (np: AzuraNowPlayingEntry) => {
    if (!('mediaSession' in navigator)) return;
    const song = np.song;
    try {
      const art = song.art || '';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title || song.text || 'EuphoricFM',
        artist: song.artist || 'EuphoricFM',
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

  if ('mediaSession' in navigator) {
    const bridge = () => window.__efmAudio;
    navigator.mediaSession.setActionHandler('play', () => bridge()?.play());
    navigator.mediaSession.setActionHandler('pause', () => bridge()?.pause());
    navigator.mediaSession.setActionHandler('stop', () => bridge()?.pause());
    // Seek doesn't apply to a live stream; skip prev/next intentionally too.
  }

  // Boot.
  refreshPending();
  refresh();
  startPolling();
  requestAnimationFrame(tick);
})();
