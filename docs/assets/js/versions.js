// Version history, laid out like a document's history: a dated list on the side, the differences in the main pane.
import { getJSON, fmt, h, figure, combobox } from "./lib.js?b=4f78ad799d";
import { columns } from "./charts.js?b=4f78ad799d";
import { searchPlaces, placeSub } from "./places.js?b=4f78ad799d";

const SIGN = { Added: ["add", "+"], Fixed: ["chg", "~"], Changed: ["chg", "~"], Removed: ["del", "−"] };
let V;
let from;
let to;
const list = () => V.versions;
const byId = (id) => V.versions.find((v) => v.id === id);
const older = (id) => { const i = list().findIndex((v) => v.id === id); return list()[i + 1]?.id || null; };

function rail() {
  const box = document.getElementById("rail");
  if (!box) return;
  const ul = h("ul", { class: "rail-list" });
  let lastDate = "";
  const iTo = list().findIndex((v) => v.id === to);
  const iFrom = from ? list().findIndex((v) => v.id === from) : iTo;
  list().forEach((v, i) => {
    const li = h("li", {});
    if (v.date !== lastDate) {
      li.append(h("div", { class: "rail-date", text: fmt.date(v.date) }));
      lastDate = v.date;
    }
    const b = h("button", { type: "button", class: `rail-item ${i > iTo && i <= iFrom ? "in-range" : ""}`, "aria-current": v.id === to ? "true" : "false", onclick: () => pick(v.id, older(v.id)) },
      h("span", { class: "rail-top" }, h("span", { class: "ver", text: v.id }), v.id === V.current ? h("span", { class: "pill", text: "Current" }) : h("span", { class: "tiny", text: "Superseded" })),
      h("b", { text: v.label }), h("span", { class: "tiny", text: v.scope }));
    li.append(b);
    ul.append(li);
  });
  box.replaceChildren(h("h2", { style: "font-size:1.25rem", text: "History" }), ul, h("p", { class: "tiny", text: "Select a version to see what changed from the one before it. Use the two menus to compare any pair." }));
}

function pick(t, f) {
  to = t;
  from = f;
  history.replaceState(null, "", `#${from ? `${from}..` : ""}${to}`);
  render();
}

function selects() {
  const a = document.getElementById("cmp-from");
  if (!a) return;
  const b = document.getElementById("cmp-to");
  a.replaceChildren(h("option", { value: "", text: "Nothing earlier" }), ...list().map((v) => h("option", { value: v.id, text: `${v.id} · ${fmt.date(v.date)}` })));
  b.replaceChildren(...list().map((v) => h("option", { value: v.id, text: `${v.id} · ${fmt.date(v.date)}` })));
  a.value = from || "";
  b.value = to;
}

function diffLines(items) {
  return h("div", { class: "diff" }, items.map(([kind, text]) => {
    const [cls, sign] = SIGN[kind] || ["chg", "~"];
    return h("div", { class: cls }, h("span", { class: "sign", "aria-label": kind, text: sign }), h("span", { class: "txt", text }));
  }));
}

function claimLines(items) {
  const box = h("div", { class: "diff" });
  items.forEach(([was, now], i) => {
    box.append(h("div", { class: `del ${i ? "pair-gap" : ""}` }, h("span", { class: "sign", "aria-label": "Removed", text: "−" }), h("span", { class: "txt", text: was })));
    box.append(h("div", { class: "add" }, h("span", { class: "sign", "aria-label": "Added", text: "+" }), h("span", { class: "txt", text: now })));
  });
  return box;
}

function section(parent, title, ...kids) {
  parent.append(h("section", { class: "vsec" }, h("h3", { text: title }), ...kids));
}

const dOf = (a, b) => V.diffs[`${a}..${b}`];
const signed = (d, f) => `${d > 0 ? "+" : "−"}${f(Math.abs(d))}`;

function numbers(parent, A, B) {
  const rows = [
    ["National household income (₱) per month, weighted", "income", fmt.int, (d) => signed(d, (x) => `₱${fmt.int(x)}`)],
    ["National poverty, %, weighted", "poverty", (v) => v?.toFixed(2), (d) => `${signed(d, (x) => x.toFixed(2))} points`],
    ["People counted", "population", fmt.int, (d) => signed(d, fmt.int)],
    ["Rows with estimates", "with_estimates", fmt.int, (d) => signed(d, fmt.int)],
    ["Median barangay income (₱) per month", "income_median", fmt.int, (d) => signed(d, (x) => `₱${fmt.int(x)}`)],
    ["Median barangay poverty, %", "poverty_median", (v) => v?.toFixed(2), (d) => signed(d, (x) => x.toFixed(2))],
    ["Median width of the 90% poverty interval, points", "pi_width_median", (v) => (v == null ? "n/a" : v.toFixed(1)), (d) => signed(d, (x) => x.toFixed(1))],
  ];
  const cell = (a, b, df) => {
    if (a == null || b == null) return h("td", { class: "n same", text: "n/a" });
    const d = b - a;
    return h("td", { class: `n ${Math.abs(d) < 1e-9 ? "same" : ""}`, text: Math.abs(d) < 1e-9 ? "no change" : df(d) });
  };
  const tbl = h("table", {}, h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Measure" }), h("th", { scope: "col", class: "n", text: A.id }), h("th", { scope: "col", class: "n", text: B.id }), h("th", { scope: "col", class: "n", text: "Difference" }))),
    h("tbody", {}, rows.map(([label, k, f, df]) => h("tr", {}, h("td", { text: label }), h("td", { class: "n", text: f(A.stats[k]) ?? "n/a" }), h("td", { class: "n", text: f(B.stats[k]) ?? "n/a" }), cell(A.stats[k], B.stats[k], df)))));
  section(parent, "Headline numbers", h("div", { class: "tv" }, tbl), (A.scope !== B.scope) ? h("p", { class: "tiny", text: `${A.id} covers ${A.scope.toLowerCase()}. ${B.id} covers ${B.scope.toLowerCase()}. Figures are each version's own, and each is weighted by its own population.` }) : null);
}

function movement(parent, A, B) {
  const d = dOf(A.id, B.id);
  if (!d) return;
  const P = d.poverty;
  const I = d.income;
  const sec = h("section", { class: "vsec" }, h("h3", { text: "How far barangay estimates moved" }));
  parent.append(sec);
  sec.append(h("p", { class: "small", text: `On the ${fmt.int(d.matched)} barangays in both versions, income moved by a median of ${I.median}% (99th percentile ${I.p99}%, largest ${I.max}%). Poverty moved by a median of ${P.median} points (99th percentile ${P.p99}, largest ${P.max}), with ${fmt.int(P.over1)} moving over 1 point and ${fmt.int(P.over5)} over 5. Rank correlation between the versions: ${I.rank} for income, ${P.rank} for poverty.` }));
  const box = h("div", { class: "two" });
  sec.append(box);
  const iRows = d.hist_income.labels.map((l, i) => ({ label: l, value: d.hist_income.counts[i] }));
  const pRows = d.hist.labels.map((l, i) => ({ label: l, value: d.hist.counts[i] }));
  figure(box, {
    title: "Change in barangay income",
    sub: `Number of barangays, ${B.id} against ${A.id}, in percent.`,
    draw: (b, w) => columns(b, w, { rows: iRows, color: "income", format: (v) => (v >= 1000 ? fmt.compact(v) : String(v)), yFormat: (v) => fmt.compact(v), height: 220, tipRows: (q) => [{ value: fmt.int(q.value), label: "barangays" }] }),
    table: () => ({ headers: ["Change", "Barangays"], numeric: [0, 1], rows: iRows.map((r) => [r.label, fmt.int(r.value)]) }),
  });
  figure(box, {
    title: "Change in barangay poverty rate",
    sub: `Number of barangays, ${B.id} minus ${A.id}, in percentage points.`,
    draw: (b, w) => columns(b, w, { rows: pRows, color: "poverty", format: (v) => (v >= 1000 ? fmt.compact(v) : String(v)), yFormat: (v) => fmt.compact(v), height: 220, tipRows: (q) => [{ value: fmt.int(q.value), label: "barangays" }] }),
    table: () => ({ headers: ["Change, points", "Barangays"], numeric: [0, 1], rows: pRows.map((r) => [r.label, fmt.int(r.value)]) }),
  });
  sec.append(h("details", {}, h("summary", { text: "By region" }), h("div", { class: "tv" }, h("table", {}, h("thead", {}, h("tr", {}, ["Region", `${A.id} (₱) per month`, `${B.id} (₱) per month`, `${A.id} poverty %`, `${B.id} poverty %`].map((t, i) => h("th", { scope: "col", class: i ? "n" : null, text: t })))), h("tbody", {}, d.regions.map((r) => h("tr", {}, h("td", { text: r.name }), h("td", { class: "n", text: fmt.int(r.ia) }), h("td", { class: "n", text: fmt.int(r.ib) }), h("td", { class: "n", text: r.a }), h("td", { class: "n", text: r.b }))))))));
  sec.append(h("p", {}, h("a", { class: "btn quiet", href: `map.html#ver=${B.id}&from=${A.id}`, text: "See this change on the map" })));
}

function added(parent, B, A) {
  const hi = B.date;
  const lo = A ? A.date : "0000";
  const rows = B.no_new_inputs ? [] : V.log.filter((r) => r.date <= hi && r.date > lo);
  const grouped = {};
  rows.forEach((r) => { (grouped[r.date] = grouped[r.date] || []).push(r); });
  const dates = Object.keys(grouped).sort().reverse();
  const note = A ? null : h("p", { class: "small" }, "Dated by each file. Raw files are not republished, and the ", h("a", { href: "methods.html#sources", text: "source list" }), " has their checksums.");
  section(parent, A ? "Data added for this version" : "The data behind this version", note, dates.length ? h("ol", { class: "tl" }, dates.map((d) => h("li", {}, h("b", { text: fmt.date(d) }), h("ul", {}, grouped[d].map((r) => h("li", {}, `${r.label} `, h("span", { class: "tiny", text: `· ${r.source}` }))))))) : h("p", { class: "small", text: B.no_new_inputs ? "No new source files. Every change here came from reworking data already in the project." : "None between these versions." }));
}

function lookup(parent) {
  const inputId = "bgy-lookup";
  const input = h("input", { type: "search", id: inputId, placeholder: "Type a barangay name", style: "width:100%" });
  const out = h("div", {});
  const sec = h("section", { class: "vsec" }, h("h3", { text: "Look up one barangay across versions" }), h("div", { class: "combo", style: "max-width:420px" }, h("label", { for: inputId, class: "tiny", text: "Barangay" }), input), out);
  parent.append(sec);
  combobox(input, {
    search: async (q) => (await searchPlaces(q)).filter((p) => p.kind === "bgy"),
    label: (p) => p.name, sub: placeSub,
    onPick: async (p) => {
      input.value = p.name;
      const rows = await Promise.all(list().map(async (v) => {
        try {
          const [idx, vals] = await Promise.all([getJSON(`bgy/${p.chunk}.json`), getJSON(`versions/${v.id}/${p.chunk}.json`)]);
          const i = idx.ids.indexOf(p.id);
          return [v, vals.i[i], vals.p[i], vals.h ? vals.h[i] : null];
        } catch (e) { return [v, null, null, null]; }
      }));
      out.replaceChildren(h("div", { class: "tv" }, h("table", {}, h("thead", {}, h("tr", {}, ["Version", "Date", "Income (₱) per month", "Poverty %", "People"].map((t, i) => h("th", { scope: "col", class: i > 1 ? "n" : null, text: t })))),
        h("tbody", {}, rows.map(([v, a, b, c]) => h("tr", {}, h("td", { class: "ver", text: v.id }), h("td", { text: fmt.date(v.date) }), h("td", { class: "n", text: a == null ? "not covered" : fmt.hundreds(a) }), h("td", { class: "n", text: b == null ? "not covered" : b.toFixed(1) }), h("td", { class: "n", text: c == null ? "not covered" : fmt.int(c) })))))),
      h("p", { class: "tiny", text: "v0.2 and v0.1 modeled population from satellite data, and labeled their figures 2026. See what changed in v0.3." }));
    },
  });
}

function render() {
  rail();
  selects();
  const main = document.getElementById("vmain");
  main.replaceChildren();
  const B = byId(to);
  const A = from ? byId(from) : null;
  main.append(h("header", { class: "fig-head" }, h("div", { class: "eyebrow", text: `${B.id} · ${fmt.date(B.date)}${B.time_note ? `, ${B.time_note}` : ""}` }), h("h2", { text: B.label }), h("p", { class: "lede", style: "font-size:1.125rem", text: B.summary }), h("div", { class: "chips" }, h("span", { text: `Covers: ${B.scope}` }), h("span", { text: `Levels from: ${B.levels_from}` }))));
  const notAdjacent = A && older(B.id) !== A.id;
  if (notAdjacent) main.append(h("p", { class: "small", text: `You are comparing ${A.id} with ${B.id}, which spans ${list().findIndex((v) => v.id === A.id) - list().findIndex((v) => v.id === B.id)} versions. The changes listed below are those made in ${B.id} itself. The numbers cover the whole span.` }));
  section(main, A ? `What changed in ${B.id}` : `What ${B.id} contains`, A ? diffLines(B.changes) : h("div", { class: "prose" }, h("ul", {}, B.changes.map(([, text]) => h("li", { text })))));
  if (B.fixed) {
    const tbl = h("table", {}, h("thead", {}, h("tr", {}, ["Error in the earlier version", "Evidence", "Fix"].map((t) => h("th", { scope: "col", text: t })))), h("tbody", {}, B.fixed.map((r) => h("tr", {}, r.map((c) => h("td", { text: c }))))));
    section(main, "Errors this version fixed", h("div", { class: "tv", style: "max-height:none" }, tbl));
  }
  if (B.docs) section(main, "Corrections to what the project had claimed", h("p", { class: "small", text: `Lines in red are statements made about ${older(B.id)}. Lines in green replace them.` }), claimLines(B.docs));
  if (A) {
    numbers(main, A, B);
    movement(main, A, B);
  }
  added(main, B, A);
  if (list().length > 1) lookup(main);
}

async function boot() {
  V = await getJSON("versions.json");
  const m = /^#(?:(v[\d.]+)\.\.)?(v[\d.]+)$/.exec(location.hash);
  to = m && byId(m[2]) ? m[2] : V.current;
  from = m ? (m[1] && byId(m[1]) ? m[1] : null) : older(to);
  document.getElementById("cmp-from")?.addEventListener("change", (e) => pick(to, e.target.value || null));
  document.getElementById("cmp-to")?.addEventListener("change", (e) => pick(e.target.value, from === e.target.value ? older(e.target.value) : from));
  render();
  const log = document.getElementById("full-log");
  if (!log) return;
  const grouped = {};
  V.log.forEach((r) => { (grouped[r.date] = grouped[r.date] || []).push(r); });
  log.replaceChildren(...Object.keys(grouped).sort().reverse().map((d) => h("li", {}, h("b", { text: fmt.date(d) }), h("ul", {}, grouped[d].map((r) => h("li", {}, `${r.label} `, h("span", { class: "tiny", text: `· ${r.source}` })))))));
}
boot().catch(console.error);
