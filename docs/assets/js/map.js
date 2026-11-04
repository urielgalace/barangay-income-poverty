// The interactive map. Cities and municipalities load at once; barangays load province by province as you zoom in.
import { getJSON, objects, fmt, h, s, combobox, segmented } from "./lib.js?b=65ddb44d93";
import { RAMPS, DIFF, NODATA, LAND, SEA } from "./ramps.js?b=65ddb44d93";
import { searchPlaces, placeSub } from "./places.js?b=65ddb44d93";
import { lineChart } from "./charts.js?b=65ddb44d93";

const BGY_MIN_ZOOM = 8;
const MAX_CHUNKS = 28;
const REPORT_URL = (place) => `report.html?place=${encodeURIComponent(place)}`;

const state = { metric: "income", level: "barangay", local: false, localRamp: null, ver: null, from: null, sel: null };
const store = {};              // source id -> { fc, byId }
const chunks = new Map();      // chunk -> { state: loading|ready, used, bbox }
let map, meta, lgus, lguById, provs, provById, regs, regById, chunkRows, versions;
const el = (id) => document.getElementById(id);

// ---- geometry decoding: integer rings on a 0.0001 degree grid, delta coded
function decodeRing(a) {
  const out = [];
  let x = a[0];
  let y = a[1];
  out.push([x / 1e4, y / 1e4]);
  for (let i = 2; i < a.length; i += 2) {
    x += a[i];
    y += a[i + 1];
    out.push([x / 1e4, y / 1e4]);
  }
  out.push(out[0]);
  return out;
}
function toFeatures(geo, propsOf) {
  return geo.ids.map((id, i) => ({ type: "Feature", properties: propsOf(id, i), geometry: { type: "MultiPolygon", coordinates: geo.geom[i].map((part) => part.map(decodeRing)) } }));
}
const setStore = (sid, features) => {
  const fc = { type: "FeatureCollection", features };
  const byId = new Map(features.map((f) => [f.properties.id, f]));
  store[sid] = { fc, byId };
  return fc;
};
function bboxOf(feature) {
  let x0 = 999; let y0 = 999; let x1 = -999; let y1 = -999;
  for (const part of feature.geometry.coordinates) for (const [x, y] of part[0]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [[x0, y0], [x1, y1]];
}

// ---- color expressions
const pkey = (base, ver) => (ver ? `${base}@${ver}` : base);
function currentRamp() {
  if (state.from) return DIFF[state.metric];
  if (state.local && state.localRamp) return state.localRamp;
  return RAMPS[state.metric];
}
function valueExpr() {
  const base = RAMPS[state.metric].key;
  if (state.from) {
    const a = ["get", pkey(base, state.from)];
    const b = ["get", pkey(base, state.ver)];
    return state.metric === "income" ? ["*", ["-", ["/", b, a], 1], 100] : ["-", b, a];
  }
  return ["get", pkey(base, state.ver)];
}
function hasExpr() {
  const base = RAMPS[state.metric].key;
  if (state.from) return ["all", ["has", pkey(base, state.from)], ["has", pkey(base, state.ver)]];
  return ["has", pkey(base, state.ver)];
}
function fillExpr() {
  if (state.metric === "poor") return LAND;
  const r = currentRamp();
  const step = ["step", valueExpr(), r.colors[0]];
  r.breaks.forEach((b, i) => step.push(b, r.colors[i + 1]));
  return ["case", hasExpr(), step, NODATA];
}

// ---- layers
const bgyLayers = () => [...chunks.entries()].filter(([, c]) => c.state === "ready").map(([k]) => `b-${k}-fill`);
function activeFills() {
  if (state.level === "region") return ["region-fill"];
  if (state.level === "province") return ["province-fill"];
  if (state.level === "lgu") return ["lgu-fill"];
  return [...bgyLayers().reverse(), "lgu-fill"];
}
function addCoverage(sid, fc, opts = {}) {
  map.addSource(sid, { type: "geojson", data: fc, promoteId: "id", tolerance: opts.tolerance ?? 0.3, buffer: 32, maxzoom: 14 });
  map.addLayer({ id: `${sid}-fill`, type: "fill", source: sid, paint: { "fill-color": fillExpr(), "fill-outline-color": fillExpr(), "fill-antialias": true } }, "overlay-start");
}
function refreshFills() {
  const color = fillExpr();
  for (const id of ["region-fill", "province-fill", "lgu-fill", ...bgyLayers()]) {
    if (map.getLayer(id)) {
      map.setPaintProperty(id, "fill-color", color);
      map.setPaintProperty(id, "fill-outline-color", color);
    }
  }
}
function setVis(id, on) {
  if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
}
function applyLevel() {
  const lv = state.level;
  setVis("region-fill", lv === "region");
  setVis("province-fill", lv === "province");
  setVis("lgu-fill", lv === "lgu" || lv === "barangay");
  const showB = lv === "barangay" && state.metric !== "poor";
  for (const id of bgyLayers()) {
    setVis(id, showB);
    setVis(id.replace("-fill", "-line"), showB);
    setVis(id.replace("-fill", "-name"), showB);
  }
  setVis("province-line", lv === "province" || lv === "region");
  setVis("lgu-line", lv === "lgu" || lv === "barangay");
  const pts = lv === "region" ? "region" : lv === "province" ? "province" : "lgu";
  for (const p of ["region", "province", "lgu"]) setVis(`${p}-bubble`, state.metric === "poor" && p === pts);
  updateSeg();
  if (lv === "barangay" && state.metric !== "poor") loadVisibleChunks();
  else setStatus("");
}

// ---- barangay chunks
function visibleChunkIds() {
  const b = map.getBounds();
  return chunkRows.filter((c) => c.x1 >= b.getWest() && c.x0 <= b.getEast() && c.y1 >= b.getSouth() && c.y0 <= b.getNorth()).map((c) => c.chunk);
}
async function ensureChunk(chunk) {
  const known = chunks.get(chunk);
  if (known) return known.promise;
  const rec = { state: "loading", used: Date.now() };
  chunks.set(chunk, rec);
  rec.promise = (async () => {
    const [geo, vals] = await Promise.all([getJSON(`bgy/${chunk}.geo.json`), getJSON(`bgy/${chunk}.json`)]);
    const feats = toFeatures(geo, (id, i) => {
      const p = { id, chunk, n: vals.n[i], c: vals.c[i], psgc: vals.psgc[i], t: vals.t[i], m: vals.m[i], u: vals.u[i], a: vals.a[i] };
      for (const k of ["p", "pl", "ph", "ps", "i", "il", "ih", "h", "f"]) if (vals[k][i] != null) p[k] = vals[k][i];
      return p;
    });
    const sid = `b-${chunk}`;
    const fc = setStore(sid, feats);
    for (const v of [state.ver, state.from]) if (v) await mergeVersion(sid, chunk, v);
    addCoverage(sid, fc, { tolerance: 0.2 });
    map.addLayer({ id: `${sid}-line`, type: "line", source: sid, minzoom: 9.5, paint: { "line-color": SEA, "line-opacity": ["interpolate", ["linear"], ["zoom"], 9.5, 0, 11, 0.55], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.3, 15, 1] } }, "overlay-start");
    // one label point per barangay, so a polygon that crosses map tiles is not named twice
    map.addSource(`${sid}-pts`, { type: "geojson", data: { type: "FeatureCollection", features: vals.n.map((n, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [vals.x[i], vals.y[i]] }, properties: { n } })).filter((f) => f.geometry.coordinates[0] != null) } });
    map.addLayer({ id: `${sid}-name`, type: "symbol", source: `${sid}-pts`, minzoom: 12.2, layout: { "text-field": ["get", "n"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-max-width": 8 }, paint: { "text-color": "#f4fafb", "text-halo-color": SEA, "text-halo-width": 1.2 } }, "overlay-names");
    rec.state = "ready";
    applyLevel();
    evictChunks();
    if (state.local) requestAnimationFrame(updateLocal);
    return rec;
  })().catch((e) => {
    chunks.delete(chunk);
    setStatus("Some barangays could not load. Check your connection and move the map to retry.");
    throw e;
  });
  return rec.promise;
}
function evictChunks() {
  const ready = [...chunks.entries()].filter(([, c]) => c.state === "ready");
  if (ready.length <= MAX_CHUNKS) return;
  const keep = new Set(visibleChunkIds());
  ready.sort((a, b) => a[1].used - b[1].used);
  for (const [k] of ready) {
    if (chunks.size <= MAX_CHUNKS) break;
    if (keep.has(k) || (state.sel && state.sel.chunk === k)) continue;
    const sid = `b-${k}`;
    for (const l of [`${sid}-fill`, `${sid}-line`, `${sid}-name`]) if (map.getLayer(l)) map.removeLayer(l);
    map.removeSource(sid);
    map.removeSource(`${sid}-pts`);
    delete store[sid];
    chunks.delete(k);
  }
}
function loadVisibleChunks() {
  if (state.level !== "barangay" || state.metric === "poor") return;
  const z = map.getZoom();
  if (z < BGY_MIN_ZOOM) {
    setStatus(`Showing cities and municipalities. Zoom in to load barangays.`);
    return;
  }
  const ids = visibleChunkIds();
  if (ids.length > 16) {
    setStatus("Zoom in a little more to load barangays.");
    return;
  }
  const missing = ids.filter((k) => !chunks.has(k));
  ids.forEach((k) => { const c = chunks.get(k); if (c) c.used = Date.now(); });
  if (missing.length) {
    setStatus(`Loading barangays for ${missing.length} ${missing.length === 1 ? "area" : "areas"}…`);
    Promise.allSettled(missing.map(ensureChunk)).then(() => setStatus(""));
  } else if (!Object.keys(store).length) setStatus("");
  else setStatus("");
}
const setStatus = (t) => { el("map-status").textContent = t; };

// ---- versions on the map
async function mergeVersion(sid, chunk, ver) {
  const rec = store[sid];
  if (!rec || rec[`has${ver}`]) return;
  rec[`has${ver}`] = true;
  let data;
  try { data = await getJSON(`versions/${ver}/${chunk}.json`); } catch (e) { return; }  // this version does not cover the area
  rec.fc.features.forEach((f, i) => {
    if (data.p[i] != null) f.properties[`p@${ver}`] = data.p[i];
    if (data.i[i] != null) f.properties[`i@${ver}`] = data.i[i];
  });
}
async function mergeVersionLgu(ver) {
  const rec = store.lgu;
  if (rec[`has${ver}`]) return;
  rec[`has${ver}`] = true;
  const data = await getJSON(`versions/${ver}/lgu.json`);
  rec.fc.features.forEach((f) => {
    const i = lguIndex.get(f.properties.id);
    if (data.p[i] != null) f.properties[`p@${ver}`] = data.p[i];
    if (data.i[i] != null) f.properties[`i@${ver}`] = data.i[i];
  });
}
let lguIndex;
async function setVersions(ver, from) {
  state.ver = ver && ver !== meta.version ? ver : null;
  state.from = from || null;
  // comparing always needs a value for the newer side, so the current version gets its own key
  const needed = [state.ver, state.from].filter(Boolean);
  setStatus(needed.length ? "Loading that version…" : "");
  for (const v of needed) await mergeVersionLgu(v);
  map.getSource("lgu").setData(store.lgu.fc);
  for (const [k, c] of chunks) {
    if (c.state !== "ready") continue;
    const sid = `b-${k}`;
    for (const v of needed) await mergeVersion(sid, k, v);
    map.getSource(sid).setData(store[sid].fc);
  }
  if (needed.length) {
    if (state.metric !== "poverty" && state.metric !== "income") state.metric = "income";
    if (state.level === "region" || state.level === "province") state.level = "barangay";
  }
  refreshAll();
  setStatus("");
}

// ---- local color scale: stretch the classes over what is on screen
function updateLocal() {
  if (!state.local || state.metric === "poor" || state.from) { state.localRamp = null; return; }
  const key = pkey(RAMPS[state.metric].key, state.ver);
  const vals = map.queryRenderedFeatures({ layers: activeFills().filter((l) => map.getLayer(l)) }).map((f) => f.properties[key]).filter((v) => v != null);
  if (vals.length < 8) return;
  vals.sort((a, b) => a - b);
  const base = RAMPS[state.metric];
  const n = base.colors.length;
  const raw = Array.from({ length: n - 1 }, (_, i) => vals[Math.floor((vals.length * (i + 1)) / n)]);
  const breaks = [];
  const nd = state.metric === "income" ? 0 : (raw[raw.length - 1] < 5 ? 2 : 1);
  for (const b of raw) {
    const r = state.metric === "income" ? Math.round(b / 100) * 100 : +b.toFixed(nd);
    if (!breaks.length || r > breaks[breaks.length - 1]) breaks.push(r);
  }
  const f = (v) => (state.metric === "income" ? fmt.peso(v) : `${v.toFixed(nd)}%`);
  const labels = breaks.map((b, i) => (i === 0 ? `Under ${f(b)}` : `${f(breaks[i - 1])} to ${f(b)}`));
  labels.push(`${f(breaks[breaks.length - 1])} or more`);
  const colors = breaks.length + 1 === n ? base.colors : Array.from({ length: breaks.length + 1 }, (_, i) => base.colors[Math.round((i * (n - 1)) / breaks.length)]);
  state.localRamp = { ...base, breaks, labels, colors };
  refreshFills();
  drawLegend();
}

// ---- legend
function drawLegend() {
  const box = el("map-legend");
  box.replaceChildren();
  if (state.metric === "poor") {
    box.append(h("div", { class: "title", text: "Number of people in poverty" }), h("div", { class: "tiny", text: "Bubble size represents the estimated number of people living in poverty." }));
    return;
  }
  const r = currentRamp();
  box.append(h("div", { class: "title", text: r.label + (state.from ? ` from ${state.from} to ${state.ver || meta.version}` : "") }));
  const rows = h("div", { class: "lg-rows" });
  r.labels.forEach((t, i) => rows.append(h("div", { class: "lg-row" }, h("i", { style: `background:${r.colors[i]}` }), t)));
  rows.append(h("div", { class: "lg-row" }, h("i", { style: `background:${NODATA}` }), state.from ? "Not in both versions" : "No data or no residents"));
  box.append(rows);
  if (state.local && !state.from) box.append(h("div", { class: "tiny", text: "Color bands are adjusted to the range of values currently displayed on screen." }));
}
let segLevel;
let segMetric;
function updateSeg() {
  const versioned = state.ver || state.from;
  segLevel.set(state.level);
  segMetric.set(state.metric);
  for (const b of segLevel.buttons) {
    const v = b.dataset.v;
    b.disabled = versioned && (v === "region" || v === "province");
  }
  for (const b of segMetric.buttons) {
    const v = b.dataset.v;
    b.disabled = versioned && v === "poor";
  }
  el("local-wrap").hidden = state.metric === "poor" || !!state.from;
}
function refreshAll() {
  if (state.local) updateLocal(); else state.localRamp = null;
  refreshFills();
  applyLevel();
  drawLegend();
  writeHash();
  if (state.sel) renderDetail(state.sel);
}

// ---- hover and selection
function setHighlight(srcId, geometry) {
  const src = map.getSource(srcId);
  if (src) src.setData(geometry ? { type: "Feature", geometry, properties: {} } : { type: "FeatureCollection", features: [] });
}
function kindOfLayer(layerId) {
  if (layerId === "region-fill" || layerId === "region-bubble") return "region";
  if (layerId === "province-fill" || layerId === "province-bubble") return "province";
  if (layerId === "lgu-fill" || layerId === "lgu-bubble") return "lgu";
  return "bgy";
}
const sourceOf = (kind, chunk) => (kind === "bgy" ? `b-${chunk}` : kind);
function describeValue(p) {
  if (state.metric === "poor") return `${fmt.int(p.poor ?? 0)} people in poverty`;
  const r = RAMPS[state.metric];
  const key = r.key;
  if (state.from) {
    const a = p[pkey(key, state.from)];
    const b = p[pkey(key, state.ver)];
    if (a == null || b == null) return "Not in both versions";
    const d = state.metric === "income" ? (b / a - 1) * 100 : b - a;
    return `${DIFF[state.metric].format(d)} (${r.format(a)} to ${r.format(b)})`;
  }
  const v = p[pkey(key, state.ver)];
  return v == null ? "No data" : r.format(v);
}
function nameOf(kind, p) {
  if (kind === "bgy") return p.n;
  if (kind === "lgu") return lguById.get(p.id)?.name;
  if (kind === "province") return p.id;
  return regById.get(p.id)?.short;
}
function hoverLayers() {
  if (state.metric === "poor") return [`${state.level === "region" ? "region" : state.level === "province" ? "province" : "lgu"}-bubble`];
  return activeFills();
}
let hoverRaf = 0;
function onMove(e) {
  if (hoverRaf) return;
  hoverRaf = requestAnimationFrame(() => {
    hoverRaf = 0;
    const layers = hoverLayers().filter((l) => map.getLayer(l));
    const f = map.queryRenderedFeatures(e.point, { layers })[0];
    const t = el("map-tip");
    if (!f) { t.hidden = true; map.getCanvas().style.cursor = ""; setHighlight("hover", null); return; }
    map.getCanvas().style.cursor = "pointer";
    const kind = kindOfLayer(f.layer.id);
    const rec = store[sourceOf(kind, f.properties.chunk)];
    const feat = rec && rec.byId.get(f.properties.id);
    if (feat) setHighlight("hover", feat.geometry);
    t.replaceChildren(h("b", { text: nameOf(kind, f.properties) || "" }), document.createTextNode(describeValue(f.properties)));
    t.hidden = false;
    const ex = e.originalEvent.clientX;
    const ey = e.originalEvent.clientY;
    const b = t.getBoundingClientRect();
    t.style.left = `${ex + 14 + b.width > innerWidth ? ex - b.width - 12 : ex + 14}px`;
    t.style.top = `${ey - b.height - 10 < 0 ? ey + 14 : ey - b.height - 10}px`;
  });
}
function onClick(e) {
  const layers = hoverLayers().filter((l) => map.getLayer(l));
  const f = map.queryRenderedFeatures(e.point, { layers })[0];
  if (!f) { clearSelection(); return; }
  const kind = kindOfLayer(f.layer.id);
  select({ kind, id: f.properties.id, chunk: f.properties.chunk });
}
function clearSelection() {
  state.sel = null;
  setHighlight("selected", null);
  el("detail").hidden = true;
  writeHash();
}
function select(sel, fly) {
  const rec = store[sourceOf(sel.kind, sel.chunk)];
  const f = rec && rec.byId.get(sel.id);
  if (!f) return;
  state.sel = sel;
  setHighlight("selected", f.geometry);
  if (fly) map.fitBounds(bboxOf(f), { padding: { top: 40, bottom: innerWidth < 760 ? 420 : 60, left: innerWidth < 760 ? 30 : 360, right: innerWidth < 760 ? 30 : 390 }, maxZoom: sel.kind === "bgy" ? 14.2 : 11.5, duration: 700 });
  renderDetail(sel);
  writeHash();
}

// ---- detail panel
function intervalBar(lo, mid, hi, max, color, tick, tickLabel) {
  const X = (v) => 4 + (Math.min(v, max) / max) * 292;
  const svg = s("svg", { class: "pi", viewBox: "0 0 300 34", role: "img", "aria-label": `Estimate ${mid}, 90% interval from ${lo} to ${hi}` });
  svg.append(s("line", { x1: 4, x2: 296, y1: 14, y2: 14, stroke: "var(--rule-2)", "stroke-width": 1 }));
  svg.append(s("rect", { x: X(lo), y: 9, width: Math.max(X(hi) - X(lo), 2), height: 10, rx: 3, fill: color, opacity: 0.28 }));
  if (tick != null) {
    svg.append(s("line", { x1: X(tick), x2: X(tick), y1: 4, y2: 24, stroke: "var(--ink-2)", "stroke-width": 1 }));
    svg.append(s("text", { x: Math.min(Math.max(X(tick), 40), 260), y: 33, "text-anchor": "middle", style: "font:400 10.5px var(--body);fill:var(--ink-2)", text: tickLabel }));
  }
  svg.append(s("circle", { cx: X(mid), cy: 14, r: 5, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
  return svg;
}
function bigValue(label, value, range, bar) {
  return h("div", { class: "d-big" }, h("div", { class: "lab", text: label }), h("div", { class: "val", text: value }), range ? h("div", { class: "rng", text: range }) : null, bar);
}
const TYPE_NOTE = {
  1: "This polygon holds more than one current barangay. No boundaries exist for the parts, so they share one estimate.",
  2: "Older polygons were merged into this barangay under PSA's change log, and are shown as one.",
};
async function renderDetail(sel) {
  const box = el("detail-body");
  box.replaceChildren();
  el("detail").hidden = false;
  const rec = store[sourceOf(sel.kind, sel.chunk)];
  const f = rec?.byId.get(sel.id);
  if (!f) return;
  const p = f.properties;
  const nat = meta.poverty;
  const natI = meta.income;
  if (sel.kind === "bgy") {
    const l = lguById.get(p.c);
    const area = provById.get(l?.parent);
    box.append(h("div", { class: "crumbs", text: [l?.reg, l?.prov, l?.name].filter(Boolean).join(" › ") }), h("div", { class: "d-title", text: p.n }));
    if (p.psgc) box.append(h("div", { class: "tiny", text: `PSGC ${p.psgc.replaceAll(";", ", ")}` }));
    if (p.t === 3) {
      box.append(h("p", { class: "small", text: "This polygon is forest land, a park or a similar area, not a barangay. It has no estimates." }));
    } else if (p.p == null) {
      box.append(h("p", { class: "small", text: "The 2024 census counted no residents here, so there are no estimates." }));
    } else {
      box.append(bigValue("Estimated average monthly household income", fmt.peso(p.i), `90% interval ${fmt.peso(p.il)} to ${fmt.peso(p.ih)}`, intervalBar(p.il, p.i, p.ih, 120000, "var(--income)", natI, `Philippines ${fmt.pesoExact(natI)}`)));
      box.append(bigValue("Estimated poverty incidence", RAMPS.poverty.format(p.p), `90% interval ${p.pl.toFixed(1)}% to ${p.ph.toFixed(1)}%`, intervalBar(p.pl, p.p, p.ph, 100, "var(--poverty)", nat, `Philippines ${nat}%`)));
      box.append(h("dl", { class: "d-kv" },
        h("div", {}, h("dt", { text: "Population, 2024 census" }), h("dd", { text: fmt.int(p.h) })),
        h("div", {}, h("dt", { text: "Households" }), h("dd", { text: fmt.int(p.f) })),
        h("div", {}, h("dt", { text: "City or municipality income" }), h("dd", { text: l ? fmt.peso(l.i) : "n/a" })),
        h("div", {}, h("dt", { text: "City or municipality poverty" }), h("dd", { text: l ? RAMPS.poverty.format(l.p) : "n/a" }))));
      if (area) box.append(h("p", { class: "d-note", text: `Poverty level set by: ${area.id}, official ${area.official == null ? "n/a" : `${area.official}%`}${area.p != null ? `, ${area.p.toFixed(1)}% as used here` : ""}. ${l?.src ? `Municipal pattern: ${l.src}.` : ""}` }));
      box.append(h("p", { class: "d-note", text: "These are model-based estimates, and figures for individual barangays may be inaccurate. They are best used to identify broader patterns, not to rank or evaluate individual barangays." }));
      if (TYPE_NOTE[p.t]) box.append(h("p", { class: "d-note", text: TYPE_NOTE[p.t] }));
      if (p.m === "code_rename") box.append(h("p", { class: "d-note", text: "This barangay's name differs from the 2023 boundary layer. It was linked by its code." }));
      if (l?.name === "City of Taguig" || l?.name === "City of Makati") box.append(h("p", { class: "d-note", text: "The 2023 city figures behind Makati and Taguig still counted the EMBO barangays in Makati, so levels here are less certain." }));
    }
    box.append(h("div", { class: "d-links" }, h("a", { href: REPORT_URL(l ? `${p.n}, ${l.name}` : p.n), target: "_blank", rel: "noopener", text: "Report a problem" }), l ? h("a", { href: `trends.html#a=m:${l.id}`, text: `${l.name} over time` }) : null));
  } else if (sel.kind === "lgu") {
    const l = lguById.get(sel.id);
    const area = provById.get(l.parent);
    box.append(h("div", { class: "crumbs", text: [l.reg, l.prov].filter(Boolean).join(" › ") }), h("div", { class: "d-title", text: l.name }));
    box.append(h("div", { class: "tiny", text: `PSGC ${l.id}${l.cls ? ` · ${{ HUC: "Highly urbanized city", ICC: "Independent component city", CC: "Component city" }[l.cls]}` : ""}` }));
    box.append(bigValue("Estimated average monthly household income", fmt.peso(l.i), `Barangays range from ${fmt.peso(l.imin)} to ${fmt.peso(l.imax)}`, intervalBar(l.imin ?? l.i, l.i, l.imax ?? l.i, 120000, "var(--income)", natI, `Philippines ${fmt.pesoExact(natI)}`)));
    box.append(bigValue("Estimated poverty incidence", RAMPS.poverty.format(l.p), `Barangays range from ${l.pmin?.toFixed(1)}% to ${l.pmax?.toFixed(1)}%`, intervalBar(l.pmin ?? l.p, l.p, l.pmax ?? l.p, 100, "var(--poverty)", nat, `Philippines ${nat}%`)));
    box.append(h("dl", { class: "d-kv" },
      h("div", {}, h("dt", { text: "Population, 2024 census" }), h("dd", { text: fmt.int(l.pop) })),
      h("div", {}, h("dt", { text: "Estimated people in poverty" }), h("dd", { text: fmt.int(l.poor) })),
      h("div", {}, h("dt", { text: "Barangays" }), h("dd", { text: fmt.int(l.nb) })),
      h("div", {}, h("dt", { text: "Households" }), h("dd", { text: fmt.int(l.hh) }))));
    const chartBox = h("div", {});
    box.append(chartBox);
    if (area) box.append(h("p", { class: "d-note", text: `Poverty level set by: ${area.id}, official ${area.official == null ? "n/a" : `${area.official}%`}. Municipal pattern: ${l.src}. City and municipal figures are moderate estimates.` }));
    box.append(h("div", { class: "d-links" }, h("a", { href: `trends.html#a=m:${l.id}`, text: "Full trend" }), h("a", { href: REPORT_URL(l.name), target: "_blank", rel: "noopener", text: "Report a problem" })));
    getJSON("series.json").then((sr) => {
      const q = sr[`m:${l.id}`];
      if (!q || !q.pov?.length) return;
      const pts = q.pov.map((r) => ({ x: r[0], y: r[1], lo: r[2], hi: r[3] }));
      if (q.est != null && !q.pov.some((r) => r[0] === 2025)) pts.push({ x: 2025, y: q.est, hollow: true });
      chartBox.append(h("div", { class: "lab tiny", text: "Poverty over time, official figures and the 2025 estimate" }));
      lineChart(chartBox, 318, { series: [{ key: "a", label: l.name, color: "poverty", points: pts }], height: 120, xTicks: [2018, 2021, 2023, 2025], yFormat: (v) => `${v}%`, tipFormat: (v) => `${v.toFixed(1)}%`, compact: true, yMin: 0 });
    }).catch(() => {});
  } else {
    const a = sel.kind === "province" ? provById.get(sel.id) : regById.get(sel.id);
    box.append(h("div", { class: "crumbs", text: sel.kind === "province" ? a.reg : "Region" }), h("div", { class: "d-title", text: a.name }));
    box.append(bigValue("Average monthly household income", sel.kind === "province" ? fmt.peso(a.i) : fmt.pesoExact(a.i_official ?? a.i), sel.kind === "province" ? "Weighted by households across the area" : "Family Income and Expenditure Survey (FIES) 2025, preliminary"));
    box.append(bigValue(sel.kind === "province" && a.official != null ? "Poverty incidence, as used here" : "Poverty incidence, official", `${(a.p ?? a.official).toFixed(1)}%`, a.official != null ? `PSA published ${a.official}%${a.cv ? `, coefficient of variation ${a.cv}%` : ""}` : null));
    box.append(h("dl", { class: "d-kv" },
      h("div", {}, h("dt", { text: "Population, 2024 census" }), h("dd", { text: fmt.int(a.pop) })),
      h("div", {}, h("dt", { text: "Estimated people in poverty" }), h("dd", { text: fmt.int(a.poor) })),
      h("div", {}, h("dt", { text: "Barangays" }), h("dd", { text: fmt.int(a.nb) })),
      h("div", {}, h("dt", { text: "Households" }), h("dd", { text: fmt.int(a.hh) }))));
  }
}

// ---- address bar: every view can be linked
function writeHash() {
  const q = new URLSearchParams();
  if (state.metric !== "income") q.set("m", state.metric);
  if (state.level !== "barangay") q.set("l", state.level);
  if (state.ver) q.set("ver", state.ver);
  if (state.from) q.set("from", state.from);
  if (state.local) q.set("fit", "1");
  if (state.sel?.kind === "bgy") q.set("b", `${state.sel.chunk}/${state.sel.id}`);
  else if (state.sel?.kind === "lgu") q.set("g", state.sel.id);
  history.replaceState(null, "", q.toString() ? `#${q}` : location.pathname + location.search);
}
function readHash() {
  return new URLSearchParams(location.hash.slice(1));
}

async function boot() {
  const gl = document.createElement("canvas");
  if (!window.maplibregl || !(gl.getContext("webgl2") || gl.getContext("webgl"))) {
    el("map").replaceChildren(h("div", { style: "padding:80px 24px;color:#e7f0f2;max-width:520px" }, h("h2", { text: "This map needs WebGL" }), h("p", { text: "Your browser could not start it. The home page has a simpler version of the map, and the statistics page has every figure as a table." }), h("p", {}, h("a", { href: "index.html", style: "color:#62c4d8", text: "Go to the home page" }))));
    return;
  }
  const [m, lg, ar, ch, geoL, geoP, geoR, vs] = await Promise.all([getJSON("meta.json"), getJSON("lgus.json"), getJSON("areas.json"), getJSON("chunks.json"), getJSON("geo/lgu.json"), getJSON("geo/province.json"), getJSON("geo/region.json"), getJSON("versions.json")]);
  meta = m;
  versions = vs;
  lgus = objects(lg);
  lguById = new Map(lgus.map((l) => [l.id, l]));
  lguIndex = new Map(lgus.map((l, i) => [l.id, i]));
  provs = objects(ar.province);
  provById = new Map(provs.map((a) => [a.id, a]));
  regs = objects(ar.region);
  regById = new Map(regs.map((a) => [a.id, a]));
  chunkRows = objects(ch);

  const q = readHash();
  if (q.get("m") && (RAMPS[q.get("m")] || q.get("m") === "poor")) state.metric = q.get("m");
  if (q.get("l")) state.level = q.get("l");
  if (q.get("fit")) state.local = true;

  map = new maplibregl.Map({
    container: "map",
    style: { version: 8, glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf", sources: {}, layers: [{ id: "sea", type: "background", paint: { "background-color": SEA } }, { id: "overlay-start", type: "background", layout: { visibility: "none" } }, { id: "overlay-names", type: "background", layout: { visibility: "none" } }, { id: "overlay-top", type: "background", layout: { visibility: "none" } }] },
    bounds: [[116.6, 4.4], [127.2, 21.3]],
    fitBoundsOptions: { padding: innerWidth < 760 ? { top: 16, bottom: 190, left: 16, right: 16 } : { top: 20, bottom: 20, left: 350, right: 40 } },
    minZoom: 4,
    maxZoom: 16,
    maxBounds: [[106, -3], [138, 28]],
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: `Estimates: <a href="https://github.com/${meta.repo}">this project</a> · Boundaries: PSGC shapefiles (MIT)` }), innerWidth < 760 ? "top-right" : "bottom-right");
  map.on("error", (e) => { if (e?.error?.message && !/openfreemap/.test(e.error.message)) console.warn(e.error.message); });

  map.on("load", async () => {
    const lf = toFeatures(geoL, (id) => {
      const l = lguById.get(id);
      const p = { id };
      if (l) { if (l.p != null) p.p = l.p; if (l.i != null) p.i = l.i; p.poor = l.poor; }
      return p;
    });
    const pf = toFeatures(geoP, (id) => {
      const a = provById.get(id);
      const p = { id };
      if (a) { if (a.p != null) p.p = a.p; if (a.i != null) p.i = a.i; p.poor = a.poor; }
      return p;
    });
    const rf = toFeatures(geoR, (id) => {
      const a = regById.get(id);
      const p = { id };
      if (a) { if (a.official != null) p.p = a.official; if (a.i_official != null) p.i = a.i_official; p.poor = a.poor; }
      return p;
    });
    addCoverage("lgu", setStore("lgu", lf));
    addCoverage("province", setStore("province", pf));
    addCoverage("region", setStore("region", rf));
    map.addLayer({ id: "lgu-line", type: "line", source: "lgu", minzoom: 5.5, paint: { "line-color": SEA, "line-opacity": ["interpolate", ["linear"], ["zoom"], 5.5, 0.25, 8, 0.7, 12, 0.9], "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.3, 10, 0.9, 14, 1.6] } }, "overlay-names");
    map.addLayer({ id: "province-line", type: "line", source: "province", paint: { "line-color": SEA, "line-width": 0.8 } }, "overlay-names");
    map.addLayer({ id: "region-line", type: "line", source: "region", paint: { "line-color": SEA, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 9, 1.8] } }, "overlay-names");
    const bubble = (id, rows, k0, k1) => {
      map.addSource(`${id}-pts`, { type: "geojson", promoteId: "id", data: { type: "FeatureCollection", features: rows.filter((r) => r.lon != null && r.poor > 0).map((r) => ({ type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] }, properties: { id: r.id, poor: r.poor } })) } });
      map.addLayer({ id: `${id}-bubble`, type: "circle", source: `${id}-pts`, layout: { visibility: "none", "circle-sort-key": ["-", 0, ["get", "poor"]] }, paint: { "circle-color": "#fb794d", "circle-opacity": 0.78, "circle-stroke-color": SEA, "circle-stroke-width": 0.8, "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["*", ["sqrt", ["get", "poor"]], k0], 11, ["*", ["sqrt", ["get", "poor"]], k1]] } }, "overlay-top");
    };
    bubble("lgu", lgus, 0.028, 0.16);
    bubble("province", provs, 0.03, 0.13);
    bubble("region", regs, 0.03, 0.1);
    for (const hl of ["hover", "selected"]) map.addSource(hl, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "hover-line", type: "line", source: "hover", paint: { "line-color": "#ffffff", "line-width": 1.2, "line-opacity": 0.9 } });
    map.addLayer({ id: "selected-casing", type: "line", source: "selected", paint: { "line-color": SEA, "line-width": 5, "line-opacity": 0.75 } });
    map.addLayer({ id: "selected-line", type: "line", source: "selected", paint: { "line-color": "#ffffff", "line-width": 2.4 } });

    // roads and place names are a convenience: the map still works if this outside service is down
    try {
      map.addSource("omt", { type: "vector", url: "https://tiles.openfreemap.org/planet" });
      map.addLayer({ id: "roads", type: "line", source: "omt", "source-layer": "transportation", minzoom: 8, filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"], true, false], layout: { "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-opacity": ["interpolate", ["linear"], ["zoom"], 8, 0.14, 12, 0.3, 15, 0.42], "line-width": ["interpolate", ["linear"], ["zoom"], 8, ["match", ["get", "class"], ["motorway", "trunk"], 0.9, ["primary"], 0.5, 0.15], 14, ["match", ["get", "class"], ["motorway", "trunk"], 2.4, ["primary"], 1.8, ["secondary"], 1.2, 0.6]] } }, "overlay-names");
      map.addLayer({ id: "places", type: "symbol", source: "omt", "source-layer": "place", minzoom: 5.5, filter: ["match", ["get", "class"], ["city", "town"], true, false], layout: { "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]], "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 6, 10.5, 12, 13.5], "text-max-width": 8 }, paint: { "text-color": "#eef6f7", "text-halo-color": SEA, "text-halo-width": 1.3 } }, "overlay-top");
    } catch (e) { /* the map works without them */ }

    map.on("mousemove", onMove);
    map.getCanvasContainer().addEventListener("mouseleave", () => { el("map-tip").hidden = true; setHighlight("hover", null); });
    map.on("click", onClick);
    map.on("moveend", () => {
      loadVisibleChunks();
      if (state.local) updateLocal();
    });

    const known = (id) => versions.versions.length > 1 && versions.versions.some((v) => v.id === id);
    if (known(q.get("ver")) || known(q.get("from"))) await setVersions(known(q.get("ver")) ? q.get("ver") : null, known(q.get("from")) ? q.get("from") : null);
    refreshAll();
    if (q.get("b")) {
      const [c, id] = q.get("b").split("/");
      try { await ensureChunk(c); select({ kind: "bgy", id, chunk: c }, true); } catch (e) { /* bad link: stay on the country view */ }
    } else if (q.get("g")) {
      select({ kind: "lgu", id: q.get("g") }, true);
    }
    loadVisibleChunks();
    setStatus(el("map-status").textContent);
  });

  // ---- controls
  segMetric = segmented(el("metric"), [{ value: "income", label: "Income" }, { value: "poverty", label: "Poverty" }, { value: "poor", label: "Poor people" }], state.metric, (v) => { state.metric = v; refreshAll(); }, "Measure");
  segLevel = segmented(el("level"), [{ value: "region", label: "Region" }, { value: "province", label: "Province" }, { value: "lgu", label: "City/mun." }, { value: "barangay", label: "Barangay" }], state.level, (v) => { state.level = v; refreshAll(); }, "Level");
  const localBox = el("local");
  localBox.checked = state.local;
  localBox.addEventListener("change", () => { state.local = localBox.checked; state.localRamp = null; refreshAll(); });
  const verSel = el("ver");
  const fromSel = el("from");
  if (verSel) {   // the page has these only once the site holds more than one version
    for (const v of versions.versions) {
      verSel.append(h("option", { value: v.id, text: `${v.id} · ${fmt.date(v.date)}` }));
      if (v.id !== versions.current) fromSel.append(h("option", { value: v.id, text: `${v.id} · ${fmt.date(v.date)}` }));
    }
    verSel.value = versions.versions.some((v) => v.id === q.get("ver")) ? q.get("ver") : versions.current;
    fromSel.value = versions.versions.some((v) => v.id === q.get("from")) ? q.get("from") : "";
    const onVer = () => {
      if (fromSel.value && fromSel.value === verSel.value) fromSel.value = "";
      setVersions(verSel.value, fromSel.value);
    };
    verSel.addEventListener("change", onVer);
    fromSel.addEventListener("change", onVer);
  }

  combobox(el("search"), {
    search: searchPlaces,
    label: (p) => p.name,
    sub: placeSub,
    onPick: async (p) => {
      el("search").value = p.name;
      const c = el("panel-controls");
      if (innerWidth < 760) c.classList.add("collapsed");
      if (p.kind === "lgu") {
        if (state.level === "region" || state.level === "province") state.level = "lgu";
        applyLevel();
        select({ kind: "lgu", id: p.id }, true);
      } else {
        state.level = "barangay";
        if (state.metric === "poor") state.metric = "income";
        refreshAll();
        map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 11), duration: 600 });
        await ensureChunk(p.chunk);
        select({ kind: "bgy", id: p.id, chunk: p.chunk }, true);
      }
    },
  });
  el("detail-close").addEventListener("click", clearSelection);
  el("panel-toggle").addEventListener("click", () => {
    const c = el("panel-controls");
    c.classList.toggle("collapsed");
    el("panel-toggle").textContent = c.classList.contains("collapsed") ? "Layers" : "Close";
  });
  if (innerWidth < 760) el("panel-controls").classList.add("collapsed");
}
window.addEventListener("hashchange", () => location.reload());
boot().catch((e) => {
  console.error(e);
  el("map-status").textContent = "The map could not load. Check your connection and reload the page.";
});
