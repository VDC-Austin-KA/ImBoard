# ImBoard — longboard route planner

Live at **https://board.ackerworks.com** (Cloudflare Worker `board`; `scripts/build-worker.mjs` bundles `public/` into the script).

A mobile-first map app (installable PWA) for planning smooth, low-effort longboard rides.

## Features
- **Longboard-aware routing** — [BRouter](https://brouter.de) with a custom profile (`public/longboard.brf`) that
  penalises climbing, descents steeper than the rider's skill level, rough/unpaved surfaces and busy roads.
  Alternatives are fetched and ranked by a **downhill-first ride score**: green sweet-spot downhill earns the most,
  a little yellow (fast) is fine, flat (blue) costs points, and a **coast simulation** (gravity, rolling resistance,
  drag, momentum carried through short flats) measures how much of the ride you'd have to kick. Cards show "% kick-free".
- **Cruise suggestions** — scouts terrain in 12 directions (and nearby skateparks) for destinations with a gentle
  average downhill, routes the best candidates and shows the top 3.
- **Topography** — Topographic base map, Esri hillshade, and a client-side **terrain steepness** overlay
  computed from AWS Terrarium elevation tiles (green < 5 %, yellow < 8 %, orange < 12 %, red steeper).
- **Contours, elevation shading & hilltops** — client-side contour lines (marching squares), a hillshaded
  elevation tint scaled to the elevations in view, and ▲/▼ markers for local hilltops and low points.
- **Area route finder** — "Best runs in this map view" starts from hilltops / high ground anywhere in the view
  and finds the best downhill runs of the chosen length (short / medium / long). If you're not at the start,
  ride mode first guides you there.
- **Skill levels** — Beginner (≤ 4 %), Intermediate (≤ 7 %), Advanced (≤ 10 %), Expert (≤ 14 %) set the target
  average grade runs aim for, how routes are graded, and when steep-section warnings fire.
- **Loop runs (park & ride)** — finish near the start: the finder picks an end point within walking distance and
  well below the start (a steep slope), routes a longer, gentle ride out via a mid-elevation point and back down to it,
  then routes the walk back up with a hiking profile (shown as yellow dots, with distance and climb).
- **Directions to start** — opens Google Maps directions to the selected run's first point.
- **Austin pavement intel** (City of Austin open ArcGIS data): street condition grades A–F, completed
  overlays ("fresh asphalt") and seal coats with dates, and the FY27 resurfacing plan. Routes inside Austin are
  re-scored by the pavement they ride on. Roads under construction come from OpenStreetMap everywhere.
- **"Here" terrain profile** — elevation, a 16-direction slope rose and a 500 m profile ahead of your heading.
- **Elevation profile** of each route, colour-coded by grade; drag across it to inspect any point on the map.
- **Skateparks** from OpenStreetMap (Overpass), ranked by a popularity heuristic (named, wiki/website, lit, concrete…).
- **Eyes-free ride mode** — staged chime + vibration cues before each turn (2 pulses = left, 3 = right, panned to
  that ear), "turn now" buzz, steep-section speed warnings, off-route detection with automatic reroute,
  optional voice, screen wake-lock and a black **pocket mode**.
- **AR heads-up view** — camera passthrough with a compass-locked arrow toward the route (or toward the
  gentlest downhill when no route is active).

> iPhone Safari has no Vibration API: cues play as stereo chimes (headphones recommended).

## Develop
No build step. Serve `public/` with any static server:
```sh
cd public && python3 -m http.server 8787
```
Geolocation, camera and compass need HTTPS (or `localhost`).

## Deploy
```sh
node scripts/build-worker.mjs && npx wrangler deploy
```
`wrangler.toml` binds the custom domain `board.ackerworks.com`. Bump `CACHE` in `public/sw.js` when shipping
changes so installed PWAs pick them up.

## Data & credits
© OpenStreetMap contributors · BRouter · OpenTopoMap · CyclOSM · Esri hillshade · Mapzen/AWS Terrain Tiles ·
Nominatim search · City of Austin Open Data (Transportation & Public Works) · Leaflet. All free/community services — please keep request volumes modest.
