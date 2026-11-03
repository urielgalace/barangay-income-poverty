// Hand-built SVG charts. Thin marks, solid hairline grids, rounded data ends, surface rings on dots, a hover layer on
// everything. Colors come from CSS custom properties, so light and dark mode need no redraw.
import { s, tip, fmt } from "./lib.js?b=3380a9cdd9";

export const scale = (d0, d1, r0, r1) => {
  const f = (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);
  f.inv = (p) => d0 + ((p - r0) / (r1 - r0 || 1)) * (d1 - d0);
  return f;
};

export function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((m) => m >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-6; v += step) out.push(+v.toFixed(8));
  return out;
}

const canvas = document.createElement("canvas").getContext("2d");
export function textWidth(t, font = "13px 'Atkinson Hyperlegible Next', system-ui, sans-serif") {
  canvas.font = font;
  return canvas.measureText(t).width;
}

function roundedBarH(x0, x1, y, hgt, r = 4) {
  const rr = Math.min(r, Math.max(x1 - x0, 0), hgt / 2);
  return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + hgt - rr}Q${x1},${y + hgt} ${x1 - rr},${y + hgt}H${x0}Z`;
}
function roundedBarV(x, y0, y1, wid, r = 4) {
  const rr = Math.min(r, Math.max(y1 - y0, 0), wid / 2);
  return `M${x},${y1}V${y0 + rr}Q${x},${y0} ${x + rr},${y0}H${x + wid - rr}Q${x + wid},${y0} ${x + wid},${y0 + rr}V${y1}Z`;
}

// ---- line chart with optional confidence band, crosshair and keyboard stepping
// series: [{ key, label, color (css var name), points: [{x, y, lo, hi, hollow}], width, faint, endLabel }]
export function lineChart(box, W, { series, yMin, yMax, xTicks, height = 250, yFormat = (v) => v, tipFormat, xFormat = (v) => String(v), compact = false, xMin, xMax, yTicks = 5, annotate }) {
  const live = series.filter((q) => q.points.length);
  const allPts = live.flatMap((q) => q.points);
  if (!allPts.length) return;
  const xs = [...new Set(allPts.map((p) => p.x))].sort((a, b) => a - b);
  const top = Math.max(...allPts.map((p) => (p.hi != null ? p.hi : p.y)));
  const low = Math.min(...allPts.map((p) => (p.lo != null ? p.lo : p.y)));
  const y1 = yMax != null ? yMax : top * 1.08;
  const y0 = yMin != null ? yMin : Math.min(0, low);
  const ticks = niceTicks(y0, y1, compact ? 3 : yTicks);
  const yTop = Math.max(y1, ticks[ticks.length - 1]);
  const labelled = live.filter((q) => q.endLabel);
  const lw = compact ? 0 : Math.max(0, ...labelled.map((q) => textWidth(q.endLabel, "500 12px sans-serif")));
  const m = { l: compact ? Math.max(30, textWidth(yFormat(yTop), "12px sans-serif") + 10) : Math.max(38, textWidth(yFormat(yTop), "12px sans-serif") + 12), r: lw ? Math.min(lw + 12, W * 0.32) : 14, t: 10, b: 24 };
  const X = scale(xMin ?? xs[0], xMax ?? xs[xs.length - 1], m.l + 4, W - m.r - 4);
  const Y = scale(y0, yTop, height - m.b, m.t);
  const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", tabindex: compact ? null : 0 });
  const grid = s("g", { cls: "tick" });
  for (const t of ticks) {
    grid.append(s("line", { cls: t === y0 ? "baseline" : "gridline", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    grid.append(s("text", { x: m.l - 7, y: Y(t) + 4, "text-anchor": "end", text: yFormat(t) }));
  }
  for (const t of (xTicks || xs).filter((v) => v >= (xMin ?? xs[0]) && v <= (xMax ?? xs[xs.length - 1]))) grid.append(s("text", { x: X(t), y: height - 6, "text-anchor": "middle", text: xFormat(t) }));
  svg.append(grid);
  for (const q of live) {
    const band = q.points.filter((p) => p.lo != null && p.hi != null);
    if (band.length > 1 && !q.faint) {
      const d = `M${band.map((p) => `${X(p.x)},${Y(p.hi)}`).join("L")}L${band.slice().reverse().map((p) => `${X(p.x)},${Y(p.lo)}`).join("L")}Z`;
      svg.append(s("path", { d, fill: `var(--${q.color})`, opacity: 0.12 }));
    }
    const solid = q.points.filter((p) => !p.hollow);
    if (solid.length > 1) svg.append(s("path", { d: `M${solid.map((p) => `${X(p.x)},${Y(p.y)}`).join("L")}`, fill: "none", stroke: `var(--${q.color})`, "stroke-width": q.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    const hollow = q.points.filter((p) => p.hollow);
    if (hollow.length && solid.length) {
      const a = solid[solid.length - 1];
      for (const b of hollow) svg.append(s("line", { x1: X(a.x), y1: Y(a.y), x2: X(b.x), y2: Y(b.y), stroke: `var(--${q.color})`, "stroke-width": 1.5, "stroke-dasharray": "3 3" }));
    }
    if (!q.faint) {
      for (const p of q.points) {
        svg.append(s("circle", { cx: X(p.x), cy: Y(p.y), r: compact ? 2.5 : 4, fill: p.hollow ? "var(--surface)" : `var(--${q.color})`, stroke: p.hollow ? `var(--${q.color})` : "var(--page)", "stroke-width": 2 }));
      }
    }
    if (q.endLabel && !compact) {
      const lp = q.points[q.points.length - 1];
      svg.append(s("text", { cls: `dir-label ${q.faint ? "quiet" : ""}`, x: X(lp.x) + 9, y: Y(lp.y) + 4, text: q.endLabel }));
    }
  }
  if (annotate) annotate(svg, X, Y);
  // hover layer
  const cross = s("line", { cls: "crosshair", y1: m.t, y2: height - m.b, visibility: "hidden" });
  svg.append(cross);
  const nearest = (px) => xs.reduce((a, b) => (Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a), xs[0]);
  const fmtTip = tipFormat || yFormat;
  const show = (xv, cx, cy) => {
    cross.setAttribute("x1", X(xv));
    cross.setAttribute("x2", X(xv));
    cross.setAttribute("visibility", "visible");
    const rows = [];
    for (const q of live) {
      const p = q.points.find((z) => z.x === xv);
      if (!p) continue;
      rows.push({ cls: q.colorClass || `c-${q.color}`, value: fmtTip(p.y), label: `${q.label}${p.hollow ? " (estimate)" : ""}${p.lo != null ? ` · ${fmtTip(p.lo)} to ${fmtTip(p.hi)}` : ""}` });
    }
    tip.show(cx, cy, xFormat(xv), rows);
  };
  const hit = s("rect", { x: m.l, y: 0, width: W - m.l - m.r, height, fill: "transparent" });
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    show(nearest(px), e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hide(); });
  svg.append(hit);
  if (!compact) {
    let idx = xs.length - 1;
    svg.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") idx = Math.max(0, idx - 1);
      else if (e.key === "ArrowRight") idx = Math.min(xs.length - 1, idx + 1);
      else if (e.key === "Escape") { cross.setAttribute("visibility", "hidden"); tip.hide(); return; } else return;
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      show(xs[idx], r.left + (X(xs[idx]) / W) * r.width, r.top + r.height / 3);
    });
    svg.addEventListener("focus", () => {
      const r = svg.getBoundingClientRect();
      show(xs[idx], r.left + (X(xs[idx]) / W) * r.width, r.top + r.height / 3);
    });
    svg.addEventListener("blur", () => { cross.setAttribute("visibility", "hidden"); tip.hide(); });
    svg.setAttribute("aria-label", live.map((q) => `${q.label}: ${q.points.map((p) => `${xFormat(p.x)} ${fmtTip(p.y)}`).join(", ")}`).join(". "));
  }
  box.append(svg);
}

// ---- horizontal bars. rows: [{ label, value, color, tip }], ref: { value, label }
export function barsH(box, W, { rows, color = "poverty", format, ref, labelWidth, rowH = 26, max, tipRows }) {
  const lwMax = labelWidth || Math.min(W * 0.42, Math.max(...rows.map((r) => textWidth(r.label))) + 10);
  const valW = Math.max(...rows.map((r) => textWidth(format(r.value), "500 12.5px sans-serif"))) + 8;
  const hmax = max || Math.max(...rows.map((r) => r.value), ref ? ref.value : 0) * 1.0;
  const top = ref ? 20 : 4;
  const H = top + rows.length * rowH + 4;
  const X = scale(0, hmax, lwMax, W - valW);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": rows.map((r) => `${r.label} ${format(r.value)}`).join(", ") });
  const barH = Math.min(rowH - 8, 18);
  rows.forEach((r, i) => {
    const y = top + i * rowH;
    const g = s("g", {});
    g.append(s("text", { cls: "row-label", x: lwMax - 8, y: y + rowH / 2 + 4, "text-anchor": "end", text: r.label }));
    if (r.value != null) {
      const bar = s("path", { d: roundedBarH(X(0), Math.max(X(r.value), X(0) + 1), y + (rowH - barH) / 2, barH), fill: `var(--${r.color || color})` });
      g.append(bar);
      g.append(s("text", { cls: "val-label", x: X(r.value) + 6, y: y + rowH / 2 + 4, text: format(r.value) }));
    }
    const hit = s("rect", { x: 0, y, width: W, height: rowH, fill: "transparent", tabindex: 0 });
    const on = (cx, cy) => {
      g.setAttribute("opacity", 0.85);
      tip.show(cx, cy, r.label, tipRows ? tipRows(r) : [{ value: format(r.value) }]);
    };
    hit.addEventListener("pointermove", (e) => on(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => { g.removeAttribute("opacity"); tip.hide(); });
    hit.addEventListener("focus", () => { const b = hit.getBoundingClientRect(); on(b.left + lwMax, b.top); });
    hit.addEventListener("blur", () => { g.removeAttribute("opacity"); tip.hide(); });
    g.append(hit);
    svg.append(g);
  });
  svg.insertBefore(s("line", { cls: "baseline", x1: X(0), x2: X(0), y1: top, y2: H - 4 }), svg.firstChild);
  if (ref) {
    svg.append(s("line", { x1: X(ref.value), x2: X(ref.value), y1: top - 4, y2: H - 4, stroke: "var(--ink)", "stroke-width": 1 }));
    const anchor = X(ref.value) > W * 0.7 ? "end" : "start";
    svg.append(s("text", { cls: "dir-label", x: X(ref.value) + (anchor === "end" ? -4 : 4), y: 11, "text-anchor": anchor, text: ref.label }));
  }
  box.append(svg);
}

// ---- dumbbell: two values per row. a = first, b = second
export function dumbbell(box, W, { rows, format, aLabel, bLabel, aColor = "context", bColor = "poverty", rowH = 24, min = 0, max, xFormat, labelWidth }) {
  const lw = labelWidth || Math.min(W * 0.4, Math.max(...rows.map((r) => textWidth(r.label))) + 10);
  const top = 22;
  const H = top + rows.length * rowH + 6;
  const hi = max || Math.max(...rows.flatMap((r) => [r.a ?? 0, r.b ?? 0])) * 1.04;
  const X = scale(min, hi, lw, W - 16);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${aLabel} and ${bLabel} by row: ${rows.slice(0, 40).map((r) => `${r.label} ${format(r.a)} to ${format(r.b)}`).join(", ")}` });
  const g0 = s("g", { cls: "tick" });
  for (const t of niceTicks(min, hi, W < 560 ? 4 : 5)) {
    g0.append(s("line", { cls: t === min ? "baseline" : "gridline", x1: X(t), x2: X(t), y1: top - 4, y2: H - 4 }));
    g0.append(s("text", { x: X(t), y: 12, "text-anchor": "middle", text: (xFormat || format)(t) }));
  }
  svg.append(g0);
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    const g = s("g", {});
    g.append(s("text", { cls: "row-label", x: lw - 8, y: y + 4, "text-anchor": "end", text: r.label }));
    if (r.a != null && r.b != null) g.append(s("line", { x1: X(r.a), x2: X(r.b), y1: y, y2: y, stroke: "var(--context-2)", "stroke-width": 2 }));
    if (r.a != null) g.append(s("circle", { cx: X(r.a), cy: y, r: 4, fill: `var(--${aColor})`, stroke: "var(--page)", "stroke-width": 2 }));
    if (r.b != null) g.append(s("circle", { cx: X(r.b), cy: y, r: 4, fill: `var(--${bColor})`, stroke: "var(--page)", "stroke-width": 2 }));
    const hit = s("rect", { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: "transparent", tabindex: 0 });
    const on = (cx, cy) => tip.show(cx, cy, r.label, [{ cls: `dot c-${aColor}`, value: format(r.a), label: aLabel }, { cls: `dot c-${bColor}`, value: format(r.b), label: bLabel }, ...(r.note ? [{ value: "", label: r.note }] : [])]);
    hit.addEventListener("pointermove", (e) => on(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => tip.hide());
    hit.addEventListener("focus", () => { const b = hit.getBoundingClientRect(); on(b.left + lw, b.top); });
    hit.addEventListener("blur", () => tip.hide());
    g.append(hit);
    svg.append(g);
  });
  box.append(svg);
}

// ---- columns with a surface gap. rows: [{ label, value }]
export function columns(box, W, { rows, color = "poverty", format, height = 230, tipRows, yFormat }) {
  if (W < 520) {
    barsH(box, W, { rows, color, format, tipRows });
    return;
  }
  const m = { l: 44, r: 6, t: 20, b: 34 };
  const hi = Math.max(...rows.map((r) => r.value));
  const ticks = niceTicks(0, hi, 4);
  const Y = scale(0, Math.max(hi, ticks[ticks.length - 1]), height - m.b, m.t);
  const slot = (W - m.l - m.r) / rows.length;
  const bw = Math.min(slot - 2, 64);
  const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": rows.map((r) => `${r.label} ${format(r.value)}`).join(", ") });
  const g0 = s("g", { cls: "tick" });
  for (const t of ticks) {
    g0.append(s("line", { cls: t === 0 ? "baseline" : "gridline", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    g0.append(s("text", { x: m.l - 7, y: Y(t) + 4, "text-anchor": "end", text: (yFormat || format)(t) }));
  }
  svg.append(g0);
  rows.forEach((r, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    const g = s("g", {});
    g.append(s("path", { d: roundedBarV(x, Y(r.value), Y(0), bw), fill: `var(--${color})` }));
    g.append(s("text", { cls: "val-label", x: x + bw / 2, y: Y(r.value) - 5, "text-anchor": "middle", text: format(r.value) }));
    const parts = r.label.split(" ");
    const tx = s("text", { cls: "tick", "text-anchor": "middle", x: x + bw / 2, y: height - m.b + 15, style: "fill:var(--ink-3);font:400 11.5px var(--body)", text: r.label });
    if (textWidth(r.label, "11.5px sans-serif") > slot - 2 && parts.length > 1) {
      tx.textContent = "";
      const mid = Math.ceil(parts.length / 2);
      tx.append(s("tspan", { x: x + bw / 2, text: parts.slice(0, mid).join(" ") }), s("tspan", { x: x + bw / 2, dy: 13, text: parts.slice(mid).join(" ") }));
    }
    g.append(tx);
    const hit = s("rect", { x: m.l + i * slot, y: 0, width: slot, height, fill: "transparent", tabindex: 0 });
    const on = (cx, cy) => { g.setAttribute("opacity", 0.85); tip.show(cx, cy, r.label, tipRows ? tipRows(r) : [{ value: format(r.value) }]); };
    hit.addEventListener("pointermove", (e) => on(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => { g.removeAttribute("opacity"); tip.hide(); });
    hit.addEventListener("focus", () => { const b = hit.getBoundingClientRect(); on(b.left + b.width / 2, b.top + 30); });
    hit.addEventListener("blur", () => { g.removeAttribute("opacity"); tip.hide(); });
    g.append(hit);
    svg.append(g);
  });
  box.append(svg);
}

// ---- stacked horizontal bars for part-to-whole. rows: [{ label, values: [...] }], groups: [{label,color}]
export function stackedH(box, W, { rows, groups, rowH = 26, labelWidth }) {
  const lw = labelWidth || Math.min(W * 0.34, Math.max(...rows.map((r) => textWidth(r.label))) + 10);
  const H = rows.length * rowH + 4;
  const X = scale(0, 100, lw, W - 4);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": rows.map((r) => `${r.label}: ${r.values.map((v, i) => `${groups[i].label} ${v.toFixed(1)}%`).join(", ")}`).join(". ") });
  rows.forEach((r, i) => {
    const y = i * rowH;
    const barH = Math.min(rowH - 8, 18);
    const g = s("g", {});
    g.append(s("text", { cls: "row-label", x: lw - 8, y: y + rowH / 2 + 4, "text-anchor": "end", text: r.label }));
    const total = r.values.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    r.values.forEach((v, k) => {
      const share = (v / total) * 100;
      const x0 = X(acc);
      const x1 = X(acc + share);
      if (x1 - x0 > 2) g.append(s("rect", { x: x0, y: y + (rowH - barH) / 2, width: x1 - x0 - 2, height: barH, fill: `var(--${groups[k].color})` }));
      acc += share;
    });
    const hit = s("rect", { x: 0, y, width: W, height: rowH, fill: "transparent", tabindex: 0 });
    const on = (cx, cy) => tip.show(cx, cy, r.label, r.values.map((v, k) => ({ cls: `box c-${groups[k].color}`, value: `${v.toFixed(1)}%`, label: groups[k].label })));
    hit.addEventListener("pointermove", (e) => on(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", () => tip.hide());
    hit.addEventListener("focus", () => { const b = hit.getBoundingClientRect(); on(b.left + lw, b.top); });
    hit.addEventListener("blur", () => tip.hide());
    g.append(hit);
    svg.append(g);
  });
  box.append(svg);
}

// ---- scatter with a nearest-point hover. points: [{x, y, label, sub, on, r}]
export function scatter(box, W, { points, xLabel, yLabel, xFormat, yFormat, height = 420, xLog = false, xMin, xMax, yMin = 0, yMax, color = "poverty", refLine, xTicks, onPick, tipRows }) {
  const m = { l: 46, r: 12, t: 12, b: 40 };
  const xv = points.map((p) => p.x);
  const x0 = xMin ?? Math.min(...xv);
  const x1 = xMax ?? Math.max(...xv);
  const y1 = yMax ?? Math.max(...points.map((p) => p.y)) * 1.04;
  const X = xLog ? (() => { const l = scale(Math.log(x0), Math.log(x1), m.l, W - m.r); return (v) => l(Math.log(v)); })() : scale(x0, x1, m.l, W - m.r);
  const Y = scale(yMin, y1, height - m.b, m.t);
  const svg = s("svg", { viewBox: `0 0 ${W} ${height}`, role: "img", "aria-label": `${yLabel} against ${xLabel}. Use the table for exact values.` });
  const g0 = s("g", { cls: "tick" });
  for (const t of niceTicks(yMin, y1, 5)) {
    g0.append(s("line", { cls: t === yMin ? "baseline" : "gridline", x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) }));
    g0.append(s("text", { x: m.l - 7, y: Y(t) + 4, "text-anchor": "end", text: yFormat(t) }));
  }
  for (const t of xTicks || niceTicks(x0, x1, W < 520 ? 4 : 6)) {
    g0.append(s("line", { cls: "gridline", x1: X(t), x2: X(t), y1: m.t, y2: height - m.b }));
    g0.append(s("text", { x: X(t), y: height - m.b + 16, "text-anchor": "middle", text: xFormat(t) }));
  }
  g0.append(s("text", { cls: "axis-label", x: (m.l + W - m.r) / 2, y: height - 4, "text-anchor": "middle", text: xLabel }));
  svg.append(g0);
  svg.append(s("text", { cls: "axis-label", x: m.l, y: 8, text: yLabel }));
  if (refLine) svg.append(s("line", { x1: X(refLine[0]), y1: Y(refLine[1]), x2: X(refLine[2]), y2: Y(refLine[3]), stroke: "var(--ink-3)", "stroke-width": 1 }));
  const off = s("g", {});
  const on = s("g", {});
  for (const p of points) {
    p._x = X(p.x);
    p._y = Y(p.y);
    (p.on ? on : off).append(s("circle", { cx: p._x.toFixed(1), cy: p._y.toFixed(1), r: p.r || (p.on ? 4 : 2.6), fill: p.on ? `var(--${color})` : "var(--context)", opacity: p.on ? 0.95 : 0.5, stroke: p.on ? "var(--page)" : "none", "stroke-width": p.on ? 1 : 0 }));
  }
  svg.append(off, on);
  const ring = s("circle", { r: 6, fill: "none", stroke: "var(--ink)", "stroke-width": 2, visibility: "hidden" });
  svg.append(ring);
  let current = null;
  const near = (px, py) => {
    let best = null;
    let bd = 900;
    for (const p of points) {
      const d = (p._x - px) ** 2 + (p._y - py) ** 2;
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  };
  const hit = s("rect", { x: 0, y: 0, width: W, height, fill: "transparent" });
  hit.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect();
    const k = W / r.width;
    const p = near((e.clientX - r.left) * k, (e.clientY - r.top) * k);
    current = p;
    if (!p) { ring.setAttribute("visibility", "hidden"); tip.hide(); return; }
    ring.setAttribute("cx", p._x);
    ring.setAttribute("cy", p._y);
    ring.setAttribute("visibility", "visible");
    tip.show(e.clientX, e.clientY, p.label, tipRows ? tipRows(p) : [{ value: yFormat(p.y), label: yLabel }, { value: xFormat(p.x), label: xLabel }]);
  });
  hit.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); tip.hide(); });
  if (onPick) { hit.style.cursor = "pointer"; hit.addEventListener("click", () => { if (current) onPick(current); }); }
  svg.append(hit);
  box.append(svg);
}

export { fmt };
