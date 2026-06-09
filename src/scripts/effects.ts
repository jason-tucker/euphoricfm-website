// effects.ts — owns the optional "effects" layer of the page:
//   1. Album-art colour theme  — derive a dom/accent/mute triad from the
//      current track's art, run it through the OKLCH "safe-gamut" sanitiser
//      (so it can never clash or over-contrast), and publish it as
//      --efm-theme-* on :root.
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

// ---- Album-art colour theme + OKLCH safe-gamut sanitiser ----------------
//
// Album art is arbitrary, so its raw dominant colour can be neon, near-black,
// near-white, or a hue that fights the gold/red brand — publishing that
// straight to the page is exactly what made colours "clash." Instead we work in
// OKLCH (perceptually uniform): clamp chroma + lightness into a safe band (no
// neon, no near-black/white → it always reads on the dark surface), derive an
// *analogous* dom/accent/mute triad from a single seed (so the three theme
// colours can never clash with each other), and blend each a little toward the
// brand gold so the whole palette stays in EuphoricFM's orbit. Grayscale art is
// left untinted (falls back to brand).

let lastArtUrl = '';
let extractToken = 0; // guards against a slow load resolving after a newer track

const clearTheme = (): void => {
  root.style.removeProperty('--efm-theme-dom');
  root.style.removeProperty('--efm-theme-accent');
  root.style.removeProperty('--efm-theme-mute');
};

// --- Colour maths (sRGB ↔ OKLab/OKLCH) ---------------------------------
type RGB = [number, number, number]; // channels 0..255
interface Lab { L: number; a: number; b: number; }

const clampN = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

// sRGB channel (0..255) ↔ linear-light 0..1.
const srgbToLin = (c: number): number => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const linToSrgb = (c: number): number => {
  const x = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return clampN(Math.round(x * 255), 0, 255);
};

// linear-light sRGB → OKLab (Björn Ottosson's matrices).
const rgbToLab = ([r, g, b]: RGB): Lab => {
  const lr = srgbToLin(r), lg = srgbToLin(g), lb = srgbToLin(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
};

// OKLab → linear-light sRGB (may fall outside 0..1 → out of gamut).
const labToLin = ({ L, a, b }: Lab): RGB => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
};

const inGamut = ([r, g, b]: RGB): boolean =>
  r >= -0.0015 && r <= 1.0015 && g >= -0.0015 && g <= 1.0015 && b >= -0.0015 && b <= 1.0015;

// OKLab → sRGB. If out of gamut, scale chroma (a,b) toward 0 via binary search
// so the colour lands on the gamut boundary at the same L + hue, rather than
// hard-clipping a channel (which would shift the hue and undo the safeguard).
const labToRgb = (lab: Lab): RGB => {
  let lin = labToLin(lab);
  if (!inGamut(lin)) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 18; i++) {
      const t = (lo + hi) / 2;
      lin = labToLin({ L: lab.L, a: lab.a * t, b: lab.b * t });
      if (inGamut(lin)) lo = t; else hi = t;
    }
    lin = labToLin({ L: lab.L, a: lab.a * lo, b: lab.b * lo });
  }
  return [linToSrgb(lin[0]), linToSrgb(lin[1]), linToSrgb(lin[2])];
};

// Perceptual blend of two sRGB colours through OKLab (t = weight of `y`).
const mix = (x: RGB, y: RGB, t: number): RGB => {
  const X = rgbToLab(x), Y = rgbToLab(y);
  return labToRgb({
    L: X.L + (Y.L - X.L) * t,
    a: X.a + (Y.a - X.a) * t,
    b: X.b + (Y.b - X.b) * t,
  });
};

// --- Safe bands (the safeguards) ---------------------------------------
const BRAND_GOLD: RGB = [254, 177, 57]; // #feb139 — the cohesion anchor
const BRAND_COHESION = 0.12;            // 0 = pure album colour, 1 = pure brand
const SEED_GRAY_C = 0.030;              // below this OKLCH chroma the art is ~grayscale → no tint
const C_MIN = 0.050, C_MAX = 0.150;     // chroma floor (never washed-out) / ceiling (never neon)
const L_MIN = 0.520, L_MAX = 0.700;     // lightness band — reads on #0a0a0a, never a white-out

// One OKLCH role (L, chroma, hue) → a brand-cohered, in-gamut sRGB colour.
const role = (L: number, C: number, H: number): RGB =>
  mix(labToRgb({ L, a: C * Math.cos(H), b: C * Math.sin(H) }), BRAND_GOLD, BRAND_COHESION);

// Seed sRGB colour → a harmonious dom/accent/mute triad, or null for grayscale
// art (caller then falls back to brand).
const sanitiseTheme = (seed: RGB): { dom: RGB; accent: RGB; mute: RGB } | null => {
  const { L, a, b } = rgbToLab(seed);
  const C = Math.hypot(a, b);
  if (C < SEED_GRAY_C) return null;               // grayscale → leave untinted
  const H = Math.atan2(b, a);
  const L0 = clampN(L, L_MIN, L_MAX);
  const C0 = clampN(C, C_MIN, C_MAX);
  return {
    dom: role(L0, C0, H),
    // accent: a touch brighter + a small +16° hue step → an analogous "pop".
    accent: role(clampN(L0 + 0.07, 0.58, 0.76), clampN(C0 + 0.02, C_MIN, C_MAX), H + 0.28),
    // mute: a calmer bridge — lower chroma, slightly darker, −10° the other way.
    mute: role(clampN(L0 - 0.05, 0.46, L_MAX), C0 * 0.60, H - 0.17),
  };
};

const rgb = (c: RGB): string => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

const applyTheme = (t: { dom: RGB; accent: RGB; mute: RGB }): void => {
  root.style.setProperty('--efm-theme-dom', rgb(t.dom));
  root.style.setProperty('--efm-theme-accent', rgb(t.accent));
  root.style.setProperty('--efm-theme-mute', rgb(t.mute));
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

      // Seed = saturation-weighted mean, de-emphasising near-black/white pixels
      // so the tint reflects the art's real colour, not its letterboxing. The
      // sanitiser below does the heavy lifting of keeping it on-palette.
      let rd = 0, gd = 0, bd = 0, wsum = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], alpha = data[i + 3];
        if (alpha < 128) continue;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const lum = (max + min) / 510; // 0..1
        const w = sat * 0.7 + 0.3 - Math.abs(lum - 0.5) * 0.4;
        if (w > 0) { rd += r * w; gd += g * w; bd += b * w; wsum += w; }
      }
      if (wsum < 4) { clearTheme(); return; } // too little usable colour data
      const seed: RGB = [
        Math.round(rd / wsum), Math.round(gd / wsum), Math.round(bd / wsum),
      ];
      const theme = sanitiseTheme(seed);
      if (!theme) { clearTheme(); return; } // grayscale art → brand fallback
      applyTheme(theme);
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
