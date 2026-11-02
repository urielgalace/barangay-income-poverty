// Shared helpers: data loading, number formats, DOM building, tooltip, combobox, figure frame.
const BUILD = document.documentElement.dataset.build || "dev";
const cache = new Map();

export function getJSON(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(`data/${path}?b=${BUILD}`).then((r) => {
      if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
      return r.json();
    }));
  }
  return cache.get(path);
}

export const objects = ({ cols, rows }) => rows.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));

const n0 = new Intl.NumberFormat("en-PH", { maximumFractionDigits: 0 });
export const fmt = {
  int: (v) => (v == null ? "n/a" : n0.format(v)),
  pct: (v, d) => (v == null ? "n/a" : `${v.toFixed(d ?? (Math.abs(v) < 10 ? 1 : 1))}%`),
  pts: (v, d = 1) => (v == null ? "n/a" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}`),
  // income is always pesos per month: estimates to the nearest ₱100, official figures as published
  peso: (v) => (v == null ? "n/a" : `₱${n0.format(Math.round(v / 100) * 100)}`),
  pesoExact: (v) => (v == null ? "n/a" : `₱${n0.format(Math.round(v))}`),
  pesoAxis: (v) => (v === 0 ? "₱0" : `₱${+(v / 1000).toFixed(1)}k`),
  hundreds: (v) => (v == null ? "n/a" : n0.format(Math.round(v / 100) * 100)),   // table cells that hold estimates
  compact: (v) => {
    if (v == null) return "n/a";
    const a = Math.abs(v);
    if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K`;
    return n0.format(v);
  },
  bytes: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)} MB` : `${Math.round(v / 1e3)} KB`),
  date: (s) => new Date(`${s}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
};

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

export function s(tag, attrs = {}, ...kids) {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k === "cls" ? "class" : k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

export const normName = (t) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// ---- tooltip: one element, built with textContent so labels stay inert
let tipEl;
export const tip = {
  show(x, y, title, rows = []) {
    if (!tipEl) {
      tipEl = h("div", { class: "tip", role: "status" });
      document.body.append(tipEl);
    }
    tipEl.replaceChildren();
    if (title) tipEl.append(h("div", { class: "t-title", text: title }));
    for (const r of rows) {
      const row = h("div", { class: "t-row" });
      if (r.cls) row.append(h("span", { class: `key ${r.cls}` }));
      row.append(h("b", { text: r.value }));
      if (r.label) row.append(h("em", { text: r.label }));
      tipEl.append(row);
    }
    tipEl.hidden = false;
    const b = tipEl.getBoundingClientRect();
    let px = x + 14;
    let py = y - b.height - 10;
    if (px + b.width > innerWidth - 8) px = x - b.width - 14;
    if (px < 8) px = 8;
    if (py < 8) py = y + 16;
    tipEl.style.left = `${px}px`;
    tipEl.style.top = `${py}px`;
  },
  hide() {
    if (tipEl) tipEl.hidden = true;
  },
};

// ---- combobox: accessible search box with a result list
export function combobox(input, { search, label, sub, onPick, onFocus, empty }) {
  const wrap = input.closest(".combo") || input.parentElement;
  const id = `${input.id}-list`;
  const list = h("ul", { class: "combo-list", role: "listbox", id, hidden: true });
  wrap.append(list);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", id);
  input.autocomplete = "off";
  let items = [];
  let active = -1;
  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  };
  const paint = () => {
    [...list.children].forEach((li, i) => {
      li.setAttribute("aria-selected", i === active ? "true" : "false");
      if (i === active) {
        input.setAttribute("aria-activedescendant", li.id);
        li.scrollIntoView({ block: "nearest" });
      }
    });
  };
  const pick = (it) => {
    close();
    onPick(it);
  };
  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    items = await search(q);
    list.replaceChildren();
    if (!items.length) {
      list.append(h("li", { class: "combo-empty", text: empty || "No matches. Check the spelling, or try part of the name." }));
    } else {
      items.forEach((it, i) => {
        const li = h("li", { role: "option", id: `${id}-${i}`, "aria-selected": "false" }, label(it));
        const small = sub && sub(it);
        if (small) li.append(h("small", { text: small }));
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(it);
        });
        list.append(li);
      });
    }
    active = items.length ? 0 : -1;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    paint();
  };
  input.addEventListener("input", run);
  input.addEventListener("focus", () => {
    if (onFocus) onFocus();
    if (input.value.trim().length >= 2) run();
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      active = (active + 1) % items.length;
      paint();
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      active = (active - 1 + items.length) % items.length;
      paint();
    } else if (e.key === "Enter") {
      if (!list.hidden && active >= 0 && items[active]) {
        e.preventDefault();
        pick(items[active]);
      }
    } else if (e.key === "Escape") {
      close();
    }
  });
  return { close };
}

// Ranks matches: whole name, then start of name, then start of a word, then anywhere.
export function rankMatches(rows, q, nameOf, limit = 14) {
  const nq = normName(q);
  const out = [];
  for (const r of rows) {
    const n = normName(nameOf(r));
    let score = -1;
    if (n === nq) score = 0;
    else if (n.startsWith(nq)) score = 1;
    else if (n.includes(` ${nq}`)) score = 2;
    else if (n.includes(nq)) score = 3;
    if (score >= 0) out.push([score, n.length, r]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out.slice(0, limit).map((x) => x[2]);
}

// ---- figure frame: title, chart, note, and a table twin for every chart
export function figure(parent, { title, sub, note, legend, draw, table }) {
  const head = h("figcaption", { class: "fig-head" });
  const t = h("h3", { text: title });
  const st = h("div", { class: "fig-sub", text: sub || "" });
  head.append(t, st);
  const lg = h("div", { class: "legend" });
  const body = h("div", { class: "fig-body" });
  const tvBox = h("div", { class: "tv", hidden: true });
  const noteEl = h("div", { class: "note", text: note || "" });
  const btn = h("button", { class: "linkish", type: "button", "aria-expanded": "false", text: "Show table" });
  const foot = h("div", { class: "fig-foot" }, noteEl, btn);
  const fig = h("figure", { class: "fig" }, head, lg, body, tvBox, foot);
  parent.append(fig);
  let cur = { sub, note, legend, draw, table };
  let lastW = 0;
  const paintLegend = () => {
    lg.replaceChildren();
    for (const it of cur.legend || []) lg.append(h("span", {}, h("span", { class: `key ${it.mark || ""} ${it.cls}` }), it.label));
    lg.hidden = !(cur.legend && cur.legend.length);
  };
  const render = (force) => {
    const w = Math.round(body.clientWidth || parent.clientWidth || 600);
    if (!force && w === lastW) return;
    lastW = w;
    body.replaceChildren();
    if (cur.draw) cur.draw(body, w);
  };
  const renderTable = () => {
    const T = cur.table && cur.table();
    tvBox.replaceChildren();
    if (!T) return;
    const tbl = h("table", {}, h("thead", {}, h("tr", {}, T.headers.map((x, i) => h("th", { class: T.numeric && T.numeric[i] ? "n" : null, scope: "col", text: x })))),
      h("tbody", {}, T.rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: T.numeric && T.numeric[i] ? "n" : null, text: c == null ? "n/a" : String(c) }))))));
    tvBox.append(tbl);
  };
  btn.addEventListener("click", () => {
    const open = tvBox.hidden;
    tvBox.hidden = !open;
    btn.textContent = open ? "Hide table" : "Show table";
    btn.setAttribute("aria-expanded", open);
    if (open) renderTable();
  });
  btn.hidden = !cur.table;
  paintLegend();
  if (window.ResizeObserver) new ResizeObserver(() => render(false)).observe(body);
  requestAnimationFrame(() => render(true));
  return {
    el: fig,
    update(next) {
      cur = { ...cur, ...next };
      if (next.title != null) t.textContent = next.title;
      if ("sub" in next) st.textContent = next.sub || "";
      if ("note" in next) noteEl.textContent = next.note || "";
      paintLegend();
      btn.hidden = !cur.table;
      render(true);
      if (!tvBox.hidden) renderTable();
    },
  };
}

export function segmented(parent, options, value, onChange, labelText) {
  const seg = h("div", { class: "seg", role: "group", "aria-label": labelText || "" });
  const buttons = options.map((o) => {
    const b = h("button", { type: "button", "aria-pressed": o.value === value ? "true" : "false", text: o.label, onclick: () => set(o.value, true) });
    b.dataset.v = o.value;
    return b;
  });
  function set(v, fire) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v ? "true" : "false"));
    if (fire) onChange(v);
  }
  seg.append(...buttons);
  parent.append(seg);
  return { el: seg, set, buttons };
}

// ---- theme switch in the footer
export function initTheme() {
  const box = document.getElementById("theme-switch");
  if (!box) return;
  let stored = "auto";
  try { stored = localStorage.getItem("theme") || "auto"; } catch (e) { /* storage may be blocked */ }
  const apply = (v) => {
    if (v === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", v);
    try { localStorage.setItem("theme", v); } catch (e) { /* storage may be blocked */ }
  };
  segmented(box, [{ value: "auto", label: "Auto" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], stored, apply, "Color theme");
}
