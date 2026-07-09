/* Sodwana Bay bathymetry web app — dependency-free (MapLibre GL v5 global + maplibre-contour).
 * No API keys, no build step. Loads local terrarium raster-dem tiles when present.
 * Depth convention: seafloor negative metres. */

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
  { key: 'relief',    label: 'Depth colour',           def: true,  sw: 'var(--depth-30)' },
  { key: 'hill',      label: 'Hillshade',              def: true,  sw: '#8aa0bf' },
  { key: 'contour',   label: 'Contours',               def: true,  sw: '#bfe9ff' },
  { key: 'sites',     label: 'Dive sites',             def: true,  sw: 'var(--c-site)' },
  { key: 'tracks',    label: 'ICESat-2 tracks',        def: false, sw: 'var(--c-track)' },
  { key: 'prospects', label: 'Prospect leads',         def: false, sw: 'var(--c-prospect)' },
  { key: 'geology',   label: 'Seafloor geology (CGS)', def: false, sw: 'var(--c-reef)' },
  { key: 'isobaths',  label: 'CGS isobaths',           def: false, sw: 'var(--depth-10)' },
  { key: 'entries',   label: 'Dive entry points',      def: false, sw: 'var(--c-entry)' },
  { key: 'measure',   label: 'Measure distance',       def: false, kind: 'measure' },
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
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('error', (e) => console.warn('map resource issue (non-fatal):', e && e.error && e.error.message));

  wireSidebarCollapse();
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
  wireAdmin(map);
}

/* ---------- terrain / 3D ---------- */
function set3D(map, on, ex) {
  if (on) { if (!map.getSource('terrain-dem')) return; map.setTerrain({ source: 'terrain-dem', exaggeration: ex }); }
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
  const demSource = new mlcontour.DemSource({ url: tilesBase + '{z}/{x}/{y}.png', encoding: 'terrarium', maxzoom: 15, worker: true });
  demSource.setupMaplibre(maplibregl);
  map.addSource('contour-src', {
    type: 'vector',
    tiles: [demSource.contourProtocolUrl({
      thresholds: { 11: [10, 50], 13: [5, 25], 15: [1, 5] },
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
}

/* ---------- vector overlays ---------- */
async function loadVector(map, url, id, styler, after) {
  const gj = await getJSON(url);
  if (!gj) return;
  map.addSource(id, { type: 'geojson', data: gj });
  styler(map, id);
  if (after) after(map, gj);
}

function geologyStyle(map, id) {
  map.addLayer({
    id: 'geology-fill', type: 'fill', source: id, layout: { visibility: 'none' },
    paint: {
      'fill-opacity': 0.45,
      'fill-color': ['match', ['get', 'geology'],
        'Prominent Reef', C.reefProminent, 'Reef', C.reef, 'Scattered Reef', C.reefScattered,
        'Coarse Shelly Sediment', C.sedCoarse, 'Sand', C.sedSand, '#9aa7b0'],
    },
  });
  map.addLayer({ id: 'geology-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: { 'line-color': '#00121f', 'line-width': 0.3, 'line-opacity': 0.4 } });
  map.on('click', 'geology-fill', (e) => {
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>CGS substrate</b><br>${esc(e.features[0].properties.geology)}`).addTo(map);
  });
}

function isobathStyle(map, id) {
  // CGS 2005 survey isobaths — coloured by depth on the shared blue->cyan scale.
  // Multiples of 25 m drawn thicker as index contours.
  map.addLayer({ id: 'isobath-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: {
      'line-color': depthRamp('depth_m'),
      'line-width': ['case', ['==', ['%', ['get', 'depth_m'], 25], 0], 1.5, 0.7],
      'line-opacity': 0.85,
    } });
  map.addLayer({
    id: 'isobath-label', type: 'symbol', source: id,
    layout: { visibility: 'none', 'symbol-placement': 'line', 'symbol-spacing': 220,
      'text-field': ['concat', ['to-string', ['get', 'depth_m']], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 9 },
    paint: { 'text-color': depthRamp('depth_m'), 'text-halo-color': '#04263a', 'text-halo-width': 1.4 },
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
  map.addSource('sites', { type: 'geojson', data: sitesForDisplay() });
  diveSiteStyle(map, 'sites');
  applySites(map);
}
// visitors never see features flagged hidden:true; admin sees everything
function sitesForDisplay() {
  const feats = (state.sites.features || []).filter((f) => state.adminMode || f.properties.hidden !== true);
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
    const visitorHidden = !state.adminMode && state.layerConfig[d.key] === false;
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
  } else {
    (VIS[d.key] || []).forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none'));
  }
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
    if (window.__measuring) return;
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
      const dd = totalKm(pts), b = bearing(pts[pts.length - 2], pts[pts.length - 1]);
      document.getElementById('clicked').innerHTML = `${(dd * 1000).toFixed(0)} m total · last leg bearing ${b.toFixed(0)}°`;
    }
    map.getSource(srcId).setData(fc(feats));
  });
}
function setMeasure(map, on) {
  window.__measuring = on;
  map.getCanvas().style.cursor = on ? 'crosshair' : '';
  if (!on && window.__measureReset) window.__measureReset();
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
 * ADMIN MODE — client-side hash gate + session-local editing +
 * export-to-commit. No backend; edits are session-local until the
 * owner exports the file and commits it.
 * ========================================================== */
function wireAdmin(map) {
  const link = document.getElementById('admin-link');
  link.onclick = () => toggleAdmin(map);
  if (state.adminMode) renderAdminPanel(map);
  refreshAdminLink();
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
function lockAdmin(map) {
  state.adminMode = false;
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
    <div class="note">Edits apply to <b>this browser session only</b>. To publish them, Export the file and commit it to the repo.</div>
    <div class="admin-actions"><button id="admin-lock" class="btn">Lock</button></div>

    <div class="section-title">Dive sites — rename &amp; show/hide</div>
    <div id="admin-sites" class="admin-list"></div>
    <div class="admin-actions"><button id="export-sites" class="btn primary">Export dive_sites.geojson</button></div>

    <div class="section-title">Visitor layers — visible to everyone</div>
    <div id="admin-layers" class="admin-list"></div>
    <div class="admin-actions"><button id="export-config" class="btn primary">Export layer_config.json</button></div>`;

  // ---- site rows ----
  const sbox = panel.querySelector('#admin-sites');
  (state.sites.features || []).forEach((f, i) => {
    const p = f.properties;
    const row = document.createElement('div'); row.className = 'arow';
    row.innerHTML = `<input type="checkbox" title="Show to visitors" ${p.hidden === true ? '' : 'checked'}>
      <input type="text" value="${esc(p.name)}">`;
    const [cb, tx] = row.querySelectorAll('input');
    cb.onchange = () => { f.properties.hidden = !cb.checked; applySites(map); };
    tx.onchange = () => { f.properties.name = tx.value.trim() || f.properties.name; applySites(map); };
    sbox.appendChild(row);
  });

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

  panel.querySelector('#admin-lock').onclick = () => lockAdmin(map);
  panel.querySelector('#export-sites').onclick = () => download('dive_sites.geojson', JSON.stringify(state.sites, null, 2));
  panel.querySelector('#export-config').onclick = () => {
    const cfg = {}; LAYER_DEFS.forEach((d) => { cfg[d.key] = state.layerConfig[d.key] !== false; });
    download('layer_config.json', JSON.stringify(cfg, null, 2));
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
function bearing(a, b) {
  const toR = (x) => x * Math.PI / 180, toD = (x) => x * 180 / Math.PI;
  const y = Math.sin(toR(b[0] - a[0])) * Math.cos(toR(b[1]));
  const x = Math.cos(toR(a[1])) * Math.sin(toR(b[1])) - Math.sin(toR(a[1])) * Math.cos(toR(b[1])) * Math.cos(toR(b[0] - a[0]));
  return (toD(Math.atan2(y, x)) + 360) % 360;
}
function haversine(a, b) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dlat = toR(b[1] - a[1]), dlon = toR(b[0] - a[0]);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function totalKm(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += haversine(pts[i - 1], pts[i]); return s; }
function fc(features) { return { type: 'FeatureCollection', features }; }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function getJSON(url) { try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; } }
async function head(url) { try { const r = await fetch(url, { method: 'HEAD' }); return r.ok; } catch { return false; } }
