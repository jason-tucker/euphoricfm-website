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
  // Editable live-event copy (site.config.ts → BaseLayout clientConfig).
  liveEvents: {
    pill: string;
    idlePill: string;
    label: string;
    fallbackName: string;
    elapsedPrefix: string;
  };
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
  // Live special-event UI (banner + pill internals + eyebrow label).
  const elLiveBanner = $('np-live-banner');
  const elLiveStreamer = $('np-live-streamer');
  const elLiveArt = $<HTMLImageElement>('np-live-art');
  const elStatusText = $('np-status-text');
  const elLiveDot = $('np-live-dot');
  const elEyebrow = $('np-eyebrow');

  // Mutable state for the RAF loop.
  let lastShId = 0;
  let playedAt = 0; // ms
  let duration = 0; // seconds
  let listeners = 0;

  // Live special-event state. `liveKnown` stays false until the first poll
  // response so loading into an in-progress event applies the live UI without
  // replaying the transition flash.
  const liveCopy = cfg.liveEvents;
  let isLive = false;
  let liveKnown = false;
  let broadcastStartMs = 0; // 0 = AzuraCast sent no broadcast_start
  let liveStreamer = '';
  let liveRawName = ''; // streamer_name exactly as AzuraCast sends it (pre-fallback)
  let liveArt = ''; // streamer-account artwork (live.art), same-origin rewritten
  let lastNp: AzuraNowPlayingEntry | null = null;
  const baseTitle = document.title;
  const eyebrowDefault = elEyebrow?.textContent || 'Now Playing';

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

  // Broadcast elapsed — like fmtTime but grows an hours segment past 1h,
  // since live sets routinely run longer than any single track.
  const fmtElapsed = (sec: number) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const ss = Math.floor(sec % 60).toString().padStart(2, '0');
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${ss}` : `${m}:${ss}`;
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

  // A live source that pushes no metadata still yields a now_playing entry —
  // AzuraCast fills the song fields with placeholders (the streamer name,
  // "Live Broadcast", the station name, …). Detect those so the card shows
  // the EVENT (DJ name + picture) instead of a bogus track title.
  const isUntitledLive = (song: AzuraNowPlayingEntry['song']): boolean => {
    if (!isLive) return false;
    // Strip stray "Artist - " separators AzuraCast leaves when half is empty.
    const norm = (s: string) => s.replace(/^[\s\-–—]+|[\s\-–—]+$/g, '').trim().toLowerCase();
    const title = norm(song.title || song.text || '');
    if (!title) return true;
    return [
      norm(liveStreamer),
      norm(liveRawName),
      norm(baseTitle),
      'live broadcast',
      'live',
      'unknown',
      'unknown track',
      'untitled',
    ].includes(title);
  };

  const applyNowPlaying = (np: AzuraNowPlayingEntry) => {
    const song = np.song;
    // Untitled live set: show the event, not the placeholder — DJ name as the
    // title, the live label as the byline, and the DJ picture as the artwork.
    const untitled = isUntitledLive(song);
    const artRaw = untitled && liveArt ? liveArt : song.art;
    if (elArt && artRaw) {
      const artUrl = toSameOriginArt(artRaw);
      elArt.src = artUrl;
      elArt.alt = untitled ? liveStreamer : `${song.title} — ${song.artist}`;
      // Announce the (same-origin) art URL so effects.ts can extract its
      // palette. It dedupes by URL, so firing every poll is harmless.
      document.dispatchEvent(new CustomEvent('efm:track-art', { detail: { url: artUrl } }));
    }
    if (elTitle) elTitle.textContent = untitled ? liveStreamer : song.title || song.text || 'Unknown track';
    if (elArtist) elArtist.textContent = untitled ? liveCopy.label : song.artist || '—';
    if (elAlbum) elAlbum.textContent = untitled ? '' : song.album || '';
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

  // Status pill — three states: OFFLINE, AUTO DJ (autopilot), ON AIR (live
  // DJ). Only the #np-status-text child is retexted; assigning textContent on
  // the pill itself is what used to wipe the #np-live-dot span every poll.
  const setOnline = (online: boolean) => {
    if (!elStatus) return;
    if (elStatusText) {
      elStatusText.textContent = !online ? 'OFFLINE' : isLive ? liveCopy.pill : liveCopy.idlePill;
    }
    const base =
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-widest';
    elStatus.className = !online
      ? `${base} bg-cream/10 text-cream/50`
      : isLive
        ? `${base} bg-ruby/90 text-cream animate-soft-pulse`
        : `${base} bg-ruby/20 text-ruby`;
    if (elLiveDot) elLiveDot.classList.toggle('hidden', !online);
  };

  // Live special-event state machine. Runs every poll; does real work only on
  // an is_live flip (or streamer rename mid-event). Entering live: banner
  // slides open, eyebrow swaps to the live label, .np-live on the card drives
  // the CSS (indeterminate bar, cream dot), title + media session credit the
  // DJ. Leaving: everything restores, including the times/bar the live branch
  // of tick() owned. Both directions replay the np-flash — except on the very
  // first poll, so loading mid-event doesn't flash.
  const applyLive = (live: AzuraNowPlayingResponse['live'] | undefined, online: boolean) => {
    const nowLive = !!(live && live.is_live) && online;
    const name = nowLive ? (live!.streamer_name || '').trim() || liveCopy.fallbackName : '';
    const art = nowLive && live!.art ? toSameOriginArt(live!.art) : '';
    const changed = nowLive !== isLive || !liveKnown;
    const renamed = nowLive && !changed && (name !== liveStreamer || art !== liveArt);
    const wasKnown = liveKnown;
    liveKnown = true;
    isLive = nowLive;
    liveStreamer = name;
    liveRawName = nowLive ? (live!.streamer_name || '').trim() : '';
    liveArt = art;
    broadcastStartMs = nowLive && live!.broadcast_start ? live!.broadcast_start * 1000 : 0;

    // DJ picture in the banner — only when the streamer account has one.
    if (elLiveArt) {
      if (liveArt && !elLiveArt.src.endsWith(liveArt)) elLiveArt.src = liveArt;
      elLiveArt.classList.toggle('hidden', !liveArt);
    }

    if (changed) {
      if (elCard) elCard.classList.toggle('np-live', isLive);
      if (elLiveBanner) {
        elLiveBanner.classList.toggle('is-open', isLive);
        elLiveBanner.setAttribute('aria-hidden', String(!isLive));
      }
      if (elEyebrow) elEyebrow.textContent = isLive ? liveCopy.label : eyebrowDefault;
      if (!isLive) {
        // The live branch of tick() owned these — reset so the normal branch
        // repaints from clean state instead of leaving live text behind.
        if (elBar) elBar.style.width = '0%';
        if (elTimes) elTimes.textContent = '0:00 / 0:00';
        document.title = baseTitle;
      }
      if (wasKnown && elCard) {
        elCard.classList.remove('np-flash');
        void elCard.offsetWidth;
        elCard.classList.add('np-flash');
      }
    }
    if (isLive && (changed || renamed)) {
      // Streamer name is remote data — textContent only, never innerHTML.
      if (elLiveStreamer) elLiveStreamer.textContent = liveStreamer;
      document.title = `${liveCopy.elapsedPrefix}: ${liveStreamer} — ${baseTitle}`;
    }
    if ((changed || renamed) && lastNp) {
      // Re-render the track block under the new mode — the untitled-live
      // override (and its exit) must not wait for the next sh_id change.
      applyNowPlaying(lastNp);
      updateMediaSession(lastNp);
    }
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
      if (np) lastNp = np;
      // applyLive first — setOnline and updateMediaSession read `isLive`.
      const online = data.is_online !== false;
      applyLive(data.live, online);
      setOnline(online);

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
    if (isLive) {
      // Live event: the bar is a CSS indeterminate sweep (.np-live on the
      // card), so only the elapsed readout updates here. broadcast_start can
      // be null → just the bare prefix. Math.max guards a client clock that
      // sits behind the server's broadcast_start.
      if (elTimes) {
        elTimes.textContent =
          broadcastStartMs > 0
            ? `${liveCopy.elapsedPrefix} · ${fmtElapsed(Math.max(0, (Date.now() - broadcastStartMs) / 1000))}`
            : liveCopy.elapsedPrefix;
      }
      // playing_next is meaningless mid-broadcast — keep the panel shut.
      // applyUpNext keeps priming content, so normal reveal resumes on exit.
      if (elUpNext) elUpNext.classList.remove('is-open');
    } else if (duration > 0 && playedAt > 0) {
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
    const untitled = isUntitledLive(song);
    try {
      const art = (untitled && liveArt ? liveArt : song.art) || '';
      navigator.mediaSession.metadata = new MediaMetadata({
        title: untitled ? liveStreamer : song.title || song.text || 'EuphoricFM',
        // During a live event the DJ gets the credit — applyLive re-invokes
        // this on is_live flips and mid-event renames, so it restores too.
        artist: isLive ? `${liveCopy.elapsedPrefix}: ${liveStreamer}` : song.artist || 'EuphoricFM',
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
