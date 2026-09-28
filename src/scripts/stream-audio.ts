// stream-audio.ts — the live-stream audio engine shared by the home
// PlayerCard and the Web Player (/player/). It owns the <audio> element's
// play/stop cycle and the Web Audio analyser that writes --efm-bass / --efm-mid
// / --efm-high / --efm-energy on :root every frame so anything on the page can
// react to the music. UI (icons, labels) stays with the caller via onChange.
//
// The stream is live, so there is no seeking: play sets `src` to the stream
// URL plus a `?t=<now>` cache-buster (always the live edge, never a stale
// buffer) and stop clears `src` so the connection is released.

export interface StreamEngineOptions {
  audio: HTMLAudioElement;
  /** Current stream URL — read on every play, so a picker can change it. */
  getStreamUrl: () => string;
  /** Element that gets `.is-playing` (and loses it when the reaction stops). */
  card?: HTMLElement | null;
  /** Called whenever playback starts or stops. */
  onChange?: (playing: boolean) => void;
}

export interface StreamEngine {
  toggle: () => Promise<void>;
  play: () => Promise<void>;
  stop: () => void;
  /** Re-open the stream (e.g. after the quality picker changed) if playing. */
  restart: () => Promise<void>;
  isPlaying: () => boolean;
}

export const createStreamEngine = (opts: StreamEngineOptions): StreamEngine => {
  const { audio, card } = opts;
  const root = document.documentElement;

  let audioCtx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArr: Uint8Array<ArrayBuffer> | null = null;
  let rafId = 0;
  let playing = false;

  const setupAnalyser = async (): Promise<boolean> => {
    try {
      if (audioCtx) {
        if (audioCtx.state === 'suspended') await audioCtx.resume();
        return true;
      }
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      audioCtx = new AC();
      if (audioCtx.state === 'suspended') await audioCtx.resume();

      const sourceNode = audioCtx.createMediaElementSource(audio);
      analyser = audioCtx.createAnalyser();
      // 256 bins gives us enough resolution for bass/mid/high splits while
      // keeping the per-frame copy cheap.
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -10;
      dataArr = new Uint8Array(analyser.frequencyBinCount);
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);
      return true;
    } catch (err) {
      console.warn('[efm] Web Audio unavailable; reactions disabled', err);
      return false;
    }
  };

  // Per-frame tick — reads the FFT and writes four CSS variables on :root.
  // Bands split roughly:
  //   bass:  0 –  8% of bins  (kick + bass)
  //   mid:   8 – 35%          (vocals, snare, instruments)
  //   high: 35 – 100%         (cymbals, brightness)
  //   energy: average of all  (overall loudness)
  const tickReact = () => {
    if (analyser && dataArr) {
      analyser.getByteFrequencyData(dataArr);
      const n = dataArr.length;
      const bassEnd = Math.max(2, Math.floor(n * 0.08));
      const midEnd = Math.max(bassEnd + 2, Math.floor(n * 0.35));
      let bs = 0, md = 0, hi = 0, all = 0;
      for (let i = 0; i < n; i++) {
        const v = dataArr[i];
        all += v;
        if (i < bassEnd) bs += v;
        else if (i < midEnd) md += v;
        else hi += v;
      }
      root.style.setProperty('--efm-bass', ((bs / bassEnd) / 255).toFixed(3));
      root.style.setProperty('--efm-mid', ((md / (midEnd - bassEnd)) / 255).toFixed(3));
      root.style.setProperty('--efm-high', ((hi / (n - midEnd)) / 255).toFixed(3));
      root.style.setProperty('--efm-energy', ((all / n) / 255).toFixed(3));
    }
    rafId = requestAnimationFrame(tickReact);
  };

  const startReact = async () => {
    // Effects toggle (effects.ts) can disable all visual reactivity while the
    // music keeps playing. window.__efmFx is the live flag.
    const fx = (window as unknown as { __efmFx?: { on: boolean } }).__efmFx;
    if (fx && !fx.on) return;
    const ok = await setupAnalyser();
    if (!ok) return;
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tickReact);
  };
  const stopReact = () => {
    cancelAnimationFrame(rafId);
    // Reset all reactivity vars so the page settles back to its idle look.
    root.style.removeProperty('--efm-bass');
    root.style.removeProperty('--efm-mid');
    root.style.removeProperty('--efm-high');
    root.style.removeProperty('--efm-energy');
    if (card) card.classList.remove('is-playing');
  };

  audio.crossOrigin = 'anonymous';

  const setPlaying = (isPlaying: boolean) => {
    playing = isPlaying;
    if (card) card.classList.toggle('is-playing', isPlaying);
    opts.onChange?.(isPlaying);
  };

  const play = async () => {
    const url = opts.getStreamUrl();
    audio.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
    await audio.play();
    setPlaying(true);
    await startReact();
  };

  const stop = () => {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    setPlaying(false);
    stopReact();
  };

  const toggle = async () => {
    try {
      if (audio.paused) await play();
      else stop();
    } catch (err) {
      console.warn('[efm] audio play failed', err);
    }
  };

  const restart = async () => {
    if (!playing) return;
    try {
      await play();
    } catch (err) {
      console.warn('[efm] audio restart failed', err);
      stop();
    }
  };

  audio.addEventListener('ended', () => { setPlaying(false); stopReact(); });
  audio.addEventListener('error', () => { setPlaying(false); stopReact(); });

  // Effects toggle flipped (effects.ts): stop writing FFT vars when off, and
  // resume if it's turned back on mid-playback. Music itself is unaffected.
  document.addEventListener('efm:fx-change', (e) => {
    const on = (e as CustomEvent<{ on?: boolean }>).detail?.on;
    if (!on) stopReact();
    else if (playing) startReact();
  });

  // Bridge for the Media Session API handlers (np-core.ts).
  window.__efmAudio = {
    play: () => { if (audio.paused) void toggle(); },
    pause: () => { if (!audio.paused) void toggle(); },
    el: audio,
  };

  return { toggle, play, stop, restart, isPlaying: () => playing };
};
