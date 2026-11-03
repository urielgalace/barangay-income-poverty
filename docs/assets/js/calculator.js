// Income percentile calculator: percentile, income class and living wage, with incomes adjusted for household size by the
// square-root scale. It all runs in the browser, and nothing typed here goes into the URL.
import { getJSON, objects, fmt, h, figure, segmented, combobox, rankMatches } from "./lib.js?b=f2d0e5d55c";
import { barsH } from "./charts.js?b=f2d0e5d55c";
import { searchPlaces, placeSub } from "./places.js?b=f2d0e5d55c";

const $ = (id) => document.getElementById(id);
const SUFFIX = ["th", "st", "nd", "rd"];
const ordinal = (n) => {
  const v = n % 100;
  return `${n}${SUFFIX[(v - 20) % 10] || SUFFIX[v] || "th"}`;
};
const pctLabel = (v) => {
  const r = Math.round(v);
  return r < 1 ? "Below 1st" : r > 99 ? "Above 99th" : ordinal(r);
};
const peopleText = (v, word = "about") => {
  const r = Math.round(v);
  return r < 1 ? "less than 1%" : r > 99 ? "more than 99%" : `${word} ${r}%`;
};
// the Dagum curve, and its inverse
const shareBelow = (y, d) => 100 * Math.exp(-d.p * Math.log1p(Math.pow(y / d.b, -d.a)));
const incomeAt = (u, d) => d.b * Math.pow(Math.pow(u, -1 / d.p) - 1, -1 / d.a);
const the = (name) => (/^(City of|\d)/.test(name) ? `the ${name}` : name);
const times = (m) => (m < 100 ? m.toFixed(1) : fmt.int(m));
const para = (box, ...texts) => box.replaceChildren(...texts.filter(Boolean).map((t) => (t instanceof Node ? t : h("p", { text: t }))));

async function boot() {
  const [C, P, ar] = await Promise.all([getJSON("calculator.json"), getJSON("prices.json"), getJSON("areas.json")]);
  // the poverty line in the latest month's prices, for a family of five and for any household size
  const line5 = Math.round(C.line * P.factor) * 5;
  const lineFor = (n) => Math.round(line5 * Math.sqrt(n / 5));
  const notes = { label: P.label, pct: P.pct.toFixed(1), line5: fmt.int(line5), line1: fmt.int(lineFor(1)) };
  document.querySelectorAll("[data-price]").forEach((e) => { e.textContent = notes[e.dataset.price]; });

  const regions = objects(ar.region);
  const provinces = objects(ar.province).filter((p) => p.level !== "city");
  const nat = C.dist[0];
  const regionLabel = (s) => C.wage[s]?.label || "the Negros Island Region";
  const refName = (d, own) => (d.id === own?.id ? own.name : C.reg[d.id] != null ? regionLabel(d.id) : d.id);
  const provName = (p) => p.name.replace(/ \(BARMM residual\)/, "");
  // a place's size-adjusted average income, relative to the area whose model it borrows
  const scaled = (i, size, d) => (i / Math.sqrt(size > 0 ? size : d.z)) / (d.i / Math.sqrt(d.z));

  let period = "month";
  let basis = "individual";
  let picked = null;     // what the search box chose
  let place = null;      // that choice, with its income model
  let pctFig;
  let wageFig;

  async function resolve(it) {
    if (it.kind === "reg") {
      const s = it.r.short;
      return { name: regionLabel(s), short: s, d: C.dist[C.reg[s]], k: 1, own: true, reg: s };
    }
    if (it.kind === "prov") {
      const p = it.p;
      const d = C.dist[C.prov[p.id]];
      const own = d.id === p.id;
      return { name: provName(p), short: provName(p), d, k: own ? 1 : scaled(p.i, p.pop / p.hh, d), own, ref: refName(d), reg: p.reg, parent: p.id };
    }
    const l = it.lgu;
    const d = C.dist[C.lgu[l.id]];
    if (it.kind === "lgu") {
      const own = d.id === l.id;
      return { name: l.name, short: l.name, d, k: own ? 1 : scaled(l.i, l.pop / l.hh, d), own, ref: refName(d, l), reg: l.reg, parent: l.parent };
    }
    const t = await getJSON(`bgy/${it.chunk}.json`);
    const j = t.ids.indexOf(it.id);
    const name = `${it.name}, ${l.name}`;
    const base = { name, short: it.name, reg: l.reg, parent: l.parent, ref: refName(d, l), d };
    if (j < 0 || t.i[j] == null) return { ...base, noData: true };
    const k = scaled(t.i[j], t.h[j] / t.f[j], d);
    return { ...base, k, kLo: t.il[j] != null ? k * t.il[j] / t.i[j] : null, kHi: t.ih[j] != null ? k * t.ih[j] / t.i[j] : null };
  }

  function wageFor(p) {
    const national = { ...C.wage.ph, area: "the Philippines", mwArea: "the Philippines", note: "" };
    if (!p) return national;
    if (p.reg === "Negros Island") {
      const alt = C.negros[p.parent];
      if (!alt) return { ...national, note: "IBON Foundation does not publish a figure for the Negros Island Region, so this uses the national figure." };
      const w = C.wage[alt];
      return { ...w, area: w.label, mwArea: w.label, note: `IBON Foundation does not publish a figure for the Negros Island Region, so this uses the figure for ${w.label}.` };
    }
    const w = C.wage[p.reg];
    if (w.flw == null) return { ...national, mw: w.mw, mwArea: w.label, note: `IBON Foundation has no living wage figure for ${w.label}, because the National Wages and Productivity Commission did not release one, so this uses the national figure.` };
    return { ...w, area: w.label, mwArea: w.label, note: "" };
  }

  function card(label, value, sub, word) {
    return h("div", { class: "stat" }, h("dt", { text: label }), h("dd", { text: value, class: word ? "word" : null }), sub ? h("div", { class: "d", text: sub }) : null);
  }

  function render() {
    const msg = $("c-msg");
    const raw = $("c-income").value.replace(/[₱,\s]/g, "");
    const amount = Number(raw);
    const size = Number($("c-size").value);
    const house = basis === "household";
    msg.textContent = "";
    let ok = raw !== "";
    if (raw && !(amount > 0 && Number.isFinite(amount))) {
      msg.textContent = "Enter an income greater than zero, using numbers only.";
      ok = false;
    }
    if (house && !(Number.isInteger(size) && size >= 1 && size <= 30)) {
      msg.textContent = "Enter a household size from 1 to 30.";
      ok = false;
    }
    $("c-results").hidden = !ok;
    if (!ok) return;

    const monthly = period === "year" ? amount / 12 : amount;
    const n = house ? size : 1;
    const unit = house ? `a household of ${n}` : "one person";
    const you = house ? "Your household income" : "Your income";
    const adjusted = monthly / Math.sqrt(n) / P.factor;      // size-adjusted, in 2025 prices like the survey
    const natPct = shareBelow(adjusted, nat);
    const local = place && !place.noData;
    const locPct = local ? shareBelow(adjusted / place.k, place.d) : null;
    const lo = local && place.kHi ? shareBelow(adjusted / place.kHi, place.d) : null;
    const hi = local && place.kLo ? shareBelow(adjusted / place.kLo, place.d) : null;
    // the income a household of this size needs to reach the middle, in the latest month's prices
    const middle = (d, k = 1) => incomeAt(0.5, d) * k * P.factor * Math.sqrt(n);

    // ---- income class
    const line = lineFor(n);
    const mult = monthly / line;
    const idx = C.classes.findIndex((c) => mult >= c.lo && (c.hi == null || mult < c.hi));
    const cls = C.classes[idx];

    // ---- living wage
    const w = wageFor(place);
    const need = w.flw * Math.sqrt(n / 5);
    const pct = monthly / need * 100;
    const gap = fmt.pesoExact(Math.abs(monthly - need));

    const cards = [card("Percentile nationwide", pctLabel(natPct))];
    if (local) cards.push(card(`Percentile in ${place.short}`, pctLabel(locPct), lo != null ? `Likely range: ${pctLabel(lo)} to ${pctLabel(hi)}` : place.own ? null : "Rough estimate"));
    cards.push(card("Income class", cls.name, `${times(mult)} times the poverty line`, true));
    cards.push(card("Share of the living wage", `${fmt.int(pct)}%`, house ? `Household of ${n}` : "One person"));
    $("r-cards").replaceChildren(...cards);

    para($("r-pct-text"),
      `Adjusted for household size, ${you.toLowerCase()} is higher than that of ${peopleText(natPct)} of Filipinos.`
        + (local ? ` In ${the(place.name)}, it is higher than that of ${peopleText(locPct, place.own ? "about" : "roughly")} of residents.` : ""),
      lo != null ? `Given the margin of error of this barangay's estimate, your percentile there is likely between the ${pctLabel(lo).toLowerCase()} and the ${pctLabel(hi).toLowerCase()}.` : null,
      local && !place.own ? `The Family Income and Expenditure Survey (FIES) has no figures for ${the(place.short)} itself, so this applies the income spread of ${the(place.ref)} to the estimated average income of ${the(place.short)}.` : null,
      place?.noData ? `There is no income estimate for ${place.name}, because it had no recorded residents in the 2024 census.` : null,
      `To reach the middle of the national distribution, ${house ? `a household of ${n}` : "a person living alone"} would need about ${fmt.peso(middle(nat))} per month.`
        + (local ? ` In ${the(place.name)}, the figure is about ${fmt.peso(middle(place.d, place.k))}.` : ""));

    const pctRows = [{ label: "Philippines", value: natPct, med: middle(nat) }];
    if (local) pctRows.push({ label: place.short, value: locPct, med: middle(place.d, place.k) });
    const pctUpdate = {
      title: "Your income percentile", sub: "",
      draw: (b, W) => barsH(b, W, { rows: pctRows, color: "income", format: pctLabel, max: 100, tipRows: (r) => [{ value: pctLabel(r.value), label: "percentile" }] }),
      table: () => ({ headers: ["Area", "Your percentile", `Income (₱) per month at the 50th percentile, ${house ? `household of ${n}` : "one person"}`], numeric: [0, 1, 1], rows: pctRows.map((r) => [r.label, pctLabel(r.value), fmt.hundreds(r.med)]) }),
    };
    if (!pctFig) pctFig = figure($("r-pct-fig"), pctUpdate);
    else pctFig.update(pctUpdate);

    const lead = h("p", {}, "Based on the classification of the Philippine Institute for Development Studies, your income places you in the ", h("strong", { text: cls.name.toLowerCase() }), " class.");
    para($("r-class-text"), lead, `${you} is ${times(mult)} times the poverty line for ${unit}, which is ${fmt.pesoExact(line)} per month in ${P.label} prices.`);
    const range = (c) => {
      const a = fmt.int(line * c.lo);
      const b = c.hi && fmt.int(line * c.hi);
      return !c.lo ? `Below ${b}` : b ? `${a} to ${b}` : `${a} or more`;
    };
    const multiple = (c) => (!c.lo ? `Below ${c.hi}` : c.hi ? `${c.lo} to ${c.hi}` : `${c.lo} or more`);
    const share = (v) => (v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`);
    $("r-class-table").replaceChildren(
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: "Income class" }), h("th", { scope: "col", class: "n times", text: "Times the poverty line" }),
        h("th", { scope: "col", class: "n", text: `Income (₱) per month, ${house ? `household of ${n}` : "one person"}` }), h("th", { scope: "col", class: "n", text: "Share of Filipinos" }))),
      h("tbody", {}, C.classes.map((c, i) => h("tr", { "aria-current": i === idx ? "true" : null },
        h("td", {}, c.name, i === idx ? h("span", { class: "you", text: "You" }) : null), h("td", { class: "n times", text: multiple(c) }), h("td", { class: "n", text: range(c) }), h("td", { class: "n", text: share(c.share) })))));

    const flw = fmt.pesoExact(w.flw);
    const five = house && n === 5;
    const opening = `IBON Foundation estimates that a family of five in ${w.area} should receive ${flw} per month to live decently.`;
    const meaning = `${you} is ${fmt.int(pct)}% of the living wage for ${five ? "a family of five" : unit}. ${opening}`
      + (five ? " " : ` Adjusted for household size, that is ${fmt.pesoExact(need)} per month for ${unit}. `)
      + (pct >= 100 ? `${house ? "Your household has" : "You have"} ${gap} per month left over at that standard.` : `${house ? "Your household falls" : "You would fall"} ${gap} per month short of that standard.`);
    para($("r-wage-text"), meaning,
      house ? null : `If your income also had to support a family of five, it would cover ${fmt.int(monthly / w.flw * 100)}% of IBON's figure.`,
      `For comparison, a full-time minimum wage earner in ${w.mwArea} earns about ${fmt.pesoExact(w.mw)} per month, or ${fmt.int(w.mw / w.flw * 100)}% of the living wage for a family of five.`,
      w.note);

    const wageRows = [
      { label: "Your income", value: monthly, color: "income" },
      { label: "Living wage", value: need, color: "context" },
      { label: "Minimum wage", value: w.mw, color: "context" },
    ];
    const wageUpdate = {
      title: "Your income and the living wage",
      sub: `Pesos per month. The living wage is IBON's figure for a family of five${five ? "" : `, adjusted to ${unit}`}. The minimum wage is for one full-time worker.`,
      draw: (b, W) => barsH(b, W, { rows: wageRows, format: fmt.pesoExact }),
      table: () => ({ headers: ["", "Income (₱) per month", "Share of the living wage"], numeric: [0, 1, 1], rows: wageRows.map((r) => [r.label, fmt.int(r.value), `${fmt.int(r.value / need * 100)}%`]) }),
    };
    if (!wageFig) wageFig = figure($("r-wage-fig"), wageUpdate);
    else wageFig.update(wageUpdate);
  }

  segmented($("c-period"), [{ value: "month", label: "Monthly" }, { value: "year", label: "Annual" }], period, (v) => { period = v; render(); }, "Income period");
  segmented($("c-basis"), [{ value: "individual", label: "Individual" }, { value: "household", label: "Household" }], basis, (v) => {
    basis = v;
    $("c-size-field").hidden = v !== "household";
    render();
  }, "Whose income");
  $("c-form").addEventListener("submit", (e) => e.preventDefault());
  $("c-income").addEventListener("input", render);
  $("c-size").addEventListener("input", render);

  const box = $("c-place");
  let token = 0;
  combobox(box, {
    search: async (q) => {
      const regs = rankMatches(regions, q, (r) => `${r.name} ${r.short}${r.short === "NCR" ? " Metro Manila" : ""}`, 2).map((r) => ({ kind: "reg", name: r.name, r }));
      const provs = rankMatches(provinces, q, (p) => p.name, 3).map((p) => ({ kind: "prov", name: provName(p), p }));
      return [...regs, ...provs, ...(await searchPlaces(q))].slice(0, 14);
    },
    label: (p) => p.name,
    sub: (p) => (p.kind === "reg" ? "Region" : p.kind === "prov" ? `${p.p.level === "district" ? "District" : "Province"} · ${p.p.reg}` : placeSub(p)),
    onPick: async (it) => {
      box.value = it.name;
      picked = it.name;
      const mine = ++token;
      const r = await resolve(it);
      if (mine !== token) return;
      place = r;
      render();
    },
  });
  box.addEventListener("input", () => {
    if (picked != null && box.value !== picked) {
      picked = null;
      place = null;
      token += 1;
      render();
    }
  });
}

boot().catch((e) => {
  $("c-msg").textContent = "The calculator could not load its data. Please reload the page.";
  console.error(e);
});
