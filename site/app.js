/* Sodwana Bay bathymetry web app — dependency-free (MapLibre GL v5 global + maplibre-contour).
 * No API keys, no build step. Loads local terrarium raster-dem tiles when present.
 * Depth convention: seafloor negative metres. */

import {
  haversineKm, bearingDeg, totalKm, routeLegs,
  ACCURACY_BANDS, bandForDepth, sampleRouteProfile, formatRouteReport,
} from './route.js';

const AOI = { lonMin: 32.62, lonMax: 32.82, latMin: -27.62, latMax: -27.32 };
const CENTER = [(AOI.lonMin + AOI.lonMax) / 2, (AOI.latMin + AOI.latMax) / 2];

/* ============================================================
 * DESIGN TOKENS — single source of truth for layer colours.
 * These mirror the CSS custom properties in index.html. Change
 * here + there together for the categorical (site/reef/track/etc.)
 * colours; the depth ramp below is a special case — see its comment.
 * ========================================================== */
const C = {
  // Depth ramp for isobaths (blue -> cyan). Shares the -60/-30/-10 mid stops
  // with style.json's color-relief DEM ramp, but the endpoints differ ON
  // PURPOSE, not by drift: CGS isobaths only span 0..-95 m (vs. the DEM's
  // full -120..0 m range), so anchoring at -95 uses the ramp's full contrast
  // over the data that actually exists; and the 0 m stop is pale cyan
  // (#aef2ff) rather than style.json's pure white so isobath lines/labels
  // stay legible drawn over the map instead of disappearing into glare.
  // index.html's --depth-* legend tokens are a third, separately-tuned copy
  // (legend swatch legibility against the dark panel) — if you change the
  // core blue/cyan hues, update all three, but don't force the endpoints
  // to match; they're context-specific by design.
  depth: [[-95, '#02103f'], [-60, '#001f7a'], [-30, '#0077ff'], [-10, '#00e5ff'], [0, '#aef2ff']],
  site: '#ffd400', siteUnverified: '#ff9f6b',
  reefProminent: '#c1440e', reef: '#e8722c', reefScattered: '#f2b134',
  sedCoarse: '#b9a67d', sedSand: '#e3d7b4',
  track: '#63e6c0', prospect: '#ff5db1', prospectOk: '#4dff88', entry: '#5ad1ff',
  ink: '#dfeaff', inkDim: '#8fb3e0', halo: '#0a1830', edge: '#0a1424',
  accent: '#00e5ff', // mirrors --accent in index.html's :root
};
// depth_m -> colour interpolation expression, reused by isobaths (and available to future depth layers)
function depthRamp(prop) {
  const expr = ['interpolate', ['linear'], ['get', prop]];
  for (const [d, c] of C.depth) expr.push(d, c);
  return expr;
}

/* ============================================================
 * LAYER REGISTRY — drives sidebar toggle rendering, wiring, and
 * the admin visitor-visibility picker. One list, no duplication.
 * ========================================================== */
const LAYER_DEFS = [
  { key: '3d',        label: '3D terrain',             def: false, kind: 'terrain' },
  { key: 'fusion1',   label: 'Fusion1 model (0–300 m)', def: false, kind: 'demswap', sw: '#00e5ff' },
  { key: 'relief',    label: 'Depth colour',           def: true,  sw: 'var(--depth-30)' },
  { key: 'hill',      label: 'Hillshade',              def: true,  sw: '#8aa0bf' },
  { key: 'contour',   label: 'Contours',               def: true,  sw: '#bfe9ff' },
  { key: 'sites',     label: 'Dive sites',             def: true,  sw: 'var(--c-site)' },
  { key: 'tracks',    label: 'ICESat-2 tracks',        def: false, sw: 'var(--c-track)' },
  { key: 'prospects', label: 'Prospect leads',         def: false, sw: 'var(--c-prospect)' },
  { key: 'geology',   label: 'Seafloor geology (CGS)', def: true,  sw: 'var(--c-reef)' },
  { key: 'isobaths',  label: 'CGS isobaths',           def: true,  sw: 'var(--depth-10)' },
  { key: 'entries',   label: 'Dive entry points',      def: false, sw: 'var(--c-entry)' },
  { key: 'measure',   label: 'Measure distance',       def: false, kind: 'measure' },
  { key: 'route',     label: 'Plan route',             def: false, kind: 'route' },
  { key: 'scale',     label: 'Scale bar',              def: true,  kind: 'scale' },
];
// which map layers each toggle key controls
const VIS = {
  relief: ['color-relief'], hill: ['hillshade'],
  contour: ['contour-lines', 'contour-labels'],
  sites: ['sites-dot', 'sites-label'], tracks: ['tracks-line'],
  prospects: ['prospects-dot'], geology: ['geology-fill', 'geology-line'],
  isobaths: ['isobath-line', 'isobath-label'], entries: ['entries-dot'],
};

/* ============================================================
 * ADMIN AUTH (client-side only — static $0 site, no backend).
 * ADMIN_HASH is the SHA-256 of the admin password. Default password
 * is "sodwana" — CHANGE IT by regenerating the hash. In a browser
 * console or Node:
 *   (async p => [...new Uint8Array(await crypto.subtle.digest(
 *     'SHA-256', new TextEncoder().encode(p)))]
 *     .map(x => x.toString(16).padStart(2,'0')).join(''))('YOUR-PASSWORD')
 * Paste the result below and commit. Only the hash lives in the repo;
 * the password itself is never stored anywhere.
 * ========================================================== */
const ADMIN_HASH = 'daca69b7c5b72a8a68a5884a118d3176593827173a232f1c284eeeb5a0d6b50a';
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/* ---------- app state ---------- */
const state = {
  map: null,
  sites: fc([]),            // master dive-site FeatureCollection (edited in-memory by admin)
  layerConfig: {},          // key -> visitor-visible bool (from data/layer_config.json)
  toggleState: {},          // key -> checked bool (live UI state, survives re-render)
  adminMode: false,
  previewAsVisitor: false,  // admin-only: simulate the visitor view without logging out
  scaleControl: null,       // maplibregl.ScaleControl instance, so we can show/hide its DOM element
  demSource: null,          // maplibre-contour DemSource (also used to sample route depth profiles)
  demSourceF1: null,        // maplibre-contour DemSource for the Fusion1 DEM (deep contours)
  activeDem: 'terrain-dem', // which raster-dem drives relief/hillshade/3D ('terrain-dem' | 'fusion1-dem')
  fusion1: false,           // Fusion1 (0–300 m) DEM mode active?
  lastRoute: null,          // { wp, legsResult, profile } — last confirmed route, for summary export
  selectedSiteIds: new Set(), // admin: site.properties.id values checked for "export selected"
  expandedSiteId: null,       // admin: which site row's edit form is open (one at a time)
};
LAYER_DEFS.forEach((d) => { state.toggleState[d.key] = d.def; });

/* ---------- boot ---------- */
function bootstrap() {
  if (!window.maplibregl) { setTimeout(bootstrap, 60); return; }
  start();
}
window.__mlReady = bootstrap;
bootstrap();

async function start() {
  const h = location.hash.replace(/^#/, '').split('/').map(Number);
  const startView = (h.length === 3 && h.every(Number.isFinite))
    ? { zoom: h[0], center: [h[2], h[1]] }
    : { zoom: 11.5, center: CENTER };

  const map = new maplibregl.Map({
    container: 'map', style: 'style.json',
    center: startView.center, zoom: startView.zoom,
    maxBounds: [[AOI.lonMin - 0.3, AOI.latMin - 0.3], [AOI.lonMax + 0.3, AOI.latMax + 0.3]],
    hash: false,
  });
  state.map = map;
  window.__mlmap = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  state.scaleControl = new maplibregl.ScaleControl({ unit: 'metric' });
  map.addControl(state.scaleControl, 'bottom-left');
  map.on('error', (e) => console.warn('map resource issue (non-fatal):', e && e.error && e.error.message));

  wireSidebarCollapse();
  wireSectionCollapse();
  wireLegendCollapse();
  map.on('load', async () => {
    await onLoad(map);
    updateHash(map);
    map.on('moveend', () => updateHash(map));
  });
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y };
}

async function onLoad(map) {
  const zc = 12, tc = lonLatToTile(CENTER[0], CENTER[1], zc);
  const tilesPresent = await head(`tiles/xyz/${zc}/${tc.x}/${tc.y}.png`);
  document.getElementById('data-note').innerHTML = tilesPresent
    ? 'DEM tiles loaded.'
    : '⚠ DEM tiles not built yet — run <code>pipeline/07_make_tiles.py</code>. Basemap, markers &amp; tools still work.';

  // visitor layer availability (missing file / missing key => visible)
  state.layerConfig = (await getJSON('data/layer_config.json')) || {};

  await setupContours(map);
  await loadVector(map, 'data/cgs_geology.geojson', 'geology', geologyStyle);
  await loadVector(map, 'data/cgs_isobaths.geojson', 'isobaths', isobathStyle);
  await loadVector(map, 'data/dive_entries.geojson', 'entries', entryStyle);
  await loadSites(map);
  await loadVector(map, 'data/icesat2_tracks.geojson', 'tracks', trackStyle);
  await loadVector(map, 'data/prospects.geojson', 'prospects', prospectStyle);

  state.adminMode = sessionStorage.getItem('sb-admin') === '1';
  renderToggles(map);
  wireCoordinates(map);
  initMeasure(map);
  initRoute(map);
  wireRouteButtons(map);
  wireAdmin(map);
}

/* ---------- terrain / 3D ---------- */
function set3D(map, on, ex) {
  const dem = state.activeDem || 'terrain-dem';
  if (on) { if (!map.getSource(dem)) return; map.setTerrain({ source: dem, exaggeration: ex }); }
  else { map.setTerrain(null); }
}

/* ---------- contours ---------- */
async function setupContours(map) {
  if (!map.getSource('terrain-dem')) return;
  let mlcontour;
  try { mlcontour = (await import('./vendor/index.mjs')).default; }
  catch {
    try { mlcontour = (await import('https://unpkg.com/maplibre-contour@0.1.0/dist/index.mjs')).default; }
    catch (e) { console.warn('maplibre-contour unavailable; contours disabled', e); return; }
  }
  const tilesBase = new URL('tiles/xyz/', location.href).href;
  // Kept on state (not a local) so the Plan Route tool can reuse it to sample
  // the fused DEM along a route (route.js sampleRouteProfile -> getDemTile).
  state.demSource = new mlcontour.DemSource({ url: tilesBase + '{z}/{x}/{y}.png', encoding: 'terrarium', maxzoom: 15, worker: true });
  state.demSource.setupMaplibre(maplibregl);
  map.addSource('contour-src', {
    type: 'vector',
    tiles: [state.demSource.contourProtocolUrl({
      thresholds: { 11: [10, 50], 13: [2, 10], 15: [1, 5] },
      elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
    })],
    maxzoom: 15,
    bounds: [AOI.lonMin, AOI.latMin, AOI.lonMax, AOI.latMax],
  });
  map.addLayer({
    id: 'contour-lines', type: 'line', source: 'contour-src', 'source-layer': 'contours',
    paint: { 'line-color': '#bfe9ff', 'line-opacity': ['match', ['get', 'level'], 1, 0.9, 0.35], 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] },
  });
  map.addLayer({
    id: 'contour-labels', type: 'symbol', source: 'contour-src', 'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    layout: { 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 },
    paint: { 'text-color': '#eafaff', 'text-halo-color': '#0a1830', 'text-halo-width': 1.2 },
  });

  // Fusion1 deep contours (0 → -300 m) — shown only when the Fusion1 DEM is active.
  try {
    const f1Base = new URL('tiles_fusion1/xyz/', location.href).href;
    state.demSourceF1 = new mlcontour.DemSource({ url: f1Base + '{z}/{x}/{y}.png', encoding: 'terrarium', maxzoom: 15, worker: true });
    state.demSourceF1.setupMaplibre(maplibregl);
    map.addSource('fusion1-contour-src', {
      type: 'vector',
      tiles: [state.demSourceF1.contourProtocolUrl({
        thresholds: { 10: [50, 100], 12: [20, 100], 14: [10, 50], 15: [5, 25] },
        elevationKey: 'ele', levelKey: 'level', contourLayer: 'contours',
      })],
      maxzoom: 15,
      bounds: [AOI.lonMin, AOI.latMin, AOI.lonMax, AOI.latMax],
    });
    map.addLayer({
      id: 'fusion1-contour-lines', type: 'line', source: 'fusion1-contour-src', 'source-layer': 'contours',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#bfe9ff', 'line-opacity': ['match', ['get', 'level'], 1, 0.9, 0.35], 'line-width': ['match', ['get', 'level'], 1, 1.1, 0.5] },
    });
    map.addLayer({
      id: 'fusion1-contour-labels', type: 'symbol', source: 'fusion1-contour-src', 'source-layer': 'contours',
      filter: ['>', ['get', 'level'], 0],
      layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['concat', ['number-format', ['get', 'ele'], {}], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 10 },
      paint: { 'text-color': '#eafaff', 'text-halo-color': '#0a1830', 'text-halo-width': 1.2 },
    });
  } catch (e) { console.warn('Fusion1 contours unavailable', e); }
}

/* ---------- vector overlays ---------- */
async function loadVector(map, url, id, styler, after) {
  const gj = await getJSON(url);
  if (!gj) return;
  map.addSource(id, { type: 'geojson', data: gj });
  styler(map, id);
  if (after) after(map, gj);
}

// Substrate fill reads as an accent ON the depth colour, not a wash OVER it: reef classes
// (the diagnostically useful "where's the actual reef" signal) get a saturated, zoom-growing
// fill; Sand/Coarse Shelly Sediment (the "nothing to see here" substrate that just repeats
// what the pale depth colour already implies) get a near-transparent wash so they don't mud
// the blue-cyan ramp underneath. An unrecognised class renders invisible (no grey fallback
// wash) rather than a muddy default.
function geologyStyle(map, id) {
  const fillOpacity = ['match', ['get', 'geology'],
    'Prominent Reef', ['interpolate', ['linear'], ['zoom'], 9, 0.22, 12, 0.4, 15, 0.55],
    'Reef', ['interpolate', ['linear'], ['zoom'], 9, 0.18, 12, 0.34, 15, 0.48],
    'Scattered Reef', ['interpolate', ['linear'], ['zoom'], 9, 0.14, 12, 0.26, 15, 0.38],
    'Coarse Shelly Sediment', ['interpolate', ['linear'], ['zoom'], 9, 0.03, 14, 0.1],
    'Sand', ['interpolate', ['linear'], ['zoom'], 9, 0.02, 14, 0.07],
    0];
  map.addLayer({
    id: 'geology-fill', type: 'fill', source: id,
    paint: {
      'fill-opacity': fillOpacity,
      'fill-color': ['match', ['get', 'geology'],
        'Prominent Reef', C.reefProminent, 'Reef', C.reef, 'Scattered Reef', C.reefScattered,
        'Coarse Shelly Sediment', C.sedCoarse, 'Sand', C.sedSand, 'transparent'],
    },
  });
  // Reef-class boundaries get a visible glow line (the actionable edges divers care about);
  // sediment classes get a hairline only, present but not competing with the depth contours.
  map.addLayer({ id: 'geology-line', type: 'line', source: id,
    paint: {
      'line-color': ['match', ['get', 'geology'],
        'Prominent Reef', C.reefProminent, 'Reef', C.reef, 'Scattered Reef', C.reefScattered, '#00121f'],
      'line-width': ['match', ['get', 'geology'],
        'Prominent Reef', 0.9, 'Reef', 0.7, 'Scattered Reef', 0.5, 0.25],
      'line-opacity': ['match', ['get', 'geology'],
        'Prominent Reef', 0.85, 'Reef', 0.7, 'Scattered Reef', 0.55, 0.3],
    } });
  map.on('click', 'geology-fill', (e) => {
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>CGS substrate</b><br>${esc(e.features[0].properties.geology)}`).addTo(map);
  });
}

function isobathStyle(map, id) {
  // CGS 2005 survey isobaths — coloured by depth on the shared blue->cyan scale.
  // Multiples of 25 m drawn thicker as index contours.
  map.addLayer({ id: 'isobath-line', type: 'line', source: id,
    paint: {
      'line-color': depthRamp('depth_m'),
      'line-width': ['case', ['==', ['%', ['get', 'depth_m'], 25], 0], 1.5, 0.7],
      'line-opacity': 0.85,
    } });
  map.addLayer({
    id: 'isobath-label', type: 'symbol', source: id,
    layout: { 'symbol-placement': 'line', 'symbol-spacing': 220,
      'text-field': ['concat', ['to-string', ['get', 'depth_m']], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 9 },
    paint: { 'text-color': '#eafaff', 'text-halo-color': '#04263a', 'text-halo-width': 1.6 },
  });
}

function entryStyle(map, id) {
  map.addLayer({ id: 'entries-dot', type: 'circle', source: id, layout: { visibility: 'none' },
    paint: { 'circle-radius': 3, 'circle-color': C.entry, 'circle-opacity': 0.35, 'circle-stroke-color': C.halo, 'circle-stroke-width': 0.4 } });
}

function trackStyle(map, id) {
  map.addLayer({ id: 'tracks-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: { 'line-color': C.track, 'line-width': 1, 'line-opacity': 0.7 } });
}

function prospectStyle(map, id) {
  map.addLayer({
    id: 'prospects-dot', type: 'circle', source: id, layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 4, 10, 11],
      'circle-color': ['case', ['==', ['get', 'cgs_corroborated'], true], C.prospectOk, C.prospect],
      'circle-opacity': 0.6, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1,
    },
  });
  map.on('click', 'prospects-dot', (e) => prospectPopup(map, e.features[0]));
  map.on('mouseenter', 'prospects-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'prospects-dot', () => (map.getCanvas().style.cursor = ''));
}

/* ---------- dive sites (admin-editable) ---------- */
async function loadSites(map) {
  const gj = await getJSON('data/dive_sites.geojson');
  state.sites = gj || fc([]);
  ensureSiteIds();
  map.addSource('sites', { type: 'geojson', data: sitesForDisplay() });
  diveSiteStyle(map, 'sites');
  applySites(map);
}
// Every site gets a stable client-side id (not just its array index, which shifts on
// import/delete) so the "export selected" checkbox state survives a re-render.
function ensureSiteIds() {
  (state.sites.features || []).forEach((f) => {
    if (!f.properties.id) f.properties.id = genId();
  });
}
function genId() { return 'site_' + Math.random().toString(36).slice(2, 10); }
// visitors never see features flagged hidden:true; admin sees everything
// (unless previewing as a visitor — see isEffectiveAdmin())
function sitesForDisplay() {
  const feats = (state.sites.features || []).filter((f) => isEffectiveAdmin() || f.properties.hidden !== true);
  return fc(feats);
}
function applySites(map) {
  if (map.getSource('sites')) map.getSource('sites').setData(sitesForDisplay());
  buildSiteList(map);
}

function diveSiteStyle(map, id) {
  map.addLayer({
    id: 'sites-dot', type: 'circle', source: id,
    paint: {
      'circle-radius': 5,
      'circle-color': ['case', ['==', ['get', 'verified'], false], C.siteUnverified, C.site],
      'circle-opacity': ['case', ['==', ['get', 'hidden'], true], 0.4, 1],
      'circle-stroke-color': C.halo, 'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'sites-label', type: 'symbol', source: id,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
      'text-offset': [0, 1.1], 'text-anchor': 'top',
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': C.halo, 'text-halo-width': 1.2 },
  });
  map.on('click', 'sites-dot', (e) => sitePopup(map, e.features[0]));
  map.on('mouseenter', 'sites-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'sites-dot', () => (map.getCanvas().style.cursor = ''));
}

/* ---------- popups ---------- */
function sitePopup(map, f) {
  const p = f.properties, [lon, lat] = f.geometry.coordinates;
  const depth = (p.depth_min_m != null) ? `${p.depth_min_m} to ${p.depth_max_m} m` : '—';
  const unver = (p.verified === false || p.verified === 'false');
  const dives = (p.n_dives) ? `<br>${p.n_dives} logged dive(s)` : '';
  const alt = (p.alt_names) ? `<br><small>also: ${esc(p.alt_names)}</small>` : '';
  const html = `<b>${esc(p.name)}</b>${unver ? ' <i style="color:#ff9f6b">(unverified)</i>' : ''}<br>
    Depth: ${depth}${dives}${alt}<br>${p.description ? esc(p.description) + '<br>' : ''}
    <code>${lat.toFixed(5)}, ${lon.toFixed(5)}</code><br>
    <button onclick="navigator.clipboard.writeText('${lat.toFixed(6)}, ${lon.toFixed(6)}')">Copy decimal</button>
    <button onclick="navigator.clipboard.writeText('${ddm(lat, lon)}')">Copy DDM</button>
    <button onclick="window.open('https://www.google.com/maps?q=${lat},${lon}','_blank')">Google Maps</button>`;
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat([lon, lat]).setHTML(html).addTo(map);
}

function prospectPopup(map, f) {
  const p = f.properties, [lon, lat] = f.geometry.coordinates;
  const sub = p.cgs_substrate ? `<br>CGS substrate: <b>${esc(p.cgs_substrate)}</b>` : '';
  const html = `<b>Prospect lead #${p.rank ?? '?'}</b> · score ${p.score}<br>
    ~${p.mean_depth_m} m · ${p.km_from_known_site} km from nearest known site${sub}<br>
    <i>${esc(p.confidence || 'lead — ground-truth before diving')}</i><br>
    <code>${lat.toFixed(5)}, ${lon.toFixed(5)}</code><br>
    <button onclick="navigator.clipboard.writeText('${ddm(lat, lon)}')">Copy DDM</button>`;
  new maplibregl.Popup({ maxWidth: '260px' }).setLngLat([lon, lat]).setHTML(html).addTo(map);
}

/* ---------- reef sidebar list ---------- */
function buildSiteList(map) {
  const ul = document.getElementById('site-list');
  ul.innerHTML = '';
  (sitesForDisplay().features || []).forEach((f) => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const li = document.createElement('li');
    if (p.verified === false) li.className = 'unverified';
    const depth = (p.depth_min_m != null) ? `${p.depth_min_m}–${p.depth_max_m} m` : '';
    li.innerHTML = `<span class="nm">${esc(p.name)}</span><span class="d">${depth}</span>`;
    li.onclick = () => {
      map.flyTo({ center: [lon, lat], zoom: 14, pitch: 60, bearing: -20, duration: 2000 });
      const t3 = document.getElementById('t-3d');
      if (t3 && !t3.checked) { t3.checked = true; state.toggleState['3d'] = true; set3D(map, true, exVal()); syncEx(); }
      setTimeout(() => sitePopup(map, f), 2100);
    };
    ul.appendChild(li);
  });
}

/* ============================================================
 * SIDEBAR TOGGLES — rendered from LAYER_DEFS + layerConfig.
 * ========================================================== */
function renderToggles(map) {
  // #exwrap (the 3D exaggeration slider) is a STATIC sibling in index.html —
  // it sits between #toggle-3d and #toggles and is never appended/moved here,
  // so clearing these two containers on re-render can never destroy it.
  // (Previously #exwrap was appendChild'd INTO #toggles, which meant the next
  // box.innerHTML='' deleted it and the following appendChild(getElementById
  // ('exwrap')) threw on null — that crash made renderToggles() non-
  // idempotent and broke the admin-unlock path. Keep #exwrap out of any
  // container this function clears.)
  const box3d = document.getElementById('toggle-3d');
  const box = document.getElementById('toggles');
  box3d.innerHTML = '';
  box.innerHTML = '';
  LAYER_DEFS.forEach((d) => {
    const visitorHidden = !isEffectiveAdmin() && state.layerConfig[d.key] === false;
    if (visitorHidden) return;
    const row = document.createElement('label');
    row.className = 'toggle';
    row.htmlFor = 't-' + d.key;
    const swatch = d.sw ? `<span class="sw" style="background:${d.sw}"></span>` : '<span class="sw" style="background:transparent;box-shadow:none"></span>';
    row.innerHTML = `<input type="checkbox" id="t-${d.key}">${swatch}<span>${d.label}</span>`;
    // 3D row renders into its own tiny container so the (static) exaggeration
    // slider that sits right after it in the markup stays visually attached.
    (d.key === '3d' ? box3d : box).appendChild(row);
    const cb = row.querySelector('input');
    cb.checked = !!state.toggleState[d.key];
    cb.onchange = () => applyToggle(map, d, cb.checked);
  });
  // apply current state to the map so re-renders don't desync visibility
  LAYER_DEFS.forEach((d) => applyToggle(map, d, !!state.toggleState[d.key], true));
  syncEx();
  wireEx(map);
}

function applyToggle(map, d, on, silent) {
  state.toggleState[d.key] = on;
  if (d.kind === 'terrain') {
    set3D(map, on, exVal());
    const ew = document.getElementById('exwrap');
    if (ew) ew.hidden = !on;
  } else if (d.kind === 'measure') {
    setMeasure(map, on);
  } else if (d.kind === 'route') {
    setRoute(map, on);
  } else if (d.kind === 'scale') {
    setScale(on);
  } else if (d.kind === 'demswap') {
    state.fusion1 = on;
    state.activeDem = on ? 'fusion1-dem' : 'terrain-dem';
    refreshDemLayers(map);
    if (state.toggleState['3d']) set3D(map, true, exVal());
  } else if (d.key === 'relief' || d.key === 'hill' || d.key === 'contour') {
    refreshDemLayers(map);
  } else {
    (VIS[d.key] || []).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  }
}

// Keep the depth-colour, hillshade and contour layers pointed at whichever DEM is
// active (baseline terrain-dem, or the Fusion1 0–300 m model), honouring each layer's
// own on/off toggle.
function refreshDemLayers(map) {
  const vis = (id, v) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', v ? 'visible' : 'none');
  const f = !!state.fusion1;
  const reliefOn = state.toggleState['relief'] !== false;
  const hillOn = state.toggleState['hill'] !== false;
  const contourOn = state.toggleState['contour'] !== false;
  vis('color-relief', !f && reliefOn); vis('fusion1-relief', f && reliefOn);
  vis('hillshade', !f && hillOn); vis('fusion1-hill', f && hillOn);
  // HD 5 m reef inset draws on top within its bounds when Fusion1 is active
  vis('fusion1hd-relief', f && reliefOn); vis('fusion1hd-hill', f && hillOn);
  vis('contour-lines', !f && contourOn); vis('contour-labels', !f && contourOn);
  vis('fusion1-contour-lines', f && contourOn); vis('fusion1-contour-labels', f && contourOn);
}

function exVal() { const el = document.getElementById('ex'); return el ? parseFloat(el.value) : 1.6; }
function syncEx() { const s = document.getElementById('exval'); if (s) s.textContent = exVal().toFixed(1) + '×'; }
function wireEx(map) {
  const ex = document.getElementById('ex');
  if (!ex || ex.__wired) return;
  ex.__wired = true;
  ex.oninput = () => { syncEx(); if (state.toggleState['3d']) set3D(map, true, exVal()); };
}

/* ---------- coordinate UX ---------- */
function wireCoordinates(map) {
  const cur = document.getElementById('cursor');
  map.on('mousemove', (e) => { cur.textContent = `lat ${e.lngLat.lat.toFixed(5)}, lon ${e.lngLat.lng.toFixed(5)}`; });
  let marker = null;
  map.on('click', (e) => {
    if (window.__measuring || window.__routing) return;
    const { lat, lng } = e.lngLat;
    if (marker) marker.remove();
    marker = new maplibregl.Marker({ color: C.accent }).setLngLat([lng, lat]).addTo(map);
    document.getElementById('clicked').innerHTML = `<code>${lat.toFixed(6)}, ${lng.toFixed(6)}</code><br>${ddm(lat, lng)}`;
    const btn = document.getElementById('copybtn');
    btn.hidden = false;
    btn.onclick = () => navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  });
}

/* ---------- distance measure ---------- */
function initMeasure(map) {
  const pts = [];
  const srcId = 'measure-src';
  window.__measureReset = () => { pts.length = 0; if (map.getSource(srcId)) map.getSource(srcId).setData(fc([])); };
  map.on('click', (e) => {
    if (!window.__measuring) return;
    pts.push([e.lngLat.lng, e.lngLat.lat]);
    if (!map.getSource(srcId)) {
      map.addSource(srcId, { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'measure-line', type: 'line', source: srcId, paint: { 'line-color': '#00e5ff', 'line-width': 2, 'line-dasharray': [2, 1] } });
      map.addLayer({ id: 'measure-pts', type: 'circle', source: srcId, filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#00e5ff' } });
    }
    const feats = pts.map((p) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: p } }));
    if (pts.length > 1) {
      feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts } });
      const dd = totalKm(pts), b = bearingDeg(pts[pts.length - 2], pts[pts.length - 1]);
      document.getElementById('clicked').innerHTML = `${(dd * 1000).toFixed(0)} m total · last leg bearing ${b.toFixed(0)}°`;
    }
    map.getSource(srcId).setData(fc(feats));
  });
}
function setMeasure(map, on) {
  window.__measuring = on;
  // Mutual exclusion: Measure and Plan Route are both global click-capture
  // modes; only one may be active. Turning Measure on forces Route off.
  if (on && window.__routing) {
    const rEntry = LAYER_DEFS.find((d) => d.key === 'route');
    const rcb = document.getElementById('t-route');
    if (rcb) rcb.checked = false;
    if (rEntry) applyToggle(map, rEntry, false);
  }
  if (!on && window.__measureReset) window.__measureReset();
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}

/* ---------- scale bar ---------- */
function setScale(on) {
  const el = document.querySelector('.maplibregl-ctrl-scale');
  if (el) el.style.display = on ? '' : 'none';
}

/* ============================================================
 * PLAN ROUTE — click a polyline of waypoints, sample the fused DEM
 * along it (route.js), and produce a dive-planning summary + report.
 * Mirrors the measure tool's structure: a global __routing flag, a
 * single click handler that only acts when routing, waypoints in a
 * module array, lazily-created GeoJSON source+layers, full setData()
 * redraw on every click. All depth logic lives in route.js.
 * ========================================================== */
let routeWp = []; // [lon,lat] waypoints in click order (module scope: shared by route fns)

function initRoute(map) {
  const srcId = 'route-src';
  window.__routingReset = () => {
    routeWp = [];
    if (map.getSource(srcId)) map.getSource(srcId).setData(fc([]));
    updateRouteHud();
  };
  map.on('click', (e) => {
    if (!window.__routing) return;
    routeWp.push([e.lngLat.lng, e.lngLat.lat]);
    rebuildRouteLayers(map, routeWp);
    updateRouteHud();
  });
}

function rebuildRouteLayers(map, wp) {
  const srcId = 'route-src';
  if (!map.getSource(srcId)) {
    map.addSource(srcId, { type: 'geojson', data: fc([]) });
    // Solid accent line — deliberately distinct from the measure tool's
    // dashed cyan (#00e5ff) line so the two modes never read as the same.
    map.addLayer({ id: 'route-line', type: 'line', source: srcId, filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': C.prospectOk, 'line-width': 3, 'line-opacity': 0.95 } });
    map.addLayer({ id: 'route-pts', type: 'circle', source: srcId, filter: ['==', '$type', 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': C.prospectOk, 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'route-num', type: 'symbol', source: srcId, filter: ['==', '$type', 'Point'],
      layout: { 'text-field': ['to-string', ['get', 'n']], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'text-offset': [0, -1.4] },
      paint: { 'text-color': '#eafaff', 'text-halo-color': C.halo, 'text-halo-width': 1.4 } });
  }
  const feats = wp.map((p, i) => ({ type: 'Feature', properties: { n: i + 1 }, geometry: { type: 'Point', coordinates: p } }));
  if (wp.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: wp } });
  map.getSource(srcId).setData(fc(feats));
}

function updateRouteHud() {
  const stats = document.getElementById('route-hud-stats');
  if (stats) stats.textContent = `${routeWp.length} point${routeWp.length === 1 ? '' : 's'} · ${Math.round(totalKm(routeWp) * 1000)} m`;
  const confirm = document.getElementById('route-confirm');
  if (confirm) confirm.disabled = routeWp.length < 2;
}

function setRoute(map, on) {
  window.__routing = on;
  const hud = document.getElementById('route-hud');
  const summary = document.getElementById('route-summary');
  if (on) {
    // Mutual exclusion: turning Route on forces Measure off.
    if (window.__measuring) {
      const mEntry = LAYER_DEFS.find((d) => d.key === 'measure');
      const mcb = document.getElementById('t-measure');
      if (mcb) mcb.checked = false;
      if (mEntry) applyToggle(map, mEntry, false);
    }
    if (hud) hud.classList.remove('hidden');
    if (summary) summary.classList.add('hidden');
    if (window.__routingReset) window.__routingReset(); // start clean
  } else {
    if (window.__routingReset) window.__routingReset();
    if (hud) hud.classList.add('hidden');
    if (summary) summary.classList.add('hidden');
  }
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
}

function wireRouteButtons(map) {
  const routeEntry = () => LAYER_DEFS.find((d) => d.key === 'route');
  const exitRoute = () => {
    const cb = document.getElementById('t-route');
    if (cb) cb.checked = false;
    applyToggle(map, routeEntry(), false);
  };
  const cancel = document.getElementById('route-cancel');
  if (cancel) cancel.onclick = () => exitRoute();
  const confirm = document.getElementById('route-confirm');
  if (confirm) confirm.onclick = async () => {
    if (routeWp.length < 2) return;
    await openRouteSummary(map, routeWp.slice());
  };
  const close = document.getElementById('route-summary-close');
  if (close) close.onclick = () => {
    document.getElementById('route-summary').classList.add('hidden');
    exitRoute(); // Close behaves like Cancel (per design), just after a summary was shown
  };
  const exportBtn = document.getElementById('route-summary-export');
  if (exportBtn) exportBtn.onclick = () => {
    if (!state.lastRoute) return;
    const { wp, legsResult, profile } = state.lastRoute;
    const ta = document.getElementById('route-export-text');
    ta.value = formatRouteReport(wp, legsResult, profile);
    ta.hidden = false;
    const copy = document.getElementById('route-export-copy');
    if (copy) copy.hidden = false;
  };
  const copyBtn = document.getElementById('route-export-copy');
  if (copyBtn) copyBtn.onclick = () => navigator.clipboard.writeText(document.getElementById('route-export-text').value);
}

async function openRouteSummary(map, wp) {
  const legsResult = routeLegs(wp);
  // sampleRouteProfile never throws (per route.js contract); a missing
  // demSource just yields all-null depths, not a crash.
  const profile = await sampleRouteProfile(state.demSource, wp);
  state.lastRoute = { wp: wp.slice(), legsResult, profile };

  const body = document.getElementById('route-summary-body');
  if (body) body.innerHTML = buildRouteSummaryHTML(wp, legsResult, profile);
  const ta = document.getElementById('route-export-text');
  if (ta) { ta.hidden = true; ta.value = ''; }
  const copy = document.getElementById('route-export-copy');
  if (copy) copy.hidden = true;

  document.getElementById('route-hud').classList.add('hidden');
  document.getElementById('route-summary').classList.remove('hidden');
}

// One depth reading (signed negative metres) with its confidence-band tag.
function depthReadingHTML(reading) {
  if (!reading || reading.depthM == null) return 'no data (land / outside coverage)';
  const b = reading.band;
  const tag = b ? ` <small style="color:var(--ink-faint)">${esc(b.label)} — ${esc(b.status)}</small>` : '';
  return `${reading.depthM.toFixed(1)} m${tag}`;
}

function buildRouteSummaryHTML(wp, legsResult, profile) {
  const stats = profile && profile.stats;
  const P = [];

  // Entry point (decimal + DDM, matching the coordinate-pin readout style)
  const [elon, elat] = wp[0];
  P.push('<div class="section-title" style="margin-top:0">Entry point</div>');
  P.push(`<div><code>${elat.toFixed(6)}, ${elon.toFixed(6)}</code><br>${ddm(elat, elon)}</div>`);

  // Waypoint list
  P.push(`<div class="section-title">Waypoints (${wp.length})</div>`);
  P.push('<ol style="margin:2px 0 0;padding-left:20px;font-variant-numeric:tabular-nums;">');
  wp.forEach((pt) => P.push(`<li><code>${pt[0].toFixed(6)}, ${pt[1].toFixed(6)}</code></li>`));
  P.push('</ol>');

  // Honesty warning banner when the route enters lower-confidence depth bands
  const crossed = (profile && profile.bandsCrossed) || [];
  if (crossed.includes('optical-wall') || crossed.includes('coarse')) {
    const bandObj = ACCURACY_BANDS.find((b) => b.key !== 'validated' && crossed.includes(b.key));
    const statusTxt = bandObj ? bandObj.status : 'lower confidence beyond 15 m';
    P.push(`<div style="margin-top:10px;padding:7px 9px;border:1px solid var(--c-prospect);border-radius:var(--radius-sm);background:#2a0e22;color:var(--ink);font-size:var(--fs-sm);">
      &#9888; This route passes deeper than 15 m. Depths beyond 15 m are lower-confidence — ${esc(statusTxt)}.</div>`);
  }

  // Depth profile chart
  P.push('<div class="section-title">Depth profile</div>');
  P.push(routeProfileSVG(profile));

  // Depth summary (signed negative values, each tagged with its band)
  P.push('<div class="section-title">Depth summary</div>');
  if (stats) {
    P.push('<div style="line-height:1.7;">');
    P.push(`Entry: ${depthReadingHTML(stats.entry)}<br>`);
    if (stats.max && stats.max.depthM != null) {
      P.push(`Deepest: ${depthReadingHTML(stats.max)} <small style="color:var(--ink-faint)">(at ${Math.round(stats.max.dM)} m along route)</small><br>`);
    } else {
      P.push('Deepest: no data (land / outside coverage)<br>');
    }
    P.push(`Average: ${stats.avg && stats.avg.depthM != null ? stats.avg.depthM.toFixed(1) + ' m' : 'no data (land / outside coverage)'}<br>`);
    P.push(`Exit: ${depthReadingHTML(stats.exit)}<br>`);
    P.push(`<small style="color:var(--ink-faint)">${stats.validCount}/${stats.sampleCount} samples had depth data</small>`);
    P.push('</div>');
  } else {
    P.push('<div class="note">No depth profile available.</div>');
  }

  // Per-leg breakdown
  const legs = (legsResult && legsResult.legs) || [];
  P.push('<div class="section-title">Legs</div>');
  if (legs.length) {
    P.push('<div style="font-variant-numeric:tabular-nums;line-height:1.6;">');
    legs.forEach((leg) => {
      P.push(`Leg ${leg.index}: heading ${String(Math.round(leg.bearingDeg)).padStart(3, '0')}°, distance ${Math.round(leg.distanceM)} m<br>`);
    });
    P.push(`<b>Total: ${Math.round(legsResult.totalM)} m (${(legsResult.totalM / 1000).toFixed(2)} km)</b>`);
    P.push('</div>');
  } else {
    P.push('<div class="note">Single point — no legs.</div>');
  }

  return P.join('');
}

/* Pure SVG string (no DOM/map dependency). X = distance along route,
 * Y = depth (0 at top, more negative lower). The plotted line BREAKS at
 * null-depth samples — one polyline per contiguous valid run, coloured by
 * the WORST (highest-uncertainty) band in that run so the chart never
 * overstates confidence. */
function routeProfileSVG(profile) {
  const W = 320, H = 168;
  const plotX0 = 40, plotX1 = 312, plotY0 = 12, plotY1 = 118;
  const samples = (profile && profile.samples) || [];
  const totalM = (profile && profile.totalM) || 0;
  let dataMin = 0;
  for (const s of samples) if (s.depthM != null && s.depthM < dataMin) dataMin = s.depthM;
  const yBottom = Math.min(-25, dataMin); // most-negative Y bound (at least -25 m)
  const xFor = (dM) => (totalM > 0 ? plotX0 + (dM / totalM) * (plotX1 - plotX0) : (plotX0 + plotX1) / 2);
  const yFor = (d) => plotY0 + (yBottom !== 0 ? (0 - d) / (0 - yBottom) : 0) * (plotY1 - plotY0);

  // Band -> colour. Cool for validated, warmer as confidence drops (caution
  // reads better than the near-invisible dark-blue end of --depth-* on the
  // dark panel). --depth-10 kept for the validated tier.
  const bandColor = { validated: 'var(--depth-10)', 'optical-wall': '#ffb020', coarse: '#ff5db1' };
  const bandIdx = (k) => ACCURACY_BANDS.findIndex((b) => b.key === k);

  const P = [];
  P.push(`<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;margin-top:4px;background:#0a1424;border:1px solid var(--edge);border-radius:6px;">`);

  // Y gridlines + labels at 0, -15, -25 (+ route max if deeper than -25)
  const ticks = [0, -15, -25];
  if (dataMin < -25) ticks.push(Math.round(dataMin));
  ticks.forEach((t) => {
    if (t < yBottom - 0.001) return;
    const y = yFor(t);
    P.push(`<line x1="${plotX0}" y1="${y.toFixed(1)}" x2="${plotX1}" y2="${y.toFixed(1)}" stroke="#24406b" stroke-width="0.6"${t === 0 ? '' : ' stroke-dasharray="3 3"'}/>`);
    P.push(`<text x="${plotX0 - 4}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#8fb3e0">${t} m</text>`);
  });

  // X axis endpoints
  P.push(`<text x="${plotX0}" y="${plotY1 + 12}" font-size="9" fill="#7e9bc4">0 m</text>`);
  P.push(`<text x="${plotX1}" y="${plotY1 + 12}" text-anchor="end" font-size="9" fill="#7e9bc4">${Math.round(totalM)} m</text>`);

  // Contiguous valid runs — one polyline each, broken across null gaps.
  const runs = [];
  let cur = null;
  for (const s of samples) {
    if (s.depthM == null) { cur = null; continue; }
    if (!cur) { cur = []; runs.push(cur); }
    cur.push(s);
  }
  runs.forEach((run) => {
    let worst = 0;
    run.forEach((s) => { const i = s.band ? bandIdx(s.band.key) : 0; if (i > worst) worst = i; });
    const color = bandColor[ACCURACY_BANDS[worst].key] || 'var(--depth-10)';
    if (run.length === 1) {
      P.push(`<circle cx="${xFor(run[0].dM).toFixed(1)}" cy="${yFor(run[0].depthM).toFixed(1)}" r="1.8" fill="${color}"/>`);
    } else {
      const pts = run.map((s) => `${xFor(s.dM).toFixed(1)},${yFor(s.depthM).toFixed(1)}`).join(' ');
      P.push(`<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  });
  if (!runs.length) {
    P.push(`<text x="${W / 2}" y="${(plotY0 + plotY1) / 2}" text-anchor="middle" font-size="10" fill="#7e9bc4">no depth data along this route</text>`);
  }

  // Legend
  let lx = plotX0;
  const ly = H - 10;
  ACCURACY_BANDS.forEach((b) => {
    const col = bandColor[b.key];
    P.push(`<rect x="${lx}" y="${ly - 8}" width="9" height="9" rx="2" fill="${col}"/>`);
    P.push(`<text x="${lx + 12}" y="${ly}" font-size="8" fill="#8fb3e0">${b.key}</text>`);
    lx += 12 + b.key.length * 4.6 + 12;
  });

  P.push('</svg>');
  return P.join('');
}

/* ============================================================
 * SIDEBAR COLLAPSE — UI preference, persisted in localStorage.
 * ========================================================== */
function wireSidebarCollapse() {
  const sb = document.getElementById('sidebar');
  const opener = document.getElementById('sb-open');
  const collapseBtn = document.getElementById('sb-collapse');
  const apply = (collapsed) => {
    sb.classList.toggle('collapsed', collapsed);
    opener.hidden = !collapsed;
    try { localStorage.setItem('sb-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  };
  collapseBtn.onclick = () => apply(true);
  opener.onclick = () => apply(false);
  let start = false;
  try { start = localStorage.getItem('sb-collapsed') === '1'; } catch { /* ignore */ }
  apply(start);
}

/* ============================================================
 * LEGEND COLLAPSE — same persisted-preference pattern as
 * wireSidebarCollapse(), applied to the bottom-right depth legend.
 * Collapsed state shrinks the panel to just its header chip rather
 * than hiding it entirely.
 * ========================================================== */
function wireLegendCollapse() {
  const legend = document.querySelector('.legend');
  const header = document.getElementById('legend-head');
  if (!legend || !header) return;
  const apply = (collapsed) => {
    legend.classList.toggle('collapsed', collapsed);
    try { localStorage.setItem('legend-collapsed', collapsed ? '1' : '0'); } catch { /* ignore */ }
  };
  header.onclick = () => apply(!legend.classList.contains('collapsed'));
  let start = false;
  try { start = localStorage.getItem('legend-collapsed') === '1'; } catch { /* ignore */ }
  apply(start);
}

/* ============================================================
 * SECTION COLLAPSE — persist open/closed state of the native
 * <details> sidebar sections (Layers, Reefs & dive sites) across
 * reloads, same convention as wireSidebarCollapse() above.
 * ========================================================== */
function wireSectionCollapse() {
  const sections = [
    { id: 'sec-layers', key: 'sb-section-layers' },
    { id: 'sec-sites', key: 'sb-section-sites' },
  ];
  sections.forEach(({ id, key }) => {
    const el = document.getElementById(id);
    if (!el) return;
    let openState = true; // default open, matches the `open` attribute already in the HTML
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) openState = stored === '1';
    } catch { /* ignore */ }
    el.open = openState;
    el.addEventListener('toggle', () => {
      try { localStorage.setItem(key, el.open ? '1' : '0'); } catch { /* ignore */ }
    });
  });
}

/* ============================================================
 * ADMIN MODE — client-side hash gate + session-local editing +
 * export-to-commit. No backend; edits are session-local until the
 * owner exports the file and commits it.
 * ========================================================== */
// True only when the admin is unlocked AND not currently previewing as a
// visitor. Layer-visibility and hidden-site gates should check THIS, never
// state.adminMode directly, so "Preview as visitor" can simulate the public
// view without actually logging out. The admin link/panel itself is NOT
// gated by this — it must stay reachable so Euan can exit preview.
function isEffectiveAdmin() { return state.adminMode && !state.previewAsVisitor; }

function wireAdmin(map) {
  const link = document.getElementById('admin-link');
  link.onclick = () => toggleAdmin(map);
  if (state.adminMode) renderAdminPanel(map);
  refreshAdminLink();
  const bannerExit = document.getElementById('preview-banner-exit');
  if (bannerExit) bannerExit.onclick = () => togglePreviewAsVisitor(map);
}
function refreshAdminLink() {
  const link = document.getElementById('admin-link');
  link.lastChild.textContent = state.adminMode ? ' Admin mode (unlocked)' : ' Admin';
}
async function toggleAdmin(map) {
  if (state.adminMode) { showAdminPanel(true); return; }
  const pw = window.prompt('Admin password:');
  if (pw == null) return;
  const ok = (await sha256(pw)) === ADMIN_HASH;
  if (!ok) { window.alert('Incorrect password.'); return; }
  state.adminMode = true;
  try { sessionStorage.setItem('sb-admin', '1'); } catch { /* ignore */ }
  refreshAdminLink();
  renderToggles(map);      // admin now sees every toggle
  applySites(map);         // admin now sees hidden sites too
  renderAdminPanel(map);
}
// Purely a rendering/visibility simulation: no sessionStorage change, no
// actual logout, ADMIN_HASH/password flow untouched. Re-renders toggles and
// sites so isEffectiveAdmin()'s new value takes effect immediately, then
// refreshes the admin panel (button label) and the top-center banner.
function togglePreviewAsVisitor(map) {
  state.previewAsVisitor = !state.previewAsVisitor;
  renderToggles(map);
  applySites(map);
  renderAdminPanel(map);
  const banner = document.getElementById('preview-banner');
  if (banner) banner.classList.toggle('hidden', !state.previewAsVisitor);
}

function lockAdmin(map) {
  state.adminMode = false;
  state.previewAsVisitor = false; // reset so the next unlock doesn't inherit a stale preview state
  const banner = document.getElementById('preview-banner');
  if (banner) banner.classList.add('hidden');
  try { sessionStorage.removeItem('sb-admin'); } catch { /* ignore */ }
  const panel = document.getElementById('admin-panel');
  panel.classList.add('hidden'); panel.innerHTML = '';
  refreshAdminLink();
  renderToggles(map);
  applySites(map);
}
function showAdminPanel(on) {
  document.getElementById('admin-panel').classList.toggle('hidden', !on);
}

function renderAdminPanel(map) {
  const panel = document.getElementById('admin-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="section-title" style="margin-top:6px">Admin mode</div>
    <div class="note">Edits apply to <b>this browser session only</b>. To publish them, Export the file(s) and commit to the repo.</div>
    <div class="admin-actions">
      <button id="admin-preview" class="btn">${state.previewAsVisitor ? 'Exit preview (back to admin)' : 'Preview as visitor'}</button>
      <button id="admin-lock" class="btn">Lock</button>
    </div>

    <div class="section-title">Import dive sites</div>
    <div class="import-form">
      <div class="filepick">
        <button id="site-import-pick" class="btn small" type="button">Choose file…</button>
        <input type="file" id="site-import-file" accept=".csv,.geojson,.json" hidden />
        <span class="fname" id="site-import-fname">CSV or GeoJSON — columns/keys: name, lat, lon, depth_min_m, depth_max_m, description</span>
      </div>
      <div class="row2">
        <input type="text" id="site-import-collection" placeholder="Collection / folder (optional)">
        <button id="site-import-go" class="btn" type="button" disabled>Import</button>
      </div>
      <div class="import-status" id="site-import-status"></div>
    </div>

    <div class="section-title">Add a site manually</div>
    <div class="add-form">
      <div class="row2"><input type="text" id="site-add-name" placeholder="Name*"><input type="text" id="site-add-collection" placeholder="Collection / folder"></div>
      <div class="row2"><input type="text" id="site-add-lat" placeholder="Lat (decimal)*"><input type="text" id="site-add-lon" placeholder="Lon (decimal)*"></div>
      <div class="row2"><input type="text" id="site-add-dmin" placeholder="Min depth (m)"><input type="text" id="site-add-dmax" placeholder="Max depth (m)"></div>
      <input type="text" id="site-add-desc" placeholder="Description (optional)">
      <button id="site-add-go" class="btn primary" type="button">Add site</button>
      <div class="import-status" id="site-add-status"></div>
    </div>

    <div class="section-title">Dive sites — edit, organise &amp; show/hide</div>
    <div id="admin-sites" class="admin-list"></div>
    <div class="admin-actions">
      <button id="export-sites" class="btn primary">Export all (dive_sites.geojson)</button>
      <button id="export-sites-sel" class="btn">Export selected (<span id="sel-count">0</span>)</button>
    </div>

    <div class="section-title">Visitor layers — visible to everyone</div>
    <div id="admin-layers" class="admin-list"></div>
    <div class="admin-actions"><button id="export-config" class="btn primary">Export layer_config.json</button></div>`;

  renderSiteManagerList(map);
  wireSiteImport(map);
  wireSiteAdd(map);

  // ---- layer availability rows ----
  const lbox = panel.querySelector('#admin-layers');
  LAYER_DEFS.forEach((d) => {
    const avail = state.layerConfig[d.key] !== false;
    const row = document.createElement('div'); row.className = 'arow';
    row.innerHTML = `<input type="checkbox" ${avail ? 'checked' : ''}><span>${d.label}</span>`;
    row.querySelector('input').onchange = (e) => {
      state.layerConfig[d.key] = e.target.checked;
      renderToggles(map);   // reflect immediately (admin still sees all; preview affects nothing until export)
    };
    lbox.appendChild(row);
  });

  panel.querySelector('#admin-preview').onclick = () => togglePreviewAsVisitor(map);
  panel.querySelector('#admin-lock').onclick = () => lockAdmin(map);
  panel.querySelector('#export-sites').onclick = () => download('dive_sites.geojson', JSON.stringify(state.sites, null, 2));
  panel.querySelector('#export-sites-sel').onclick = () => {
    const feats = (state.sites.features || []).filter((f) => state.selectedSiteIds.has(f.properties.id));
    if (!feats.length) { window.alert('No sites selected. Tick the checkbox next to each site you want to export.'); return; }
    download('dive_sites_selected.geojson', JSON.stringify(fc(feats), null, 2));
  };
  panel.querySelector('#export-config').onclick = () => {
    const cfg = {}; LAYER_DEFS.forEach((d) => { cfg[d.key] = state.layerConfig[d.key] !== false; });
    download('layer_config.json', JSON.stringify(cfg, null, 2));
  };
}

/* ---- dive-site manager: grouped, editable, selectable list ---- */
function siteCollection(f) { return (f.properties.collection && String(f.properties.collection).trim()) || 'Uncategorized'; }

function renderSiteManagerList(map) {
  const panel = document.getElementById('admin-panel');
  const sbox = panel.querySelector('#admin-sites');
  const selCount = panel.querySelector('#sel-count');
  sbox.innerHTML = '';
  const feats = state.sites.features || [];
  selCount.textContent = String(state.selectedSiteIds.size);

  const groups = new Map();
  feats.forEach((f) => {
    const k = siteCollection(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  });
  const order = [...groups.keys()].sort((a, b) => (a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)));

  order.forEach((coll) => {
    const head = document.createElement('div'); head.className = 'collgroup';
    head.textContent = `${coll} (${groups.get(coll).length})`;
    sbox.appendChild(head);
    groups.get(coll).forEach((f) => sbox.appendChild(buildSiteRow(map, f)));
  });
}

function buildSiteRow(map, f) {
  const p = f.properties;
  const id = p.id;
  const row = document.createElement('div'); row.className = 'arow site-row';
  row.innerHTML = `
    <input type="checkbox" class="sel-cb" title="Select for export" ${state.selectedSiteIds.has(id) ? 'checked' : ''}>
    <input type="checkbox" class="vis-cb" title="Show to visitors" ${p.hidden === true ? '' : 'checked'}>
    <input type="text" class="nm-tx" value="${esc(p.name)}">
    <button class="btn small expandbtn" type="button">${state.expandedSiteId === id ? 'Close' : 'Edit'}</button>`;
  const selCb = row.querySelector('.sel-cb');
  const visCb = row.querySelector('.vis-cb');
  const nmTx = row.querySelector('.nm-tx');
  const expandBtn = row.querySelector('.expandbtn');

  selCb.onchange = () => {
    if (selCb.checked) state.selectedSiteIds.add(id); else state.selectedSiteIds.delete(id);
    const selCount = document.getElementById('sel-count');
    if (selCount) selCount.textContent = String(state.selectedSiteIds.size);
  };
  visCb.onchange = () => { f.properties.hidden = !visCb.checked; applySites(map); };
  nmTx.onchange = () => { f.properties.name = nmTx.value.trim() || f.properties.name; applySites(map); };
  expandBtn.onclick = () => {
    state.expandedSiteId = (state.expandedSiteId === id) ? null : id;
    renderSiteManagerList(map);
  };

  if (state.expandedSiteId === id) {
    const [lon, lat] = f.geometry.coordinates;
    const edit = document.createElement('div'); edit.className = 'site-edit';
    edit.innerHTML = `
      <div><label>Latitude</label><input type="text" class="e-lat" value="${lat}"></div>
      <div><label>Longitude</label><input type="text" class="e-lon" value="${lon}"></div>
      <div><label>Min depth (m)</label><input type="text" class="e-dmin" value="${p.depth_min_m ?? ''}"></div>
      <div><label>Max depth (m)</label><input type="text" class="e-dmax" value="${p.depth_max_m ?? ''}"></div>
      <div class="full"><label>Collection / folder</label><input type="text" class="e-coll" value="${esc(siteCollection(f) === 'Uncategorized' ? '' : siteCollection(f))}" placeholder="Uncategorized"></div>
      <div class="full"><label>Description</label><textarea class="e-desc">${esc(p.description || '')}</textarea></div>
      <div class="full admin-actions" style="margin:2px 0 0">
        <button class="btn small e-save" type="button">Save</button>
        <button class="btn small danger e-delete" type="button">Delete site</button>
      </div>`;
    const g = (cls) => edit.querySelector(cls);
    g('.e-save').onclick = () => {
      const newLat = parseFloat(g('.e-lat').value), newLon = parseFloat(g('.e-lon').value);
      if (Number.isFinite(newLat) && Number.isFinite(newLon)) f.geometry.coordinates = [newLon, newLat];
      const dmin = g('.e-dmin').value.trim(), dmax = g('.e-dmax').value.trim();
      f.properties.depth_min_m = dmin === '' ? undefined : parseFloat(dmin);
      f.properties.depth_max_m = dmax === '' ? undefined : parseFloat(dmax);
      f.properties.description = g('.e-desc').value.trim() || undefined;
      f.properties.collection = g('.e-coll').value.trim() || undefined;
      applySites(map);
      renderSiteManagerList(map);
    };
    g('.e-delete').onclick = () => {
      if (!window.confirm(`Delete "${p.name}"? This only affects your current browser session until you export.`)) return;
      state.sites.features = state.sites.features.filter((x) => x !== f);
      state.selectedSiteIds.delete(id);
      state.expandedSiteId = null;
      applySites(map);
      renderSiteManagerList(map);
    };
    row.appendChild(edit);
  }
  return row;
}

/* ---- import (CSV / GeoJSON) ---- */
function wireSiteImport(map) {
  const pick = document.getElementById('site-import-pick');
  const file = document.getElementById('site-import-file');
  const fname = document.getElementById('site-import-fname');
  const go = document.getElementById('site-import-go');
  const status = document.getElementById('site-import-status');
  let picked = null;
  pick.onclick = () => file.click();
  file.onchange = () => {
    picked = file.files && file.files[0];
    fname.textContent = picked ? picked.name : 'CSV or GeoJSON — columns/keys: name, lat, lon, depth_min_m, depth_max_m, description';
    go.disabled = !picked;
    status.textContent = ''; status.className = 'import-status';
  };
  go.onclick = async () => {
    if (!picked) return;
    const collection = document.getElementById('site-import-collection').value.trim() || undefined;
    status.className = 'import-status'; status.textContent = 'Reading…';
    try {
      const text = await picked.text();
      const isJson = /\.(geojson|json)$/i.test(picked.name) || text.trim().startsWith('{') || text.trim().startsWith('[');
      const parsed = isJson ? parseSitesFromGeoJSON(text) : parseSitesFromCSV(text);
      if (!parsed.features.length) {
        status.className = 'import-status err';
        status.textContent = parsed.errors.length ? `No sites imported: ${parsed.errors[0]}` : 'No sites found in file.';
        return;
      }
      parsed.features.forEach((f) => {
        f.properties.id = genId();
        f.properties.verified = false;
        if (collection) f.properties.collection = collection;
      });
      state.sites.features = (state.sites.features || []).concat(parsed.features);
      applySites(map);
      renderSiteManagerList(map);
      const skipped = parsed.errors.length ? ` (${parsed.errors.length} row(s) skipped: ${parsed.errors.slice(0, 3).join('; ')}${parsed.errors.length > 3 ? '…' : ''})` : '';
      status.className = 'import-status';
      status.textContent = `Imported ${parsed.features.length} site(s)${skipped}.`;
      file.value = ''; picked = null; go.disabled = true;
      fname.textContent = 'CSV or GeoJSON — columns/keys: name, lat, lon, depth_min_m, depth_max_m, description';
    } catch (err) {
      status.className = 'import-status err';
      status.textContent = `Import failed: ${err.message || err}`;
    }
  };
}

// Flexible column-name matching: accepts common aliases so an export from any dive-log app
// or a hand-built spreadsheet is likely to "just work" without a required exact header.
const COL_ALIASES = {
  name: ['name', 'site', 'site_name', 'sitename', 'title'],
  lat: ['lat', 'latitude', 'y'],
  lon: ['lon', 'lng', 'long', 'longitude', 'x'],
  depth_min_m: ['depth_min_m', 'min_depth', 'mindepth', 'depth_min', 'min_depth_m'],
  depth_max_m: ['depth_max_m', 'max_depth', 'maxdepth', 'depth_max', 'max_depth_m', 'depth', 'depth_m'],
  description: ['description', 'desc', 'notes', 'note', 'comment'],
  collection: ['collection', 'folder', 'group', 'category'],
};
function matchCol(headerLower, field) {
  const idx = headerLower.findIndex((h) => COL_ALIASES[field].includes(h));
  return idx;
}
function parseCsvLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseSitesFromCSV(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  const errors = [];
  if (!lines.length) return { features: [], errors: ['file is empty'] };
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const ci = {
    name: matchCol(header, 'name'), lat: matchCol(header, 'lat'), lon: matchCol(header, 'lon'),
    depth_min_m: matchCol(header, 'depth_min_m'), depth_max_m: matchCol(header, 'depth_max_m'),
    description: matchCol(header, 'description'), collection: matchCol(header, 'collection'),
  };
  if (ci.lat < 0 || ci.lon < 0) return { features: [], errors: ['could not find latitude/longitude columns'] };
  const features = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const lat = parseFloat(cols[ci.lat]), lon = parseFloat(cols[ci.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { errors.push(`row ${i + 1}: bad coordinates`); continue; }
    const props = { name: (ci.name >= 0 && cols[ci.name] && cols[ci.name].trim()) || `Imported site ${features.length + 1}` };
    if (ci.depth_min_m >= 0 && cols[ci.depth_min_m] !== undefined && cols[ci.depth_min_m] !== '') props.depth_min_m = parseFloat(cols[ci.depth_min_m]);
    if (ci.depth_max_m >= 0 && cols[ci.depth_max_m] !== undefined && cols[ci.depth_max_m] !== '') props.depth_max_m = parseFloat(cols[ci.depth_max_m]);
    if (ci.description >= 0 && cols[ci.description]) props.description = cols[ci.description].trim();
    if (ci.collection >= 0 && cols[ci.collection]) props.collection = cols[ci.collection].trim();
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }
  return { features, errors };
}
function parseSitesFromGeoJSON(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { features: [], errors: [`invalid JSON: ${e.message}`] }; }
  const errors = [];
  let rawFeatures;
  if (data && data.type === 'FeatureCollection') rawFeatures = data.features || [];
  else if (data && data.type === 'Feature') rawFeatures = [data];
  else if (Array.isArray(data)) {
    // tolerant: an array of plain {name, lat, lon, ...} objects, not real GeoJSON
    rawFeatures = data.map((r) => {
      const lat = r.lat ?? r.latitude ?? r.y, lon = r.lon ?? r.lng ?? r.longitude ?? r.x;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      return { type: 'Feature', properties: { ...r }, geometry: { type: 'Point', coordinates: [lon, lat] } };
    }).filter(Boolean);
  } else return { features: [], errors: ['unrecognised GeoJSON structure'] };

  const features = [];
  rawFeatures.forEach((f, i) => {
    if (!f || f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) { errors.push(`feature ${i + 1}: not a Point`); return; }
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { errors.push(`feature ${i + 1}: bad coordinates`); return; }
    const props = { ...(f.properties || {}) };
    if (!props.name) props.name = `Imported site ${features.length + 1}`;
    features.push({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
  });
  return { features, errors };
}

/* ---- manual add ---- */
function wireSiteAdd(map) {
  const go = document.getElementById('site-add-go');
  const status = document.getElementById('site-add-status');
  go.onclick = () => {
    const name = document.getElementById('site-add-name').value.trim();
    const lat = parseFloat(document.getElementById('site-add-lat').value);
    const lon = parseFloat(document.getElementById('site-add-lon').value);
    if (!name) { status.className = 'import-status err'; status.textContent = 'Name is required.'; return; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { status.className = 'import-status err'; status.textContent = 'Valid latitude and longitude are required.'; return; }
    const dminV = document.getElementById('site-add-dmin').value.trim();
    const dmaxV = document.getElementById('site-add-dmax').value.trim();
    const collection = document.getElementById('site-add-collection').value.trim() || undefined;
    const description = document.getElementById('site-add-desc').value.trim() || undefined;
    const props = { id: genId(), name, verified: false };
    if (dminV !== '') props.depth_min_m = parseFloat(dminV);
    if (dmaxV !== '') props.depth_max_m = parseFloat(dmaxV);
    if (collection) props.collection = collection;
    if (description) props.description = description;
    state.sites.features = (state.sites.features || []).concat([{ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } }]);
    applySites(map);
    renderSiteManagerList(map);
    status.className = 'import-status'; status.textContent = `Added "${name}".`;
    ['site-add-name', 'site-add-collection', 'site-add-lat', 'site-add-lon', 'site-add-dmin', 'site-add-dmax', 'site-add-desc']
      .forEach((id) => { document.getElementById(id).value = ''; });
  };
}

function download(name, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- helpers ---------- */
function updateHash(map) {
  const c = map.getCenter();
  history.replaceState(null, '', `#${map.getZoom().toFixed(2)}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
}
function ddm(lat, lon) {
  const f = (v, pos, neg) => {
    const hemi = v >= 0 ? pos : neg, a = Math.abs(v), d = Math.floor(a), m = (a - d) * 60;
    return `${d}°${m.toFixed(3)}'${hemi}`;
  };
  return `${f(lat, 'N', 'S')} ${f(lon, 'E', 'W')}`;
}
// haversineKm / bearingDeg / totalKm now live in route.js (imported at top) —
// the measure tool and Plan Route share the same great-circle formulas there.
function fc(features) { return { type: 'FeatureCollection', features }; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function getJSON(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } }
async function head(url) { try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; } }
