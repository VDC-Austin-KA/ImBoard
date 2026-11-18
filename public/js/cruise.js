// "Suggest a cruise": scout the terrain around the rider for gently-downhill destinations,
// route the most promising ones and rank them by real ride quality.
import { destination, compass, settings, sleep, bearing, haversine } from './util.js';
import { elevationAt } from './terrain.js';
import { fetchRoute, analyze } from './routing.js';

export async function suggestCruises(origin, targetM, parks = [], onProgress = () => {}) {
  const ideal = Math.min(0.03, settings.maxDown * 0.45); // sweet-spot average grade
  const e0 = await elevationAt(origin, 13);
  if (e0 == null) throw new Error('Elevation data unavailable here');
  onProgress('Scouting terrain…');

  const cands = [];
  for (let b = 0; b < 360; b += 30) {
    for (const k of [0.6, 1, 1.4]) cands.push({ p: destination(origin, b, targetM * k), b, title: null });
  }
  for (const pk of parks) {
    if (pk.dist > 300 && pk.dist < targetM * 1.8) cands.push({ p: [pk.lat, pk.lon], park: pk, title: `Cruise to ${pk.name}` });
  }
  await Promise.all(cands.map(async (c) => {
    const e = await elevationAt(c.p, 13);
    c.b ??= bearing(origin, c.p);
    if (e == null) { c.s = -Infinity; return; }
    const straight = Math.max(1, haversine(origin, c.p));
    const g = (e0 - e) / (straight * 1.3); // 1.3 ≈ road detour factor
    c.s = -Math.abs(g - ideal) * 100 - (g < 0 ? 5 + -g * 300 : 0) + (c.park ? 0.5 : 0);
  }));

  // pick up to 4 promising, directionally diverse targets
  const picks = [];
  for (const c of cands.sort((a, b) => b.s - a.s)) {
    if (c.s === -Infinity) break;
    if (picks.every((p) => angDiff(p.b, c.b) > 50 || (c.park && !p.park))) picks.push(c);
    if (picks.length === 4) break;
  }

  const out = [];
  for (const [i, c] of picks.entries()) {
    onProgress(`Checking route ${i + 1} of ${picks.length}…`);
    try {
      const route = await fetchRoute(origin, c.p, 0);
      const a = analyze(route);
      out.push({ route, a, to: c.p, title: c.title || `${a.descent > a.climb ? 'Downhill' : 'Rolling'} cruise heading ${compass(c.b)}` });
    } catch (e) {
      console.warn('cruise route failed', e);
    }
    await sleep(250); // be gentle with the public routing server
  }
  return out.sort((x, y) => y.a.score - x.a.score).slice(0, 3);
}

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
