// Shared geo math, formatting, settings and fetch helpers.
const R = 6371008.8;
export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function haversine(a, b) {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a, b) {
  const p1 = toRad(a[0]), p2 = toRad(b[0]), dl = toRad(b[1] - a[1]);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(p, brg, dist) {
  const d = dist / R, t = toRad(brg), p1 = toRad(p[0]), l1 = toRad(p[1]);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [toDeg(p2), ((toDeg(l2) + 540) % 360) - 180];
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// ---- settings ----
const DEFAULTS = {
  units: /^en-(US|LR|MM)/.test(navigator.language) ? 'imperial' : 'metric',
  maxDown: 0.07, // steepest comfortable downhill grade
  voice: false,
  vibrate: true,
};
export const settings = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem('imboard.settings') || '{}'));
export const saveSettings = () => localStorage.setItem('imboard.settings', JSON.stringify(settings));

// ---- formatting ----
export function fmtDist(m) {
  if (settings.units === 'imperial') {
    const mi = m / 1609.344;
    return mi < 0.1 ? `${Math.round(m * 3.28084 / 10) * 10} ft` : `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
  }
  return m < 1000 ? `${Math.round(m / 5) * 5} m` : `${(m / 1000).toFixed(1)} km`;
}
export const fmtElev = (m) => settings.units === 'imperial' ? `${Math.round(m * 3.28084)} ft` : `${Math.round(m)} m`;
export const fmtGrade = (g) => `${g > 0 ? '+' : ''}${(g * 100).toFixed(1)}%`;
export const fmtSpeed = (ms) => settings.units === 'imperial' ? `${Math.round(ms * 2.23694)} mph` : `${Math.round(ms * 3.6)} km/h`;

export async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Google Maps directions from the user's current location to a point (opens the app on phones). */
export const googleMapsDirections = ([lat, lon]) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lon.toFixed(6)}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

let toastTimer;
export function toast(msg, ms = 3500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}
