// Trends: any area's official series, the regions side by side, and every province's change since 2023.
import { getJSON, fmt, h, figure, combobox, rankMatches, segmented } from "./lib.js?b=65ddb44d93";
import { lineChart, dumbbell } from "./charts.js?b=65ddb44d93";

const YEARS = [2018, 2021, 2023, 2025];
let series;
let items;
const figs = {};
const KIND = { national: "Country", region: "Region", province: "Province", district: "NCR district", city: "City", lgu: "City or municipality" };

const pts = (rows) => (rows || []).map((r) => ({ x: r[0], y: r[1], lo: r[2], hi: r[3] }));
const plain = (rows) => (rows || []).map((r) => ({ x: r[0], y: r[1] }));
const pctF = (v) => `${v.toFixed(1)}%`;

function contextOf(key, q) {
  const out = [];
  if (q.type === "lgu" && q.parent && series[q.parent]) out.push([q.parent, series[q.parent]]);
  if (key !== "ph") out.push(["ph", series.ph]);
  return out;
}

function renderArea(key) {
  const q = series[key];
  if (!q) return;
  document.getElementById("area-title").textContent = q.name;
  const where = q.type === "lgu" ? [q.prov, q.reg].filter(Boolean).join(", ") : q.reg || "";
  document.getElementById("area-sub").textContent = [KIND[q.type], where].filter(Boolean).join(" · ");
  document.getElementById("area-note").textContent = q.note || "";
  document.getElementById("area-note").hidden = !q.note;
  const ctx = contextOf(key, q);
  const ctxColors = ["context", "context2"];

  // income and spending
  const inc = pts(q.inc);
  const exp = plain(q.exp);
  figs.inc.el.hidden = !inc.length;
  if (inc.length) {
    const incSeries = [{ key: "i", label: "Income", color: "income", points: inc }];
    if (exp.length) incSeries.push({ key: "e", label: "Spending", color: "s3", points: exp });
    if (key !== "ph") incSeries.push({ key: "n", label: "Philippines income", color: "context", points: plain(series.ph.inc), faint: true, width: 1.5 });
    figs.inc.update({
      title: "Average monthly household income and spending",
      sub: "The band is a 95% confidence interval from PSA's coefficients of variation, where published.",
      legend: [{ cls: "c-income", label: "Income" }, ...(exp.length ? [{ cls: "c-s3", label: "Spending" }] : []), ...(key !== "ph" ? [{ cls: "c-context", label: "Philippines income" }] : [])],
      draw: (b, w) => lineChart(b, w, { series: incSeries, xTicks: YEARS, yMin: 0, yFormat: fmt.pesoAxis, tipFormat: fmt.pesoExact, height: 270 }),
      table: () => ({ headers: ["Year", "Income (₱) per month", "Low", "High", "CV %", "Spending (₱) per month"], numeric: [0, 1, 1, 1, 1, 1], rows: q.inc.map((r) => [r[0], fmt.int(r[1]), r[2] == null ? null : fmt.int(r[2]), r[3] == null ? null : fmt.int(r[3]), r[4], (q.exp || []).find((x) => x[0] === r[0]) ? fmt.int((q.exp || []).find((x) => x[0] === r[0])[1]) : null]) }),
    });
  }

  // deciles
  figs.dec.el.hidden = !(q.dec && q.dec.length);
  if (q.dec && q.dec.length) {
    const names = ["Poorest tenth", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Richest tenth"];
    const rows = q.dec.map((r, i) => ({ label: names[i], a: r[0], b: r[2] }));
    figs.dec.update({
      title: "Monthly income by decile, 2021 and 2025",
      sub: "Average monthly household income in each tenth of households, ranked by income per person.",
      legend: [{ cls: "dot c-context", label: "2021" }, { cls: "dot c-income", label: "2025" }],
      draw: (b, w) => dumbbell(b, w, { rows, format: fmt.pesoExact, xFormat: fmt.pesoAxis, aLabel: "2021", bLabel: "2025", bColor: "income", rowH: 23 }),
      table: () => ({ headers: ["Decile", "2021 (₱) per month", "2023 (₱) per month", "2025 (₱) per month", "2025 CV %"], numeric: [0, 1, 1, 1, 1], rows: q.dec.map((r, i) => [names[i], fmt.int(r[0]), fmt.int(r[1]), fmt.int(r[2]), r[3]]) }),
    });
  }

  // inequality
  const gi = plain(q.gini);
  figs.gini.el.hidden = !gi.length;
  if (gi.length) {
    const giniSeries = [{ key: "g", label: q.name, color: "income", points: gi }];
    if (key !== "ph") giniSeries.push({ key: "n", label: "Philippines", color: "context", points: plain(series.ph.gini), faint: true, width: 1.5 });
    figs.gini.update({
      title: "Income inequality",
      sub: "Gini coefficient from the Family Income and Expenditure Survey (FIES).",
      legend: key !== "ph" ? [{ cls: "c-income", label: q.name }, { cls: "c-context", label: "Philippines" }] : [],
      draw: (b, w) => lineChart(b, w, { series: giniSeries, xTicks: [2021, 2023, 2025], yMin: 0.2, yMax: 0.55, yFormat: (v) => v.toFixed(2), tipFormat: (v) => v.toFixed(3), height: 230 }),
      table: () => ({ headers: ["Year", "Gini"], numeric: [0, 1], rows: q.gini.map((r) => [r[0], r[1]]) }),
    });
  }

  // poverty
  const main = pts(q.pov);
  const hasOwn2025 = main.some((p) => p.x === 2025);
  if (!hasOwn2025 && q.est != null) main.push({ x: 2025, y: q.est, hollow: true });
  const smoothed = q.type !== "lgu" && q.est != null && hasOwn2025 && Math.abs(q.est - main.find((p) => p.x === 2025).y) >= 0.5;
  const povSeries = [{ key: "main", label: q.name, color: "poverty", points: main, endLabel: null }];
  ctx.forEach(([, c], i) => povSeries.push({ key: `c${i}`, label: c.name, color: "context", colorClass: `c-${ctxColors[i]}`, points: pts(c.pov).map((p) => ({ x: p.x, y: p.y })), faint: true, width: 1.5 }));
  const band = q.pov && q.pov.length ? ` The band is a ${q.src === "sae" ? 90 : 95}% confidence interval.` : "";
  const hollow = !hasOwn2025 && q.est != null ? " The hollow point is this dataset's estimate." : "";
  figs.pov.update({
    title: "Poverty incidence",
    sub: `Share of people below the poverty line.${band}${hollow}`,
    note: smoothed ? `This dataset uses ${q.est.toFixed(1)}% for 2025, after smoothing PSA's direct estimate of ${main.find((p) => p.x === 2025).y.toFixed(1)}%.` : "",
    legend: [{ cls: "c-poverty", label: q.name }, ...ctx.map(([, c]) => ({ cls: "c-context", label: c.name }))],
    draw: main.length ? (b, w) => lineChart(b, w, { series: povSeries, xTicks: YEARS, yMin: 0, yFormat: (v) => `${v}%`, tipFormat: pctF, height: 270 }) : (b) => b.append(h("p", { class: "small", text: "PSA publishes no poverty series for this area. It first appears in the 2024 geographic code." })),
    table: () => ({ headers: ["Year", "Poverty %", "Low", "High", "CV %"], numeric: [0, 1, 1, 1, 1], rows: (q.pov || []).map((r) => [r[0], r[1], r[2], r[3], r[4]]).concat(!hasOwn2025 && q.est != null ? [["2025 (estimate)", q.est, null, null, null]] : []) }),
  });

  // people in poverty
  const poor = pts(q.poor);
  figs.poor.el.hidden = !poor.length;
  if (poor.length) {
    figs.poor.update({
      title: "People in poverty",
      sub: "Expressed in thousands and based on PSA's own population estimates.",
      draw: (b, w) => lineChart(b, w, { series: [{ key: "p", label: q.name, color: "poverty", points: poor }], xTicks: YEARS, yMin: 0, yFormat: (v) => (v === 0 ? "0" : v >= 1000 ? `${+(v / 1000).toFixed(1)}M` : `${v}k`), tipFormat: (v) => `${fmt.int(v * 1000)}`, height: 230 }),
      table: () => ({ headers: ["Year", "Poor people, thousands", "95% low", "95% high"], numeric: [0, 1, 1, 1], rows: q.poor.map((r) => [r[0], r[1], r[2], r[3]]) }),
    });
  }

  // poverty line
  const line = plain(q.line).map((p) => ({ x: p.x, y: (p.y * 5) / 12 }));
  figs.line.el.hidden = !line.length;
  if (line.length) {
    figs.line.update({
      title: "The poverty line",
      sub: "The monthly income required for a family of five to remain above the poverty line, calculated using the PSA’s annual per capita poverty threshold.",
      draw: (b, w) => lineChart(b, w, { series: [{ key: "l", label: q.name, color: "s3", points: line }], xTicks: YEARS, yMin: 0, yFormat: fmt.pesoAxis, tipFormat: (v) => `₱${fmt.int(v)}`, height: 230 }),
      table: () => ({ headers: ["Year", "Threshold per person (₱) per year", "Family of five (₱) per month"], numeric: [0, 1, 1], rows: q.line.map((r) => [r[0], fmt.int(r[1]), fmt.int((r[1] * 5) / 12)]) }),
    });
  }
  history.replaceState(null, "", key === "ph" ? location.pathname : `#a=${encodeURIComponent(key)}`);
}

function small(measure) {
  const field = measure === "income" ? "inc" : "pov";
  const color = measure === "income" ? "income" : "poverty";
  const f = measure === "income" ? fmt.pesoExact : pctF;
  const keys = Object.keys(series).filter((k) => k.startsWith("r:")).sort((a, b) => series[b][field][series[b][field].length - 1][1] - series[a][field][series[a][field].length - 1][1]);
  const box = document.getElementById("region-grid");
  box.replaceChildren();
  const ph = plain(series.ph[field]);
  const max = Math.max(...keys.flatMap((k) => series[k][field].map((r) => r[1])), ...ph.map((p) => p.y));
  for (const k of keys) {
    const q = series[k];
    const cell = h("button", { type: "button", class: "mini", onclick: () => { select(k); window.scrollTo({ top: document.getElementById("explorer").offsetTop - 10, behavior: "smooth" }); } }, h("span", { class: "mini-t", text: q.short || q.name }), h("span", { class: "mini-v", text: f(q[field][q[field].length - 1][1]) }));
    const chart = h("div", { class: "mini-c" });
    cell.append(chart);
    box.append(cell);
    requestAnimationFrame(() => lineChart(chart, Math.max(chart.clientWidth, 130), { series: [{ key: "n", label: "Philippines", color: "context", points: ph, faint: true, width: 1.5 }, { key: "r", label: q.short, color, points: plain(q[field]) }], yMin: 0, yMax: max, xTicks: [2018, 2025], yFormat: measure === "income" ? fmt.pesoAxis : (v) => `${v}%`, tipFormat: f, height: 104, compact: true }));
  }
}

function provinceChart(regionFilter, measure) {
  const income = measure === "income";
  const field = income ? "inc" : "pov";
  const rows = [];
  for (const k of Object.keys(series)) {
    const q = series[k];
    if (!k.startsWith("a:") || (regionFilter && q.reg !== regionFilter)) continue;
    const a = q[field].find((r) => r[0] === 2023);
    const b = q[field].find((r) => r[0] === 2025);
    if (!a || !b) continue;
    const under = !income && b[1] < 0.05;
    const noisy = (b[4] != null && b[4] >= (income ? 10 : 20)) || under;
    rows.push({ label: q.name, a: a[1], b: b[1], note: under ? "PSA reports under 0.05% for 2025" : noisy ? `Coefficient of variation ${b[4]}%: use with caution` : null });
  }
  rows.sort((x, y) => (income ? (y.b - y.a) - (x.b - x.a) : (x.b - x.a) - (y.b - y.a)));
  const f = income ? fmt.pesoExact : (v) => (v == null ? "n/a" : `${v.toFixed(1)}%`);
  figs.prov.update({
    title: income ? "Change in average monthly household income by province, 2023 to 2025" : "Change in poverty by province, 2023 to 2025",
    legend: [{ cls: "dot c-context", label: "2023" }, { cls: `dot c-${income ? "income" : "poverty"}`, label: "2025" }],
    draw: (b, w) => dumbbell(b, w, { rows, format: f, xFormat: income ? fmt.pesoAxis : (v) => `${v}%`, aLabel: "2023", bLabel: "2025", bColor: income ? "income" : "poverty", rowH: 22 }),
    table: () => ({ headers: ["Area", income ? "2023 (₱) per month" : "2023 %", income ? "2025 (₱) per month" : "2025 %", income ? "Change (₱) per month" : "Change, points", "Note"], numeric: [0, 1, 1, 1, 0], rows: rows.map((r) => (income ? [r.label, fmt.int(r.a), fmt.int(r.b), fmt.int(r.b - r.a), r.note || ""] : [r.label, r.a, r.b, (r.b - r.a).toFixed(1), r.note || ""])) }),
  });
}

function select(key) {
  document.getElementById("area").value = series[key].name;
  renderArea(key);
}

async function boot() {
  series = await getJSON("series.json");
  items = Object.keys(series).map((k) => ({ key: k, ...series[k] }));
  const left = document.getElementById("area-figs");
  for (const f of ["inc", "dec", "gini", "pov", "poor", "line"]) figs[f] = figure(left, { title: "", draw: null });
  figs.prov = figure(document.getElementById("prov-fig"), { title: "", draw: null });
  combobox(document.getElementById("area"), {
    search: async (q) => rankMatches(items, q, (x) => x.name, 16),
    label: (x) => x.name,
    sub: (x) => [KIND[x.type], x.prov || x.reg].filter(Boolean).join(" · "),
    onPick: (x) => select(x.key),
  });
  segmented(document.getElementById("region-measure"), [{ value: "income", label: "Income" }, { value: "poverty", label: "Poverty" }], "income", small, "Measure");
  small("income");
  const regionSelect = document.getElementById("prov-region");
  regionSelect.append(h("option", { value: "", text: "All regions" }));
  [...new Set(items.filter((x) => x.key.startsWith("a:")).map((x) => x.reg))].sort().forEach((r) => regionSelect.append(h("option", { value: r, text: r })));
  let provMeasure = "income";
  segmented(document.getElementById("prov-measure"), [{ value: "income", label: "Income" }, { value: "poverty", label: "Poverty" }], "income", (v) => { provMeasure = v; provinceChart(regionSelect.value, v); }, "Measure");
  regionSelect.addEventListener("change", () => provinceChart(regionSelect.value, provMeasure));
  provinceChart("", "income");
  const m = /[#&]a=([^&]+)/.exec(location.hash);
  const start = m ? decodeURIComponent(m[1]) : "ph";
  select(series[start] ? start : "ph");
}
boot().catch(console.error);
