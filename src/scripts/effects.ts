// effects.ts — owns the optional "effects" layer of the page:
//   1. Album-art colour theme  — extract dominant/accent/muted swatches from
//      the current track's art and publish them as --efm-theme-* on :root.
//   2. "Honey float" spring     — a tiny, hard-limited rubberband drift driven
//      by pointer position + the browser window being moved (desktop only).
//   3. Master on/off toggle      — a footer switch, persisted in localStorage,
//      that gates everything above (and PlayerCard's audio reactivity).
//
// Imported from BaseLayout alongside nowplaying.ts. nowplaying.ts dispatches
// `efm:track-art` with a same-origin art URL; PlayerCard's inline script reads
// window.__efmFx / listens for `efm:fx-change` to gate its FFT var writes.

const root = document.documentElement;
const STORAGE_KEY = 'efm-fx';

// ---- Toggle state -------------------------------------------------------

const prefersReducedMotion = (): boolean => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
};

const readStored = (): 'on' | 'off' | null => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'on' || v === 'off' ? v : null;
  } catch { return null; }
};

// Explicit stored choice wins; otherwise default OFF under reduced-motion, ON
// everywhere else. Matches the synchronous FOUC script in BaseLayout's <head>.
let effectsOn: boolean = (() => {
  const s = readStored();
  return s ? s === 'on' : !prefersReducedMotion();
})();

// Bridge for PlayerCard's inline audio script (load-order-independent: the
// getter is read lazily per frame).
(window as unknown as { __efmFx?: { on: boolean } }).__efmFx = {
  get on() { return effectsOn; },
};

// ---- Album-art colour extraction ---------------------------------------

let lastArtUrl = '';
let extractToken = 0; // guards against a slow load resolving after a newer track

const clearTheme = (): void => {
  root.style.removeProperty('--efm-theme-dom');
  root.style.removeProperty('--efm-theme-accent');
  root.style.removeProperty('--efm-theme-mute');
};

const rgb = (c: number[]): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const applyTheme = (dom: number[], accent: number[], mute: number[]): void => {
  root.style.setProperty('--efm-theme-dom', rgb(dom));
  root.style.setProperty('--efm-theme-accent', rgb(accent));
  root.style.setProperty('--efm-theme-mute', rgb(mute));
};

const extractTheme = (url: string): void => {
  if (!effectsOn || !url) return;
  const token = ++extractToken;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.onload = () => {
    if (token !== extractToken) return; // a newer track superseded this one
    try {
      const S = 24; // downscale target — ~576 px is plenty and dirt cheap
      const canvas = document.createElement('canvas');
      canvas.width = S;
      canvas.height = S;
      const ctx = canvas.getContext('2d', { willReadFrequently: true } as CanvasRenderingContext2DSettings);
      if (!ctx) { clearTheme(); return; }
      ctx.drawImage(img, 0, 0, S, S);
      const data = ctx.getImageData(0, 0, S, S).data; // throws if tainted → catch

      // Dominant = saturation-weighted mean, de-emphasising near-black/white.
      // Accent  = the single most-saturated pixel in a sane luminance band.
      let rd = 0, gd = 0, bd = 0, wsum = 0;
      let accent: number[] | null = null;
      let accSat = -1;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 128) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const lum = (max + min) / 510; // 0..1
        const w = sat * 0.7 + 0.3 - Math.abs(lum - 0.5) * 0.4;
        if (w > 0) { rd += r * w; gd += g * w; bd += b * w; wsum += w; }
        if (sat > accSat && lum > 0.25 && lum < 0.85) { accSat = sat; accent = [r, g, b]; }
      }
      if (wsum < 4) { clearTheme(); return; } // too little usable colour data
      const dom = [Math.round(rd / wsum), Math.round(gd / wsum), Math.round(bd / wsum)];
      const acc = accent ?? dom;
      const mute = [
        Math.round((dom[0] + acc[0]) / 2),
        Math.round((dom[1] + acc[1]) / 2),
        Math.round((dom[2] + acc[2]) / 2),
      ];
      applyTheme(dom, acc, mute);
    } catch {
      clearTheme(); // CORS taint, security error, decode failure → brand fallback
    }
  };
  img.onerror = () => { if (token === extractToken) clearTheme(); };
  img.src = url;
};

// ---- "Honey float" spring loop -----------------------------------------
//
// Two independent critically-ish-damped springs (one per axis). Slightly
// under-damped (ζ≈0.65) so it rubberbands a touch instead of stopping dead.
// Hard position clamp = the "couple feet of chains" — it can never drift far.

const STIFF = 50;                                  // spring constant k
const ZETA = 0.65;                                 // damping ratio (<1 → gentle overshoot)
const DAMP = 2 * ZETA * Math.sqrt(STIFF);          // damping coefficient c
const PULL = 7;                                    // px the pointer can pull at full deflection
const LIMIT = 9;                                   // px hard clamp on either side

const X = { pos: 0, vel: 0 };
const Y = { pos: 0, vel: 0 };
let pointerX = 0, pointerY = 0;                    // pointer target, normalised −1..1
let rafId = 0;
let lastTs = 0;
let lastSX = 0, lastSY = 0;                        // last window screen position

const canHover = (() => {
  try { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; }
  catch { return false; }
})();

// A window-move delta (px) → a bounded velocity impulse. Capped so a fast drag
// can't fling the springs past their clamp.
const impulse = (d: number): number => Math.max(-30, Math.min(30, d)) * 2;

const step = (a: { pos: number; vel: number }, targetN: number, imp: number, dt: number): void => {
  a.vel += imp;                                    // window-move shove
  const target = targetN * PULL;                   // pointer rest target
  const force = -STIFF * (a.pos - target) - DAMP * a.vel;
  a.vel += force * dt;
  a.pos += a.vel * dt;
  if (a.pos > LIMIT) { a.pos = LIMIT; if (a.vel > 0) a.vel = 0; }
  else if (a.pos < -LIMIT) { a.pos = -LIMIT; if (a.vel < 0) a.vel = 0; }
};

const frame = (ts: number): void => {
  if (!effectsOn) { rafId = 0; return; }           // gate: stop scheduling when off
  const dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0.016;
  lastTs = ts;

  const sx = window.screenX || 0, sy = window.screenY || 0;
  const dx = sx - lastSX, dy = sy - lastSY;        // 0 inside the CEF iframe → no-op
  lastSX = sx; lastSY = sy;

  step(X, pointerX, impulse(dx), dt);
  step(Y, pointerY, impulse(dy), dt);

  root.style.setProperty('--efm-float-x', X.pos.toFixed(2) + 'px');
  root.style.setProperty('--efm-float-y', Y.pos.toFixed(2) + 'px');

  rafId = requestAnimationFrame(frame);
};

const startSpring = (): void => {
  if (rafId || document.hidden) return;
  lastTs = 0;
  lastSX = window.screenX || 0;
  lastSY = window.screenY || 0;
  rafId = requestAnimationFrame(frame);
};

const stopSpring = (): void => {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  root.style.removeProperty('--efm-float-x');
  root.style.removeProperty('--efm-float-y');
};

if (canHover) {
  window.addEventListener('pointermove', (e) => {
    const w = window.innerWidth || 1, h = window.innerHeight || 1;
    pointerX = (e.clientX / w) * 2 - 1;
    pointerY = (e.clientY / h) * 2 - 1;
    if (effectsOn) startSpring();
  }, { passive: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopSpring();
  else if (effectsOn) startSpring();
});

// ---- State application + wiring ----------------------------------------

const toggleBtn = document.getElementById('efm-fx-toggle');

// Reconcile the DOM/loops to `effectsOn`. `persist` is false for the initial
// boot pass (don't write storage for a default the user never chose).
const applyState = (persist: boolean): void => {
  root.classList.toggle('efm-fx-off', !effectsOn);
  if (persist) {
    try { localStorage.setItem(STORAGE_KEY, effectsOn ? 'on' : 'off'); } catch { /* ignore */ }
  }
  if (toggleBtn) toggleBtn.setAttribute('aria-checked', String(effectsOn));

  if (effectsOn) {
    startSpring();
    if (lastArtUrl) extractTheme(lastArtUrl);      // re-theme from the current track
  } else {
    stopSpring();
    clearTheme();
  }

  // Let PlayerCard's inline audio script start/stop its FFT var writes.
  document.dispatchEvent(new CustomEvent('efm:fx-change', { detail: { on: effectsOn } }));
};

if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    effectsOn = !effectsOn;
    applyState(true);
  });
}

document.addEventListener('efm:track-art', (e) => {
  const url = (e as CustomEvent<{ url?: string }>).detail?.url;
  if (!url || url === lastArtUrl) return;          // dedupe — fires every poll
  lastArtUrl = url;
  extractTheme(url);
});

applyState(false);
