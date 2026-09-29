// player.ts — the Web Player page (/player/, src/pages/player.astro).
//
// Data comes from np-core.ts (the same now-playing poller the home card uses)
// and audio from stream-audio.ts (the same engine as the home PlayerCard), so
// the two players behave alike: cache-busted live stream, Web Audio reactions
// gated by the effects toggle, Media Session metadata + hardware keys.
//
// Every displayed value is written to all elements carrying the matching
// data-np="…" attribute, so the full layout and the pop-out strip stay in sync
// without separate code paths. Remote strings go through textContent, or
// escapeHtml() where a row is built as HTML.

import type { AzuraNowPlayingEntry, AzuraNowPlayingResponse, AzuraSong } from '../lib/azuracast';
import {
  buildM3u,
  buildPls,
  dataUri,
  escapeHtml,
  fmtAgo,
  fmtElapsed,
  fmtTime,
  isBreakEntry,
  streamOptions,
  type StreamOption,
} from '../lib/player-data';
import {
  bindMediaSessionActions,
  getConfig,
  setMediaMetadata,
  stationUnavailable,
  subscribeNowPlaying,
  toSameOriginArt,
} from './np-core';
import { createStreamEngine } from './stream-audio';
import { showToast } from './toast';

interface PlayerPageConfig {
  streamUrl: string;
  stationName: string;
  popout: { name: string; width: number; height: number };
  breakTitle: string;
  breakArtist: string;
  excludePlaylists: string[];
  offline: string;
  playFailed: string;
}

const VOL_KEY = 'efm-player-volume';
const STREAM_KEY = 'efm-player-stream';

const store = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
  },
};

(() => {
  const root = document.getElementById('efmp');
  const audio = document.getElementById('efmp-audio') as HTMLAudioElement | null;
  const cfg = getConfig();
  if (!root || !audio || !cfg) return;

  let pc: PlayerPageConfig;
  try {
    pc = JSON.parse(root.dataset.playerConfig || '');
  } catch {
    return;
  }
  const live = cfg.liveEvents;
  const streamOrigin = new URL(pc.streamUrl).origin;

  const all = <T extends HTMLElement = HTMLElement>(name: string) =>
    Array.from(root.querySelectorAll<T>(`[data-np="${name}"]`));
  const ctl = <T extends HTMLElement = HTMLElement>(name: string) =>
    Array.from(root.querySelectorAll<T>(`[data-efmp="${name}"]`));
  const setText = (name: string, text: string) => {
    for (const el of all(name)) if (el.textContent !== text) el.textContent = text;
  };
  const setHidden = (name: string, hidden: boolean) => {
    for (const el of all(name)) el.hidden = hidden;
  };

  // ---- Stream choice (quality picker) ------------------------------------
  const quality = document.getElementById('efmp-quality') as HTMLSelectElement | null;
  let options: StreamOption[] = [];
  let optionsKey = '';
  let streamUrl = pc.streamUrl;
  const storedStream = store.get(STREAM_KEY);
  if (storedStream) {
    try { if (new URL(storedStream).origin === streamOrigin) streamUrl = storedStream; } catch { /* ignore */ }
  }

  // ---- Audio engine + transport -------------------------------------------
  const playBtns = ctl<HTMLButtonElement>('play');
  const docTitleBase = document.title;
  let titleText = '';
  const paintDocTitle = () => {
    document.title = titleText
      ? `${engine.isPlaying() ? '▶ ' : ''}${titleText} | EuphoricFM Web Player`
      : docTitleBase;
  };

  const engine = createStreamEngine({
    audio,
    card: root,
    getStreamUrl: () => streamUrl,
    onChange: (playing) => {
      for (const b of playBtns) {
        b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        b.querySelector('use')?.setAttribute('href', playing ? '#efmp-i-pause' : '#efmp-i-play');
      }
      paintDocTitle();
    },
    onPlayError: () => showToast(pc.playFailed),
  });
  for (const b of playBtns) b.addEventListener('click', () => { void engine.toggle(); });

  // Space toggles playback (handy in the pop-out) unless focus is on a control
  // that already owns the key or the request dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== ' ' && e.code !== 'Space') return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('input, textarea, select, button, a, summary, [contenteditable]')) return;
    const overlay = document.getElementById('request-overlay');
    if (overlay && !overlay.classList.contains('hidden')) return;
    e.preventDefault();
    void engine.toggle();
  });

  // ---- Volume + mute --------------------------------------------------------
  const volInputs = ctl<HTMLInputElement>('volume');
  const muteBtns = ctl<HTMLButtonElement>('mute');
  const storedVol = Number(store.get(VOL_KEY));
  let volume = Number.isFinite(storedVol) && store.get(VOL_KEY) !== null ? Math.min(100, Math.max(0, storedVol)) : 80;

  // iOS ignores element volume (hardware buttons only) — hide the sliders
  // there instead of showing a control that does nothing.
  try {
    const probe = document.createElement('audio');
    probe.volume = 0.5;
    if (probe.volume !== 0.5) root.classList.add('efmp-novol');
  } catch { /* ignore */ }

  const paintVolume = () => {
    audio.volume = volume / 100;
    for (const v of volInputs) {
      if (Number(v.value) !== volume) v.value = String(volume);
      v.style.setProperty('--vol', `${volume}%`);
    }
    const muted = audio.muted || volume === 0;
    for (const m of muteBtns) {
      m.setAttribute('aria-pressed', String(audio.muted));
      m.setAttribute('aria-label', audio.muted ? 'Unmute' : 'Mute');
      m.querySelector('use')?.setAttribute('href', muted ? '#efmp-i-mute' : '#efmp-i-vol');
    }
  };
  for (const v of volInputs) {
    v.addEventListener('input', () => {
      volume = Number(v.value);
      if (audio.muted && volume > 0) audio.muted = false;
      store.set(VOL_KEY, String(volume));
      paintVolume();
    });
  }
  for (const m of muteBtns) {
    m.addEventListener('click', () => {
      audio.muted = !audio.muted;
      paintVolume();
    });
  }
  paintVolume();

  // ---- Quality picker + playlist files --------------------------------------
  const plsLinks = ctl<HTMLAnchorElement>('pls');
  const m3uLinks = ctl<HTMLAnchorElement>('m3u');
  const applyMounts = (data: AzuraNowPlayingResponse) => {
    const next = streamOptions(data.station?.mounts, streamOrigin);
    if (!next.length) return;
    const key = next.map((o) => `${o.url}|${o.label}|${o.name}`).join('\n');
    if (key === optionsKey) return;
    optionsKey = key;
    options = next;
    if (!options.some((o) => o.url === streamUrl)) streamUrl = options[0].url;
    if (quality) {
      quality.replaceChildren(
        ...options.map((o) => {
          const opt = document.createElement('option');
          opt.value = o.url;
          opt.textContent = options.length > 1 ? `${o.label} — ${o.name}` : o.label;
          opt.selected = o.url === streamUrl;
          return opt;
        }),
      );
      quality.title = options.find((o) => o.url === streamUrl)?.name || '';
    }
    const name = pc.stationName;
    for (const a of plsLinks) a.href = dataUri('audio/x-scpls', buildPls(name, options));
    for (const a of m3uLinks) a.href = dataUri('audio/x-mpegurl', buildM3u(name, options));
  };
  quality?.addEventListener('change', () => {
    streamUrl = quality.value;
    store.set(STREAM_KEY, streamUrl);
    quality.title = options.find((o) => o.url === streamUrl)?.name || '';
    void engine.restart();
  });

  // Playlist menu: close after a pick, on an outside click, or on Escape.
  const menus = ctl<HTMLDetailsElement>('playlist');
  document.addEventListener('click', (e) => {
    for (const d of menus) {
      if (!d.open) continue;
      const t = e.target as Node;
      const item = (t as HTMLElement).closest?.('.efmp-menu-item');
      if (!d.contains(t) || (item && d.contains(item))) d.open = false;
    }
  });

  // ---- Pop out ------------------------------------------------------------------
  for (const a of ctl<HTMLAnchorElement>('popout')) {
    a.addEventListener('click', (e) => {
      const { name, width, height } = pc.popout;
      // Open by name with no URL first: if the pop-out already exists this
      // just returns it (no reload, so its playback keeps going); a brand-new
      // window comes back on about:blank and is pointed at the player.
      const w = window.open('', name, `popup,width=${width},height=${height}`);
      if (!w) return; // blocked → let the link open it as a normal tab/window
      e.preventDefault();
      let fresh = true;
      try { fresh = w.location.href === 'about:blank'; } catch { /* cross-origin → navigate */ }
      if (fresh) w.location.href = a.href;
      // One stream at a time: the pop-out takes over playback.
      if (engine.isPlaying()) engine.stop();
      try { w.focus(); } catch { /* ignore */ }
    });
  }

  // ---- Request a song (reuses RequestModal) --------------------------------------
  for (const b of ctl('request')) {
    b.addEventListener('click', () => document.dispatchEvent(new CustomEvent('efm:open-request')));
  }
  const closeOverlay = (overlay: HTMLElement) => {
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
  };
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest?.('[data-close]');
    const id = el?.getAttribute('data-close');
    const overlay = id ? document.getElementById(id) : null;
    if (overlay) closeOverlay(overlay);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('request-overlay');
    if (overlay && !overlay.classList.contains('hidden')) closeOverlay(overlay);
    for (const d of menus) d.open = false;
  });

  // ---- Song history -----------------------------------------------------------------
  const histAside = document.getElementById('history');
  const histList = document.getElementById('efmp-history');
  const moreBtn = ctl<HTMLButtonElement>('history-more')[0];
  const moreLabel = ctl('history-more-label')[0];
  let histCount = 0;
  const setExpanded = (on: boolean) => {
    histAside?.classList.toggle('is-expanded', on);
    moreBtn?.setAttribute('aria-expanded', String(on));
    if (moreLabel) moreLabel.textContent = on ? 'Show fewer' : `Show all ${histCount}`;
  };
  moreBtn?.addEventListener('click', () => setExpanded(!histAside?.classList.contains('is-expanded')));
  for (const a of ctl('history-link')) a.addEventListener('click', () => setExpanded(true));

  const renderHistory = (history: AzuraNowPlayingEntry[]) => {
    if (!histList) return;
    const rows = history.filter((h) => !isBreakEntry(h, pc.excludePlaylists)).slice(0, 15);
    histCount = rows.length;
    const nowSec = Date.now() / 1000;
    histList.innerHTML = rows.length
      ? rows
          .map((h) => {
            // "ago" is measured from when the track ended, like the home list.
            const endedAt = (h.played_at || 0) + (h.duration || 0);
            const ago = Math.max(0, Math.floor(nowSec - endedAt));
            const iso = new Date(endedAt * 1000).toISOString();
            const title = escapeHtml(h.song.title || h.song.text || '');
            const artist = escapeHtml(h.song.artist || '');
            const art = escapeHtml(h.song.art || '');
            const req = h.is_request ? '<span class="efmp-chip-req">REQUESTED</span>' : '';
            return `<li class="efmp-hist-item">
              <img src="${art}" alt="" width="42" height="42" loading="lazy">
              <span class="efmp-hist-t"><b>${title}</b><span class="efmp-hist-a"><span>${artist}</span>${req}</span></span>
              <time datetime="${iso}">${ago < 60 ? 'just ended' : fmtAgo(ago)}</time>
            </li>`;
          })
          .join('')
      : '<li class="efmp-hist-empty">No songs yet.</li>';
    setText('history-count', `last ${rows.length}`);
    histAside?.classList.toggle('is-over3', rows.length > 3);
    histAside?.classList.toggle('is-over8', rows.length > 8);
    if (moreBtn) moreBtn.hidden = rows.length <= 3;
    setExpanded(!!histAside?.classList.contains('is-expanded'));
  };

  // ---- Now playing ----------------------------------------------------------------
  let playedAt = 0; // ms
  let duration = 0; // s
  let isLive = false;
  let broadcastStartMs = 0;
  let hasNext = false;
  let lastArt = '';
  let lastMetaKey = '';
  let hasData = false;
  let offline = false;

  const statusEls = all('status');
  const setStatus = (online: boolean) => {
    for (const el of statusEls) {
      el.classList.toggle('is-off', !online);
      el.classList.toggle('is-live', online && isLive);
      el.classList.toggle('is-auto', online && !isLive);
    }
    setText('status-text', !online ? 'OFFLINE' : isLive ? live.pill : live.idlePill);
  };

  const songLine = (entry: AzuraNowPlayingEntry | null) => {
    const brk = isBreakEntry(entry, pc.excludePlaylists);
    const song: Partial<AzuraSong> = entry?.song || {};
    return {
      brk,
      song,
      title: brk ? pc.breakTitle : song.title || song.text || 'Unknown track',
      artist: brk ? pc.breakArtist : song.artist || '',
      album: brk ? '' : song.album || '',
    };
  };

  const onNowPlaying = (data: AzuraNowPlayingResponse) => {
    hasData = true;
    offline = false;
    const online = data.is_online !== false;
    isLive = !!(online && data.live && data.live.is_live);
    const streamer = isLive ? (data.live.streamer_name || '').trim() || live.fallbackName : '';
    broadcastStartMs = isLive && data.live.broadcast_start ? data.live.broadcast_start * 1000 : 0;
    root.classList.toggle('is-live', isLive);
    setStatus(online);

    if (data.station) {
      setText('station-name', data.station.name || pc.stationName);
      setText('station-desc', data.station.description || '');
    }
    setText('listeners', String(data.listeners?.current ?? 0));
    setHidden('live-line', !isLive);
    setText('live-line', isLive ? `${live.label} · ${streamer}` : '');

    const np = data.now_playing || null;
    const cur = songLine(np);
    setText('title', cur.title);
    setText('artist', isLive ? streamer : cur.artist || ' ');
    setText('album', cur.album);
    setHidden('requested', cur.brk || !np?.is_request);
    playedAt = (np?.played_at || 0) * 1000;
    duration = np?.duration || 0;

    const rawArt = (isLive && data.live.art) || cur.song.art || '';
    if (rawArt && rawArt !== lastArt) {
      lastArt = rawArt;
      const artUrl = toSameOriginArt(rawArt);
      for (const img of all<HTMLImageElement>('art')) {
        img.src = artUrl;
        img.alt = `Cover art: ${cur.title}${cur.artist ? ` by ${cur.artist}` : ''}`;
      }
      // effects.ts extracts the album palette from this (same-origin) URL.
      document.dispatchEvent(new CustomEvent('efm:track-art', { detail: { url: artUrl } }));
    }

    const metaArtist = isLive ? `${live.elapsedPrefix}: ${streamer}` : cur.artist || 'EuphoricFM';
    const metaKey = `${np?.sh_id}|${cur.title}|${metaArtist}`;
    if (metaKey !== lastMetaKey) {
      lastMetaKey = metaKey;
      setMediaMetadata(cur.brk ? { title: cur.title, art: cur.song.art } : cur.song, metaArtist);
      titleText = `${cur.title} – ${isLive ? streamer : cur.artist || 'EuphoricFM'}`;
      paintDocTitle();
    }

    // Up next — hidden during a live set, for ads/imaging, or when missing.
    const nextEntry = data.playing_next || null;
    const next = songLine(nextEntry);
    hasNext = !!nextEntry && !next.brk && !isLive;
    setHidden('next', !hasNext);
    if (hasNext) {
      setText('next-title', next.title);
      setText('next-sub', [next.artist, next.album].filter(Boolean).join(' · '));
      setText('next-line', [next.title, next.artist].filter(Boolean).join(' · '));
      setHidden('next-requested', !nextEntry!.is_request);
      const nextArt = next.song.art || '';
      for (const img of all<HTMLImageElement>('next-art')) if (nextArt && img.src !== nextArt) img.src = nextArt;
    } else {
      setText('next-line', isLive ? `${live.label}` : '—');
    }

    applyMounts(data);
    renderHistory(data.song_history || []);
  };

  // The station's API is unreachable (network error, timeout, 5xx): show the
  // offline state instead of a live-looking "Loading…" + AUTO DJ, stop the
  // stream (same server) and keep retrying; the next good poll repaints all.
  const onUnavailable = (failures: number) => {
    if (offline || !stationUnavailable(failures, hasData)) return;
    offline = true;
    isLive = false;
    broadcastStartMs = 0;
    root.classList.remove('is-live');
    setStatus(false);
    setText('title', pc.offline);
    setText('artist', ' ');
    setText('album', '');
    setText('listeners', '0');
    setHidden('live-line', true);
    setHidden('requested', true);
    hasNext = false;
    setHidden('next', true);
    setText('next-line', '—');
    playedAt = 0;
    duration = 0;
    for (const b of bars) b.style.width = '0%';
    setText('elapsed', '0:00');
    setText('duration', '0:00');
    lastMetaKey = '';
    titleText = '';
    // Nothing loaded yet: the history's "Loading…" placeholder goes too.
    if (!hasData && histList) histList.innerHTML = `<li class="efmp-hist-empty">${escapeHtml(pc.offline)}</li>`;
    if (engine.isPlaying()) engine.stop();
    paintDocTitle();
  };

  // ---- Progress (RAF, text only rewritten when it changes) ----------------
  const bars = all('bar');
  const tick = () => {
    if (isLive) {
      setText(
        'elapsed',
        broadcastStartMs > 0
          ? `${live.elapsedPrefix} · ${fmtElapsed(Math.max(0, (Date.now() - broadcastStartMs) / 1000))}`
          : live.elapsedPrefix,
      );
      setText('duration', '');
    } else if (duration > 0 && playedAt > 0) {
      const elapsed = Math.min(duration, Math.max(0, (Date.now() - playedAt) / 1000));
      const pct = `${(elapsed / duration) * 100}%`;
      for (const b of bars) b.style.width = pct;
      setText('elapsed', fmtTime(elapsed));
      setText('duration', fmtTime(duration));
      if (hasNext) {
        const remaining = duration - elapsed;
        setText('next-when', remaining > 1 ? `in ${fmtTime(remaining)}` : 'next');
      }
    }
    requestAnimationFrame(tick);
  };

  bindMediaSessionActions();
  subscribeNowPlaying(onNowPlaying, onUnavailable);
  requestAnimationFrame(tick);
})();
