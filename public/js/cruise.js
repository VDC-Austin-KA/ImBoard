// Route finders:
//  - suggestCruises: gently-downhill rides starting from the rider.
//  - findRunsInArea: the best downhill runs anywhere in the current map view (starts on local high ground).
// Both scout terrain with elevation tiles, then route only the most promising pairs and rank them by ride quality.
import { destination, compass, settings, sleep, bearing, haversine, fmtElev, fmtDist, SKILLS } from './util.js';
import { elevationAt, sampleGrid, findExtrema } from './terrain.js';
import { fetchRoute, analyze, labelFor } from './routing.js';
import { scorePavement } from './pavement.js';

const angDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const idealGrade = () => SKILLS[settings.skill].ideal; // sweet-spot average grade for the rider's skill

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

async function routeAndRank(picks, onProgress, titleFor, post = async () => {}) {
  const out = [];
  for (const [i, c] of picks.entries()) {
    onProgress(`Checking route ${i + 1} of ${picks.length}…`);
    // Loops keep their via point; plain runs also try one alternative so the downhill-first score has a choice.
    for (const alt of c.via ? [0] : [0, 1]) {
      try {
        const route = await fetchRoute(c.from, c.p, alt, { via: c.via || [] });
        if (c.via && route.dist > c.maxDist) continue; // via point forced a huge detour
        if (out.some((o) => o.cand === c && Math.abs(o.route.dist - route.dist) < 15)) continue; // duplicate
        out.push({ route, a: analyze(route), from: c.from, to: c.p, cand: c });
      } catch (e) {
        console.warn('candidate route failed', e);
      }
      await sleep(250); // be gentle with the public routing server
    }
  }
  onProgress('Checking pavement…');
  await scorePavement(out);
  await post(out);
  out.forEach((o) => (o.title = titleFor(o)));
  return out.sort((x, y) => y.a.score - x.a.score)
    .filter((o, i, all) => all.findIndex((x) => x.cand === o.cand) === i) // best variant per run only
    .slice(0, 3);
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

/** Hilltops plus the highest ground in view, spread at least minSep apart. */
export async function highPoints(b, max, minSep) {
  const g = await sampleGrid(b, 16, 16, 13);
  const valid = g.pts.map((p, i) => ({ p, e: g.es[i] })).filter((x) => x.e != null);
  if (!valid.length) throw new Error('Elevation data unavailable here');
  const starts = findExtrema(g, 3, max).tops.map((t) => ({ p: t.p, e: t.e }));
  for (const x of valid.sort((a, c) => c.e - a.e)) {
    if (starts.length >= max) break;
    if (starts.every((s) => haversine(s.p, x.p) > minSep)) starts.push(x);
  }
  return starts.slice(0, max);
}

/** b = {s, w, n, e} map bounds. Finds the best runs that start inside the view. */
export async function findRunsInArea(b, targetM, parks = [], onProgress = () => {}) {
  onProgress('Mapping hills in view…');
  const minSep = Math.max(300, targetM * 0.25);
  const starts = await highPoints(b, 6, minSep);
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

/**
 * Loop runs for drivers: ride a long, smooth descent that finishes at the bottom of a short, steep
 * walk back up to the start (the car). origins = [{p, e}].
 *  1. End point D: within walking distance of the start and as far below it as possible (steep slope).
 *  2. Via point V: about half-way down in elevation and off to the side, so the ride swings out and
 *     back down gently instead of taking the steep line.
 *  3. Route start→V→D on the longboard profile, then route the walk D→start on a hiking profile.
 */
export async function findLoops(origins, targetM, walkM, onProgress = () => {}) {
  const ideal = idealGrade(), picks = [];
  onProgress('Looking for steep hills to walk back up…');
  for (const o of origins) {
    const ends = [];
    for (let b = 0; b < 360; b += 30) for (const k of [0.45, 0.7, 0.9]) ends.push({ p: destination(o.p, b, walkM * k), b });
    await Promise.all(ends.map(async (d) => { d.e = await elevationAt(d.p, 14); }));
    const minDrop = Math.max(5, Math.min(targetM * ideal * 0.2, walkM * 0.035)); // e.g. 450 m walk → ≥ ~16 m drop
    const good = ends.filter((d) => d.e != null && o.e - d.e >= minDrop).sort((x, y) => x.e - y.e); // lowest (biggest drop) first
    const chosen = [];
    for (const d of good) {
      if (chosen.every((c) => angDiff(c.b, d.b) > 70)) chosen.push(d);
      if (chosen.length === 2) break;
    }
    for (const d of chosen) {
      // via points where both legs (start→via, via→end) average close to the sweet-spot grade
      const vias = [];
      for (let b = 0; b < 360; b += 30) for (const k of [0.28, 0.4]) vias.push({ p: destination(o.p, b, (targetM * k) / 1.3), b });
      await Promise.all(vias.map(async (v) => { v.e = await elevationAt(v.p, 13); }));
      const scored = vias.filter((v) => v.e != null && v.e < o.e && v.e > d.e && angDiff(v.b, d.b) > 60).map((v) => {
        const g1 = (o.e - v.e) / (haversine(o.p, v.p) * 1.3), g2 = (v.e - d.e) / (haversine(v.p, d.p) * 1.3);
        return { ...v, s: -(Math.abs(g1 - ideal) + Math.abs(g2 - ideal)) * 100 };
      }).sort((x, y) => y.s - x.s);
      const vs = [];
      for (const v of scored) {
        if (vs.every((u) => angDiff(u.b, v.b) > 45)) vs.push(v);
        if (vs.length === 2) break;
      }
      vs.forEach((v) => picks.push({ from: o.p, p: d.p, via: [v.p], maxDist: targetM * 2.2, b: v.b, drop: o.e - d.e, s: v.s + (o.e - d.e) * 0.2 }));
    }
  }
  picks.sort((x, y) => y.s - x.s);
  if (!picks.length) throw new Error('No steep walk-back spots found near the start — try a longer walk distance or another area');
  return routeAndRank(picks.slice(0, 6), onProgress,
    (o) => `Loop ${compass(o.cand.b)} · walk back ${o.walk ? fmtDist(o.walk.a.dist) : '?'}`,
    async (out) => {
      for (const [i, o] of out.entries()) {
        onProgress(`Checking walk back ${i + 1} of ${out.length}…`);
        try {
          const w = await fetchRoute(o.to, o.from, 0, { profile: 'hiking-mountain' });
          o.walk = { route: w, a: analyze(w) };
          // reward a short walk relative to the ride; punish long slogs
          const ratio = o.walk.a.dist / Math.max(o.a.dist, 1);
          o.walkPenalty = Math.round(40 * Math.max(0, ratio - 0.2) + (o.walk.a.dist > walkM * 1.8 ? 15 : 0));
          o.a.score = Math.max(0, o.a.score - o.walkPenalty);
          o.a.label = labelFor(o.a.score);
        } catch (e) {
          console.warn('walk route failed', e);
        }
        await sleep(250);
      }
    });
}
