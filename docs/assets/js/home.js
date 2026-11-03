// Home page: the light SVG map, the national trend and the regional picture.
import { getJSON, objects, fmt, h, s, tip, figure, segmented, combobox } from "./lib.js?b=f8bef2dba2";
import { lineChart, barsH } from "./charts.js?b=f8bef2dba2";
import { RAMPS, colorOf } from "./ramps.js?b=f8bef2dba2";
import { searchPlaces, placeSub, placeLink } from "./places.js?b=f8bef2dba2";
import { suggestInto } from "./locate.js?b=f8bef2dba2";

async function drawMap() {
  const [geo, lg] = await Promise.all([getJSON("geo/home.json"), getJSON("lgus.json")]);
  const rows = new Map(objects(lg).map((l) => [l.id, l]));
  const box = document.getElementById("home-map");
  const svg = s("svg", { viewBox: `0 0 ${geo.w} ${geo.h}`, role: "img", "aria-label": "Map of the Philippines by city and municipality, colored by the selected measure. The statistics page has the same figures as tables." });
  const paths = geo.ids.map((id, i) => {
    const l = rows.get(id);
    const p = s("path", { d: geo.d[i] });
    p.addEventListener("pointermove", (e) => {
      if (!l) return;
      tip.show(e.clientX, e.clientY, [l.name, l.prov || l.reg].join(", "), [{ value: fmt.peso(l.i), label: "average monthly household income" }, { value: RAMPS.poverty.format(l.p), label: "poverty" }, { value: fmt.int(l.pop), label: "people" }]);
    });
    p.addEventListener("pointerleave", () => tip.hide());
    p.addEventListener("click", () => { location.href = `map.html#g=${id}`; });
    svg.append(p);
    return [p, l];
  });
  box.replaceChildren(svg);
  const scaleBox = document.getElementById("home-scale");
  const paint = (m) => {
    const r = RAMPS[m];
    for (const [p, l] of paths) p.setAttribute("fill", colorOf(r, l ? l[r.key] : null));
    const last = r.colors.length - 1;
    scaleBox.replaceChildren(...r.colors.map((c, i) => h("div", { class: "sw" }, h("i", { style: `background:${c}` }), h("span", { text: i === 0 ? r.ends[0] : i === last ? r.ends[1] : r.tick(r.breaks[i - 1]) }))));
    document.getElementById("home-map-title").textContent = `${r.label} by city and municipality`;
  };
  segmented(document.getElementById("home-metric"), [{ value: "income", label: "Income" }, { value: "poverty", label: "Poverty" }], "income", paint, "Measure on the map");
  paint("income");
}

async function drawCharts() {
  const [series, stats] = await Promise.all([getJSON("series.json"), getJSON("stats.json")]);
  const ph = series.ph;
  const pov = ph.pov.map((r) => ({ x: r[0], y: r[1], lo: r[2], hi: r[3] }));
  const inc = ph.inc.map((r) => ({ x: r[0], y: r[1], lo: r[2], hi: r[3] }));
  const exp = (ph.exp || []).map((r) => ({ x: r[0], y: r[1] }));
  const years = [2018, 2021, 2023, 2025];
  const a = document.getElementById("home-trend");
  figure(a, {
    title: "Household income and spending have both risen",
    sub: "Average monthly household income and spending. Spending rose faster from 2021 to 2025: 41%, versus 34% for income.",
    legend: [{ cls: "c-income", label: "Income" }, { cls: "c-s3", label: "Spending" }],
    draw: (b, w) => lineChart(b, w, { series: [{ key: "i", label: "Income", color: "income", points: inc, endLabel: w > 480 ? "Income" : null }, { key: "e", label: "Spending", color: "s3", points: exp, endLabel: w > 480 ? "Spending" : null }], xTicks: years, yMin: 0, yFormat: fmt.pesoAxis, tipFormat: fmt.pesoExact, height: 240 }),
    table: () => ({ headers: ["Year", "Income (₱) per month", "Spending (₱) per month"], numeric: [0, 1, 1], rows: ph.inc.map((r) => [r[0], fmt.int(r[1]), fmt.int((ph.exp || []).find((x) => x[0] === r[0])?.[1])]) }),
  });
  figure(a, {
    title: "Poverty is declining",
    sub: "Proportion of Filipinos living below the official poverty line. The shaded band represents the PSA’s 95% confidence interval.",
    draw: (b, w) => lineChart(b, w, { series: [{ key: "p", label: "Philippines", color: "poverty", points: pov }], xTicks: years, yMin: 0, yFormat: (v) => `${v}%`, tipFormat: (v) => `${v.toFixed(1)}%`, height: 240 }),
    table: () => ({ headers: ["Year", "Poverty %", "95% low", "95% high"], numeric: [0, 1, 1, 1], rows: ph.pov.map((r) => [r[0], r[1], r[2], r[3]]) }),
  });
  const natI = ph.inc[ph.inc.length - 1][1];
  const natP = ph.pov[ph.pov.length - 1][1];
  const regionTips = (q) => [{ value: fmt.pesoExact(q.r.i), label: "average monthly household income" }, { value: `${q.r.p.toFixed(1)}%`, label: "poverty" }, { value: fmt.compact(q.r.poor), label: "people in poverty, estimated" }];
  const regionTable = (list) => () => ({ headers: ["Region", "Income (₱) per month", "Poverty %", "People in poverty, est."], numeric: [0, 1, 1, 1], rows: list.map((r) => [r.name, fmt.int(r.i), r.p, fmt.int(r.poor)]) });
  const byIncome = stats.regions.slice().sort((x, y) => y.i - x.i);
  const byPoverty = stats.regions.slice().sort((x, y) => y.p - x.p);
  figure(document.getElementById("home-regions"), {
    title: "Average monthly household income by region, 2025",
    sub: "Figures are based on official data, with the line indicating the national average.",
    draw: (b, w) => barsH(b, w, { rows: byIncome.map((r) => ({ label: r.short, value: r.i, r })), color: "income", format: fmt.pesoExact, ref: { value: natI, label: `Philippines ${fmt.pesoExact(natI)}` }, tipRows: regionTips }),
    table: regionTable(byIncome),
  });
  figure(document.getElementById("home-regions"), {
    title: "Poverty by region, 2025",
    sub: "Figures are based on official data, with the line indicating the national rate.",
    draw: (b, w) => barsH(b, w, { rows: byPoverty.map((r) => ({ label: r.short, value: r.p, r })), format: (v) => `${v.toFixed(1)}%`, ref: { value: natP, label: `Philippines ${natP}%` }, tipRows: regionTips }),
    table: regionTable(byPoverty),
  });
}

combobox(document.getElementById("home-search"), {
  search: searchPlaces, label: (p) => p.name, sub: placeSub,
  onPick: (p) => { location.href = placeLink(p); },
});
suggestInto(document.getElementById("home-search")).catch(console.error);
drawMap().catch((e) => { console.error(e); document.getElementById("home-map").textContent = "The map could not load. Reload the page to try again."; });
drawCharts().catch(console.error);
