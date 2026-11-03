// Income percentile calculator: percentile, income class and living wage, with incomes adjusted for household size by the
// square-root scale. It all runs in the browser, and nothing typed here goes into the URL.
import { getJSON, objects, fmt, h, s, tip, figure, segmented, combobox, rankMatches } from "./lib.js";
import { barsH } from "./charts.js";
import { RAMPS, colorOf } from "./ramps.js";
import { loadPlaces, searchPlaces, placeSub } from "./places.js";

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
// a percentage of the living wage, or a multiple of it once it is above 100%
const ofWage = (v) => (v <= 100 ? `${fmt.int(v)}%` : `${v < 1000 ? (v / 100).toFixed(1) : fmt.int(v / 100)} times`);
// the map's percentile bands, in the site's income blues: dim for low, bright for high
const BANDS = { breaks: [25, 50, 75, 90, 95, 99], colors: RAMPS.income.colors };
const BAND_TICKS = ["Below 25th", "25th", "50th", "75th", "90th", "95th", "Above 99th"];
const cityFirst = (name) => name.replace(/^City of (.+)$/, "$1 City");
const placeAt = (v) => {
  const r = Math.round(v);
  return r > 99 ? "above the 99th percentile" : r < 1 ? "below the 1st percentile" : `at the ${ordinal(r)} percentile`;
};
const phrase = (v) => {
  const r = Math.round(v);
  return r > 99 ? "above the 99th percentile" : r < 1 ? "below the 1st percentile" : `the ${ordinal(r)} percentile`;
};
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
      return { name: regionLabel(s), short: s, d: C.dist[C.reg[s]], k: 1, own: true, reg: s, region: s, key: `reg:${s}` };
    }
    if (it.kind === "prov") {
      const p = it.p;
      const d = C.dist[C.prov[p.id]];
      const own = d.id === p.id;
      return { name: provName(p), short: provName(p), d, k: own ? 1 : scaled(p.i, p.pop / p.hh, d), own, ref: refName(d), reg: p.reg, parent: p.id, key: `prov:${p.id}` };
    }
    const l = it.lgu;
    const d = C.dist[C.lgu[l.id]];
    if (it.kind === "lgu") {
      const own = d.id === l.id;
      return { name: l.name, short: l.name, d, k: own ? 1 : scaled(l.i, l.pop / l.hh, d), own, ref: refName(d, l), reg: l.reg, parent: l.parent, lgu: l, key: `lgu:${l.id}` };
    }
    const t = await getJSON(`bgy/${it.chunk}.json`);
    const j = t.ids.indexOf(it.id);
    const name = `${it.name}, ${l.name}`;
    const base = { name, short: it.name, reg: l.reg, parent: l.parent, ref: refName(d, l), d, lgu: l, key: `lgu:${l.id}`, bgyId: it.id };
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

  // ---- the area map, shown once a place is chosen, at the chosen place's own level: the barangays of its city or
  // municipality, the cities and municipalities of its province, the provinces of its region, or the regions of the
  // country. Coloured by your percentile in each; drawn when the place changes and recoloured as you type.
  let area = null;
  let areaBuild = 0;
  let areaPaint = 0;
  let hover = { n: 1, house: false, period: "month" };     // what the tooltip's average income is expressed in
  $("r-scale").replaceChildren(...BANDS.colors.map((c, i) => h("div", { class: "sw" }, h("i", { style: `background:${c}` }), h("span", { text: BAND_TICKS[i] }))));
  const NOUN = { barangays: "Barangay", "cities and municipalities": "City or municipality", provinces: "Province", districts: "District", regions: "Region" };
  const plain = (name) => name.replace(/^the /, "").replace(/^./, (c) => c.toUpperCase());
  const allProvinces = objects(ar.province);
  const avgLabel = () => `average income, ${hover.house ? `household of ${hover.n}` : "one person"}, per ${hover.period}`;

  function areaSpec(p) {
    if (p.bgyId) return { level: "bgy", key: `bgys:${p.lgu.id}`, self: p.bgyId };
    if (p.lgu) return { level: "lgu", key: `lgus:${p.lgu.parent}`, self: p.lgu.id };
    if (p.region) return { level: "reg", key: "regions", self: p.region };
    return { level: "prov", key: `provs:${p.reg}`, self: p.parent };
  }

  // places without survey figures of their own borrow the curve of their province or region, and the note says so
  function borrowNote(units, word, every, where) {
    const tail = "These percentiles should be interpreted as estimates. Select a place on the map to use it as your location.";
    const borrowed = units.filter((u) => u.d && !u.own);
    if (!borrowed.length) return units.length === 1 ? `${units[0].label} has survey figures of its own. ${tail}` : `Every ${every} in ${where} has survey figures of its own. ${tail}`;
    const refs = [...new Set(borrowed.map((u) => u.d.id))];
    const ref = refs.length === 1 ? refName(borrowed[0].d) : refs.some((r) => C.reg[r] != null) ? "their province or region" : "their province";
    const share = borrowed.length === units.length ? "The" : borrowed.length * 2 > units.length ? "Most" : "Some";
    return `${share} ${word} in ${where} have no survey figures of their own, so these use the income spread of ${ref} as a whole, shifted to the place's estimated average income. ${tail}`;
  }

  async function areaUnits(spec, p) {
    if (spec.level === "bgy") {
      const l = p.lgu;
      const d = C.dist[C.lgu[l.id]];
      const { bgys } = await loadPlaces();
      const pts = new Map(bgys.filter((b) => b.lgu.id === l.id).map((b) => [b.id, b]));
      const chunks = [...new Set([...pts.values()].map((b) => b.chunk))];
      const files = await Promise.all(chunks.map((c) => Promise.all([getJSON(`bgy/${c}.geo.json`), getJSON(`bgy/${c}.json`), c])));
      const units = [];
      for (const [geo, v, chunk] of files) {
        geo.ids.forEach((id, i) => {
          if (v.c[i] !== l.id) return;
          const live = v.t[i] !== 3 && v.i[i] != null;
          const name = v.n[i] || "Not a barangay";
          units.push({ id, name, label: name, geom: geo.geom[i], d, own: false, k: live ? scaled(v.i[i], v.h[i] / v.f[i], d) : null,
            lon: pts.get(id)?.lon, lat: pts.get(id)?.lat, pick: v.t[i] !== 3 ? { kind: "bgy", name: v.n[i], lgu: l, chunk, id } : null });
        });
      }
      return { title: `Your percentile in each barangay of ${cityFirst(l.name)}`, word: "barangays", one: "barangay", where: cityFirst(l.name), units,
        note: `Barangay-level percentiles are estimated using the income distribution of ${cityFirst(refName(d, l))}, adjusted to each barangay’s estimated average household income and household size. These rankings should therefore be interpreted as rough estimates. Select a barangay on the map to use it as your location.` };
    }
    if (spec.level === "lgu") {
      const [geo, lg] = await Promise.all([getJSON("geo/lgu.json"), getJSON("lgus.json")]);
      const shape = new Map(geo.ids.map((id, i) => [id, geo.geom[i]]));
      const towns = objects(lg);
      let members = towns.filter((l) => l.parent === p.lgu.parent);
      let where = the(p.lgu.parent.replace(/ \(BARMM residual\)/, ""));
      // Metro Manila's districts are statistical units rather than provinces, and a few cities are province-level areas of their
      // own (Isabela City, Cotabato City): these show their region
      if (members.length < 2 || p.lgu.reg === "NCR") {
        members = towns.filter((l) => l.reg === p.lgu.reg);
        where = regionLabel(p.lgu.reg);
      }
      const units = members.filter((l) => shape.has(l.id)).map((l) => {
        const d = C.dist[C.lgu[l.id]];
        const own = d.id === l.id;
        return { id: l.id, name: cityFirst(l.name), label: cityFirst(l.name), geom: shape.get(l.id), d, own, k: l.i != null ? (own ? 1 : scaled(l.i, l.pop / l.hh, d)) : null,
          lon: l.lon, lat: l.lat, pick: { kind: "lgu", name: l.name, lgu: l, id: l.id } };
      });
      return { title: `Your percentile in each city and municipality of ${where}`, word: "cities and municipalities", one: "city or municipality", where, units,
        note: borrowNote(units, "cities and municipalities", "city and municipality", where) };
    }
    if (spec.level === "prov") {
      const geo = await getJSON("geo/province.json");
      const shape = new Map(geo.ids.map((id, i) => [id, geo.geom[i]]));
      const members = allProvinces.filter((x) => x.reg === p.reg && shape.has(x.id));
      const districts = members.every((x) => x.level === "district");
      const where = regionLabel(p.reg);
      const units = members.map((x) => {
        const d = C.dist[C.prov[x.id]];
        const own = d.id === x.id;
        const name = the(provName(x));
        return { id: x.id, name, label: plain(name), geom: shape.get(x.id), d, own, k: own ? 1 : scaled(x.i, x.pop / x.hh, d), lon: x.lon, lat: x.lat,
          pick: { kind: "prov", name: provName(x), p: x } };
      });
      const word = districts ? "districts" : "provinces";
      const one = districts ? "district" : "province";
      return { title: `Your percentile in each ${one} of ${where}`, word, one, where, units, note: borrowNote(units, word, one, where) };
    }
    const geo = await getJSON("geo/region.json");
    const shape = new Map(geo.ids.map((id, i) => [id, geo.geom[i]]));
    const units = regions.filter((r) => shape.has(r.id)).map((r) => {
      const name = regionLabel(r.short);
      return { id: r.short, name, label: plain(name), geom: shape.get(r.id), d: C.dist[C.reg[r.short]], own: true, k: 1, lon: r.lon, lat: r.lat, pick: { kind: "reg", name: r.name, r } };
    });
    return { title: "Your percentile in each region of the Philippines", word: "regions", one: "region", where: "the Philippines", units,
      note: borrowNote(units, "regions", "region", "the Philippines") };
  }

  // outlines are stored as integer degrees × 10,000, each point after the first as a step from the one before
  function drawUnits(units) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const shapes = units.map((u) => u.geom.map((part) => part.map((a) => {
      const r = new Float64Array(a.length);
      let x = a[0];
      let y = a[1];
      for (let i = 0; i < a.length; i += 2) {
        if (i) { x += a[i]; y += a[i + 1]; }
        r[i] = x;
        r[i + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return r;
    })));
    const kx = Math.cos((((y0 + y1) / 2) / 1e4) * Math.PI / 180);
    const W = 600;
    const sc = W / Math.max((x1 - x0) * kx, 1);
    const H = Math.max(120, (y1 - y0) * sc);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H.toFixed(1)}`, role: "img", "aria-label": "Map of your income percentile in each part of the chosen area. The table beside it lists the same figures." });
    units.forEach((u, j) => {
      let d = "";
      for (const part of shapes[j]) for (const r of part) {
        let seg = "";
        let lx = null;
        let ly = null;
        for (let i = 0; i < r.length; i += 2) {
          const X = (r[i] - x0) * kx * sc;
          const Y = (y1 - r[i + 1]) * sc;
          if (lx !== null && Math.abs(X - lx) < .6 && Math.abs(Y - ly) < .6) continue;     // points closer than a pixel add nothing
          seg += `${seg ? "L" : "M"}${X.toFixed(1)},${Y.toFixed(1)}`;
          lx = X;
          ly = Y;
        }
        d += `${seg}Z`;
      }
      u.p = s("path", { d, "fill-rule": "evenodd" });
      u.p.addEventListener("pointermove", (e) => {
        if (u.v == null) return;
        tip.show(e.clientX, e.clientY, u.label, [{ value: pctLabel(u.v), label: "your percentile" }, ...(u.avg != null ? [{ value: fmt.peso(u.avg), label: avgLabel() }] : [])]);
      });
      u.p.addEventListener("pointerleave", () => tip.hide());
      if (u.pick) u.p.addEventListener("click", () => choose(u.pick));
      else u.p.style.cursor = "default";
      svg.append(u.p);
    });
    return svg;
  }

  // the two places nearest to the chosen one on the map, by the distance between their centre points
  const nearest = (here, list) => {
    const kx = Math.cos((here.lat * Math.PI) / 180);
    return list.map((x) => [((x.lon - here.lon) * kx) ** 2 + (x.lat - here.lat) ** 2, x]).sort((a, b) => a[0] - b[0]).slice(0, 2).map((x) => x[1]);
  };

  async function paintArea(adjusted, n, house, period) {
    const sec = $("r-area");
    const p = place;
    if (!p) { sec.hidden = true; return; }
    const pid = ++areaPaint;
    const spec = areaSpec(p);
    if (!area || area.key !== spec.key) {
      const bid = ++areaBuild;
      const built = await areaUnits(spec, p);
      if (bid !== areaBuild) return;
      built.key = spec.key;
      built.svg = drawUnits(built.units);
      tip.hide();                      // the shapes under any open tooltip are about to be replaced
      area = built;
      $("r-map").replaceChildren(area.svg);
      $("r-area-title").textContent = area.title;
      $("r-map-all-label").textContent = `All ${area.word}`;
    }
    if (pid !== areaPaint || place !== p) return;
    sec.hidden = false;
    hover = { n, house, period };
    const yearly = period === "year" ? 12 : 1;
    const ranked = [];
    for (const u of area.units) {
      u.v = u.k != null ? shareBelow(adjusted / u.k, u.d) : null;
      // the place's average income, adjusted to your household size and period, in the latest month's prices
      u.avg = u.k != null ? (u.d.i / Math.sqrt(u.d.z)) * u.k * Math.sqrt(n) * P.factor * yearly : null;
      u.p.setAttribute("fill", colorOf(BANDS, u.v));
      u.p.classList.toggle("here", u.id === spec.self);
      if (u.v != null) ranked.push(u);
    }
    const me = area.units.find((u) => u.id === spec.self);
    if (me) area.svg.append(me.p);     // drawn last, so its outline shows on every side
    ranked.sort((a, b) => b.v - a.v);
    const count = ranked.length;
    const above = ranked.filter((u) => Math.round(u.v) > 99).length;
    const below = ranked.filter((u) => Math.round(u.v) < 1).length;

    // the chosen place beside its two nearest neighbours on the map
    const near = me && me.lon != null ? nearest(me, ranked.filter((u) => u !== me && u.lon != null)) : [];
    const self = me ? me.name : p.short;
    const selfV = me ? me.v : null;
    const lead = "After adjusting for household size, your income would place you";
    const pair = near.length === 2 ? `${placeAt(near[0].v)} in ${near[0].name} and ${phrase(near[1].v)} in ${near[1].name}` : near.length ? `${placeAt(near[0].v)} in ${near[0].name}` : null;
    const all = (test) => near.length === 2 && selfV != null && [selfV, ...near.map((x) => x.v)].every((v) => test(Math.round(v)));
    const both = near.length === 2 ? `${near[0].name} and ${near[1].name}` : "";
    const first = selfV == null
      ? (pair ? `There is no income estimate for ${self}. By comparison, your income, adjusted for household size, would place you ${pair}.` : "There are no income estimates for this area.")
      : all((r) => r > 99) ? `${lead} above the 99th percentile in ${self}, as well as in ${both}.`
        : all((r) => r < 1) ? `${lead} below the 1st percentile in ${self}, as well as in ${both}.`
          : `${lead} ${placeAt(selfV)} in ${self}.${pair ? ` By comparison, it would place you ${pair}.` : ""}`;
    para($("r-map-text"), first,
      count > 1 && above === count ? `With the same income, adjusted for household size, you would be above the 99th percentile in every one of the ${area.word} in ${area.where}.` : null,
      count > 1 && below === count ? `With the same income, adjusted for household size, you would be below the 1st percentile in every one of the ${area.word} in ${area.where}.` : null,
      above > 1 && above < count ? `It would place you above the 99th percentile in ${fmt.int(above)} of the ${fmt.int(count)} ${area.word} in ${area.where}.` : null,
      below > 1 && below < count ? `It would place you below the 1st percentile in ${fmt.int(below)} of the ${fmt.int(count)} ${area.word} in ${area.where}.` : null,
      area.note);
    const table = () => $("r-map-table").replaceChildren(
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: NOUN[area.word] }), h("th", { scope: "col", class: "n", text: "Your percentile" }),
        h("th", { scope: "col", class: "n", text: `Average income (₱) per ${period}, ${house ? `household of ${n}` : "one person"}` }))),
      h("tbody", {}, ranked.map((u) => h("tr", {}, h("td", { text: u.label }), h("td", { class: "n", text: pctLabel(u.v) }), h("td", { class: "n", text: fmt.hundreds(u.avg) })))));
    $("r-map-all").ontoggle = () => { if ($("r-map-all").open) table(); };
    if ($("r-map-all").open) table();
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
    cards.push(card(pct > 100 ? "Compared with the living wage" : "Share of the living wage", ofWage(pct), house ? `Household of ${n}` : "One person"));
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
    paintArea(adjusted, n, house, period).catch(console.error);

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
    const meaning = `${you} is ${ofWage(pct)}${pct > 100 ? "" : " of"} the living wage for ${five ? "a family of five" : unit}. ${opening}`
      + (five ? " " : ` Adjusted for household size, that is ${fmt.pesoExact(need)} per month for ${unit}. `)
      + (Math.abs(monthly - need) < 1 ? "That is exactly enough to meet that standard."
        : pct >= 100 ? `${house ? "Your household income" : "Your income"} exceeds that standard by ${gap} per month.` : `${house ? "Your household falls" : "You would fall"} ${gap} per month short of that standard.`);
    para($("r-wage-text"), meaning,
      house ? null : `If your income also had to support a family of five, it would ${monthly > w.flw ? `be ${ofWage(monthly / w.flw * 100)}` : `cover ${ofWage(monthly / w.flw * 100)} of`} IBON's figure.`,
      `For comparison, a full-time minimum wage earner in ${w.mwArea} earns about ${fmt.pesoExact(w.mw)} per month, or ${ofWage(w.mw / w.flw * 100)}${w.mw > w.flw ? "" : " of"} the living wage for a family of five.`,
      w.note);

    const wageRows = [
      { label: "Your income", value: monthly, color: "income" },
      { label: "Living wage", value: need, color: "context" },
      { label: "Minimum wage", value: w.mw, color: "context" },
    ];
    const wageUpdate = {
      title: "Your income and the living wage",
      sub: `The living wage is IBON's figure for a family of five${five ? "" : `, adjusted to ${unit}`}. The minimum wage is for one full-time worker.`,
      draw: (b, W) => barsH(b, W, { rows: wageRows, format: fmt.pesoExact }),
      table: () => ({ headers: ["", "Income (₱) per month", "Compared with the living wage"], numeric: [0, 1, 1], rows: wageRows.map((r) => [r.label, fmt.int(r.value), ofWage(r.value / need * 100)]) }),
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
    onPick: choose,
  });
  async function choose(it) {
    box.value = it.name;
    picked = it.name;
    const mine = ++token;
    const r = await resolve(it);
    if (mine !== token) return;
    place = r;
    render();
  }
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
