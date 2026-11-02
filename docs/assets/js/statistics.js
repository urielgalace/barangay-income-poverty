// Descriptive statistics for 2025: regions, income, distribution, concentration, places, sortable tables.
import { getJSON, objects, fmt, h, figure, segmented } from "./lib.js?b=37970f11b8";
import { barsH, dumbbell, columns, stackedH, lineChart, scatter } from "./charts.js?b=37970f11b8";

const pctF = (v) => `${v.toFixed(1)}%`;

async function boot() {
  const [stats, lg, ar, meta] = await Promise.all([getJSON("stats.json"), getJSON("lgus.json"), getJSON("areas.json"), getJSON("meta.json")]);
  const lgus = objects(lg);
  const provs = objects(ar.province);
  const R = stats.regions;

  // regions, with a measure switch in one row above the chart
  let regMetric = "i";
  const defs = {
    i: { title: "Average monthly household income by region", sub: "Family Income and Expenditure Survey (FIES) 2025, preliminary.", color: "income", fmt: fmt.pesoExact, ref: { value: meta.income, label: `Philippines ${fmt.pesoExact(meta.income)}` } },
    p: { title: "Poverty by region", sub: "Official 2025 poverty incidence.", color: "poverty", fmt: pctF, ref: { value: meta.poverty, label: `Philippines ${meta.poverty}%` } },
    poor: { title: "People in poverty by region", sub: "Estimates based on official rates and 2024 census data.", color: "poverty", fmt: (v) => fmt.compact(v) },
  };
  const regFig = figure(document.getElementById("reg-fig"), { title: "", draw: null });
  const drawReg = () => {
    const d = defs[regMetric];
    const rows = R.slice().sort((a, b) => b[regMetric] - a[regMetric]).map((r) => ({ label: r.short, value: r[regMetric], r }));
    regFig.update({
      title: d.title, sub: d.sub,
      draw: (b, w) => barsH(b, w, { rows, color: d.color, format: d.fmt, ref: d.ref, tipRows: (q) => [{ value: fmt.pesoExact(q.r.i), label: "average monthly household income" }, { value: pctF(q.r.p), label: "poverty" }, { value: fmt.compact(q.r.poor), label: "people in poverty, estimated" }, { value: fmt.compact(q.r.pop), label: "people" }] }),
      table: () => ({ headers: ["Region", "Income (₱) per month", "Gini", "Poverty %", "People in poverty, est.", "Population", "Barangays"], numeric: [0, 1, 1, 1, 1, 1, 1], rows: R.map((r) => [r.name, fmt.int(r.i), r.gini, r.p, fmt.int(r.poor), fmt.int(r.pop), fmt.int(r.nb)]) }),
    });
  };
  segmented(document.getElementById("reg-metric"), [{ value: "i", label: "Income" }, { value: "p", label: "Poverty rate" }, { value: "poor", label: "People in poverty" }], "i", (v) => { regMetric = v; drawReg(); }, "Measure");
  drawReg();

  // share of people and share of the poor
  const shares = R.slice().sort((a, b) => (b.share_poor - b.share_pop) - (a.share_poor - a.share_pop));
  figure(document.getElementById("share-fig"), {
    title: "Concentration of poverty relative to population size",
    sub: "When a region’s orange dot is to the right of its gray dot, its share of the country’s poor is larger than its share of the population.",
    legend: [{ cls: "dot c-context", label: "Share of all people" }, { cls: "dot c-poverty", label: "Share of all people in poverty" }],
    draw: (b, w) => dumbbell(b, w, { rows: shares.map((r) => ({ label: r.short, a: r.share_pop, b: r.share_poor })), format: pctF, xFormat: (v) => `${v}%`, aLabel: "Share of people", bLabel: "Share of people in poverty" }),
    table: () => ({ headers: ["Region", "Share of people %", "Share of people in poverty %"], numeric: [0, 1, 1], rows: shares.map((r) => [r.name, r.share_pop, r.share_poor]) }),
  });

  // sources of income
  const S = stats.sources;
  const groupColors = ["income", "poverty", "s3", "s4", "s5", "s6"];
  const groups = S.groups.map((g, i) => ({ label: g, color: groupColors[i] }));
  figure(document.getElementById("src-fig"), {
    title: "Sources of household income, 2025",
    sub: "Family Income and Expenditure Survey (FIES) 2025, preliminary. Imputed rent is the estimated rental value of a home occupied by the household that owns it.",
    legend: groups.map((g) => ({ cls: `box c-${g.color}`, label: g.label })),
    draw: (b, w) => stackedH(b, w, { rows: S.rows.map((r) => ({ label: r.name, values: r.shares })), groups }),
    table: () => ({ headers: ["Area", ...S.groups.map((g) => `${g} %`)], numeric: [0, ...S.groups.map(() => 1)], rows: S.rows.map((r) => [r.name, ...r.shares]) }),
  });

  // income by decile
  const names = ["Poorest tenth", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth", "Richest tenth"];
  figure(document.getElementById("dec-fig"), {
    title: "Average monthly household income by decile, 2025",
    sub: "Family Income and Expenditure Survey (FIES) 2025, preliminary. Households ranked by income per person.",
    draw: (b, w) => barsH(b, w, { rows: stats.deciles.map((r, i) => ({ label: names[i], value: r[2], r })), color: "income", format: fmt.pesoExact, tipRows: (q) => [{ value: fmt.pesoExact(q.r[2]), label: "2025" }, { value: fmt.pesoExact(q.r[1]), label: "2023" }, { value: fmt.pesoExact(q.r[0]), label: "2021" }, { value: `${q.r[3]}%`, label: "coefficient of variation, 2025" }] }),
    table: () => ({ headers: ["Decile", "2021 (₱) per month", "2023 (₱) per month", "2025 (₱) per month", "2025 CV %"], numeric: [0, 1, 1, 1, 1], rows: stats.deciles.map((r, i) => [names[i], fmt.int(r[0]), fmt.int(r[1]), fmt.int(r[2]), r[3]]) }),
  });

  // distribution of barangays
  let histM = "income";
  let histW = "n";
  const histFig = figure(document.getElementById("hist-fig"), { title: "", draw: null });
  const drawHist = () => {
    const H = stats.hist[histM];
    const total = H.rows.reduce((a, r) => a + r[histW], 0);
    const unit = histW === "n" ? "barangays" : histM === "poverty" ? "people" : "households";
    const rows = H.rows.map((r) => ({ label: r.label, value: (r[histW] / total) * 100, raw: r }));
    histFig.update({
      title: histM === "poverty" ? "Distribution of barangays by poverty rate" : "Distribution of barangays by monthly household income",
      sub: `The proportion of ${unit} in each ${histM === "poverty" ? "poverty" : "income"} range, based on model estimates. Because the model tends to pull extreme values toward the average, the actual distribution is likely more dispersed than shown.`,
      draw: (b, w) => columns(b, w, { rows, color: histM === "poverty" ? "poverty" : "income", format: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, yFormat: (v) => `${v}%`, tipRows: (q) => [{ value: fmt.int(q.raw.n), label: "barangays" }, { value: fmt.int(q.raw.w), label: histM === "poverty" ? "people" : "households" }] }),
      table: () => ({ headers: ["Band", "Barangays", histM === "poverty" ? "People" : "Households"], numeric: [0, 1, 1], rows: H.rows.map((r) => [r.label, fmt.int(r.n), fmt.int(r.w)]) }),
    });
  };
  segmented(document.getElementById("hist-metric"), [{ value: "income", label: "Income" }, { value: "poverty", label: "Poverty" }], "income", (v) => { histM = v; drawHist(); }, "Measure");
  segmented(document.getElementById("hist-weight"), [{ value: "n", label: "Barangays" }, { value: "w", label: "People or households" }], "n", (v) => { histW = v; drawHist(); }, "Count");
  drawHist();

  // concentration
  const C = stats.concentration;
  const toPts = (c) => [{ x: 0, y: 0 }, ...c.x.map((v, i) => ({ x: (v / c.n) * 100, y: c.y[i] }))];
  document.getElementById("conc-text").textContent = `Half of all Filipinos living in poverty are concentrated in just ${fmt.int(C.lgu.half)} of the country’s ${fmt.int(C.lgu.n)} cities and municipalities, and ${fmt.int(C.bgy.half)} of the ${fmt.int(C.bgy.n)} barangays for which estimates are available.`;
  figure(document.getElementById("conc-fig"), {
    title: "Cumulative share of people living in poverty",
    sub: "Places are ranked from the highest to the lowest number of people living in poverty. The horizontal axis represents the cumulative proportion of places.",
    legend: [{ cls: "c-poverty", label: "Cities and municipalities" }, { cls: "c-income", label: "Barangays" }],
    draw: (b, w) => lineChart(b, w, { series: [{ key: "l", label: "Cities and municipalities", color: "poverty", points: toPts(C.lgu), faint: true }, { key: "b", label: "Barangays", color: "income", points: toPts(C.bgy), faint: true }], xTicks: [0, 20, 40, 60, 80, 100], xMin: 0, xMax: 100, yMin: 0, yMax: 100, yFormat: (v) => `${v}%`, xFormat: (v) => `${Math.round(v)}%`, tipFormat: pctF, height: 290 }),
    table: () => ({ headers: ["Measure", "Cities and municipalities", "Barangays"], numeric: [0, 1, 1], rows: [["Places holding half of the poor", fmt.int(C.lgu.half), fmt.int(C.bgy.half)], ["Places holding 80% of the poor", fmt.int(C.lgu.eighty), fmt.int(C.bgy.eighty)], ["Share of the poor in the top tenth of places", `${C.lgu.tenth}%`, `${C.bgy.tenth}%`]] }),
  });

  // kinds of place
  const kinds = [...stats.urban, ...stats.kinds];
  figure(document.getElementById("kind-fig"), {
    title: "Poverty across different types of places",
    sub: "Barangay-level poverty estimates are grouped by their urban or rural classification in the census and by type of local government.",
    draw: (b, w) => barsH(b, w, { rows: kinds.map((k) => ({ label: k.label, value: k.p, k })), format: pctF, labelWidth: Math.min(w * 0.5, 290), tipRows: (q) => [{ value: fmt.peso(q.k.i), label: "average monthly household income" }, { value: pctF(q.k.p), label: "poverty" }, { value: fmt.int(q.k.pop), label: "people" }, { value: fmt.int(q.k.n), label: "barangays" }] }),
    table: () => ({ headers: ["Place", "Income (₱) per month", "Poverty %", "People", "Barangays"], numeric: [0, 1, 1, 1, 1], rows: kinds.map((k) => [k.label, fmt.hundreds(k.i), k.p, fmt.int(k.pop), fmt.int(k.n)]) }),
  });

  // urban and rural by region
  const ur = R.slice().sort((a, b) => b.p_rural - a.p_rural);
  figure(document.getElementById("ur-fig"), {
    title: "Rural and urban poverty within each region",
    sub: "Based on barangay-level estimates, with urban and rural classifications drawn from the 2024 census.",
    legend: [{ cls: "dot c-income", label: "Urban barangays" }, { cls: "dot c-poverty", label: "Rural barangays" }],
    draw: (b, w) => dumbbell(b, w, { rows: ur.map((r) => ({ label: r.short, a: r.p_urban, b: r.p_rural })), format: (v) => (v == null ? "n/a" : pctF(v)), xFormat: (v) => `${v}%`, aLabel: "Urban", bLabel: "Rural", aColor: "income" }),
    table: () => ({ headers: ["Region", "Urban %", "Rural %", "Share of people in urban barangays %"], numeric: [0, 1, 1, 1], rows: ur.map((r) => [r.name, r.p_urban, r.p_rural, r.urban_share]) }),
  });

  // income and poverty, every LGU
  const regionNames = [...new Set(lgus.map((l) => l.reg))].sort();
  const sel = document.getElementById("sc-region");
  sel.append(h("option", { value: "", text: "No region highlighted" }));
  regionNames.forEach((r) => sel.append(h("option", { value: r, text: r })));
  const scFig = figure(document.getElementById("sc-fig"), { title: "Income and poverty across cities and municipalities", sub: "Each dot represents a city or municipality, with income displayed on a logarithmic scale. Hover over a dot to identify the location, or select it to view the area on the map.", draw: null });
  const drawSc = () => {
    const r = sel.value;
    const pts = lgus.filter((l) => l.p != null && l.i != null).map((l) => ({ x: l.i, y: l.p, label: `${l.name}, ${l.prov || l.reg}`, on: r && l.reg === r, id: l.id, l }));
    scFig.update({
      draw: (b, w) => scatter(b, w, { points: pts, xLabel: "Average monthly household income", yLabel: "Poverty incidence", xFormat: fmt.pesoAxis, yFormat: (v) => `${v}%`, xLog: true, xMin: 10000, xMax: 78000, xTicks: [12000, 16000, 25000, 35000, 50000, 70000], height: Math.min(460, Math.max(320, w * 0.6)), onPick: (p) => { location.href = `map.html#g=${p.id}`; }, tipRows: (p) => [{ value: fmt.peso(p.l.i), label: "average monthly household income" }, { value: `${p.l.p.toFixed(1)}%`, label: "poverty" }, { value: fmt.int(p.l.pop), label: "people" }] }),
      table: () => ({ headers: ["City or municipality", "Province", "Region", "Income (₱) per month", "Poverty %", "People"], numeric: [0, 0, 0, 1, 1, 1], rows: lgus.filter((l) => !r || l.reg === r).map((l) => [l.name, l.prov, l.reg, fmt.hundreds(l.i), l.p, fmt.int(l.pop)]) }),
    });
  };
  sel.addEventListener("change", drawSc);
  drawSc();

  // sortable tables
  sortable("prov-table", provs, [
    { key: "name", label: "Area", text: true }, { key: "reg", label: "Region", text: true }, { key: "i", label: "Income (₱) per month", f: fmt.int }, { key: "official", label: "Official poverty %", f: (v) => (v == null ? "n/a" : v.toFixed(1)) }, { key: "p", label: "Poverty used here %", f: (v) => v.toFixed(1) },
    { key: "poor", label: "People in poverty, est.", f: fmt.int }, { key: "pop", label: "People", f: fmt.int }], "i");
  sortable("lgu-table", lgus, [
    { key: "name", label: "City or municipality", text: true, link: (r) => `map.html#g=${r.id}` }, { key: "prov", label: "Province", text: true }, { key: "reg", label: "Region", text: true }, { key: "i", label: "Income (₱) per month", f: fmt.hundreds }, { key: "p", label: "Poverty %", f: (v) => (v == null ? "n/a" : v.toFixed(1)) },
    { key: "poor", label: "People in poverty", f: fmt.int }, { key: "pop", label: "People", f: fmt.int }], "i", 25, true);
}

function sortable(id, rows, cols, initial, pageSize, withFilter) {
  const box = document.getElementById(id);
  let sortKey = initial;
  let dir = -1;
  let q = "";
  let limit = pageSize || Infinity;
  const tableBox = h("div", { class: "tv" });
  const count = h("div", { class: "tiny" });
  const more = h("button", { type: "button", class: "linkish", text: "Show 100 more", onclick: () => { limit += 100; paint(); } });
  if (withFilter) {
    const inp = h("input", { type: "search", id: `${id}-q`, placeholder: "Filter by name, province or region", "aria-label": "Filter the table" });
    inp.addEventListener("input", () => { q = inp.value.trim().toLowerCase(); limit = pageSize; paint(); });
    box.append(h("div", { class: "filters", style: "margin-bottom:10px" }, inp));
  }
  box.append(tableBox, h("div", { class: "fig-foot", style: "margin-top:6px" }, count, more));
  function paint() {
    let list = rows;
    if (q) list = list.filter((r) => cols.some((c) => c.text && String(r[c.key] || "").toLowerCase().includes(q)));
    const col = cols.find((c) => c.key === sortKey);
    list = list.slice().sort((a, b) => {
      const x = a[sortKey]; const y = b[sortKey];
      if (x == null) return 1;
      if (y == null) return -1;
      return (col.text ? String(x).localeCompare(String(y)) : x - y) * dir;
    });
    const shown = list.slice(0, limit);
    const head = h("tr", {}, cols.map((c) => h("th", { scope: "col", class: c.text ? null : "n", "aria-sort": c.key === sortKey ? (dir > 0 ? "ascending" : "descending") : null }, h("button", { class: "sort", type: "button", text: `${c.label}${c.key === sortKey ? (dir > 0 ? " ▲" : " ▼") : ""}`, onclick: () => { if (sortKey === c.key) dir = -dir; else { sortKey = c.key; dir = c.text ? 1 : -1; } paint(); } }))));
    const body = shown.map((r) => h("tr", {}, cols.map((c) => {
      const v = r[c.key];
      const text = c.f ? c.f(v) : v == null ? "" : String(v);
      return h("td", { class: c.text ? null : "n" }, c.link ? h("a", { href: c.link(r), text }) : text);
    })));
    tableBox.replaceChildren(h("table", {}, h("thead", {}, head), h("tbody", {}, body)));
    count.textContent = `${fmt.int(shown.length)} of ${fmt.int(list.length)} rows`;
    more.hidden = shown.length >= list.length;
  }
  paint();
}
boot().catch(console.error);
