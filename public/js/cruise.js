// Route finders:
//  - suggestCruises: gently-downhill rides starting from the rider.
//  - findRunsInArea: the best downhill runs anywhere in the current map view (starts on local high ground).
// Both scout terrain with elevation tiles, then route only the most promising pairs and rank them by ride quality.
import { destination, compass, settings, sleep, bearing, haversine, fmtElev } from './util.js';
import { elevationAt, sampleGrid, findExtrema } from './terrain.js';
import { fetchRoute, analyze } from './routing.js';
import { scorePavement } from './pavement.js';

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const idealGrade = () => Math.min(0.03, settings.maxDown * 0.45); // sweet-spot average grade

/** Score straight-line candidates from `origin` (elev e0) by how close their average grade is to ideal. */
async function scout(origin, e0, targetM, parks = []) {
  const ideal = idealGrade(), cands = [];
  for (let b = 0; b < 360; b += 30) {
    for (const k of [0.6, 1, 1.4]) cands.push({ from: origin, p: destination(origin, b, (targetM * k) / 1.3), b });
  }
  for (const pk of parks) {
    const d = haversine(origin, [pk.lat, pk.lon]);
    if (d > 300 && d < targetM * 1.4) cands.push({ from: origin, p: [pk.lat, pk.lon], b: bearing(origin, [pk.lat, pk.lon]), park: pk });
  }
  await Promise.all(cands.map(async (c) => {
    const e = await elevationAt(c.p, 13);
    if (e == null) { c.s = -Infinity; return; }
    const g = (e0 - e) / (Math.max(1, haversine(origin, c.p)) * 1.3); // 1.3 ≈ road detour factor
    c.drop = e0 - e;
    c.s = -Math.abs(g - ideal) * 100 - (g < 0 ? 5 + -g * 300 : 0) + (c.park ? 0.5 : 0);
  }));
  return cands.filter((c) => c.s > -Infinity);
}

async function routeAndRank(picks, onProgress, titleFor) {
  const out = [];
  for (const [i, c] of picks.entries()) {
    onProgress(`Checking route ${i + 1} of ${picks.length}…`);
    try {
      const route = await fetchRoute(c.from, c.p, 0);
      out.push({ route, a: analyze(route), from: c.from, to: c.p, cand: c });
    } catch (e) {
      console.warn('candidate route failed', e);
    }
    await sleep(250); // be gentle with the public routing server
  }
  onProgress('Checking pavement…');
  await scorePavement(out);
  out.forEach((o) => (o.title = titleFor(o)));
  return out.sort((x, y) => y.a.score - x.a.score).slice(0, 3);
}

const runName = (o) => (o.a.descent > o.a.climb * 1.5 ? 'Downhill' : 'Rolling');

export async function suggestCruises(origin, targetM, parks = [], onProgress = () => {}) {
  const e0 = await elevationAt(origin, 13);
  if (e0 == null) throw new Error('Elevation data unavailable here');
  onProgress('Scouting terrain…');
  const cands = (await scout(origin, e0, targetM, parks)).sort((a, b) => b.s - a.s);
  const picks = [];
  for (const c of cands) {
    if (picks.every((p) => angDiff(p.b, c.b) > 50 || (c.park && !p.park))) picks.push(c);
    if (picks.length === 4) break;
  }
  return routeAndRank(picks, onProgress, (o) => o.cand.park ? `Cruise to ${o.cand.park.name}` : `${runName(o)} cruise heading ${compass(o.cand.b)}`);
}

/** b = {s, w, n, e} map bounds. Finds the best runs that start inside the view. */
export async function findRunsInArea(b, targetM, parks = [], onProgress = () => {}) {
  onProgress('Mapping hills in view…');
  const g = await sampleGrid(b, 16, 16, 13);
  const valid = g.pts.map((p, i) => ({ p, e: g.es[i] })).filter((x) => x.e != null);
  if (!valid.length) throw new Error('Elevation data unavailable here');
  // start on hilltops, plus the highest ground in view (spread out)
  const starts = findExtrema(g, 3, 5).tops.map((t) => ({ p: t.p, e: t.e }));
  const minSep = Math.max(300, targetM * 0.25);
  for (const x of valid.sort((a, c) => c.e - a.e)) {
    if (starts.length >= 6) break;
    if (starts.every((s) => haversine(s.p, x.p) > minSep)) starts.push(x);
  }
  onProgress(`Scouting runs from ${starts.length} high points…`);
  const parksInView = parks.filter((pk) => pk.lat > b.s && pk.lat < b.n && pk.lon > b.w && pk.lon < b.e);
  const cands = (await Promise.all(starts.map((s) => scout(s.p, s.e, targetM, parksInView)))).flat().sort((a, c) => c.s - a.s);
  // keep runs whose start points are spread out, or that head in clearly different directions
  const picks = [];
  for (const c of cands) {
    if (picks.every((p) => haversine(p.from, c.from) > minSep || angDiff(p.b, c.b) > 60)) picks.push(c);
    if (picks.length === 5) break;
  }
  if (!picks.length) throw new Error('No downhill runs found in this view — try zooming out or a shorter length');
  return routeAndRank(picks, onProgress, (o) => `${runName(o)} run ${compass(o.cand.b)}${o.cand.park ? ` to ${o.cand.park.name}` : ''} · drops ${fmtElev(o.a.descent - o.a.climb)}`);
}
