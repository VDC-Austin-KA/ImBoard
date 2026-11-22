// BRouter routing with a custom longboard profile + ride-quality analysis.
import { settings, fetchWithTimeout, haversine, clamp } from './util.js';

const BROUTER = 'https://brouter.de/brouter';
const profileIds = {}; // per skill level

async function ensureProfile() {
  const skill = settings.skill;
  if (profileIds[skill]) return profileIds[skill];
  let profileId;
  try {
    // Only penalise descents past where the route turns yellow for this skill, so the router
    // doesn't dodge sweet-spot hills in favour of flat roads.
    const cutoff = (70 * settings.maxDown).toFixed(1);
    const brf = (await (await fetch('longboard.brf')).text()).replace(/assign downhillcutoff [\d.]+/, `assign downhillcutoff ${cutoff}`);
    const res = await fetchWithTimeout(`${BROUTER}/profile`, { method: 'POST', body: brf }, 15000);
    const j = await res.json();
    if (j.error || !j.profileid) throw new Error(j.error);
    profileId = j.profileid;
  } catch (e) {
    console.warn('Custom profile upload failed, using trekking', e);
    profileId = 'trekking';
  }
  return (profileIds[skill] = profileId);
}

/** Fetch one route. from/to/via are [lat, lon]. opts.profile overrides the longboard profile (e.g. walking). */
export async function fetchRoute(from, to, alt = 0, { via = [], profile } = {}, retried = false) {
  const prof = profile || (await ensureProfile());
  const ll = [from, ...via, to].map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join('|');
  const url = `${BROUTER}?lonlats=${ll}&profile=${prof}&alternativeidx=${alt}&format=geojson&timode=2`;
  const res = await fetchWithTimeout(url, {}, 30000);
  const text = await res.text();
  if (!text.trim().startsWith('{')) {
    if (!retried && !profile && /profile/i.test(text) && prof !== 'trekking') {
      delete profileIds[settings.skill]; // server dropped our uploaded profile; re-upload once
      return fetchRoute(from, to, alt, { via }, true);
    }
    throw new Error(text.trim().slice(0, 160) || `Routing failed (${res.status})`);
  }
  return parseRoute(JSON.parse(text));
}

/** Fetch up to n alternatives, dropping failures and near-duplicates. */
export async function fetchAlternatives(from, to, n = 3) {
  const results = await Promise.allSettled(Array.from({ length: n }, (_, i) => fetchRoute(from, to, i)));
  const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw results[0].reason;
  return ok.filter((r, i) => !ok.slice(0, i).some((o) => Math.abs(o.dist - r.dist) < 15 && Math.abs(o.climbRaw - r.climbRaw) < 2));
}

function classifyHint(cmd, angle, exit) {
  if (cmd === 13 || cmd === 14) return { dir: 'roundabout', side: angle < 0 ? 'left' : 'right', exit, strength: 'normal' };
  const a = Math.abs(angle);
  if (a < 15 && cmd !== 8 && cmd !== 9) return null; // straight on: no cue
  const side = angle < 0 ? 'left' : 'right';
  if (a > 150 || cmd === 10 || cmd === 11 || cmd === 15) return { dir: 'uturn', side, strength: 'sharp' };
  return { dir: side, side, strength: a < 45 ? 'slight' : a > 120 ? 'sharp' : 'normal' };
}

const BUSY = /highway=(primary|trunk|secondary)\b/;
const ROUGH = /surface=(paving_stones|sett|cobblestone|metal|wood)\b/;

export function parseRoute(geo) {
  const f = geo.features[0];
  const coords = f.geometry.coordinates;
  const pts = [];
  let d = 0;
  for (let i = 0; i < coords.length; i++) {
    const [lon, lat, ele] = coords[i];
    if (i) d += haversine([pts[i - 1].lat, pts[i - 1].lon], [lat, lon]);
    pts.push({ lat, lon, ele: ele ?? 0, d });
  }
  const cues = [];
  for (const [idx, cmd, exit, , angle] of f.properties.voicehints || []) {
    const c = classifyHint(cmd, angle, exit);
    if (c && pts[idx]) cues.push({ ...c, idx, d: pts[idx].d, lat: pts[idx].lat, lon: pts[idx].lon });
  }
  let busy = 0, rough = 0;
  for (const row of (f.properties.messages || []).slice(1)) {
    const len = +row[3] || 0, tags = row[9] || '';
    if (BUSY.test(tags)) busy += len;
    if (ROUGH.test(tags)) rough += len;
  }
  return {
    pts, cues, dist: d,
    climbRaw: +f.properties['filtered ascend'] || 0,
    busyFrac: d ? busy / d : 0,
    roughFrac: d ? rough / d : 0,
  };
}

// ---- ride analysis ----
export const STEP = 10; // metres between resampled points

export function gradeClass(g, maxDown = settings.maxDown) {
  if (g < -maxDown) return 'steep';
  if (g < -0.7 * maxDown) return 'fast';
  if (g < -0.008) return 'sweet';
  if (g <= 0.015) return 'flat';
  if (g <= 0.04) return 'mildup';
  return 'climb';
}
export const CLASS_COLOR = { steep: '#e74c3c', fast: '#f39c12', sweet: '#2ecc71', flat: '#3498db', mildup: '#9b59b6', climb: '#8e44ad' };
export const CLASS_LABEL = { steep: 'Too steep ↓', fast: 'Fast ↓', sweet: 'Sweet-spot ↓', flat: 'Flat', mildup: 'Mild push ↑', climb: 'Climb ↑' };

export const labelFor = (s) => (s >= 80 ? 'Butter cruise' : s >= 65 ? 'Smooth' : s >= 45 ? 'Mixed' : 'Pushy');

export function analyze(route, maxDown = settings.maxDown) {
  const { pts, dist } = route;
  const n = Math.max(2, Math.floor(dist / STEP) + 1);
  const lat = new Float64Array(n), lon = new Float64Array(n), raw = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(i * STEP, dist);
    while (j < pts.length - 2 && pts[j + 1].d < d) j++;
    const a = pts[j], b = pts[Math.min(j + 1, pts.length - 1)];
    const t = b.d > a.d ? clamp((d - a.d) / (b.d - a.d), 0, 1) : 0;
    lat[i] = a.lat + (b.lat - a.lat) * t;
    lon[i] = a.lon + (b.lon - a.lon) * t;
    raw[i] = a.ele + (b.ele - a.ele) * t;
  }
  // ±30 m moving average suppresses DEM stair-stepping
  const W = 3, ele = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) { s += raw[k]; c++; }
    ele[i] = s / c;
  }
  const grades = new Float32Array(n - 1);
  const frac = { steep: 0, fast: 0, sweet: 0, flat: 0, mildup: 0, climb: 0 };
  let climb = 0, descent = 0, maxDownG = 0, maxUpG = 0;
  for (let i = 0; i < n - 1; i++) {
    const dz = ele[i + 1] - ele[i], g = dz / STEP;
    grades[i] = g;
    if (dz > 0) climb += dz; else descent -= dz;
    maxDownG = Math.min(maxDownG, g);
    maxUpG = Math.max(maxUpG, g);
    frac[gradeClass(g, maxDown)]++;
  }
  for (const k in frac) frac[k] /= n - 1;
  const push = coast(grades, maxDown);
  const km = Math.max(dist / 1000, 0.2);
  // Ideal ride: mostly green, a little yellow, almost no blue, no kicking. Flat is work, so it costs points.
  let score = 55 + 45 * frac.sweet + 10 * Math.min(frac.fast, 0.15) - 30 * Math.max(0, frac.fast - 0.15)
    - 15 * frac.flat - 60 * push - 40 * frac.mildup - 80 * frac.climb - 100 * frac.steep
    - 0.5 * (climb / km) - 25 * route.busyFrac - 20 * route.roughFrac;
  score = Math.round(clamp(score, 0, 100));
  const flags = [];
  if (frac.steep > 0) flags.push('⚠ steep descent');
  if (push < 0.02) flags.push('🛹 no kicking'); else if (push > 0.08) flags.push(`kick ~${Math.round(push * 100)}% of the way`);
  if (frac.climb > 0.12) flags.push('lots of pushing');
  if (route.busyFrac > 0.2) flags.push('busy roads');
  if (route.roughFrac > 0.1) flags.push('rough surface');
  return { n, lat, lon, ele, grades, frac, push, climb, descent, maxDownG, maxUpG, score, label: labelFor(score), flags, dist };
}

/**
 * Coast simulation: rolls a rider down the profile with gravity, rolling resistance and air drag,
 * carrying momentum through short flats. Returns the share of distance where speed drops below a
 * walking-pace cruise and you'd have to kick. Speed is capped (rider scrubs speed) by skill level.
 */
function coast(grades, maxDown) {
  const G = 9.81, CRR = 0.015, DRAG = 0.0035, V_MIN = 2.5, vMax = 3 + 85 * maxDown; // m/s
  let v2 = 16, kicks = 0; // start after one push-off (~4 m/s)
  for (const g of grades) {
    v2 += 2 * STEP * (-G * g - G * CRR - DRAG * v2);
    if (v2 < V_MIN * V_MIN) { kicks++; v2 = V_MIN * V_MIN; }
    v2 = Math.min(v2, vMax * vMax);
  }
  return grades.length ? kicks / grades.length : 0;
}

/** Grade at a distance along the analysed route. */
export const gradeAt = (a, d) => a.grades[clamp(Math.floor(d / STEP), 0, a.grades.length - 1)];
