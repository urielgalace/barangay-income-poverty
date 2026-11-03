// Place suggestions for the home page's search box and the report form. With the visitor's permission, the browser's location is matched to a barangay here in
// the page: it is never sent anywhere, and the site only loads the map file for that province. Without it, a random one.
import { getJSON, objects } from "./lib.js?b=01f84d6641";

const MAX_ACCURACY_M = 1500;   // past this a barangay would be a guess, so suggest the city or municipality instead

function insideRing(ring, X, Y) {
  let inside = false;
  let x1 = ring[0];
  let y1 = ring[1];
  for (let i = 2; i <= ring.length; i += 2) {
    const x2 = i < ring.length ? x1 + ring[i] : ring[0];
    const y2 = i < ring.length ? y1 + ring[i + 1] : ring[1];
    if ((y1 > Y) !== (y2 > Y) && X < ((x2 - x1) * (Y - y1)) / (y2 - y1) + x1) inside = !inside;
    x1 = x2;
    y1 = y2;
  }
  return inside;
}
const insidePolygon = (parts, X, Y) => parts.some((rings) => insideRing(rings[0], X, Y) && !rings.slice(1).some((hole) => insideRing(hole, X, Y)));

export async function placeAt(lon, lat, accuracy = 0) {
  if (lon < 114 || lon > 127.5 || lat < 4 || lat > 21.5) return null;
  const [ch, lg] = await Promise.all([getJSON("chunks.json"), getJSON("lgus.json")]);
  const towns = new Map(objects(lg).map((l) => [l.id, l.name]));
  const hits = objects(ch).filter((c) => lon >= c.x0 - .001 && lon <= c.x1 + .001 && lat >= c.y0 - .001 && lat <= c.y1 + .001)
    .sort((a, b) => (a.x1 - a.x0) * (a.y1 - a.y0) - (b.x1 - b.x0) * (b.y1 - b.y0));
  for (const c of hits) {
    const [geo, vals] = await Promise.all([getJSON(`bgy/${c.chunk}.geo.json`), getJSON(`bgy/${c.chunk}.json`)]);
    for (let i = 0; i < geo.ids.length; i += 1) {
      if (insidePolygon(geo.geom[i], lon * 1e4, lat * 1e4)) {
        const town = towns.get(vals.c[i]);
        if (vals.t[i] === 3 || accuracy > MAX_ACCURACY_M) return town ? { town } : null;
        return { barangay: vals.n[i], town };
      }
    }
  }
  return null;
}

function visitorCoords() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), () => resolve(null), { timeout: 15000, maximumAge: 3600000 });
  });
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

// a random barangay and its city or municipality
export const randomPlace = async () => pick(await getJSON("suggest.json"));

export async function randomHint() {
  const [[name], lg] = await Promise.all([randomPlace(), getJSON("lgus.json")]);
  const towns = objects(lg).map((l) => l.name).filter((n) => n.length <= 22);
  return `Try ${name} or ${pick(towns)}`;
}

export function hintFor(place) {
  if (!place) return null;
  return place.barangay ? `Try ${place.barangay}${place.town ? `, ${place.town}` : ""}` : `Try ${place.town}`;
}

// Shows a random suggestion at once, then replaces it if the visitor's own place can be found.
export async function suggestInto(input, { random = randomHint, found = hintFor } = {}) {
  input.placeholder = await random();
  const c = await visitorCoords();
  if (!c) return;
  const hint = found(await placeAt(c.longitude, c.latitude, c.accuracy));
  if (hint) input.placeholder = hint;
}
