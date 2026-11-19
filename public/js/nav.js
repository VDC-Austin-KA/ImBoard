// Ride session: snaps GPS fixes to the route, fires staged turn / steep / off-route cues.
import { haversine, bearing, settings, fmtDist } from './util.js';
import { play } from './cues.js';
import { STEP, gradeAt } from './routing.js';

/** Nearest point on polyline segments [from, to) — returns { i, t, off, d }. */
function snap(pts, p, from, to) {
  let best = { off: Infinity };
  const kx = Math.cos((p[0] * Math.PI) / 180) * 111320, ky = 110540;
  for (let i = Math.max(0, from); i < Math.min(pts.length - 1, to); i++) {
    const a = pts[i], b = pts[i + 1];
    const ax = (a.lon - p[1]) * kx, ay = (a.lat - p[0]) * ky;
    const bx = (b.lon - p[1]) * kx, by = (b.lat - p[0]) * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    if (off < best.off) best = { i, t, off, d: a.d + (b.d - a.d) * t };
  }
  return best;
}

export class Ride {
  constructor(route, analysis, { onUpdate, onReroute, onArrive }) {
    Object.assign(this, { route, a: analysis, onUpdate, onReroute, onArrive });
    this.seg = 0;
    this.fired = new Set();
    this.offCount = 0;
    this.offRoute = false;
    this.lastReroute = 0;
    this.speed = 0;
    this.progress = 0;
    this.last = null;
    this.skipStartCues();
  }

  replace(route, analysis) {
    Object.assign(this, { route, a: analysis, seg: 0, fired: new Set(), offRoute: false, offCount: 0 });
    this.skipStartCues();
  }

  // the rider is already standing at the start: don't buzz for a turn right under their feet
  skipStartCues() {
    this.route.cues.filter((c) => c.d < 15).forEach((c) => ['now', 'prepare', 'heads'].forEach((n) => this.fired.add(`${c.idx}:${n}`)));
  }

  onFix(pos) {
    const { latitude, longitude, accuracy, speed, heading } = pos.coords;
    const p = [latitude, longitude], now = pos.timestamp;
    if (this.last) {
      const dt = (now - this.last.t) / 1000;
      const v = speed ?? (dt > 0 ? haversine(this.last.p, p) / dt : 0);
      this.speed = this.speed * 0.6 + Math.min(v, 25) * 0.4; // smooth, clamp GPS spikes
    }
    if (heading != null && !Number.isNaN(heading) && (speed ?? 0) > 1.5) this.gpsHeading = heading;
    this.last = { p, t: now };
    this.pos = p;

    const pts = this.route.pts;
    let s = snap(pts, p, this.seg - 5, this.seg + 150);
    if (s.off > 60) s = snap(pts, p, 0, pts.length); // lost the window: full search
    this.seg = s.i;
    this.progress = s.d;
    const v = Math.max(this.speed, 4); // assume ≥ ~15 km/h for lead times

    // off-route handling
    const reliable = accuracy < 35;
    if (s.off > 40 && reliable) {
      if (++this.offCount >= 3 && !this.offRoute) {
        this.offRoute = true;
        play.offRoute();
      }
      if (this.offRoute && now - this.lastReroute > 25000) {
        this.lastReroute = now;
        this.onReroute(p);
      }
    } else if (s.off < 25) {
      if (this.offRoute) play.backOnRoute();
      this.offRoute = false;
      this.offCount = 0;
    }

    // arrival
    const remaining = this.route.dist - s.d;
    if (remaining < 20 && s.off < 40) {
      play.arrive();
      this.onArrive();
      return;
    }

    // turn cues (staged by time-to-turn, never stacking stages)
    const next = this.route.cues.find((c) => c.d > s.d - 5 && !this.fired.has(`${c.idx}:now`));
    if (next && !this.offRoute) {
      const dist = next.d - s.d;
      const stages = [['now', Math.max(12, 2 * v)], ['prepare', Math.max(45, 6 * v)], ['heads', Math.max(120, 14 * v)]];
      for (let k = 0; k < stages.length; k++) {
        const [name, thr] = stages[k];
        if (dist <= thr) {
          if (!this.fired.has(`${next.idx}:${name}`)) {
            name === 'heads' ? play.heads(next, fmtDist(dist)) : play[name](next);
          }
          stages.slice(k).forEach(([nm]) => this.fired.add(`${next.idx}:${nm}`));
          break;
        }
      }
    }

    // steep-descent warning ahead (once per 100 m block)
    const look = Math.max(80, 8 * v);
    for (let d = s.d; d < Math.min(s.d + look, this.route.dist); d += STEP) {
      if (gradeAt(this.a, d) < -settings.maxDown) {
        const key = `steep:${Math.floor(d / 100)}`;
        if (!this.fired.has(key)) {
          play.steep();
          for (let k = -1; k <= 3; k++) this.fired.add(`steep:${Math.floor(d / 100) + k}`);
        }
        break;
      }
    }

    this.next = next;
    this.onUpdate({
      p, accuracy, off: s.off, progress: s.d, remaining, speed: this.speed,
      grade: gradeAt(this.a, s.d), next, nextDist: next ? next.d - s.d : null, offRoute: this.offRoute,
    });
  }

  /** Bearing the rider should face: toward the next turn if close, else ~30 m ahead on route. */
  targetBearing() {
    if (!this.pos) return null;
    if (this.next && this.next.d - this.progress < 60) return bearing(this.pos, [this.next.lat, this.next.lon]);
    const pts = this.route.pts, want = this.progress + 30;
    let i = this.seg;
    while (i < pts.length - 1 && pts[i].d < want) i++;
    return bearing(this.pos, [pts[i].lat, pts[i].lon]);
  }
}
