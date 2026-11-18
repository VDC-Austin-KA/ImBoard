// Elevation from AWS/Mapzen Terrarium tiles (free, CORS-enabled, ~30 m DEM).
// elev = R*256 + G + B/256 - 32768
import { destination, clamp } from './util.js';

const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const MAX_Z = 15;
const tiles = new Map(); // key -> Promise<Float32Array|null>

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tiles.has(key)) {
    const p = tiles.get(key);
    tiles.delete(key);
    tiles.set(key, p); // LRU bump
    return p;
  }
  const p = new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const e = new Float32Array(256 * 256);
      for (let i = 0; i < e.length; i++) e[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      resolve(e);
    };
    img.onerror = () => resolve(null);
    img.src = URL(z, x, y);
  });
  tiles.set(key, p);
  if (tiles.size > 300) tiles.delete(tiles.keys().next().value);
  return p;
}

function project(lat, lon, z) {
  const n = 256 * 2 ** z;
  const s = Math.sin((clamp(lat, -85, 85) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

/** Bilinear elevation (m) at a point, or null when tiles are unavailable. */
export async function elevationAt([lat, lon], z = 14) {
  const [gx, gy] = project(lat, lon, z);
  const x0 = Math.floor(gx - 0.5), y0 = Math.floor(gy - 0.5);
  const fx = gx - 0.5 - x0, fy = gy - 0.5 - y0;
  const get = async (px, py) => {
    const t = await loadTile(z, Math.floor(px / 256), Math.floor(py / 256));
    return t ? t[(py & 255) * 256 + (px & 255)] : null;
  };
  const [a, b, c, d] = await Promise.all([get(x0, y0), get(x0 + 1, y0), get(x0, y0 + 1), get(x0 + 1, y0 + 1)]);
  if ([a, b, c, d].includes(null)) return null;
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Grades (rise/run) in `n` compass directions `dist` metres out, plus centre elevation. */
export async function slopeRose(p, n = 16, dist = 80) {
  const e0 = await elevationAt(p);
  const dirs = Array.from({ length: n }, (_, i) => (i * 360) / n);
  const es = await Promise.all(dirs.map((b) => elevationAt(destination(p, b, dist))));
  return { elev: e0, dirs, grades: es.map((e) => (e == null || e0 == null ? 0 : (e - e0) / dist)) };
}

/** Terrain profile straight ahead along a bearing. */
export async function profileAhead(p, brg, len = 500, step = 25) {
  const pts = [];
  for (let d = 0; d <= len; d += step) pts.push(d);
  const es = await Promise.all(pts.map((d) => elevationAt(destination(p, brg, d))));
  return pts.map((d, i) => ({ d, e: es[i] })).filter((x) => x.e != null);
}

// ---- terrain steepness overlay ----
export function steepColor(g) {
  if (g < 0.02) return null;
  if (g < 0.05) return [46, 204, 113];
  if (g < 0.08) return [241, 196, 15];
  if (g < 0.12) return [230, 126, 34];
  return [231, 76, 60];
}

const slopeCanvases = new Map();
function slopeCanvas(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (slopeCanvases.has(key)) return slopeCanvases.get(key);
  const p = loadTile(z, x, y).then((e) => {
    if (!e) return null;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / 2 ** z))) * 180) / Math.PI;
    const px = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
    const k = Math.max(1, Math.round(15 / px)); // sample ≥ ~30 m baseline to tame DEM noise
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(256, 256);
    for (let j = 0; j < 256; j++) {
      const jm = Math.max(0, j - k), jp = Math.min(255, j + k);
      for (let i = 0; i < 256; i++) {
        const im = Math.max(0, i - k), ip = Math.min(255, i + k);
        const dx = (e[j * 256 + ip] - e[j * 256 + im]) / ((ip - im) * px);
        const dy = (e[jp * 256 + i] - e[jm * 256 + i]) / ((jp - jm) * px);
        const col = steepColor(Math.hypot(dx, dy));
        if (!col) continue;
        const o = (j * 256 + i) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 150;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
  slopeCanvases.set(key, p);
  if (slopeCanvases.size > 120) slopeCanvases.delete(slopeCanvases.keys().next().value);
  return p;
}

export function createSteepnessLayer(L) {
  const Layer = L.GridLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      const sz = Math.min(coords.z, MAX_Z), f = 2 ** (coords.z - sz);
      const sx = Math.floor(coords.x / f), sy = Math.floor(coords.y / f);
      slopeCanvas(sz, sx, sy).then((src) => {
        if (src) {
          const w = 256 / f;
          tile.getContext('2d').drawImage(src, (coords.x - sx * f) * w, (coords.y - sy * f) * w, w, w, 0, 0, 256, 256);
        }
        done(null, tile);
      });
      return tile;
    },
  });
  return new Layer({ minZoom: 12, maxZoom: 19, opacity: 0.7, attribution: 'Elevation: Mapzen/AWS Terrain Tiles' });
}
