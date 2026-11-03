// The report form: a place suggestion like the home page's, place search, and a button that opens GitHub's issue form with
// the answers filled in.
import { combobox } from "./lib.js";
import { searchPlaces, placeSub } from "./places.js";
import { suggestInto, randomPlace } from "./locate.js";

const $ = (id) => document.getElementById(id);
const FIELDS = [["r-place", "place"], ["r-problem", "problem"], ["r-source", "source"], ["r-page", "page"]];
const box = $("r-place");
const go = $("r-go");
const full = (p) => [p.name, p.kind === "lgu" ? p.lgu.prov || p.lgu.reg : p.lgu.name].filter(Boolean).join(", ");

function update() {
  const q = new URLSearchParams({ template: "data-problem.yml", title: `Data problem: ${box.value.trim()}` });
  for (const [id, key] of FIELDS) {
    const v = $(id).value.trim();
    if (v) q.set(key, v);
  }
  go.href = `${go.dataset.base}?${q}`;
}

// a place chosen on the map arrives in the link, and the page the visitor came from fills the last field
const asked = new URLSearchParams(location.search).get("place");
if (asked) box.value = asked.slice(0, 200);
try {
  const from = document.referrer ? new URL(document.referrer) : null;
  if (from && from.origin === location.origin && !from.pathname.endsWith("/report.html")) $("r-page").value = from.href;
} catch (e) {
  // no usable referrer
}

combobox(box, { search: searchPlaces, label: (p) => p.name, sub: placeSub, onPick: (p) => { box.value = full(p); update(); } });
for (const [id] of FIELDS) $(id).addEventListener("input", update);
$("r-form").addEventListener("submit", (e) => e.preventDefault());
update();

if (!asked) {
  suggestInto(box, {
    random: async () => { const [name, town] = await randomPlace(); return `For example, ${name}, ${town}`; },
    found: (p) => (p ? `For example, ${p.barangay ? `${p.barangay}, ` : ""}${p.town}` : null),
  }).catch(console.error);
}
