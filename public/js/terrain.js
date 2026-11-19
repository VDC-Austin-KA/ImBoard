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

// ---- shared: elevations for a display tile, resampled (bilinear) from the best source zoom ----
async function displayTileElev(c, res) {
  const sz = Math.min(c.z, MAX_Z), f = 2 ** (c.z - sz);
  const sx = Math.floor(c.x / f), sy = Math.floor(c.y / f);
  const src = await loadTile(sz, sx, sy);
  if (!src) return null;
  const span = 256 / f, ox = (c.x - sx * f) * span, oy = (c.y - sy * f) * span;
  const out = new Float32Array(res * res);
  for (let j = 0; j < res; j++) {
    const y = clamp(oy + (j / (res - 1)) * span - 0.5, 0, 254.999), y0 = Math.floor(y), fy = y - y0;
    for (let i = 0; i < res; i++) {
      const x = clamp(ox + (i / (res - 1)) * span - 0.5, 0, 254.999), x0 = Math.floor(x), fx = x - x0;
      const k = y0 * 256 + x0;
      out[j * res + i] = (src[k] * (1 - fx) + src[k + 1] * fx) * (1 - fy) + (src[k + 256] * (1 - fx) + src[k + 257] * fx) * fy;
    }
  }
  return out;
}
const tileLat = (z, y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const metersPerPx = (z, y) => (156543.03392 * Math.cos((tileLat(z, y + 0.5) * Math.PI) / 180)) / 2 ** z;

// ---- contour lines (marching squares) ----
function contourInterval(z, imperial) {
  const ft = { 12: 100, 13: 50, 14: 20, 15: 10, 16: 10 }, m = { 12: 25, 13: 10, 14: 5, 15: 5, 16: 2 };
  const v = (imperial ? ft : m)[clamp(z, 12, 16)];
  return imperial ? v / 3.28084 : v;
}

export function createContourLayer(L, isImperial) {
  const Layer = L.GridLayer.extend({
    createTile(c, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      const N = 65; // 64 cells → 4 px each
      displayTileElev(c, N).then((e) => {
        if (!e) return done(null, tile);
        const ctx = tile.getContext('2d');
        const step = contourInterval(c.z, isImperial()), major = step * 5;
        let lo = Infinity, hi = -Infinity;
        for (const v of e) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        const s = 256 / (N - 1), labels = [];
        for (let lv = Math.ceil(lo / step) * step; lv <= hi; lv += step) {
          const isMajor = Math.abs(lv / major - Math.round(lv / major)) < 1e-6;
          ctx.beginPath();
          let labelAt = null;
          for (let j = 0; j < N - 1; j++) {
            for (let i = 0; i < N - 1; i++) {
              const a = e[j * N + i], b = e[j * N + i + 1], cc = e[(j + 1) * N + i + 1], d = e[(j + 1) * N + i];
              const pts = [];
              const edge = (v1, v2, x1, y1, x2, y2) => {
                if ((v1 < lv) === (v2 < lv)) return;
                const t = (lv - v1) / (v2 - v1);
                pts.push([(x1 + (x2 - x1) * t) * s, (y1 + (y2 - y1) * t) * s]);
              };
              edge(a, b, i, j, i + 1, j); edge(b, cc, i + 1, j, i + 1, j + 1);
              edge(d, cc, i, j + 1, i + 1, j + 1); edge(a, d, i, j, i, j + 1);
              for (let k = 0; k + 1 < pts.length; k += 2) {
                ctx.moveTo(pts[k][0], pts[k][1]);
                ctx.lineTo(pts[k + 1][0], pts[k + 1][1]);
                if (isMajor && !labelAt && i > 8 && i < 56 && j > 8 && j < 56) labelAt = pts[k];
              }
            }
          }
          ctx.strokeStyle = isMajor ? 'rgba(121,85,72,.95)' : 'rgba(141,110,99,.6)';
          ctx.lineWidth = isMajor ? 1.6 : 0.8;
          ctx.stroke();
          if (labelAt) labels.push([lv, labelAt]);
        }
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,255,255,.85)';
        ctx.fillStyle = '#5d4037';
        for (const [lv, [x, y]] of labels) {
          const t = isImperial() ? `${Math.round(lv * 3.28084)}` : `${Math.round(lv)}`;
          ctx.strokeText(t, x + 2, y - 2);
          ctx.fillText(t, x + 2, y - 2);
        }
        done(null, tile);
      });
      return tile;
    },
  });
  return new Layer({ minZoom: 12, maxZoom: 19, attribution: 'Contours from Mapzen/AWS Terrain Tiles' });
}

// ---- elevation tint (colour relative to the elevations in view) + hillshade ----
const RAMP = [[0, [21, 101, 192]], [0.25, [0, 172, 193]], [0.5, [124, 179, 66]], [0.75, [253, 216, 53]], [1, [216, 67, 21]]];
function ramp(t) {
  t = clamp(t, 0, 1);
  for (let k = 1; k < RAMP.length; k++) {
    if (t <= RAMP[k][0]) {
      const [t0, c0] = RAMP[k - 1], [t1, c1] = RAMP[k], u = (t - t0) / (t1 - t0);
      return c0.map((v, i) => v + (c1[i] - v) * u);
    }
  }
  return RAMP[RAMP.length - 1][1];
}

export function createTintLayer(L) {
  let range = null;
  const Layer = L.GridLayer.extend({
    createTile(c, done) {
      const tile = document.createElement('canvas');
      tile.width = tile.height = 256;
      const N = 128;
      displayTileElev(c, N).then((e) => {
        if (!e || !range) return done(null, tile);
        const small = document.createElement('canvas');
        small.width = small.height = N;
        const sctx = small.getContext('2d'), img = sctx.createImageData(N, N);
        const px = (metersPerPx(c.z, c.y) * 256) / (N - 1), ex = 3; // vertical exaggeration for subtle relief
        const [lo, hi] = range, span = Math.max(hi - lo, 5);
        for (let j = 0; j < N; j++) {
          for (let i = 0; i < N; i++) {
            const k = j * N + i;
            const dx = ((e[j * N + Math.min(N - 1, i + 1)] - e[j * N + Math.max(0, i - 1)]) / (2 * px)) * ex;
            const dy = ((e[Math.min(N - 1, j + 1) * N + i] - e[Math.max(0, j - 1) * N + i]) / (2 * px)) * ex;
            // light from the north-west, 45° up
            const shade = clamp((0.5 * dx + 0.5 * dy + 0.7071) / Math.sqrt(1 + dx * dx + dy * dy), 0, 1);
            const col = ramp((e[k] - lo) / span), m = 0.45 + 0.75 * shade;
            img.data[k * 4] = col[0] * m; img.data[k * 4 + 1] = col[1] * m; img.data[k * 4 + 2] = col[2] * m; img.data[k * 4 + 3] = 255;
          }
        }
        sctx.putImageData(img, 0, 0);
        const ctx = tile.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(small, 0, 0, 256, 256);
        done(null, tile);
      });
      return tile;
    },
  });
  const layer = new Layer({ minZoom: 10, maxZoom: 19, opacity: 0.55, attribution: 'Elevation: Mapzen/AWS Terrain Tiles' });
  layer.setRange = (r) => {
    if (range && Math.abs(r[0] - range[0]) < 2 && Math.abs(r[1] - range[1]) < 2) return;
    range = r;
    layer.redraw();
  };
  layer.getRange = () => range;
  return layer;
}

/** Sample an nx×ny elevation grid across map bounds {s,w,n,e}. */
export async function sampleGrid(b, nx = 24, ny = 24, z = 13) {
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    pts.push([b.n - ((j + 0.5) / ny) * (b.n - b.s), b.w + ((i + 0.5) / nx) * (b.e - b.w)]);
  }
  const es = await Promise.all(pts.map((p) => elevationAt(p, z)));
  return { nx, ny, pts, es };
}

/** Local hilltops and low points in a grid: strict extrema over a 5×5 window with ≥ `prom` m relief. */
export function findExtrema(g, prom = 6, max = 8) {
  const tops = [], bottoms = [], R = 2;
  for (let j = R; j < g.ny - R; j++) for (let i = R; i < g.nx - R; i++) {
    const v = g.es[j * g.nx + i];
    if (v == null) continue;
    let isMax = true, isMin = true, lo = v, hi = v;
    for (let dj = -R; dj <= R; dj++) for (let di = -R; di <= R; di++) {
      if (!di && !dj) continue;
      const w = g.es[(j + dj) * g.nx + i + di];
      if (w == null) continue;
      if (w >= v) isMax = false;
      if (w <= v) isMin = false;
      lo = Math.min(lo, w); hi = Math.max(hi, w);
    }
    if (isMax && v - lo >= prom) tops.push({ p: g.pts[j * g.nx + i], e: v, rel: v - lo });
    if (isMin && hi - v >= prom) bottoms.push({ p: g.pts[j * g.nx + i], e: v, rel: hi - v });
  }
  const top = (a) => a.sort((x, y) => y.rel - x.rel).slice(0, max);
  return { tops: top(tops), bottoms: top(bottoms) };
}
