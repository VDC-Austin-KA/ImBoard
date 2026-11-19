// Canvas charts: route elevation profile, slope rose, terrain-ahead profile.
import { STEP, gradeClass, CLASS_COLOR } from './routing.js';
import { fmtElev, fmtDist, compass } from './util.js';

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** Route elevation profile coloured by ride class, with an optional progress marker. */
export function drawProfile(canvas, a, progress = null) {
  if (!a || !canvas.clientWidth) return;
  const { ctx, w, h } = setup(canvas);
  const pad = { l: 4, r: 4, t: 14, b: 14 };
  let lo = Infinity, hi = -Infinity;
  for (const e of a.ele) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
  const span = Math.max(hi - lo, 15);
  const X = (i) => pad.l + (i / (a.n - 1)) * (w - pad.l - pad.r);
  const Y = (e) => h - pad.b - ((e - lo) / span) * (h - pad.t - pad.b);
  for (let i = 0; i < a.n - 1; i++) {
    ctx.fillStyle = CLASS_COLOR[gradeClass(a.grades[i])];
    ctx.beginPath();
    ctx.moveTo(X(i), h - pad.b);
    ctx.lineTo(X(i), Y(a.ele[i]));
    ctx.lineTo(X(i + 1), Y(a.ele[i + 1]));
    ctx.lineTo(X(i + 1), h - pad.b);
    ctx.fill();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < a.n; i++) i ? ctx.lineTo(X(i), Y(a.ele[i])) : ctx.moveTo(X(i), Y(a.ele[i]));
  ctx.stroke();
  ctx.fillStyle = '#cfd8dc';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(fmtElev(hi), pad.l + 2, 11);
  ctx.fillText(fmtElev(lo), pad.l + 2, h - 2);
  const dl = fmtDist(a.dist);
  ctx.fillText(dl, w - pad.r - ctx.measureText(dl).width - 2, h - 2);
  if (progress != null) {
    const i = Math.min(a.n - 1, progress / STEP);
    const x = X(i), y = Y(a.ele[Math.floor(i)]);
    ctx.strokeStyle = '#fff';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#00e5ff';
    ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
  }
}

/** Map a pointer x on the profile canvas back to a distance along the route. */
export const profileDistAt = (canvas, a, clientX) => {
  const r = canvas.getBoundingClientRect();
  return Math.max(0, Math.min(1, (clientX - r.left - 4) / (r.width - 8))) * a.dist;
};

const roseColor = (g) => (g <= -0.12 ? '#e74c3c' : g <= -0.06 ? '#f39c12' : g <= -0.01 ? '#2ecc71' : g < 0.015 ? '#3498db' : '#8e44ad');

/** Polar slope rose: wedge length ∝ |grade|, colour = ride class. Heading arrow optional. */
export function drawRose(canvas, rose, heading = null) {
  if (canvas.clientWidth < 60) return;
  const { ctx, w, h } = setup(canvas);
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 16;
  ctx.strokeStyle = 'rgba(255,255,255,.15)';
  [0.33, 0.66, 1].forEach((k) => { ctx.beginPath(); ctx.arc(cx, cy, R * k, 0, 7); ctx.stroke(); });
  const n = rose.dirs.length, half = Math.PI / n;
  rose.dirs.forEach((b, i) => {
    const g = rose.grades[i], r = R * Math.min(1, 0.15 + Math.abs(g) / 0.12);
    const a = ((b - 90) * Math.PI) / 180;
    ctx.fillStyle = roseColor(g);
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, a - half * 0.85, a + half * 0.85); ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  [['N', 0], ['E', 90], ['S', 180], ['W', 270]].forEach(([t, b]) => {
    const a = ((b - 90) * Math.PI) / 180;
    ctx.fillText(t, cx + Math.cos(a) * (R + 9), cy + Math.sin(a) * (R + 9));
  });
  if (heading != null) {
    const a = ((heading - 90) * Math.PI) / 180;
    ctx.strokeStyle = '#00e5ff'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
  }
}

/** Best gentle-downhill direction from a rose, or null if it's all flat/up. */
export function bestDownhill(rose, maxDown) {
  let best = null;
  rose.dirs.forEach((b, i) => {
    const g = rose.grades[i];
    if (g >= -0.008 || g < -maxDown) return;
    const s = -Math.abs(g + Math.min(0.03, maxDown * 0.45));
    if (!best || s > best.s) best = { s, bearing: b, grade: g, label: compass(b) };
  });
  return best;
}

export function drawAhead(canvas, pts) {
  if (pts.length < 2 || !canvas.clientWidth) return;
  const { ctx, w, h } = setup(canvas);
  let lo = Math.min(...pts.map((p) => p.e)), hi = Math.max(...pts.map((p) => p.e));
  const span = Math.max(hi - lo, 8), L = pts[pts.length - 1].d;
  const X = (d) => 4 + (d / L) * (w - 8), Y = (e) => h - 14 - ((e - lo) / span) * (h - 28);
  for (let i = 0; i < pts.length - 1; i++) {
    const g = (pts[i + 1].e - pts[i].e) / (pts[i + 1].d - pts[i].d);
    ctx.strokeStyle = roseColor(g); ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(X(pts[i].d), Y(pts[i].e)); ctx.lineTo(X(pts[i + 1].d), Y(pts[i + 1].e)); ctx.stroke();
  }
  ctx.fillStyle = '#cfd8dc'; ctx.font = '11px system-ui, sans-serif';
  ctx.fillText(`${fmtElev(hi - lo)} relief`, 6, 11);
  const t = fmtDist(L);
  ctx.fillText(t, w - ctx.measureText(t).width - 4, h - 2);
}
