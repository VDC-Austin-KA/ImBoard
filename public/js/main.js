import { settings, saveSettings, setSkill, SKILLS, fmtDist, fmtElev, fmtGrade, fmtSpeed, esc, toast, compass, googleMapsDirections } from './util.js';
import { createSteepnessLayer, createContourLayer, createTintLayer, sampleGrid, findExtrema, slopeRose, profileAhead, elevationAt } from './terrain.js';
import { createPavementLayers, PAVEMENT_LAYERS, scorePavement, GRADE_COLOR } from './pavement.js';
import { fetchAlternatives, fetchRoute, analyze, gradeClass, CLASS_COLOR, CLASS_LABEL, STEP } from './routing.js';
import { drawProfile, profileDistAt, drawRose, drawAhead, bestDownhill } from './charts.js';
import { findParks } from './parks.js';
import { suggestCruises, findRunsInArea, findLoops, highPoints } from './cruise.js';
import { Ride } from './nav.js';
import { unlockAudio, play, describe } from './cues.js';
import { openAR, closeAR, heading as compassHeading, requestOrientationPermission } from './ar.js';

const $ = (s) => document.querySelector(s);
const L = window.L;

// ---------- map ----------
const map = L.map('map', { zoomControl: false }).setView([39.5, -98.35], 4);
L.control.zoom({ position: 'topright' }).addTo(map);
const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const base = {
  Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
  Topographic: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: `${osmAttr}, SRTM | &copy; OpenTopoMap (CC-BY-SA)` }),
  'Surfaces (CyclOSM)': L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 20, attribution: `${osmAttr} | CyclOSM` }),
  Dark: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20, attribution: `${osmAttr} &copy; CARTO` }),
};
const hillshade = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 16, opacity: 0.45, attribution: 'Hillshade &copy; Esri' });
const steepness = createSteepnessLayer(L);
const parksLayer = L.layerGroup();
const routeLayer = L.layerGroup().addTo(map);
base[settings.base] ? base[settings.base].addTo(map) : base.Streets.addTo(map);
const contours = createContourLayer(L, () => settings.units === 'imperial');
const tint = createTintLayer(L);
const extremaLayer = L.layerGroup();
let lastStatus = '';
const pave = createPavementLayers(L, map, (m) => { if (m !== lastStatus) toast((lastStatus = m)); });
L.control.layers(base, {
  'Hillshade': hillshade, 'Elevation shading (relative)': tint, 'Contour lines': contours, 'Hilltops & low points': extremaLayer,
  'Terrain steepness': steepness, 'Skateparks': parksLayer,
  ...Object.fromEntries(Object.entries(PAVEMENT_LAYERS).map(([k, name]) => [name, pave[k]])),
}, { position: 'topright', collapsed: true }).addTo(map);

// elevation range for the tint + hilltop/low-point markers, recomputed for each view
let terrainTimer;
async function refreshTerrainView() {
  if (!map.hasLayer(tint) && !map.hasLayer(extremaLayer)) return;
  const bb = map.getBounds(), z = map.getZoom();
  const g = await sampleGrid({ s: bb.getSouth(), w: bb.getWest(), n: bb.getNorth(), e: bb.getEast() }, 28, 28, Math.min(14, Math.max(10, z - 2)));
  const es = g.es.filter((e) => e != null);
  if (!es.length) return;
  tint.setRange([Math.min(...es), Math.max(...es)]);
  extremaLayer.clearLayers();
  if (!map.hasLayer(extremaLayer)) return;
  const { tops, bottoms } = findExtrema(g, z >= 15 ? 3 : 5, 10);
  const mk = (x, cls, sym, what) => L.marker(x.p, { icon: L.divIcon({ className: '', html: `<div class="${cls}">${sym}<span>${fmtElev(x.e)}</span></div>`, iconSize: [60, 22], iconAnchor: [9, 11] }) })
    .bindPopup(`<b>${what}</b><br>${fmtElev(x.e)} · ${fmtElev(x.rel)} of relief nearby<br><button class="popup-from" data-lat="${x.p[0]}" data-lon="${x.p[1]}">Start a run here</button><br><a href="${googleMapsDirections(x.p)}" target="_blank" rel="noopener">🧭 Directions (Google Maps)</a>`).addTo(extremaLayer);
  tops.forEach((t) => mk(t, 'peak', '▲', 'Hilltop'));
  bottoms.forEach((b) => mk(b, 'valley', '▼', 'Low point'));
}
map.on('moveend overlayadd', () => { clearTimeout(terrainTimer); terrainTimer = setTimeout(refreshTerrainView, 300); });
map.on('baselayerchange', (e) => { settings.base = e.name; saveSettings(); });
map.attributionControl.addAttribution('Routing: <a href="https://brouter.de">BRouter</a>');

const dot = (cls) => L.divIcon({ className: '', html: `<div class="${cls}"></div>`, iconSize: [20, 20], iconAnchor: [10, 10] });
const pin = (label, cls) => L.divIcon({ className: '', html: `<div class="pin ${cls}">${label}</div>`, iconSize: [28, 28], iconAnchor: [14, 28] });
const parkIcon = L.divIcon({ className: '', html: '<div class="park-icon">🛹</div>', iconSize: [30, 30], iconAnchor: [15, 15] });

// ---------- state ----------
let me = null, meMarker = null, meCircle = null, followMe = true;
let from = null, to = null, fromMarker = null, toMarker = null;
let options = [], selected = -1, ride = null, wakeLock = null, parks = [], lastHere = null, scrubMarker = null;

// ---------- location ----------
function onPosition(pos) {
  const first = !me;
  me = [pos.coords.latitude, pos.coords.longitude];
  if (!meMarker) {
    meMarker = L.marker(me, { icon: dot('me-dot'), interactive: false, zIndexOffset: 1000 }).addTo(map);
    meCircle = L.circle(me, { radius: pos.coords.accuracy, color: '#00b8d4', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
  }
  meMarker.setLatLng(me);
  meCircle.setLatLng(me).setRadius(pos.coords.accuracy);
  if (first) {
    map.setView(me, 15);
    updateFromLabel();
    loadParks(me, false);
    refreshHere();
  }
  if (ride) {
    ride.onFix(pos);
    if (followMe) map.panTo(me, { animate: true });
  } else if (!$('#panel-here').hidden && lastHere && map.distance(lastHere, me) > 60) {
    refreshHere();
  }
}
// GPS status + recovery: a visible chip, a quick coarse fix first, retry on tap, and platform help.
let watchId = null, gotFix = false, manual = false;
function gpsStatus(state, text) {
  const el = $('#gps-status');
  el.className = `gps gps-${state}`;
  el.textContent = text;
  el.hidden = false;
}
function onFix(pos) {
  gotFix = true;
  manual = false;
  const acc = pos.coords.accuracy;
  gpsStatus(acc <= 30 ? 'ok' : 'weak', `📍 GPS ±${fmtDist(acc)}`);
  onPosition(pos);
}
function onGeoError(e) {
  if (manual) return;
  if (e.code === 1) {
    gpsStatus('bad', '📍 Location blocked — tap for help');
    showGpsHelp(true);
  } else if (!gotFix) {
    gpsStatus('bad', e.code === 3 ? '📍 No GPS fix yet — tap to retry' : '📍 Location unavailable — tap to retry');
  }
}
function startGps() {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    gpsStatus('bad', '📍 Location not supported here — tap for help');
    return;
  }
  if (!gotFix) gpsStatus('wait', '📍 Finding you…');
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  // a fast coarse (Wi-Fi/cell) fix so the map isn't stuck waiting on satellites
  navigator.geolocation.getCurrentPosition((p) => { if (!gotFix) onFix(p); }, () => {}, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  watchId = navigator.geolocation.watchPosition(onFix, onGeoError, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
function showGpsHelp(denied) {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua), android = /Android/.test(ua);
  const inApp = /FBAN|FBAV|Instagram|Line\/|Snapchat|GSA\/|; wv\)/.test(ua);
  const steps = inApp ? 'You seem to be in an in-app browser, which often blocks location. Open board.ackerworks.com in Safari or Chrome.'
    : ios ? 'iPhone: Settings → Privacy & Security → Location Services → On, then Safari Websites (or Chrome) → “While Using the App” with Precise Location on. Then reload and tap Allow.'
    : android ? 'Android: tap the icon left of the address bar → Permissions → Location → Allow. Also make sure Location is on in quick settings (and Google Location Accuracy for faster fixes).'
    : 'Click the icon left of the address bar → Site settings → Location → Allow, then reload. Make sure your OS allows the browser to use location.';
  $('#gps-help-text').textContent = `${denied ? 'Location access is blocked for this site. ' : ''}${steps}`;
  $('#gps-help').hidden = false;
}
function setManualLocation(p) {
  manual = true;
  onPosition({ coords: { latitude: p[0], longitude: p[1], accuracy: 15, speed: null, heading: null }, timestamp: Date.now() });
  gpsStatus('weak', '📍 Set on map (tap for GPS)');
}
$('#gps-status').onclick = () => (gotFix && !manual ? map.setView(me, Math.max(map.getZoom(), 16)) : (startGps(), showGpsHelp(false)));
$('#gps-retry').onclick = () => { $('#gps-help').hidden = true; startGps(); };
$('#gps-manual').onclick = () => { $('#gps-help').hidden = true; toast('Tap the map where you are, then choose “I’m here”', 5000); };
$('#gps-close').onclick = () => ($('#gps-help').hidden = true);
startGps();
$('#btn-locate').onclick = () => {
  followMe = true;
  if (me) map.setView(me, Math.max(map.getZoom(), 16));
  if (!gotFix) startGps(); // a tap is a user gesture: some browsers only prompt then
};
map.on('dragstart', () => { if (ride) followMe = false; });

// ---------- bottom sheet ----------
document.querySelectorAll('.tab').forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
  $('#sheet').classList.remove('collapsed');
  if (name === 'here') refreshHere();
  if (name === 'plan' && selected >= 0) drawProfile($('#profile'), options[selected].a);
}
$('#sheet-handle').onclick = () => $('#sheet').classList.toggle('collapsed');

// ---------- endpoints ----------
function updateFromLabel() {
  $('#from-label').textContent = from ? `${from[0].toFixed(5)}, ${from[1].toFixed(5)}` : me ? 'My location' : 'My location (waiting for GPS)';
}
function setFrom(p) {
  from = p;
  fromMarker?.remove();
  fromMarker = p ? L.marker(p, { icon: pin('A', 'pin-a') }).addTo(map) : null;
  updateFromLabel();
}
function setTo(p, label) {
  to = p;
  toMarker?.remove();
  toMarker = p ? L.marker(p, { icon: pin('B', 'pin-b') }).addTo(map) : null;
  $('#to-label').textContent = p ? label || `${p[0].toFixed(5)}, ${p[1].toFixed(5)}` : 'Tap the map, search, or pick a skatepark';
}
$('#btn-swap').onclick = () => {
  const f = from || me, t = to;
  if (!f || !t) return toast('Set both ends first');
  setFrom(t);
  setTo(f, from ? 'Previous start' : 'My location');
  planRoutes();
};
$('#btn-clear').onclick = () => {
  setFrom(null); setTo(null); options = []; selected = -1;
  routeLayer.clearLayers(); $('#route-list').innerHTML = ''; $('#plan-result').hidden = true;
};

map.on('click', (e) => {
  if (ride) return;
  const p = [e.latlng.lat, e.latlng.lng];
  const div = document.createElement('div');
  div.className = 'popup-actions';
  div.innerHTML = '<button data-a="to">Route here</button><button data-a="from">Start here</button><button data-a="here">Terrain here</button><button data-a="me">I’m here</button>';
  const pop = L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
  div.onclick = (ev) => {
    const a = ev.target.dataset.a;
    if (!a) return;
    map.closePopup(pop);
    if (a === 'to') { setTo(p); planRoutes(); }
    if (a === 'from') { setFrom(p); if (to) planRoutes(); }
    if (a === 'here') { showTab('here'); refreshHere(p); }
    if (a === 'me') setManualLocation(p);
  };
});

// ---------- search (Nominatim) ----------
let searchCtl;
$('#search').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#q').value.trim();
  if (!q) return;
  searchCtl?.abort();
  searchCtl = new AbortController();
  const b = map.getBounds();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}` +
    `&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
  try {
    const res = await fetch(url, { signal: searchCtl.signal, headers: { 'Accept-Language': navigator.language } });
    const list = await res.json();
    const ul = $('#search-results');
    ul.innerHTML = list.length ? list.map((r, i) => `<li data-i="${i}">${esc(r.display_name)}</li>`).join('') : '<li class="muted">No results</li>';
    ul.hidden = false;
    ul.onclick = (ev) => {
      const r = list[ev.target.dataset.i];
      if (!r) return;
      ul.hidden = true;
      const p = [+r.lat, +r.lon];
      setTo(p, r.display_name.split(',').slice(0, 2).join(','));
      map.setView(p, 15);
      planRoutes();
    };
  } catch (err) {
    if (err.name !== 'AbortError') toast('Search failed');
  }
};
$('#q').addEventListener('input', () => { if (!$('#q').value) $('#search-results').hidden = true; });

// ---------- route display ----------
function scoreClass(s) { return s >= 80 ? 's-great' : s >= 65 ? 's-good' : s >= 45 ? 's-mid' : 's-bad'; }
function compBar(a) {
  return `<div class="bar">${Object.entries(a.frac).filter(([, v]) => v > 0.005)
    .map(([k, v]) => `<span style="width:${(v * 100).toFixed(1)}%;background:${CLASS_COLOR[k]}" title="${CLASS_LABEL[k]} ${(v * 100).toFixed(0)}%"></span>`).join('')}</div>`;
}
function cardHTML(o, i) {
  const a = o.a;
  return `<div class="card ${i === selected ? 'sel' : ''}" data-i="${i}">
    <div class="score ${scoreClass(a.score)}">${a.score}</div>
    <div class="card-body">
      <b>${esc(o.title)}</b> <span class="muted">· ${a.label}</span>
      <div class="meta">${fmtDist(a.dist)} · ↑${fmtElev(a.climb)} · ↓${fmtElev(a.descent)} · steepest ${fmtGrade(a.maxDownG)}</div>
      ${compBar(a)}
      ${a.pave && a.pave.coverage > 0.2 ? `<div class="meta">Pavement: <span style="color:${GRADE_COLOR.A}">${Math.round(a.pave.good * 100)}% A/B</span> · <span style="color:${GRADE_COLOR.D}">${Math.round(a.pave.poor * 100)}% D/F</span></div>` : ''}
      ${o.walk ? `<div class="meta walkback">🚶 Walk back to start: <b>${fmtDist(o.walk.a.dist)}</b> · ↑${fmtElev(o.walk.a.climb)} · steepest ${fmtGrade(o.walk.a.maxUpG)}</div>` : ''}
      ${a.flags.length ? `<div class="flags">${a.flags.map(esc).join(' · ')}</div>` : ''}
    </div></div>`;
}

function drawRoutes() {
  routeLayer.clearLayers();
  options.forEach((o, i) => {
    if (i === selected) return;
    const ll = Array.from({ length: o.a.n }, (_, k) => [o.a.lat[k], o.a.lon[k]]);
    L.polyline(ll, { color: '#78909c', weight: 5, opacity: 0.7, dashArray: '6 8' }).on('click', () => selectOption(i)).addTo(routeLayer);
  });
  const o = options[selected];
  if (!o) return;
  const a = o.a;
  const all = Array.from({ length: a.n }, (_, k) => [a.lat[k], a.lon[k]]);
  L.polyline(all, { color: '#102027', weight: 10, opacity: 0.8 }).addTo(routeLayer);
  let start = 0;
  for (let i = 1; i <= a.n - 1; i++) {
    const c = gradeClass(a.grades[i - 1]);
    if (i === a.n - 1 || gradeClass(a.grades[i]) !== c) {
      L.polyline(all.slice(start, i + 1), { color: CLASS_COLOR[c], weight: 6 }).addTo(routeLayer);
      start = i;
    }
  }
  if (o.walk) {
    L.polyline(o.walk.route.pts.map((p) => [p.lat, p.lon]), { color: '#ffd740', weight: 4, dashArray: '1 8', lineCap: 'round' })
      .bindTooltip(`Walk back ${fmtDist(o.walk.a.dist)} · ↑${fmtElev(o.walk.a.climb)}`).addTo(routeLayer);
  }
  o.route.cues.forEach((c) => L.circleMarker([c.lat, c.lon], { radius: 4, color: '#fff', weight: 2, fillColor: '#102027', fillOpacity: 1 })
    .bindTooltip(describe(c)).addTo(routeLayer));
}

function renderOptions(listEl) {
  listEl.innerHTML = options.map(cardHTML).join('');
  listEl.onclick = (e) => {
    const c = e.target.closest('.card');
    if (c) selectOption(+c.dataset.i);
  };
}

function selectOption(i, fit = true) {
  selected = i;
  const o = options[i];
  if (o.to) setTo(o.to, o.title);
  if (o.area) setFrom(o.from);
  drawRoutes();
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', +c.dataset.i === i));
  $('#plan-result').hidden = false;
  $('#plan-summary').innerHTML = `${esc(o.title)} — <b>${o.a.label}</b>, ${(o.a.frac.sweet * 100).toFixed(0)}% sweet-spot downhill`;
  drawProfile($('#profile'), o.a);
  if (fit) map.fitBounds(L.latLngBounds(Array.from({ length: o.a.n }, (_, k) => [o.a.lat[k], o.a.lon[k]])), { padding: [40, 40] });
}

async function planRoutes() {
  const f = from || me;
  if (!f) return toast('Waiting for your location — or tap the map and choose “Start here”');
  if (!to) return toast('Pick a destination first');
  showTab('plan');
  const list = $('#route-list');
  list.innerHTML = '<div class="loading">Finding smooth, low-climb routes…</div>';
  try {
    const routes = await fetchAlternatives(f, to, 3);
    options = routes.map((route, i) => ({ route, a: analyze(route), title: `Route ${'ABC'[i]}` }));
    await scorePavement(options);
    options.sort((x, y) => y.a.score - x.a.score);
    options.forEach((o, i) => (o.title = i === 0 ? 'Best ride' : `Alternative ${i}`));
    selected = 0;
    renderOptions(list);
    selectOption(0);
  } catch (e) {
    list.innerHTML = `<div class="error">Couldn't route: ${esc(e.message)}</div>`;
  }
}
$('#btn-route').onclick = planRoutes;

// profile scrubbing → show position on map
const prof = $('#profile');
prof.addEventListener('pointermove', (e) => {
  const o = options[selected];
  if (!o) return;
  const d = profileDistAt(prof, o.a, e.clientX), k = Math.min(o.a.n - 1, Math.round(d / STEP));
  scrubMarker ||= L.circleMarker([0, 0], { radius: 7, color: '#fff', fillColor: '#00e5ff', fillOpacity: 1 }).addTo(map);
  scrubMarker.setLatLng([o.a.lat[k], o.a.lon[k]]);
  drawProfile(prof, o.a, d);
  $('#profile-readout').textContent = `${fmtDist(d)} · ${fmtElev(o.a.ele[k])} · ${fmtGrade(o.a.grades[Math.min(k, o.a.grades.length - 1)])}`;
});
prof.addEventListener('pointerleave', () => { scrubMarker?.remove(); scrubMarker = null; });

// ---------- cruise suggestions ----------
async function runFinder(mode) {
  const f = from || me;
  if (mode === 'me' && !f) return toast('Waiting for your location…');
  const list = $('#cruise-list');
  list.innerHTML = '<div class="loading">Scouting terrain…</div>';
  document.querySelectorAll('.finder').forEach((b) => (b.disabled = true));
  const progress = (m) => (list.innerHTML = `<div class="loading">${esc(m)}</div>`);
  try {
    const len = +$('#cruise-len').value;
    let res;
    if ($('#cruise-loop').checked) {
      const walkM = +$('#cruise-walk').value;
      let origins;
      if (mode === 'view') {
        if (map.getZoom() < 12) throw new Error('Zoom in a little (to a neighbourhood or two) so the search stays focused');
        const bb = map.getBounds();
        origins = await highPoints({ s: bb.getSouth(), w: bb.getWest(), n: bb.getNorth(), e: bb.getEast() }, 3, 500);
      } else {
        const e = await elevationAt(f, 14);
        if (e == null) throw new Error('Elevation data unavailable here');
        origins = [{ p: f, e }];
      }
      res = await findLoops(origins, len, walkM, progress);
      if (mode === 'view') res.forEach((o) => (o.area = true));
    } else if (mode === 'view') {
      if (map.getZoom() < 12) throw new Error('Zoom in a little (to a neighbourhood or two) so the search stays focused');
      const bb = map.getBounds();
      res = await findRunsInArea({ s: bb.getSouth(), w: bb.getWest(), n: bb.getNorth(), e: bb.getEast() }, len, parks, progress);
      res.forEach((o) => (o.area = true));
    } else {
      res = await suggestCruises(f, len, parks, progress);
    }
    if (!res.length) throw new Error('No rideable runs found — try another length or area');
    options = res;
    selected = 0;
    setTo(null);
    renderOptions(list);
    selectOption(0);
    $('#cruise-hint').hidden = false;
  } catch (e) {
    list.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    document.querySelectorAll('.finder').forEach((b) => (b.disabled = false));
  }
}
$('#btn-cruise').onclick = () => runFinder('me');
$('#btn-area').onclick = () => runFinder('view');
// open Google Maps with directions to the selected run's first point
document.querySelectorAll('.gmaps').forEach((b) => (b.onclick = () => {
  const o = options[selected];
  if (!o) return toast('Pick a run first');
  window.open(googleMapsDirections([o.a.lat[0], o.a.lon[0]]), '_blank', 'noopener');
}));

$('#btn-cruise-plan').onclick = () => {
  const o = options[selected];
  if (!o) return;
  setTo(o.to, o.title);
  showTab('plan');
  renderOptions($('#route-list'));
  selectOption(selected, false);
};

// ---------- skateparks ----------
async function loadParks(center, show = true) {
  const list = $('#park-list');
  list.innerHTML = '<div class="loading">Searching OpenStreetMap for skateparks…</div>';
  try {
    parks = await findParks(center, 15000);
    parksLayer.clearLayers();
    parks.forEach((p) => L.marker([p.lat, p.lon], { icon: parkIcon, title: p.name })
      .bindPopup(parkPopup(p)).addTo(parksLayer));
    if (!map.hasLayer(parksLayer)) parksLayer.addTo(map);
    list.innerHTML = parks.length ? parks.slice(0, 40).map((p, i) => `<div class="park" data-i="${i}">
        <div><b>${esc(p.name)}</b> ${'★'.repeat(Math.min(5, Math.ceil(p.pop / 2)))}<div class="muted">${fmtDist(p.dist)} away${p.tags.lit === 'yes' ? ' · lit' : ''}${p.tags.surface ? ` · ${esc(p.tags.surface)}` : ''}</div></div>
        <button data-i="${i}">Route</button></div>`).join('') : '<div class="muted">No skateparks mapped within 15 km.</div>';
    if (show && parks.length) map.fitBounds(L.latLngBounds(parks.map((p) => [p.lat, p.lon])).pad(0.1));
  } catch (e) {
    list.innerHTML = `<div class="error">Skatepark search failed (${esc(e.message)}). Try again shortly.</div>`;
  }
}
function parkPopup(p) {
  const web = p.tags.website || p.tags['contact:website'];
  return `<b>${esc(p.name)}</b><br>${p.tags.lit === 'yes' ? 'Lit · ' : ''}${esc(p.tags.opening_hours || '')}` +
    `${web && /^https?:\/\//.test(web) ? `<br><a href="${esc(web)}" target="_blank" rel="noopener">Website</a>` : ''}` +
    `<br><button class="popup-route" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${esc(p.name)}">Route here</button>`;
}
map.on('popupopen', (e) => {
  const b = e.popup.getElement().querySelector('.popup-route');
  if (b) b.onclick = () => { map.closePopup(); setTo([+b.dataset.lat, +b.dataset.lon], b.dataset.name); planRoutes(); };
  const f = e.popup.getElement().querySelector('.popup-from');
  if (f) f.onclick = () => { map.closePopup(); setFrom([+f.dataset.lat, +f.dataset.lon]); showTab('cruise'); toast('Start point A set — tap “From me / point A” to find runs from here'); };
});
$('#park-list').onclick = (e) => {
  const i = e.target.closest('[data-i]')?.dataset.i;
  if (i == null) return;
  const p = parks[i];
  if (e.target.tagName === 'BUTTON') { setTo([p.lat, p.lon], p.name); planRoutes(); } else map.setView([p.lat, p.lon], 17);
};
$('#btn-parks-near').onclick = () => (me ? loadParks(me) : toast('Waiting for your location…'));
$('#btn-parks-area').onclick = () => { const c = map.getCenter(); loadParks([c.lat, c.lng]); };

// ---------- "Here": terrain profile of the current location ----------
let hereBusy = false, lastRose = null;
async function refreshHere(p = me) {
  if (!p || hereBusy) return;
  hereBusy = true;
  lastHere = p;
  try {
    const rose = await slopeRose(p, 16, 80);
    lastRose = rose;
    const hdg = ride?.gpsHeading ?? compassHeading();
    drawRose($('#rose'), rose, hdg);
    const best = bestDownhill(rose, settings.maxDown, SKILLS[settings.skill].ideal);
    const steepest = rose.grades.reduce((m, g) => Math.min(m, g), 0);
    $('#here-stats').innerHTML = rose.elev == null ? 'Elevation data unavailable here.' :
      `<div><span class="big">${fmtElev(rose.elev)}</span> elevation</div>
       <div>${best ? `Best gentle downhill: <b>${best.label}</b> (${fmtGrade(best.grade)})` : 'No gentle downhill nearby — mostly flat or uphill.'}</div>
       <div class="muted">Steepest drop within 80 m: ${fmtGrade(steepest)}${steepest < -settings.maxDown ? ' ⚠' : ''}</div>`;
    const brg = hdg ?? best?.bearing ?? 0;
    $('#ahead-title').textContent = `Terrain ahead toward ${compass(brg)} (500 m)`;
    drawAhead($('#ahead'), await profileAhead(p, brg));
  } finally {
    hereBusy = false;
  }
}
$('#btn-here-refresh').onclick = async () => { await requestOrientationPermission(); refreshHere(me); };

// ---------- ride mode ----------
const ARROWS = { left: { slight: '↖', normal: '⬅', sharp: '↙' }, right: { slight: '↗', normal: '➡', sharp: '↘' } };
const arrowFor = (c) => !c ? '⬆' : c.dir === 'uturn' ? '⤺' : c.dir === 'roundabout' ? '⟳' : ARROWS[c.side][c.strength];
let hud = {};

async function startRide() {
  const o = options[selected];
  if (!o) return toast('Plan a route first');
  if (!me) return toast('Need a GPS fix to start riding');
  unlockAudio();
  await requestOrientationPermission();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ }
  const start = [o.a.lat[0], o.a.lon[0]];
  if (map.distance(me, start) > 150 && confirm(`This run starts ${fmtDist(map.distance(me, start))} away. Get directions to the start first?`)) {
    try {
      const r = await fetchRoute(me, start, 0);
      const leg = { route: r, a: analyze(r), to: start, next: o };
      L.polyline(r.pts.map((p) => [p.lat, p.lon]), { color: '#00e5ff', weight: 5, dashArray: '2 8' }).addTo(routeLayer);
      return beginRide(leg);
    } catch { toast('Could not route to the start — heading straight into the run'); }
  }
  beginRide(o);
}

function beginRide(o) {
  ride = new Ride(o.route, o.a, {
    onUpdate: (u) => {
      hud = u;
      $('#hud-arrow').textContent = u.offRoute ? '⚠' : arrowFor(u.next);
      $('#hud-dist').textContent = u.offRoute ? 'Off route' : u.next ? fmtDist(u.nextDist) : fmtDist(u.remaining);
      $('#hud-instr').textContent = u.offRoute ? 'Recalculating…' : u.next ? describe(u.next) : 'Continue to destination';
      const gc = gradeClass(u.grade);
      $('#hud-grade').textContent = fmtGrade(u.grade);
      $('#hud-grade').style.color = CLASS_COLOR[gc];
      $('#hud-speed').textContent = fmtSpeed(u.speed);
      $('#hud-remain').textContent = `${fmtDist(u.remaining)} left`;
      drawProfile($('#hud-profile'), ride.a, u.progress);
    },
    onReroute: async (p) => {
      try {
        const r = await fetchRoute(p, o.to || to, 0);
        const a = analyze(r);
        ride.replace(r, a);
        if (!o.next) { options[selected] = { ...options[selected], route: r, a }; drawRoutes(); }
        toast('New route ready');
      } catch { toast('Reroute failed — keep heading toward the destination'); }
    },
    onArrive: () => {
      if (o.next) { toast('At the start — enjoy the run! 🛹', 5000); drawRoutes(); beginRide(o.next); return; }
      toast(o.walk ? `Run done! 🛹 Walk back up: ${fmtDist(o.walk.a.dist)} (yellow dots on the map)` : 'Arrived! 🛹', 7000);
      stopRide();
    },
  });
  document.body.classList.add('riding');
  $('#hud').hidden = false;
  followMe = true;
  map.setView(me, 17);
  $('#hud-instr').textContent = 'Ride on — cues will chime & buzz before each turn';
  play.backOnRoute();
}
function stopRide() {
  ride = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  closeAR();
  document.body.classList.remove('riding');
  $('#hud').hidden = true;
  $('#pocket').hidden = true;
}
document.addEventListener('visibilitychange', async () => {
  if (ride && document.visibilityState === 'visible') try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* ignore */ }
});
$('#btn-ride').onclick = startRide;
$('#btn-cruise-ride').onclick = startRide;
$('#btn-stop').onclick = stopRide;

// pocket mode: black screen (saves OLED battery, blocks pocket taps). Hold to unlock.
$('#btn-pocket').onclick = () => { $('#pocket').hidden = false; };
let holdT;
$('#pocket').addEventListener('pointerdown', () => { holdT = setTimeout(() => ($('#pocket').hidden = true), 1500); });
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => $('#pocket').addEventListener(ev, () => clearTimeout(holdT)));

// ---------- AR ----------
function arTarget() {
  if (ride) {
    const label = hud.offRoute ? 'Head back to the route' : hud.next ? `${describe(hud.next)} in ${fmtDist(hud.nextDist)}` : 'Straight on';
    return { bearing: ride.targetBearing(), gpsHeading: ride.speed > 2 ? ride.gpsHeading : null, label };
  }
  const best = lastRose && bestDownhill(lastRose, settings.maxDown, SKILLS[settings.skill].ideal);
  return best ? { bearing: best.bearing, label: `Gentle downhill ${best.label} (${fmtGrade(best.grade)})` } : { label: 'Plan a route to get turn guidance' };
}
function arInfo() {
  if (!ride) return '';
  return `<span style="color:${CLASS_COLOR[gradeClass(hud.grade ?? 0)]}">${fmtGrade(hud.grade ?? 0)}</span> · ${fmtSpeed(hud.speed ?? 0)} · ${fmtDist(hud.remaining ?? 0)} left`;
}
const startAR = () => { unlockAudio(); openAR(arTarget, arInfo); };
$('#btn-ar').onclick = startAR;
$('#btn-hud-ar').onclick = startAR;
$('#ar-close').onclick = closeAR;

// ---------- settings ----------
$('#set-units').value = settings.units;
$('#set-voice').checked = settings.voice;
$('#set-vibrate').checked = settings.vibrate;
document.querySelectorAll('.skill-select').forEach((sel) => {
  sel.innerHTML = Object.entries(SKILLS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
  sel.value = settings.skill;
  sel.onchange = () => {
    setSkill(sel.value);
    document.querySelectorAll('.skill-select').forEach((x) => (x.value = settings.skill));
    saveSettings();
    reanalyze();
  };
});
$('#cruise-loop').onchange = () => ($('#loop-walk-row').hidden = !$('#cruise-loop').checked);
function reanalyze() {
  options.forEach((o) => (o.a = analyze(o.route)));
  scorePavement(options).finally(() => {
    options.forEach((o) => { if (o.walkPenalty) o.a.score = Math.max(0, o.a.score - o.walkPenalty); });
    if (selected >= 0) { drawRoutes(); renderOptions($('#route-list')); selectOption(selected, false); }
  });
}
$('#settings-form').onchange = (e) => {
  if (e.target.classList.contains('skill-select')) return;
  settings.units = $('#set-units').value;
  settings.voice = $('#set-voice').checked;
  settings.vibrate = $('#set-vibrate').checked;
  saveSettings();
  contours.redraw();
  reanalyze();
};
if (!navigator.vibrate) $('#vibe-note').hidden = false;
$('#cue-tests').onclick = (e) => {
  const t = e.target.dataset.test;
  if (!t) return;
  unlockAudio();
  const cue = { left: { dir: 'left', side: 'left', strength: 'normal' }, right: { dir: 'right', side: 'right', strength: 'normal' },
    slight: { dir: 'right', side: 'right', strength: 'slight' }, rbt: { dir: 'roundabout', side: 'right', exit: 2, strength: 'normal' } }[t];
  if (cue) play.prepare(cue);
  else if (t === 'now') play.now({ side: 'right' });
  else play[t]();
};

// ---------- PWA ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('resize', () => { if (selected >= 0) drawProfile($('#profile'), options[selected].a); });
showTab('plan');
$('#sheet').classList.add('collapsed');
