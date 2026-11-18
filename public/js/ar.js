// AR heads-up view: camera passthrough with a world-locked arrow toward where to ride.
let video, stream, raf, compassHeading = null, getTarget, getInfo;

function onOrient(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading; // iOS: already true-north-ish
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  const screenAngle = screen.orientation?.angle ?? window.orientation ?? 0;
  compassHeading = (h + screenAngle + 360) % 360;
}

export async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
    try { await DeviceOrientationEvent.requestPermission(); } catch { /* user declined */ }
  }
  window.addEventListener('deviceorientationabsolute', onOrient);
  window.addEventListener('deviceorientation', onOrient);
}

export const heading = () => compassHeading;

export async function openAR(target, info) {
  getTarget = target;
  getInfo = info;
  const el = document.getElementById('ar');
  video = el.querySelector('video');
  el.hidden = false;
  await requestOrientationPermission();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = stream;
  } catch {
    video.removeAttribute('src'); // no camera: plain dark HUD still works
  }
  loop();
}

export function closeAR() {
  cancelAnimationFrame(raf);
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  document.getElementById('ar').hidden = true;
}

function loop() {
  const arrow = document.getElementById('ar-arrow');
  const { bearing: tb, gpsHeading, label } = getTarget() || {};
  const h = gpsHeading ?? compassHeading;
  if (tb != null && h != null) {
    const rel = ((tb - h + 540) % 360) - 180;
    arrow.style.transform = `rotate(${rel}deg)`;
    arrow.classList.toggle('ar-on-track', Math.abs(rel) < 20);
    arrow.hidden = false;
  } else {
    arrow.hidden = true;
  }
  document.getElementById('ar-label').textContent = label || (h == null ? 'Calibrating compass… wave phone in a figure-8' : '');
  document.getElementById('ar-info').innerHTML = getInfo();
  raf = requestAnimationFrame(loop);
}
