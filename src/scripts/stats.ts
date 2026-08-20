// Client-side driver for the Station Stats section (src/components/Stats.astro).
//
// Progressive enhancement: the section starts `hidden`; this module fetches
// `/stats/summary` (same-origin, reverse-proxied by Caddy to the efm-requests
// sidecar — see server/stats.mjs) 800ms after load and only unhides the
// section on success with totals.plays > 0. No sidecar (e.g. `pnpm dev`) or
// an empty store (fresh boot, no data yet) both leave the section hidden —
// that's the intended graceful-degradation behaviour, not a bug.
//
// All SVG nodes are built with document.createElementNS — createElement
// renders nothing for SVG tags, the classic silent failure. All dynamic
// strings reach the DOM via textContent only, never innerHTML.

import { site } from '../site.config';
import type {
  StatsSummary,
  StatsDay,
  ListenersSeries,
  ListenersRange,
  TrackDetail,
  TrackDetailMonth,
  TrackDetailResponse,
  ArtistDetail,
  ArtistDetailResponse,
} from '../lib/stats';

type PlaysRange = '30d' | '90d' | '1y' | 'all';
type RhythmBasis = 'hour' | 'day';
type DetailView = { kind: 'track'; id: string } | { kind: 'artist'; name: string };

// A single plotted point, shared by the chart renderer and its table twin.
interface PlotPoint {
  value: number | null; // null = gap (no data); zero is a real, plotted value
  label: string; // full-precision label — tooltip + table first column
  tick?: string; // short axis tick text; points without one get none
  tickAnchor?: 'start' | 'middle' | 'end';
  extra?: (number | null)[]; // extra table-only columns (e.g. peak alongside avg)
}

(() => {
  const s = site.stats;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T | null;

  // createElementNS for ALL svg nodes; setAttribute for every geometry attr.
  const svgEl = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs?: Record<string, string>,
  ): SVGElementTagNameMap[K] => {
    const el = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
    if (attrs) {
      for (const key in attrs) el.setAttribute(key, attrs[key]);
    }
    return el;
  };

  // Duplicated from nowplaying.ts on purpose (spec: "do not modify
  // nowplaying.ts") — rewrites euphoric.fm album-art URLs to same-origin
  // /efm-art/... so they load under CSP without a separate connect-src grant.
  const toSameOriginArt = (raw: string): string => {
    try {
      const u = new URL(raw, location.href);
      return u.origin === 'https://euphoric.fm' ? '/efm-art' + u.pathname + u.search : raw;
    } catch {
      return raw;
    }
  };

  // ---- number + date formatting -------------------------------------------

  const fullNumber = (n: number): string => new Intl.NumberFormat().format(n);

  // Compact tile/tick formatting (412345 -> "412K", 1.2e6 -> "1.2M"). Hand
  // rolled rather than Intl notation:'compact' so the exact K/M/B thresholds
  // and 1dp rounding are under our control and don't depend on locale data.
  const compactNumber = (n: number): string => {
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n);
    if (abs < 1000) return fullNumber(Math.round(n));
    const units: [number, string][] = [
      [1e9, 'B'],
      [1e6, 'M'],
      [1e3, 'K'],
    ];
    for (const [v, suffix] of units) {
      if (abs >= v) {
        const scaled = abs / v;
        const text = scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : String(Math.round(scaled));
        return `${sign}${text}${suffix}`;
      }
    }
    return fullNumber(n);
  };

  // Replaced with the real value once /stats/summary loads (meta.timezone).
  // Every Intl formatter below reads this live rather than capturing it, so
  // formatters built before load still resolve to the right zone.
  let TZ = 'America/New_York';

  const monthYearFmt = () =>
    new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', year: 'numeric' });
  const fullDateFmt = () =>
    new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });

  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // 'YYYY-MM-DD' -> "Mon D" WITHOUT ever building a Date from the string. A
  // Date parsed from a bare date string is UTC-midnight; reformatting that
  // through the station timezone (ET, UTC-4/5) can print the WRONG day
  // (shifts a day backward). Pure string parsing sidesteps the bug: `d` is
  // already a station-TZ calendar day, so the label is read straight off it.
  const dayLabel = (d: string): string => {
    const parts = d.split('-');
    const mi = parseInt(parts[1] ?? '1', 10) - 1;
    return `${MONTH_SHORT[mi] ?? parts[1]} ${parseInt(parts[2] ?? '1', 10)}`;
  };
  // Year-carrying variants for series that span years (the ALL/1Y ranges):
  // a bare "Jun 14" on a three-year axis is ambiguous. Ticks drop the day —
  // month+year is the useful granularity at that zoom; tooltips keep it.
  const dayLabelWithYear = (d: string): string => `${dayLabel(d)}, ${d.slice(0, 4)}`;
  const dayTickMonthYear = (d: string): string => monthLabel(d.slice(0, 7));
  // A day series needs year-carrying labels when it crosses a year boundary.
  const spansYears = (first?: string, last?: string): boolean =>
    !!first && !!last && first.slice(0, 4) !== last.slice(0, 4);
  const monthLabel = (m: string): string => {
    const parts = m.split('-');
    const mi = parseInt(parts[1] ?? '1', 10) - 1;
    return `${MONTH_SHORT[mi] ?? parts[1]} ${parts[0]}`;
  };

  // ISO-week (Monday) bucket key for a 'YYYY-MM-DD' day string — this is
  // bucketing MATH, not a label, so (unlike dayLabel) it's fine to parse a
  // Date here. Anchored at noon UTC to sidestep any DST-transition edge case.
  const isoWeekMonday = (d: string): string => {
    const dt = new Date(`${d}T12:00:00Z`);
    const dow = dt.getUTCDay(); // 0=Sun..6=Sat
    const back = dow === 0 ? 6 : dow - 1;
    dt.setUTCDate(dt.getUTCDate() - back);
    const y = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const da = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  };

  const addDaysISO = (d: string, days: number): string => {
    const dt = new Date(`${d}T12:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  };

  const todayStationISO = (): string => {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
    return `${get('year')}-${get('month')}-${get('day')}`;
  };

  // 24h/7d/30d listener buckets carry a real unix-second `t` — format those
  // through the station timezone per spec (this is a real instant, unlike
  // the date-only `d` strings above, so there's no reinterpretation bug).
  const listenerLabel = (range: ListenersRange, t: number): string => {
    const dt = new Date(t * 1000);
    return range === '24h'
      ? new Intl.DateTimeFormat(undefined, { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(dt)
      : new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric' }).format(dt);
  };
  const listenerTick = (range: ListenersRange, t: number): string => {
    const dt = new Date(t * 1000);
    return range === '24h'
      ? new Intl.DateTimeFormat(undefined, { timeZone: TZ, hour: 'numeric' }).format(dt)
      : new Intl.DateTimeFormat(undefined, { timeZone: TZ, month: 'short', day: 'numeric' }).format(dt);
  };

  // Rhythm hour/dow buckets are already station-local abstractions (hour 0-23
  // of day, day 0-6 of week) — NOT unix instants — so they are labelled with
  // plain lookup tables, never routed through a timezone-aware Date/Intl call.
  const HOUR_FULL = Array.from({ length: 24 }, (_, h) => {
    const period = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12} ${period}`;
  });
  const HOUR_TICKS: Record<number, string> = { 0: '12a', 6: '6a', 12: '12p', 18: '6p' };
  const DOW_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DOW_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  // Evenly-spaced tick indices, always including both ends. Width-aware:
  // ~90px per date label keeps a middle-anchored tick from colliding with
  // the end-anchored last one on narrow plots (seen at 390px in the detail
  // overlay's monthly chart — "Nov 2025"/"Aug 2026" overlapped at 5 ticks).
  // Usable plot width of a chart wrapper (falls back to a phone-ish default
  // when the element is unmeasured), minus the fixed PAD insets.
  const plotWOf = (el: HTMLElement | null): number =>
    Math.max(200, (el?.clientWidth || 360) - 44 /* PAD.left + PAD.right */);

  const pickTicks = (n: number, plotW = 360): Set<number> => {
    const count = Math.max(2, Math.min(5, Math.floor(plotW / 90) + 1, n));
    const idxs = new Set<number>();
    for (let k = 0; k < count; k++) {
      idxs.add(Math.round((k / (count - 1)) * (n - 1)));
    }
    return idxs;
  };

  // ---- DOM refs -------------------------------------------------------------

  const elSection = $('stats-section');
  const elCoverage = $('stats-coverage');

  const elKpiPlaysValue = $('stats-kpi-plays-value');
  const elKpiPlaysSub = $('stats-kpi-plays-sub');
  const elKpiPeakValue = $('stats-kpi-peak-value');
  const elKpiPeakSub = $('stats-kpi-peak-sub');
  const elKpiTracksValue = $('stats-kpi-tracks-value');
  const elKpiTracksSub = $('stats-kpi-tracks-sub');
  const elKpiRequestsValue = $('stats-kpi-requests-value');
  const elKpiRequestsSub = $('stats-kpi-requests-sub');

  const elListenersTabs = $('stats-listeners-tabs');
  const elListenersChart = $('stats-listeners-chart');
  const elListenersTable = $('stats-listeners-table');

  const elPlaysTabs = $('stats-plays-tabs');
  const elPlaysSub = $('stats-plays-sub');
  const elPlaysChart = $('stats-plays-chart');
  const elPlaysTable = $('stats-plays-table');

  const elRhythmTabs = $('stats-rhythm-tabs');
  const elRhythmSub = $('stats-rhythm-sub');
  const elRhythmChart = $('stats-rhythm-chart');
  const elRhythmTable = $('stats-rhythm-table');

  const elTopTracksList = $('stats-top-tracks-list');
  const elTopTracksMore = $('stats-top-tracks-more');
  const elTopArtistsList = $('stats-top-artists-list');
  const elTopArtistsMore = $('stats-top-artists-more');

  const elOverlay = $('stats-detail-overlay');
  const elDetailBack = $<HTMLButtonElement>('stats-detail-back');
  const elDetailTitle = $('stats-detail-title');
  const elDetailBody = $('stats-detail-body');
  const elDetailClose = elOverlay?.querySelector<HTMLButtonElement>('[data-close]') ?? null;

  // ---- generic tab helper ----------------------------------------------------

  const updateTabs = (container: HTMLElement | null, attr: string, value: string) => {
    if (!container) return;
    container.querySelectorAll<HTMLButtonElement>(`button[data-${attr}]`).forEach((btn) => {
      const active = btn.getAttribute(`data-${attr}`) === value;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  };

  // ---- table twin -------------------------------------------------------------

  const buildTable = (
    container: HTMLElement | null,
    headers: string[],
    points: PlotPoint[],
    primaryFmt: (v: number) => string,
    extraFmt: (v: number) => string,
  ) => {
    if (!container) return;
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    headers.forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    points.forEach((p) => {
      const tr = document.createElement('tr');
      const tdLabel = document.createElement('td');
      tdLabel.textContent = p.label;
      tr.appendChild(tdLabel);
      const tdVal = document.createElement('td');
      tdVal.className = 'tabular-nums';
      tdVal.textContent = p.value === null ? '—' : primaryFmt(p.value);
      tr.appendChild(tdVal);
      (p.extra ?? []).forEach((ev) => {
        const td = document.createElement('td');
        td.className = 'tabular-nums';
        td.textContent = ev === null || ev === undefined ? '—' : extraFmt(ev);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    container.innerHTML = ''; // static clear — no dynamic string involved
    container.appendChild(table);
  };

  // ---- chart renderer ---------------------------------------------------------
  //
  // Explicit insets so nothing clips at the viewBox edge; single series, no
  // legends, no dual axes. viewBox width tracks the wrapper's current CSS
  // width (fallback 320) so the chart is crisp at any phone/desktop size;
  // callers re-invoke this on a debounced resize to keep it that way.

  const PAD = { left: 34, right: 10, top: 8, bottom: 18 };
  let chartIdCounter = 0;

  const niceMax = (v: number): number => {
    if (v <= 0) return 1;
    const exp = Math.floor(Math.log10(v));
    const base = Math.pow(10, exp);
    const n = v / base;
    const niceN = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return niceN * base;
  };

  interface ChartOpts {
    wrapper: HTMLElement;
    kind: 'area' | 'column';
    height: number;
    points: PlotPoint[];
    idPrefix: string;
    yTickFormatter: (v: number) => string;
    tooltipValueFormatter: (v: number) => string;
  }

  const renderChart = (opts: ChartOpts): void => {
    const { wrapper, kind, height, points, idPrefix, yTickFormatter, tooltipValueFormatter } = opts;
    wrapper.innerHTML = '';

    const plottableCount = points.filter((p) => p.value !== null).length;
    if (plottableCount < 2) {
      const note = document.createElement('div');
      note.className = 'flex items-center justify-center h-full text-xs text-cream/40';
      note.textContent = s.notEnoughData;
      wrapper.appendChild(note);
      return;
    }

    const n = points.length;
    const W = wrapper.clientWidth || 320;
    const H = height;
    const plotX0 = PAD.left;
    const plotX1 = W - PAD.right;
    const plotY0 = PAD.top;
    const plotY1 = H - PAD.bottom;
    const plotW = Math.max(1, plotX1 - plotX0);
    const plotH = Math.max(1, plotY1 - plotY0);

    const maxVal = Math.max(0, ...points.map((p) => p.value ?? 0));
    const yMax = niceMax(maxVal || 1);
    const yOf = (v: number) => plotY1 - (v / yMax) * plotH;
    const xOf = (i: number) => (n === 1 ? (plotX0 + plotX1) / 2 : plotX0 + (i / (n - 1)) * plotW);

    const svg = svgEl('svg', {
      viewBox: `0 0 ${W} ${H}`,
      width: '100%',
      height: String(H),
      preserveAspectRatio: 'xMidYMid meet',
      'aria-hidden': 'true',
    });
    svg.style.display = 'block';

    // Grid: 3 horizontal hairlines + a slightly bolder baseline axis line.
    [0, yMax / 2, yMax].forEach((gv) => {
      const y = yOf(gv);
      svg.appendChild(
        svgEl('line', {
          x1: String(plotX0),
          x2: String(plotX1),
          y1: String(y),
          y2: String(y),
          stroke: 'rgb(var(--efm-cream-rgb) / 0.08)',
          'stroke-width': '1',
        }),
      );
      const label = svgEl('text', {
        x: String(plotX0 - 6),
        y: String(y + 3),
        'text-anchor': 'end',
        'font-size': '10',
        fill: 'rgb(var(--efm-cream-rgb) / 0.45)',
      });
      label.textContent = yTickFormatter(gv);
      svg.appendChild(label);
    });
    svg.appendChild(
      svgEl('line', {
        x1: String(plotX0),
        x2: String(plotX1),
        y1: String(plotY1),
        y2: String(plotY1),
        stroke: 'rgb(var(--efm-cream-rgb) / 0.15)',
        'stroke-width': '1',
      }),
    );

    // X ticks — only points carrying a `.tick` label get one.
    points.forEach((p, i) => {
      if (!p.tick) return;
      const text = svgEl('text', {
        x: String(xOf(i)),
        y: String(H - 4),
        'text-anchor': p.tickAnchor ?? 'middle',
        'font-size': '10',
        fill: 'rgb(var(--efm-cream-rgb) / 0.45)',
      });
      text.textContent = p.tick;
      svg.appendChild(text);
    });

    let dot: SVGCircleElement | null = null;
    let crosshair: SVGLineElement | null = null;
    let barsByIndex: (SVGPathElement | null)[] = [];
    let hitTargets: { x0: number; x1: number; idx: number }[] = [];

    if (kind === 'area') {
      const gradId = `efm-stats-grad-${idPrefix}-${chartIdCounter++}`;
      const defs = svgEl('defs');
      const grad = svgEl('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
      grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': 'rgb(var(--efm-sunburst-rgb))', 'stop-opacity': '0.22' }));
      grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': 'rgb(var(--efm-sunburst-rgb))', 'stop-opacity': '0.02' }));
      defs.appendChild(grad);
      svg.appendChild(defs);

      // Null values break the line into gap segments — draw each contiguous
      // non-null run as its own line+area pair sharing the same gradient.
      const segments: number[][] = [];
      let seg: number[] = [];
      points.forEach((p, i) => {
        if (p.value === null) {
          if (seg.length) segments.push(seg);
          seg = [];
        } else {
          seg.push(i);
        }
      });
      if (seg.length) segments.push(seg);

      segments.forEach((idxs) => {
        if (idxs.length < 2) return; // an isolated point has no line to draw
        const lineD = idxs
          .map((i, k) => `${k === 0 ? 'M' : 'L'} ${xOf(i)} ${yOf(points[i].value as number)}`)
          .join(' ');
        const areaD = `${lineD} L ${xOf(idxs[idxs.length - 1])} ${plotY1} L ${xOf(idxs[0])} ${plotY1} Z`;
        svg.appendChild(svgEl('path', { d: areaD, fill: `url(#${gradId})`, stroke: 'none' }));
        svg.appendChild(
          svgEl('path', {
            d: lineD,
            fill: 'none',
            stroke: 'rgb(var(--efm-sunburst-rgb))',
            'stroke-width': '2',
            'stroke-linejoin': 'round',
            'stroke-linecap': 'round',
          }),
        );
      });

      crosshair = svgEl('line', {
        x1: '0',
        x2: '0',
        y1: String(plotY0),
        y2: String(plotY1),
        stroke: 'rgb(var(--efm-cream-rgb) / 0.25)',
        'stroke-width': '1',
      });
      crosshair.style.display = 'none';
      svg.appendChild(crosshair);
      dot = svgEl('circle', {
        r: '4',
        fill: 'rgb(var(--efm-sunburst-rgb))',
        stroke: 'rgb(var(--efm-ink-rgb))',
        'stroke-width': '2',
      });
      dot.style.display = 'none';
      svg.appendChild(dot);

      hitTargets = points.map((_, i) => {
        const x = xOf(i);
        const halfL = i === 0 ? (xOf(1) - x) / 2 : (x - xOf(i - 1)) / 2;
        const halfR = i === n - 1 ? halfL : (xOf(i + 1) - x) / 2;
        return { x0: x - halfL, x1: x + halfR, idx: i };
      });
    } else {
      const bandW = plotW / n;
      const barW = Math.max(2, Math.min(24, bandW * 0.6));
      barsByIndex = new Array(n).fill(null);
      points.forEach((p, i) => {
        if (p.value === null) return; // no bar — reserved, empty slot
        const cx = xOf(i);
        const y = yOf(p.value);
        const h = Math.max(0, plotY1 - y);
        if (h <= 0) return;
        const r = Math.min(3, barW / 2, h);
        // Rounded TOP corners only; square baseline.
        const d =
          `M ${cx - barW / 2} ${plotY1} ` +
          `L ${cx - barW / 2} ${y + r} Q ${cx - barW / 2} ${y} ${cx - barW / 2 + r} ${y} ` +
          `L ${cx + barW / 2 - r} ${y} Q ${cx + barW / 2} ${y} ${cx + barW / 2} ${y + r} ` +
          `L ${cx + barW / 2} ${plotY1} Z`;
        const bar = svgEl('path', { d, fill: 'rgb(var(--efm-sunburst-rgb))', 'fill-opacity': '0.75' });
        svg.appendChild(bar);
        barsByIndex[i] = bar;
      });
      hitTargets = points.map((_, i) => {
        const cx = xOf(i);
        return { x0: cx - bandW / 2, x1: cx + bandW / 2, idx: i };
      });
    }

    // Transparent hit rect over the plot area — crosshair/tooltip driver.
    const hit = svgEl('rect', {
      x: String(plotX0),
      y: String(plotY0),
      width: String(plotW),
      height: String(plotH),
      fill: 'transparent',
    });
    svg.appendChild(hit);
    wrapper.appendChild(svg);

    const tooltip = document.createElement('div');
    tooltip.className = 'efm-stats-tooltip';
    tooltip.style.display = 'none';
    wrapper.appendChild(tooltip);

    let hoveredColIdx = -1;
    const setColumnHighlight = (idx: number) => {
      if (hoveredColIdx >= 0) barsByIndex[hoveredColIdx]?.setAttribute('fill-opacity', '0.75');
      hoveredColIdx = idx;
      if (idx >= 0) barsByIndex[idx]?.setAttribute('fill-opacity', '1');
    };

    const showAt = (idx: number) => {
      const p = points[idx];
      if (kind === 'area') {
        if (p.value === null) {
          if (dot) dot.style.display = 'none';
          if (crosshair) crosshair.style.display = 'none';
        } else {
          if (dot) {
            dot.setAttribute('cx', String(xOf(idx)));
            dot.setAttribute('cy', String(yOf(p.value)));
            dot.style.display = '';
          }
          if (crosshair) {
            crosshair.setAttribute('x1', String(xOf(idx)));
            crosshair.setAttribute('x2', String(xOf(idx)));
            crosshair.style.display = '';
          }
        }
      }
      if (p.value === null) {
        tooltip.style.display = 'none';
        return;
      }
      tooltip.textContent = '';
      const valueEl = document.createElement('div');
      valueEl.className = 'font-semibold text-cream';
      valueEl.textContent = tooltipValueFormatter(p.value);
      const labelEl = document.createElement('div');
      labelEl.className = 'text-cream/60';
      labelEl.textContent = p.label;
      tooltip.appendChild(valueEl);
      tooltip.appendChild(labelEl);
      tooltip.style.display = '';

      const rect = svg.getBoundingClientRect();
      const scale = rect.width > 0 ? W / rect.width : 1;
      const xCss = xOf(idx) / scale;
      const wrapRect = wrapper.getBoundingClientRect();
      const tw = tooltip.offsetWidth || 80;
      const left = Math.max(4, Math.min(xCss - tw / 2, wrapRect.width - tw - 4));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(0, yOf(p.value) / scale - 32)}px`;
    };

    const findIdx = (userX: number): number => {
      if (userX < hitTargets[0].x0) return hitTargets[0].idx;
      for (const t of hitTargets) {
        if (userX >= t.x0 && userX < t.x1) return t.idx;
      }
      return hitTargets[hitTargets.length - 1].idx;
    };

    const handlePointer = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0) return;
      const scale = W / rect.width;
      const userX = (e.clientX - rect.left) * scale;
      const idx = findIdx(userX);
      if (kind === 'column') setColumnHighlight(idx);
      showAt(idx);
    };
    const handleLeave = () => {
      tooltip.style.display = 'none';
      if (crosshair) crosshair.style.display = 'none';
      if (dot) dot.style.display = 'none';
      if (kind === 'column') setColumnHighlight(-1);
    };
    hit.addEventListener('pointermove', handlePointer);
    hit.addEventListener('pointerdown', handlePointer);
    hit.addEventListener('pointerleave', handleLeave);
  };

  // ---- resize: debounced re-render of whichever charts are on screen --------

  const debounce = (fn: () => void, ms: number) => {
    let handle: number | null = null;
    return () => {
      if (handle != null) window.clearTimeout(handle);
      handle = window.setTimeout(fn, ms);
    };
  };

  let rerenderListeners: (() => void) | null = null;
  let rerenderPlays: (() => void) | null = null;
  let rerenderRhythm: (() => void) | null = null;
  let rerenderDetail: (() => void) | null = null;

  window.addEventListener(
    'resize',
    debounce(() => {
      rerenderListeners?.();
      rerenderPlays?.();
      rerenderRhythm?.();
      rerenderDetail?.();
    }, 250),
  );

  // ---- state ------------------------------------------------------------------

  let summary: StatsSummary | null = null;
  const listenersCache = new Map<ListenersRange, ListenersSeries>();
  const trackCache = new Map<string, TrackDetail>();
  const artistCache = new Map<string, ArtistDetail>();

  let activeListenersRange: ListenersRange = '24h';
  let activePlaysRange: PlaysRange = '30d';
  let activeRhythmBasis: RhythmBasis = 'hour';
  let tracksShown = 10;
  let artistsShown = 10;

  // ---- KPIs + coverage --------------------------------------------------------

  const renderCoverage = (sum: StatsSummary) => {
    if (!elCoverage) return;
    const { coverage } = sum.meta;
    if (!coverage.from) {
      elCoverage.textContent = '';
      return;
    }
    const prefix = coverage.backfill === 'done' ? s.coveragePrefixFull : s.coveragePrefixPartial;
    elCoverage.textContent = `${prefix} ${monthYearFmt().format(new Date(coverage.from * 1000))}`;
  };

  const renderKpis = (sum: StatsSummary) => {
    const { totals } = sum;
    if (elKpiPlaysValue) elKpiPlaysValue.textContent = compactNumber(totals.plays);
    if (elKpiPlaysSub) {
      elKpiPlaysSub.textContent = sum.meta.coverage.from
        ? s.kpi.plays.sub.replace('{date}', monthYearFmt().format(new Date(sum.meta.coverage.from * 1000)))
        : '';
    }
    if (elKpiPeakValue) elKpiPeakValue.textContent = compactNumber(totals.peakListeners.value);
    if (elKpiPeakSub) {
      elKpiPeakSub.textContent =
        totals.peakListeners.value > 0 && totals.peakListeners.at
          ? s.kpi.peakListeners.sub.replace('{date}', fullDateFmt().format(new Date(totals.peakListeners.at * 1000)))
          : '';
    }
    if (elKpiTracksValue) elKpiTracksValue.textContent = compactNumber(totals.uniqueTracks);
    if (elKpiTracksSub) elKpiTracksSub.textContent = s.kpi.tracks.sub.replace('{count}', fullNumber(totals.uniqueArtists));
    if (elKpiRequestsValue) elKpiRequestsValue.textContent = compactNumber(totals.requests);
    if (elKpiRequestsSub) {
      const pct = totals.plays > 0 ? (totals.requests / totals.plays) * 100 : 0;
      elKpiRequestsSub.textContent = totals.plays > 0 ? s.kpi.requests.sub.replace('{pct}', pct.toFixed(1)) : '';
    }
  };

  // ---- listeners card -----------------------------------------------------------

  const loadListeners = async (range: ListenersRange): Promise<ListenersSeries | null> => {
    const cached = listenersCache.get(range);
    if (cached) return cached;
    try {
      const r = await fetch(`/stats/listeners?range=${range}`);
      if (!r.ok) return null;
      const data = (await r.json()) as ListenersSeries;
      listenersCache.set(range, data);
      return data;
    } catch (err) {
      console.warn('[efm] /stats/listeners fetch failed', err);
      return null;
    }
  };

  const pointsFromListeners = (series: ListenersSeries, plotW: number): PlotPoint[] => {
    const n = series.points.length;
    const tickIdxs = pickTicks(n, plotW);
    const longSpan = spansYears(series.points[0]?.d, series.points[n - 1]?.d);
    return series.points.map((pt, i) => {
      let label: string;
      let tick: string | undefined;
      if (pt.d) {
        label = longSpan ? dayLabelWithYear(pt.d) : dayLabel(pt.d);
        tick = tickIdxs.has(i) ? (longSpan ? dayTickMonthYear(pt.d) : dayLabel(pt.d)) : undefined;
      } else {
        const t = pt.t ?? 0;
        label = listenerLabel(series.range, t);
        tick = tickIdxs.has(i) ? listenerTick(series.range, t) : undefined;
      }
      return {
        value: pt.avg,
        label,
        tick,
        tickAnchor: i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle',
        extra: [pt.max],
      };
    });
  };

  const showListeners = async (range: ListenersRange) => {
    activeListenersRange = range;
    updateTabs(elListenersTabs, 'range', range);
    if (!elListenersChart) return;
    // Hold the previous chart dimmed while the new range loads — no
    // skeleton, no layout jump (spec: opacity 0.5, contents untouched).
    elListenersChart.style.opacity = '0.5';
    const series = await loadListeners(range);
    elListenersChart.style.opacity = '1';
    if (!series) {
      renderChart({
        wrapper: elListenersChart,
        kind: 'area',
        height: 180,
        points: [],
        idPrefix: 'listeners',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
      rerenderListeners = null;
      if (elListenersTable) elListenersTable.innerHTML = '';
      return;
    }
    const points = pointsFromListeners(series, plotWOf(elListenersChart));
    const draw = () => {
      if (!elListenersChart) return;
      renderChart({
        wrapper: elListenersChart,
        kind: 'area',
        height: 180,
        points,
        idPrefix: 'listeners',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
    };
    draw();
    rerenderListeners = draw;
    buildTable(elListenersTable, [s.listeners.tableTime, s.listeners.tableAvg, s.listeners.tableMax], points, fullNumber, fullNumber);
  };

  // ---- plays card -----------------------------------------------------------------

  const playsPointsForRange = (
    sum: StatsSummary,
    range: PlaysRange,
    plotW: number,
  ): { points: PlotPoint[]; perWeek: boolean } => {
    let filtered: StatsDay[];
    if (range === 'all') {
      filtered = sum.days;
    } else {
      const n = range === '30d' ? 30 : range === '90d' ? 90 : 365;
      const cutoff = addDaysISO(todayStationISO(), -n);
      // Date is selected numerically-by-string, never by array index.
      filtered = sum.days.filter((d) => d.d >= cutoff);
    }
    let series: { d: string; p: number }[] = filtered.map((d) => ({ d: d.d, p: d.p }));
    let perWeek = false;
    if (series.length > 120) {
      const buckets = new Map<string, number>();
      series.forEach((pt) => {
        const wk = isoWeekMonday(pt.d);
        buckets.set(wk, (buckets.get(wk) ?? 0) + pt.p);
      });
      series = Array.from(buckets.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, p]) => ({ d, p }));
      perWeek = true;
    }
    const tickIdxs = pickTicks(series.length, plotW);
    const longSpan = spansYears(series[0]?.d, series[series.length - 1]?.d);
    const points: PlotPoint[] = series.map((pt, i) => ({
      value: pt.p,
      label: longSpan ? dayLabelWithYear(pt.d) : dayLabel(pt.d),
      tick: tickIdxs.has(i) ? (longSpan ? dayTickMonthYear(pt.d) : dayLabel(pt.d)) : undefined,
      tickAnchor: i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle',
    }));
    return { points, perWeek };
  };

  const showPlays = (range: PlaysRange) => {
    if (!summary) return;
    activePlaysRange = range;
    updateTabs(elPlaysTabs, 'range', range);
    const { points, perWeek } = playsPointsForRange(summary, range, plotWOf(elPlaysChart));
    if (elPlaysSub) elPlaysSub.textContent = perWeek ? s.plays.perWeek : s.plays.perDay;
    const draw = () => {
      if (!elPlaysChart) return;
      renderChart({
        wrapper: elPlaysChart,
        kind: 'area',
        height: 180,
        points,
        idPrefix: 'plays',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
    };
    draw();
    rerenderPlays = draw;
    buildTable(elPlaysTable, [s.plays.tableDate, s.plays.tablePlays], points, fullNumber, fullNumber);
  };

  // ---- rhythm card ----------------------------------------------------------------

  const showRhythm = (basis: RhythmBasis) => {
    if (!summary) return;
    activeRhythmBasis = basis;
    updateTabs(elRhythmTabs, 'basis', basis);
    let points: PlotPoint[];
    let usePlays: boolean;
    if (basis === 'hour') {
      const arr = summary.hours;
      usePlays = arr.every((x) => x.lavg === null);
      points = arr.map((x, i) => ({
        value: usePlays ? x.p : x.lavg,
        label: HOUR_FULL[x.h] ?? String(x.h),
        tick: HOUR_TICKS[x.h],
        tickAnchor: i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle',
      }));
    } else {
      const arr = summary.dow;
      usePlays = arr.every((x) => x.lavg === null);
      points = arr.map((x, i) => ({
        value: usePlays ? x.p : x.lavg,
        label: DOW_FULL[x.w] ?? String(x.w),
        tick: DOW_SHORT[x.w],
        tickAnchor: i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle',
      }));
    }
    if (elRhythmSub) {
      elRhythmSub.textContent =
        basis === 'hour'
          ? usePlays
            ? s.rhythm.subtitlePlaysHour
            : s.rhythm.subtitleListenersHour
          : usePlays
            ? s.rhythm.subtitlePlaysDay
            : s.rhythm.subtitleListenersDay;
    }
    const draw = () => {
      if (!elRhythmChart) return;
      renderChart({
        wrapper: elRhythmChart,
        kind: 'column',
        height: 150,
        points,
        idPrefix: 'rhythm',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
    };
    draw();
    rerenderRhythm = draw;
    const header0 = basis === 'hour' ? s.rhythm.tableHour : s.rhythm.tableDay;
    buildTable(elRhythmTable, [header0, s.rhythm.tableValue], points, fullNumber, fullNumber);
  };

  // ---- top tracks / top artists lists ----------------------------------------------

  const renderTopTracks = () => {
    if (!summary || !elTopTracksList) return;
    const list = summary.topTracks.slice(0, tracksShown);
    elTopTracksList.innerHTML = '';
    list.forEach((t, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full min-h-[48px] text-left flex items-center gap-3 py-2';
      btn.addEventListener('click', () => openTrackDetail(t.id));

      const rank = document.createElement('span');
      rank.className = 'w-6 shrink-0 text-cream/40 tabular-nums text-xs';
      rank.textContent = String(i + 1);

      const img = document.createElement('img');
      img.src = toSameOriginArt(t.art);
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.className = 'w-10 h-10 rounded-md object-cover bg-cream/10 shrink-0';

      const mid = document.createElement('div');
      mid.className = 'min-w-0 flex-1';
      const title = document.createElement('div');
      title.className = 'truncate text-sm font-semibold text-cream';
      title.textContent = t.title;
      const artist = document.createElement('div');
      artist.className = 'truncate text-xs text-cream/60';
      artist.textContent = t.artist;
      mid.appendChild(title);
      mid.appendChild(artist);

      const count = document.createElement('span');
      count.className = 'shrink-0 text-sm tabular-nums text-sunburst/90';
      count.textContent = fullNumber(t.plays);

      btn.appendChild(rank);
      btn.appendChild(img);
      btn.appendChild(mid);
      btn.appendChild(count);
      li.appendChild(btn);
      elTopTracksList.appendChild(li);
    });
    if (elTopTracksMore) {
      elTopTracksMore.classList.toggle('hidden', tracksShown >= Math.min(50, summary.topTracks.length));
    }
  };

  const renderTopArtists = () => {
    if (!summary || !elTopArtistsList) return;
    const list = summary.topArtists.slice(0, artistsShown);
    elTopArtistsList.innerHTML = '';
    list.forEach((a, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full min-h-[48px] text-left flex items-center gap-3 py-2';
      btn.addEventListener('click', () => openArtistDetail(a.name));

      const rank = document.createElement('span');
      rank.className = 'w-6 shrink-0 text-cream/40 tabular-nums text-xs';
      rank.textContent = String(i + 1);

      const mid = document.createElement('div');
      mid.className = 'min-w-0 flex-1';
      const name = document.createElement('div');
      name.className = 'truncate text-sm font-semibold text-cream';
      name.textContent = a.name;
      const sub = document.createElement('div');
      sub.className = 'truncate text-xs text-cream/60';
      sub.textContent = `${fullNumber(a.tracks)} ${s.topArtists.tracksSuffix}`;
      mid.appendChild(name);
      mid.appendChild(sub);

      const count = document.createElement('span');
      count.className = 'shrink-0 text-sm tabular-nums text-sunburst/90';
      count.textContent = fullNumber(a.plays);

      btn.appendChild(rank);
      btn.appendChild(mid);
      btn.appendChild(count);
      li.appendChild(btn);
      elTopArtistsList.appendChild(li);
    });
    if (elTopArtistsMore) {
      elTopArtistsMore.classList.toggle('hidden', artistsShown >= Math.min(50, summary.topArtists.length));
    }
  };

  elTopTracksMore?.addEventListener('click', () => {
    tracksShown = Math.min(50, tracksShown + 20);
    renderTopTracks();
  });
  elTopArtistsMore?.addEventListener('click', () => {
    artistsShown = Math.min(50, artistsShown + 20);
    renderTopArtists();
  });

  // ---- detail overlay ---------------------------------------------------------------

  // Only one level of "back" is ever available: top-level lists open a fresh
  // view (no back button); an artist's "Top tracks" row opens a track view
  // whose back returns to that one artist view, then back disappears again.
  let previousView: DetailView | null = null;

  const updateBackButton = () => {
    elDetailBack?.classList.toggle('hidden', !previousView);
  };

  const openOverlay = () => {
    elOverlay?.classList.remove('hidden');
    elOverlay?.setAttribute('aria-hidden', 'false');
  };
  const closeOverlay = () => {
    elOverlay?.classList.add('hidden');
    elOverlay?.setAttribute('aria-hidden', 'true');
    previousView = null;
    rerenderDetail = null;
  };

  const monthPoints = (months: TrackDetailMonth[], plotW: number): PlotPoint[] => {
    const tickIdxs = pickTicks(months.length, plotW);
    return months.map((m, i) => ({
      value: m.p,
      label: monthLabel(m.m),
      tick: tickIdxs.has(i) ? monthLabel(m.m) : undefined,
      tickAnchor: i === 0 ? 'start' : i === months.length - 1 ? 'end' : 'middle',
    }));
  };

  const buildMiniStats = (plays: number, requests: number, firstAt: number, lastAt: number): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'grid grid-cols-3 gap-2 mt-3 text-center';
    const cell = (label: string, value: string) => {
      const c = document.createElement('div');
      const v = document.createElement('div');
      v.className = 'text-sm font-bold text-cream tabular-nums';
      v.textContent = value;
      const l = document.createElement('div');
      l.className = 'text-[10px] uppercase tracking-wide text-cream/50';
      l.textContent = label;
      c.appendChild(v);
      c.appendChild(l);
      return c;
    };
    row.appendChild(cell(s.detail.plays, fullNumber(plays)));
    row.appendChild(cell(s.detail.requests, fullNumber(requests)));
    row.appendChild(
      cell(
        `${s.detail.firstPlayed} → ${s.detail.lastPlayed}`,
        `${monthYearFmt().format(new Date(firstAt * 1000))} → ${monthYearFmt().format(new Date(lastAt * 1000))}`,
      ),
    );
    return row;
  };

  const buildMonthlyChart = (label: string): HTMLElement => {
    const wrap = document.createElement('div');
    const heading = document.createElement('div');
    heading.className = 'text-[11px] uppercase tracking-wide text-cream/50 mt-3 mb-1';
    heading.textContent = label;
    wrap.appendChild(heading);
    const chart = document.createElement('div');
    chart.className = 'efm-stats-chart efm-stats-chart--mini';
    chart.setAttribute('role', 'img');
    chart.setAttribute('aria-label', label);
    wrap.appendChild(chart);
    return wrap;
  };

  const buildTrackRow = (t: { id: string; title: string; art: string; plays: number }, rank: number, onOpen: () => void): HTMLElement => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full min-h-[48px] text-left flex items-center gap-3 py-2';
    btn.addEventListener('click', onOpen);

    const rankEl = document.createElement('span');
    rankEl.className = 'w-6 shrink-0 text-cream/40 tabular-nums text-xs';
    rankEl.textContent = String(rank);
    const img = document.createElement('img');
    img.src = toSameOriginArt(t.art);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'w-10 h-10 rounded-md object-cover bg-cream/10 shrink-0';
    const mid = document.createElement('div');
    mid.className = 'min-w-0 flex-1';
    const title = document.createElement('div');
    title.className = 'truncate text-sm font-semibold text-cream';
    title.textContent = t.title;
    mid.appendChild(title);
    const count = document.createElement('span');
    count.className = 'shrink-0 text-sm tabular-nums text-sunburst/90';
    count.textContent = fullNumber(t.plays);

    btn.appendChild(rankEl);
    btn.appendChild(img);
    btn.appendChild(mid);
    btn.appendChild(count);
    li.appendChild(btn);
    return li;
  };

  const renderDetailError = () => {
    if (!elDetailBody) return;
    elDetailBody.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'text-xs text-ruby py-4 text-center';
    p.textContent = s.detail.loadError;
    elDetailBody.appendChild(p);
  };

  const renderTrackDetailBody = (detail: TrackDetail) => {
    if (!elDetailBody) return;
    elDetailBody.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'flex items-center gap-3';
    const img = document.createElement('img');
    img.src = toSameOriginArt(detail.art);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.className = 'w-24 h-24 rounded-xl object-cover bg-cream/10 shrink-0';
    const info = document.createElement('div');
    info.className = 'min-w-0';
    const title = document.createElement('div');
    title.className = 'text-lg font-bold text-cream truncate';
    title.textContent = detail.title;
    const artist = document.createElement('div');
    artist.className = 'text-sm text-cream/60 truncate';
    artist.textContent = detail.artist;
    info.appendChild(title);
    info.appendChild(artist);
    head.appendChild(img);
    head.appendChild(info);
    elDetailBody.appendChild(head);

    elDetailBody.appendChild(buildMiniStats(detail.plays, detail.requests, detail.firstAt, detail.lastAt));

    const chartBlock = buildMonthlyChart(s.detail.playsPerMonth);
    elDetailBody.appendChild(chartBlock);
    const chartWrap = chartBlock.querySelector<HTMLElement>('.efm-stats-chart');
    const points = monthPoints(detail.months, plotWOf(chartWrap));
    const draw = () => {
      if (!chartWrap) return;
      renderChart({
        wrapper: chartWrap,
        kind: 'area',
        height: 120,
        points,
        idPrefix: 'detail-track',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
    };
    draw();
    rerenderDetail = draw;
  };

  const renderArtistDetailBody = (detail: ArtistDetail) => {
    if (!elDetailBody) return;
    elDetailBody.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'text-lg font-bold text-cream truncate';
    title.textContent = detail.name;
    elDetailBody.appendChild(title);

    elDetailBody.appendChild(buildMiniStats(detail.plays, detail.requests, detail.firstAt, detail.lastAt));

    const tracksNote = document.createElement('div');
    tracksNote.className = 'text-[11px] text-cream/50 mt-1 text-center';
    tracksNote.textContent = `${fullNumber(detail.tracks)} ${s.detail.tracksSuffix}`;
    elDetailBody.appendChild(tracksNote);

    const chartBlock = buildMonthlyChart(s.detail.playsPerMonth);
    elDetailBody.appendChild(chartBlock);
    const chartWrap = chartBlock.querySelector<HTMLElement>('.efm-stats-chart');
    const points = monthPoints(detail.months, plotWOf(chartWrap));
    const draw = () => {
      if (!chartWrap) return;
      renderChart({
        wrapper: chartWrap,
        kind: 'area',
        height: 120,
        points,
        idPrefix: 'detail-artist',
        yTickFormatter: compactNumber,
        tooltipValueFormatter: fullNumber,
      });
    };
    draw();
    rerenderDetail = draw;

    const tracksLabel = document.createElement('div');
    tracksLabel.className = 'text-[11px] uppercase tracking-wide text-cream/50 mt-4 mb-1';
    tracksLabel.textContent = s.detail.topTracks;
    elDetailBody.appendChild(tracksLabel);

    const list = document.createElement('ul');
    list.className = 'divide-y divide-cream/5';
    const artistView: DetailView = { kind: 'artist', name: detail.name };
    detail.topTracks.slice(0, 20).forEach((t, i) => {
      list.appendChild(buildTrackRow(t, i + 1, () => openTrackDetail(t.id, artistView)));
    });
    elDetailBody.appendChild(list);
  };

  const loadTrack = async (id: string): Promise<TrackDetail | null> => {
    const cached = trackCache.get(id);
    if (cached) return cached;
    try {
      const r = await fetch(`/stats/track?id=${encodeURIComponent(id)}`);
      if (!r.ok) return null;
      const data = (await r.json()) as TrackDetailResponse;
      trackCache.set(id, data.track);
      return data.track;
    } catch (err) {
      console.warn('[efm] /stats/track fetch failed', err);
      return null;
    }
  };
  const loadArtist = async (name: string): Promise<ArtistDetail | null> => {
    const cached = artistCache.get(name);
    if (cached) return cached;
    try {
      const r = await fetch(`/stats/artist?name=${encodeURIComponent(name)}`);
      if (!r.ok) return null;
      const data = (await r.json()) as ArtistDetailResponse;
      artistCache.set(name, data.artist);
      return data.artist;
    } catch (err) {
      console.warn('[efm] /stats/artist fetch failed', err);
      return null;
    }
  };

  async function openTrackDetail(id: string, from?: DetailView) {
    previousView = from ?? null;
    openOverlay();
    updateBackButton();
    if (elDetailTitle) elDetailTitle.textContent = '';
    if (elDetailBody) elDetailBody.innerHTML = '';
    const detail = await loadTrack(id);
    if (!detail) {
      renderDetailError();
      return;
    }
    if (elDetailTitle) elDetailTitle.textContent = detail.title;
    renderTrackDetailBody(detail);
  }
  async function openArtistDetail(name: string, from?: DetailView) {
    previousView = from ?? null;
    openOverlay();
    updateBackButton();
    if (elDetailTitle) elDetailTitle.textContent = '';
    if (elDetailBody) elDetailBody.innerHTML = '';
    const detail = await loadArtist(name);
    if (!detail) {
      renderDetailError();
      return;
    }
    if (elDetailTitle) elDetailTitle.textContent = detail.name;
    renderArtistDetailBody(detail);
  }

  elDetailBack?.addEventListener('click', () => {
    const target = previousView;
    if (!target) return;
    if (target.kind === 'track') openTrackDetail(target.id);
    else openArtistDetail(target.name);
  });

  // data-close lives ONLY on this button (never the overlay root) so
  // ActionRow's document-level `closest('[data-close]')` handler can't treat
  // a click anywhere inside the overlay as a close. ActionRow's delegated
  // handler also fires and toggles the same classes — harmless, idempotent —
  // but our own listener is what resets previousView/rerenderDetail.
  elDetailClose?.addEventListener('click', () => closeOverlay());
  // Backdrop dismiss: only a click on the overlay root itself (the
  // semi-opaque bg-ink/90 backdrop), never a click that bubbled from content.
  elOverlay?.addEventListener('click', (e) => {
    if (e.target === elOverlay) closeOverlay();
  });
  // Own Escape listener — ActionRow's keydown handler only knows its own
  // hardcoded overlay id list, which is not ours to edit.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (elOverlay && !elOverlay.classList.contains('hidden')) closeOverlay();
  });

  // ---- tab wiring ---------------------------------------------------------------

  elListenersTabs?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-range]');
    const range = btn?.dataset.range as ListenersRange | undefined;
    if (range) void showListeners(range);
  });
  elPlaysTabs?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-range]');
    const range = btn?.dataset.range as PlaysRange | undefined;
    if (range) showPlays(range);
  });
  elRhythmTabs?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-basis]');
    const basis = btn?.dataset.basis as RhythmBasis | undefined;
    if (basis) showRhythm(basis);
  });

  // ---- boot -------------------------------------------------------------------------

  const boot = async () => {
    try {
      const r = await fetch('/stats/summary');
      if (!r.ok) return;
      const data = (await r.json()) as StatsSummary;
      if (!data.ok || !data.totals || data.totals.plays === 0) return;
      summary = data;
      TZ = data.meta.timezone || TZ;
      elSection?.classList.remove('hidden');
      renderCoverage(data);
      renderKpis(data);
      tracksShown = 10;
      artistsShown = 10;
      renderTopTracks();
      renderTopArtists();
      void showListeners(activeListenersRange);
      showPlays(activePlaysRange);
      showRhythm(activeRhythmBasis);
    } catch (err) {
      console.warn('[efm] /stats/summary fetch failed', err);
    }
  };

  setTimeout(boot, 800);
})();
