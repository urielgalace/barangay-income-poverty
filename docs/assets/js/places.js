// The search index: every barangay, city and municipality, loaded once on first use.
import { getJSON, objects, rankMatches } from "./lib.js?b=37970f11b8";

let cached;
export function loadPlaces() {
  if (!cached) {
    cached = Promise.all([getJSON("search.json"), getJSON("lgus.json")]).then(([sx, lg]) => {
      const lgus = objects(lg);
      const bgys = sx.b.map((r) => ({ kind: "bgy", name: r[0], lgu: lgus[r[1]], chunk: r[2], lon: r[3], lat: r[4], id: r[5] }));
      const towns = lgus.map((l) => ({ kind: "lgu", name: l.name, lgu: l, id: l.id, lon: l.lon, lat: l.lat }));
      return { bgys, towns };
    });
  }
  return cached;
}

export async function searchPlaces(q) {
  const { bgys, towns } = await loadPlaces();
  const a = rankMatches(towns, q, (p) => p.name, 5);
  const b = rankMatches(bgys, q, (p) => p.name, 12);
  return [...a, ...b].slice(0, 14);
}

export const placeSub = (p) => {
  const where = p.kind === "lgu" ? [p.lgu.prov, p.lgu.reg] : [p.lgu.name, p.lgu.prov || p.lgu.reg];
  return `${p.kind === "lgu" ? "City or municipality" : "Barangay"} · ${where.filter(Boolean).join(", ")}`;
};

export const placeLink = (p) => (p.kind === "lgu" ? `map.html#g=${p.id}` : `map.html#b=${p.chunk}/${p.id}`);
