// Skateparks from OpenStreetMap via Overpass, ranked by a simple "popularity" heuristic.
import { fetchWithTimeout, haversine } from './util.js';

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

function popularity(t) {
  let s = 0;
  if (t.name) s += 3;
  if (t.wikidata || t.wikipedia) s += 3;
  if (t.website || t['contact:website']) s += 2;
  if (t.lit === 'yes') s += 1;
  if (t.opening_hours) s += 1;
  if (/concrete/.test(t.surface || '')) s += 1;
  if (t.leisure === 'skatepark') s += 1;
  return s;
}

export async function findParks([lat, lon], radius = 15000) {
  const q = `[out:json][timeout:25];(nwr["leisure"="skatepark"](around:${radius},${lat},${lon});` +
    `nwr["sport"~"skateboard"](around:${radius},${lat},${lon}););out center tags 200;`;
  let lastErr;
  for (const m of MIRRORS) {
    try {
      const res = await fetchWithTimeout(m, { method: 'POST', body: new URLSearchParams({ data: q }) }, 30000);
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const { elements } = await res.json();
      const seen = new Set();
      return elements
        .map((e) => {
          const p = e.type === 'node' ? [e.lat, e.lon] : e.center ? [e.center.lat, e.center.lon] : null;
          if (!p) return null;
          const t = e.tags || {};
          return {
            id: `${e.type}/${e.id}`, lat: p[0], lon: p[1], tags: t,
            name: t.name || (t.leisure === 'skatepark' ? 'Skatepark' : 'Skate spot'),
            pop: popularity(t), dist: haversine([lat, lon], p),
          };
        })
        .filter((p) => {
          if (!p) return false;
          const k = `${p.name}|${p.lat.toFixed(3)}|${p.lon.toFixed(3)}`; // drop node+area duplicates
          return !seen.has(k) && seen.add(k);
        })
        .sort((a, b) => b.pop - a.pop || a.dist - b.dist);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
