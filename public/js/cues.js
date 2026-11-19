// Eyes-free cue language: chimes (stereo-panned toward the turn side) + vibration.
//   LEFT  = 2 pulses   RIGHT = 3 pulses   (short pulses = slight/keep, long = sharp)
//   U-turn = 4 pulses · Roundabout = 1 long + one short per exit
//   Turn NOW = one long buzz · Steep ahead = rapid ticks · Off route = low double drone
import { settings } from './util.js';

let ctx;
export function unlockAudio() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  // iOS: a silent buffer inside the gesture keeps the context alive
  const b = ctx.createBufferSource();
  b.buffer = ctx.createBuffer(1, 1, 22050);
  b.connect(ctx.destination);
  b.start();
}

function tone(freq, start, dur, { pan = 0, type = 'sine', vol = 0.35 } = {}) {
  if (!ctx) return;
  const t = ctx.currentTime + start;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o.connect(g);
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    node = node.connect(p);
  }
  node.connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

/** Pulses: array of [ms on, ms off]. Plays the same rhythm as audio + vibration. */
function pulses(seq, { freq = 880, pan = 0, type = 'sine', glide = 0 } = {}) {
  let t = 0;
  const vib = [];
  seq.forEach(([on, off], i) => {
    tone(freq + glide * i, t / 1000, on / 1000, { pan, type });
    vib.push(on, off);
    t += on + off;
  });
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(vib);
}

function say(text) {
  if (!settings.voice || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  speechSynthesis.speak(u);
}

const sidePan = (side) => (side === 'left' ? -0.9 : side === 'right' ? 0.9 : 0);
const pulseLen = (strength) => (strength === 'slight' ? 70 : strength === 'sharp' ? 220 : 130);

function turnSeq(cue) {
  const on = pulseLen(cue.strength);
  if (cue.dir === 'roundabout') return [[450, 150], ...Array.from({ length: Math.max(1, cue.exit || 1) }, () => [90, 110])];
  const n = cue.dir === 'uturn' ? 4 : cue.side === 'left' ? 2 : 3;
  return Array.from({ length: n }, () => [on, 110]);
}

export function describe(cue) {
  if (cue.dir === 'roundabout') return `Roundabout, exit ${cue.exit || 1}`;
  if (cue.dir === 'uturn') return 'Make a U-turn';
  return `${cue.strength === 'slight' ? 'Bear' : cue.strength === 'sharp' ? 'Sharp' : 'Turn'} ${cue.side}`;
}

export const play = {
  /** ~12 s before a turn: one soft chime on the turn side. */
  heads(cue, distText) {
    tone(660, 0, 0.25, { pan: sidePan(cue.side), vol: 0.2 });
    if (settings.vibrate && navigator.vibrate) navigator.vibrate(60);
    say(`${describe(cue)} in ${distText}`);
  },
  /** ~5 s before: the direction pattern. */
  prepare(cue) {
    pulses(turnSeq(cue), { freq: cue.side === 'left' ? 587 : 880, pan: sidePan(cue.side) });
    say(describe(cue));
  },
  /** At the turn. */
  now(cue) {
    pulses([[420, 0]], { freq: cue.side === 'left' ? 523 : 784, pan: sidePan(cue.side), type: 'triangle' });
  },
  steep() {
    pulses(Array.from({ length: 6 }, () => [45, 55]), { freq: 1400, type: 'square', glide: -80 });
    say('Steep section ahead, check your speed');
  },
  offRoute() {
    pulses([[320, 160], [320, 0]], { freq: 220, type: 'sawtooth' });
    tone(233, 0, 0.8, { type: 'sawtooth', vol: 0.15 });
    say('Off route, recalculating');
  },
  backOnRoute() {
    pulses([[90, 40], [160, 0]], { freq: 660, glide: 220 });
  },
  arrive() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.35, { vol: 0.3 }));
    if (settings.vibrate && navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 400]);
    say('You have arrived');
  },
};
