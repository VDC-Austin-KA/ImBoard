// Pavement intel: City of Austin open GIS data (condition grades, completed & planned resurfacing)
// plus OpenStreetMap roads under construction. Also scores routes by the pavement they ride on.
import { fetchWithTimeout, esc } from './util.js';
import { labelFor } from './routing.js';

const AGS = 'https://services.arcgis.com/0L95CJ0VTaxqcmED/ArcGIS/rest/services';
const AUSTIN = { w: -98.05, s: 30.05, e: -97.45, n: 30.55 };
const OVERLAY_IDS = [218, 219, 221], SEALCOAT_IDS = [213, 214]; // PMIS treatment ids (overlay = new asphalt)
const isoDaysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'unknown');

export const inAustin = (b) => !(b.e < AUSTIN.w || b.w > AUSTIN.e || b.n < AUSTIN.s || b.s > AUSTIN.n);
export const GRADE_COLOR = { A: '#00c853', B: '#64dd17', C: '#ffd600', D: '#ff6d00', F: '#d50000' };

async function agsQuery(service, where, fields, b, { maxPages = 1 } = {}) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({
      where, outFields: fields, f: 'geojson', outSR: '4326', inSR: '4326', geometryPrecision: '6',
      geometry: `${b.w},${b.s},${b.e},${b.n}`, geometryType: 'esriGeometryEnvelope', spatialRel: 'esriSpatialRelIntersects',
      resultOffset: String(page * 2000), resultRecordCount: '2000',
    });
    const res = await fetchWithTimeout(`${AGS}/${service}/FeatureServer/0/query?${q}`, {}, 30000);
    const j = await res.json();
    if (j.error) throw new Error(j.error.message);
    out.push(...j.features);
    if (!j.properties?.exceededTransferLimit) break;
  }
  return out;
}

const SOURCES = {
  condition: {
    minZoom: 14,
    pane: 'pave',
    fetch: (b) => agsQuery('TRANSPORTATION_pw_street_condition_scores', '1=1', 'FULL_STREET_NAME,GRADE,RIDE_COMFORT_INDEX,INTL_ROUGHNESS_INDEX_AVG', b),
    style: (p) => ({ color: GRADE_COLOR[p.GRADE] || '#9e9e9e', weight: 4, opacity: 0.85 }),
    popup: (p) => `<b>${esc(p.FULL_STREET_NAME)}</b><br>Pavement grade <b>${esc(p.GRADE)}</b><br>Ride comfort ${p.RIDE_COMFORT_INDEX ?? '?'} / 5 · roughness (IRI) ${p.INTL_ROUGHNESS_INDEX_AVG ?? '?'}`,
  },
  fresh: {
    minZoom: 12,
    pane: 'paveTop',
    fetch: (b) => agsQuery('Pavement_Management_Information_System',
      `pms_treatment_id IN (${OVERLAY_IDS},${SEALCOAT_IDS}) AND date_completed >= DATE '${isoDaysAgo(3 * 365)}'`,
      'pmis_street,pmis_from,pmis_to,date_completed,pms_treatment_id', b, { maxPages: 2 }),
    style: (p) => {
      const months = (Date.now() - p.date_completed) / 2.63e9;
      if (SEALCOAT_IDS.includes(p.pms_treatment_id)) return months < 12 ? { color: '#8d6e63', weight: 4, dashArray: '2 6', opacity: 0.9 } : null;
      return { color: months < 6 ? '#00e5ff' : months < 12 ? '#18ffff' : '#84ffff', weight: months < 12 ? 6 : 4, opacity: months < 12 ? 0.95 : 0.6 };
    },
    popup: (p) => SEALCOAT_IDS.includes(p.pms_treatment_id)
      ? `<b>${esc(p.pmis_street)}</b><br>Seal coat (chip seal) on ${fmtDate(p.date_completed)}<br><i>Usually rough, loose gravel for months — not great for wheels.</i>`
      : `<b>${esc(p.pmis_street)}</b> ${p.pmis_from ? `(${esc(p.pmis_from)} → ${esc(p.pmis_to)})` : ''}<br>🛹 <b>New asphalt overlay</b> completed ${fmtDate(p.date_completed)}`,
  },
  planned: {
    minZoom: 12,
    pane: 'paveTop',
    fetch: (b) => agsQuery('PavementMaintenance_Service_Plan_FY27', "TREATMENT IN ('Overlay','Sealcoat')", 'STREET_NAM,FROM_STREE,TO_STREET,TREATMENT,YEAR', b, { maxPages: 2 }),
    style: (p) => ({ color: p.TREATMENT === 'Overlay' ? '#d500f9' : '#a1887f', weight: 4, dashArray: '8 6', opacity: 0.85 }),
    popup: (p) => `<b>${esc(p.STREET_NAM)}</b> (${esc(p.FROM_STREE)} → ${esc(p.TO_STREET)})<br>Planned FY${p.YEAR}: <b>${esc(p.TREATMENT)}</b><br><i>City schedule; dates depend on utilities & funding.</i>`,
  },
  construction: {
    minZoom: 13,
    global: true,
    pane: 'paveTop',
    fetch: async (b) => {
      const q = `[out:json][timeout:25];way["highway"="construction"](${b.s},${b.w},${b.n},${b.e});out geom tags 300;`;
      for (const m of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
        try {
          const res = await fetchWithTimeout(m, { method: 'POST', body: new URLSearchParams({ data: q }) }, 30000);
          const j = await res.json();
          return j.elements.filter((e) => e.geometry).map((e) => ({
            type: 'Feature', id: e.id, properties: e.tags || {},
            geometry: { type: 'LineString', coordinates: e.geometry.map((g) => [g.lon, g.lat]) },
          }));
        } catch { /* try next mirror */ }
      }
      throw new Error('Overpass unavailable');
    },
    style: () => ({ color: '#ff1744', weight: 5, dashArray: '4 6', opacity: 0.9 }),
    popup: (p) => `<b>🚧 ${esc(p.name || 'Road under construction')}</b><br>${p.construction ? `Becoming: ${esc(p.construction)}<br>` : ''}${p.opening_date ? `Opening: ${esc(p.opening_date)}` : 'Opening date not mapped'}<br><i>OpenStreetMap — check before riding.</i>`,
  },
};

export const PAVEMENT_LAYERS = {
  condition: 'Pavement condition (Austin)',
  fresh: 'Fresh asphalt / seal coat (Austin)',
  planned: 'Planned resurfacing FY27 (Austin)',
  construction: 'Road construction (OSM)',
};

/** Create Leaflet layer groups that refresh for the current view while they're on the map. */
export function createPavementLayers(L, map, onStatus) {
  // below the route overlay (400): condition grades, then fresh/planned/construction on top
  map.createPane('pave').style.zIndex = 380;
  map.createPane('paveTop').style.zIndex = 390;
  const groups = {};
  for (const key of Object.keys(SOURCES)) groups[key] = L.layerGroup();
  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const bb = map.getBounds(), b = { w: bb.getWest(), s: bb.getSouth(), e: bb.getEast(), n: bb.getNorth() };
      for (const [key, src] of Object.entries(SOURCES)) {
        const g = groups[key];
        if (!map.hasLayer(g)) continue;
        if (!src.global && !inAustin(b)) { g.clearLayers(); onStatus(`${PAVEMENT_LAYERS[key]}: City of Austin data only`); continue; }
        if (map.getZoom() < src.minZoom) { g.clearLayers(); onStatus(`Zoom in to see ${PAVEMENT_LAYERS[key].toLowerCase()}`); continue; }
        try {
          const feats = await src.fetch(b);
          g.clearLayers();
          L.geoJSON({ type: 'FeatureCollection', features: feats }, {
            pane: src.pane,
            filter: (f) => !!src.style(f.properties),
            style: (f) => src.style(f.properties),
            onEachFeature: (f, l) => l.bindPopup(src.popup(f.properties)),
          }).addTo(g);
        } catch (e) {
          onStatus(`${PAVEMENT_LAYERS[key]} unavailable (${e.message})`);
        }
      }
    }, 400);
  };
  map.on('moveend overlayadd', refresh);
  return groups;
}

// ---- route pavement scoring (Austin) ----
function indexSegments(features, prop) {
  // ~10 m points on each segment in a 0.0002° (~20 m) hash grid
  const grid = new Map(), C = 0.0002;
  for (const f of features) {
    const val = prop(f.properties);
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const line of lines) {
      for (let k = 0; k < line.length - 1; k++) {
        const [x1, y1] = line[k], [x2, y2] = line[k + 1];
        const n = Math.max(1, Math.ceil(Math.hypot((x2 - x1) * 96000, (y2 - y1) * 111000) / 10));
        for (let t = 0; t <= n; t++) {
          const x = x1 + ((x2 - x1) * t) / n, y = y1 + ((y2 - y1) * t) / n;
          const key = `${Math.floor(x / C)},${Math.floor(y / C)}`;
          (grid.get(key) || grid.set(key, []).get(key)).push([x, y, val]);
        }
      }
    }
  }
  return (lat, lon, maxM = 14) => {
    let best = null, bd = maxM;
    const gx = Math.floor(lon / C), gy = Math.floor(lat / C);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const [x, y, v] of grid.get(`${gx + dx},${gy + dy}`) || []) {
        const d = Math.hypot((x - lon) * 96000, (y - lat) * 111000);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best;
  };
}

/** Adds a.pave {good, poor, fresh, coverage} and adjusts the score for routes inside Austin. */
export async function scorePavement(options) {
  if (!options.length) return;
  let b = { w: 180, s: 90, e: -180, n: -90 };
  for (const { a } of options) for (let i = 0; i < a.n; i += 5) {
    b = { w: Math.min(b.w, a.lon[i]), e: Math.max(b.e, a.lon[i]), s: Math.min(b.s, a.lat[i]), n: Math.max(b.n, a.lat[i]) };
  }
  if (!inAustin(b)) return;
  b = { w: b.w - 0.001, e: b.e + 0.001, s: b.s - 0.001, n: b.n + 0.001 };
  let cond, fresh;
  try {
    [cond, fresh] = await Promise.all([
      agsQuery('TRANSPORTATION_pw_street_condition_scores', '1=1', 'GRADE', b, { maxPages: 4 }),
      agsQuery('Pavement_Management_Information_System', `pms_treatment_id IN (${OVERLAY_IDS}) AND date_completed >= DATE '${isoDaysAgo(2 * 365)}'`, 'pms_treatment_id', b, { maxPages: 2 }),
    ]);
  } catch (e) {
    console.warn('pavement scoring skipped', e);
    return;
  }
  const gradeAt = indexSegments(cond, (p) => p.GRADE), freshAt = indexSegments(fresh, () => true);
  for (const o of options) {
    const a = o.a;
    let n = 0, cov = 0, good = 0, poor = 0, fr = 0;
    for (let i = 0; i < a.n; i += 2) {
      n++;
      if (freshAt(a.lat[i], a.lon[i])) fr++;
      const g = gradeAt(a.lat[i], a.lon[i]);
      if (!g) continue;
      cov++;
      if (g === 'A' || g === 'B') good++;
      if (g === 'D' || g === 'F') poor++;
    }
    if (!n) continue;
    a.pave = { coverage: cov / n, good: cov ? good / cov : 0, poor: cov ? poor / cov : 0, fresh: fr / n };
    if (cov / n > 0.2) {
      a.score = Math.round(Math.max(0, Math.min(100, a.score + 12 * a.pave.good - 30 * a.pave.poor + 10 * a.pave.fresh)));
      a.label = labelFor(a.score);
    }
    if (a.pave.fresh > 0.05) a.flags.unshift(`🛹 ${Math.round(a.pave.fresh * 100)}% fresh asphalt`);
    if (a.pave.poor > 0.2) a.flags.push('poor pavement');
  }
}
