/* =============================================================================
   stk-charts.js — small shared chart helpers for STK pages (no dependencies).
   Load as stk-charts.js?v=N and bump N on every page that uses it whenever this file
   changes (GitHub Pages caches sub-resources for ~10 minutes). Exposes window.StkCharts:

     niceTicks(min, max, count)   { min, max, step, ticks }: round steps (1, 2, 2.5 or 5
                                  times a power of ten) covering min..max, about `count` ticks
     rollingAverage(values, n)    same length; null until a full window of n values exists
     bestSoFar(values)            the running maximum (null before the first finite value)
     nearestIndex(xs, x)          index of the closest x; ties go to the lower index; -1 if empty
     line(container, spec)        draws an SVG line chart into container; returns
                                  { select(i), destroy() }
       spec = { points: [{ x, y, label }], rolling: array | null, best: array | null,
                yFormat(n) -> string, ariaLabel: string, onSelect(index) }
       Dots for every point, a faint line joining them, a thick solid rolling-average
       line, a dashed best-so-far line and a ringed circle on the selected point. Tap or
       click selects the nearest point (onSelect is called; select() from code is not).
       Redrawn on resize; no animation. Every label is set with textContent.
   ============================================================================= */
(function () {
  "use strict";

  const SVGNS = "http://www.w3.org/2000/svg";
  const COLOURS = { point: "#8B6B49", rolling: "#6F5439", best: "#1A1A18", grid: "#D9D2C3", text: "#5A5650" };
  const MIN_WIDTH = 280;
  const isNum = (v) => typeof v === "number" && isFinite(v);

  function niceTicks(min, max, count) {
    let lo = Number(min), hi = Number(max);
    const n = Math.max(2, Math.round(isNum(count) ? count : 5));
    if (!isNum(lo) || !isNum(hi)) { lo = 0; hi = 1; }
    if (lo > hi) { const t = lo; lo = hi; hi = t; }
    if (lo === hi) { const pad = Math.abs(lo) / 2 || 0.5; lo -= pad; hi += pad; }
    const raw = (hi - lo) / (n - 1);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let mult = 10;
    for (const m of [1, 2, 2.5, 5, 10]) { if (m * mag >= raw * (1 - 1e-9)) { mult = m; break; } }
    const step = mult * mag;
    // decimals needed to print the step exactly (2.5 needs one more than the power of ten)
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (mult === 2.5 ? 1 : 0));
    const fix = (v) => { const r = Number(v.toFixed(Math.min(20, decimals))); return r === 0 ? 0 : r; }; // never -0
    const a = Math.floor(lo / step + 1e-9), b = Math.ceil(hi / step - 1e-9);
    const ticks = [];
    for (let i = a; i <= b; i++) ticks.push(fix(i * step));
    return { min: ticks[0], max: ticks[ticks.length - 1], step: fix(step), ticks };
  }

  function rollingAverage(values, windowSize) {
    const w = Math.max(1, Math.floor(windowSize));
    return values.map((_, i) => {
      if (i < w - 1) return null;
      let sum = 0;
      for (let k = i - w + 1; k <= i; k++) { if (!isNum(values[k])) return null; sum += values[k]; }
      const avg = sum / w;
      return isNum(avg) ? avg : null;
    });
  }

  function bestSoFar(values) {
    let best = null;
    return values.map((v) => { if (isNum(v) && (best === null || v > best)) best = v; return best; });
  }

  function nearestIndex(xs, x) {
    let bi = -1, bd = Infinity;
    for (let i = 0; i < xs.length; i++) { const d = Math.abs(xs[i] - x); if (d < bd) { bd = d; bi = i; } }
    return bi;
  }

  function sv(tag, attrs, text) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function line(container, spec) {
    const points = spec.points || [];
    const fmt = typeof spec.yFormat === "function" ? spec.yFormat : (v) => String(v);
    const wide = window.matchMedia("(min-width: 700px)");
    let sel = points.length ? points.length - 1 : -1;
    let geom = null, svg = null, lastW = -1, lastH = -1, dead = false;

    function series(arr) { return Array.isArray(arr) && arr.length === points.length ? arr : null; }
    const rolling = series(spec.rolling), best = series(spec.best);

    function draw() {
      if (dead) return;
      const W = Math.max(MIN_WIDTH, Math.floor(container.clientWidth || 0));
      const H = wide.matches ? 280 : 220;
      lastW = W; lastH = H;
      const vals = [];
      for (const p of points) if (isNum(p.y)) vals.push(p.y);
      for (const s of [rolling, best]) if (s) for (const v of s) if (isNum(v)) vals.push(v);
      const ax = niceTicks(vals.length ? Math.min(...vals) : 0, vals.length ? Math.max(...vals) : 1, 5);
      const labels = ax.ticks.map((t) => fmt(t));
      const ml = Math.min(120, Math.max(36, 10 + 7 * Math.max(...labels.map((l) => l.length)))), mr = 14, mt = 12, mb = 30;
      const pw = W - ml - mr, ph = H - mt - mb;
      const xOf = (i) => (points.length === 1 ? ml + pw / 2 : ml + (i / (points.length - 1)) * pw);
      const yOf = (v) => mt + (1 - (v - ax.min) / (ax.max - ax.min)) * ph;
      const s = sv("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": spec.ariaLabel || "", class: "stk-chart" });
      s.style.display = "block";
      s.style.touchAction = "pan-y";
      s.style.maxWidth = "none";
      const grid = sv("g", { "data-part": "grid" });
      ax.ticks.forEach((t, i) => {
        const y = yOf(t).toFixed(1);
        grid.append(sv("line", { x1: ml, x2: ml + pw, y1: y, y2: y, stroke: COLOURS.grid, "stroke-width": 1 }));
        grid.append(sv("text", { x: ml - 6, y: (+y + 4).toFixed(1), "text-anchor": "end", "font-size": 12, fill: COLOURS.text }, labels[i]));
      });
      s.append(grid);
      if (points.length) {
        const first = points[0], last = points[points.length - 1];
        const xl = sv("g", { "data-part": "x-labels" });
        xl.append(sv("text", { x: points.length === 1 ? xOf(0) : ml, y: H - 8, "text-anchor": points.length === 1 ? "middle" : "start", "font-size": 12, fill: COLOURS.text }, String(first.label ?? "")));
        if (points.length > 1) xl.append(sv("text", { x: ml + pw, y: H - 8, "text-anchor": "end", "font-size": 12, fill: COLOURS.text }, String(last.label ?? "")));
        s.append(xl);
      }
      const poly = (arr, attrs) => {
        // one polyline per run of consecutive finite values
        const runs = []; let cur = [];
        arr.forEach((v, i) => { if (isNum(v)) cur.push(`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`); else { if (cur.length) runs.push(cur); cur = []; } });
        if (cur.length) runs.push(cur);
        const g = sv("g", attrs);
        for (const r of runs) if (r.length >= 2) g.append(sv("polyline", { points: r.join(" "), fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round" }));
        return g;
      };
      if (points.length >= 2) s.append(poly(points.map((p) => p.y), { "data-series": "runs-line", stroke: COLOURS.point, "stroke-opacity": 0.35, "stroke-width": 1 }));
      if (rolling) s.append(poly(rolling, { "data-series": "rolling", stroke: COLOURS.rolling, "stroke-width": 3.5 }));
      if (best) s.append(poly(best, { "data-series": "best", stroke: COLOURS.best, "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
      const dots = sv("g", { "data-series": "points", fill: COLOURS.point });
      const xs = points.map((_, i) => xOf(i));
      points.forEach((p, i) => { if (isNum(p.y)) dots.append(sv("circle", { cx: xs[i].toFixed(1), cy: yOf(p.y).toFixed(1), r: 3.5 })); });
      s.append(dots);
      const ring = sv("circle", { r: 9, fill: "none", stroke: COLOURS.best, "stroke-width": 2, "data-part": "selected-ring" });
      const dot = sv("circle", { r: 6, fill: COLOURS.point, "data-part": "selected-dot" });
      s.append(ring, dot);
      geom = { xs, yOf, ring, dot };
      if (svg) svg.replaceWith(s); else container.append(s);
      svg = s;
      place();
    }
    function place() {
      if (!geom) return;
      const p = points[sel];
      const show = !!p && isNum(p.y);
      for (const c of [geom.ring, geom.dot]) {
        c.setAttribute("visibility", show ? "visible" : "hidden");
        if (show) { c.setAttribute("cx", geom.xs[sel].toFixed(1)); c.setAttribute("cy", geom.yOf(p.y).toFixed(1)); }
      }
    }
    function onClick(e) {
      if (!geom || !svg || !points.length) return;
      const r = svg.getBoundingClientRect();
      const i = nearestIndex(geom.xs, e.clientX - r.left);
      if (i < 0) return;
      sel = i; place();
      if (typeof spec.onSelect === "function") spec.onSelect(i);
    }
    function onResize() {
      const W = Math.max(MIN_WIDTH, Math.floor(container.clientWidth || 0)), H = wide.matches ? 280 : 220;
      if (W !== lastW || H !== lastH) draw();
    }

    draw();
    container.addEventListener("click", onClick);
    const ro = window.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(container);
    if (wide.addEventListener) wide.addEventListener("change", onResize);

    return {
      select(i) {
        if (dead || !points.length) return;
        sel = Math.max(0, Math.min(points.length - 1, Math.floor(i)));
        place();
      },
      destroy() {
        if (dead) return;
        dead = true;
        container.removeEventListener("click", onClick);
        if (ro) ro.disconnect();
        if (wide.removeEventListener) wide.removeEventListener("change", onResize);
        if (svg) svg.remove();
        svg = null; geom = null;
      },
    };
  }

  window.StkCharts = Object.freeze({ niceTicks, rollingAverage, bestSoFar, nearestIndex, line });
})();
