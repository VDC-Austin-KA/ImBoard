// Bundles public/ into a single Worker script (dist/worker.js) so deploys need only the script-upload API.
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('../public/', import.meta.url).pathname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.brf': 'text/plain; charset=utf-8',
};
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const files = {};
for (const f of walk(ROOT)) {
  const type = TYPES[extname(f)];
  if (!type) continue; // skips _headers etc.
  const buf = readFileSync(f);
  files['/' + relative(ROOT, f)] = { type, b64: buf.toString('base64'), etag: createHash('sha1').update(buf).digest('hex').slice(0, 16) };
}
const worker = `const FILES = ${JSON.stringify(files)};
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(self), camera=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self)',
  'X-Frame-Options': 'DENY',
};
const decoded = new Map();
export default {
  fetch(req) {
    const url = new URL(req.url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    let path = url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname;
    if (!FILES[path]) path = '/index.html';
    const f = FILES[path];
    const etag = '"' + f.etag + '"';
    const revalidate = path.endsWith('.html') || path === '/sw.js';
    const headers = { ...HEADERS, 'Content-Type': f.type, ETag: etag, 'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600' };
    if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers });
    if (!decoded.has(path)) decoded.set(path, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    return new Response(req.method === 'HEAD' ? null : decoded.get(path), { headers });
  },
};
`;
mkdirSync(new URL('../dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('../dist/worker.js', import.meta.url), worker);
console.log(`Bundled ${Object.keys(files).length} files, ${(worker.length / 1024).toFixed(0)} KiB`);
