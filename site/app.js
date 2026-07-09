/* Sodwana Bay bathymetry web app — dependency-free (MapLibre GL v5 global + maplibre-contour).
 * No API keys. Loads local terrarium raster-dem tiles when present; degrades gracefully without them.
 * Depth convention: seafloor negative metres. */

const AOI = { lonMin: 32.62, lonMax: 32.82, latMin: -27.62, latMax: -27.32 };
const CENTER = [(AOI.lonMin + AOI.lonMax) / 2, (AOI.latMin + AOI.latMax) / 2];

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
  window.__mlmap = map;  // test/debug handle (harmless; used by headless verification)
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.on('error', (e) => console.warn('map resource issue (non-fatal):', e && e.error && e.error.message));
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
    : '⚠ DEM tiles not built yet — run <code>pipeline/07_make_tiles.py</code>. Basemap, markers & tools still work.';

  await setupContours(map);
  await loadVector(map, 'data/cgs_geology.geojson', 'geology', geologyStyle);
  await loadVector(map, 'data/cgs_isobaths.geojson', 'isobaths', isobathStyle);
  await loadVector(map, 'data/dive_entries.geojson', 'entries', entryStyle);
  await loadVector(map, 'data/dive_sites.geojson', 'sites', diveSiteStyle, buildSiteList);
  await loadVector(map, 'data/icesat2_tracks.geojson', 'tracks', trackStyle);
  await loadVector(map, 'data/prospects.geojson', 'prospects', prospectStyle);

  wireToggles(map);
  wireCoordinates(map);
  wireMeasure(map);
}

/* ---------- terrain / 3D ---------- */
function set3D(map, on, ex) {
  if (on) { if (!map.getSource('terrain-dem')) return; map.setTerrain({ source: 'terrain-dem', exaggeration: ex }); }
  else { map.setTerrain(null); }
}

/* ---------- contours (client-side from the same terrarium tiles) ---------- */
async function setupContours(map) {
  if (!map.getSource('terrain-dem')) return;
  let mlcontour;
  try { mlcontour = (await import('./vendor/index.mjs')).default; }
  catch {
    try { mlcontour = (await import('https://unpkg.com/maplibre-contour@0.1.0/dist/index.mjs')).default; }
    catch (e) { console.warn('maplibre-contour unavailable; contours disabled', e); return; }
  }
  // maplibre-contour fetches tiles inside a Web Worker (no page base URL) — pass an ABSOLUTE url.
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
  // CGS seafloor substrate. Reef classes warm, sediment sandy — off by default (busy overlay).
  map.addLayer({
    id: 'geology-fill', type: 'fill', source: id, layout: { visibility: 'none' },
    paint: {
      'fill-opacity': 0.45,
      'fill-color': ['match', ['get', 'geology'],
        'Prominent Reef', '#c1440e', 'Reef', '#e8722c', 'Scattered Reef', '#f2b134',
        'Coarse Shelly Sediment', '#d9c9a3', 'Sand', '#efe6cf', '#9aa7b0'],
    },
  });
  map.addLayer({ id: 'geology-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: { 'line-color': '#00121f', 'line-width': 0.3, 'line-opacity': 0.4 } });
  map.on('click', 'geology-fill', (e) => {
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>CGS substrate</b><br>${esc(e.features[0].properties.geology)}`).addTo(map);
  });
}

function isobathStyle(map, id) {
  // CGS 2005 survey isobaths (real depth contours, incl. the deep zone the optical DEM can't show).
  map.addLayer({ id: 'isobath-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: { 'line-color': '#7fd4ff', 'line-width': 0.8, 'line-opacity': 0.7 } });
  map.addLayer({
    id: 'isobath-label', type: 'symbol', source: id,
    layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'depth_m']], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 9 },
    paint: { 'text-color': '#cdeeff', 'text-halo-color': '#04263a', 'text-halo-width': 1 },
  });
}

function diveSiteStyle(map, id) {
  map.addLayer({
    id: 'sites-dot', type: 'circle', source: id,
    paint: {
      'circle-radius': 5,
      'circle-color': ['case', ['==', ['get', 'verified'], false], '#ff9f6b', '#ffd400'],
      'circle-stroke-color': '#0a1830', 'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'sites-label', type: 'symbol', source: id,
    layout: {
      'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11,
      'text-offset': [0, 1.1], 'text-anchor': 'top',
    },
    paint: { 'text-color': '#ffffff', 'text-halo-color': '#0a1830', 'text-halo-width': 1.2 },
  });
  map.on('click', 'sites-dot', (e) => sitePopup(map, e.features[0]));
  map.on('mouseenter', 'sites-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'sites-dot', () => (map.getCanvas().style.cursor = ''));
}

function entryStyle(map, id) {
  // Individual Garmin dive-entry GPS fixes — a density cloud under the named-site markers.
  map.addLayer({ id: 'entries-dot', type: 'circle', source: id, layout: { visibility: 'none' },
    paint: { 'circle-radius': 3, 'circle-color': '#00e5ff', 'circle-opacity': 0.35, 'circle-stroke-color': '#0a1830', 'circle-stroke-width': 0.4 } });
}

function trackStyle(map, id) {
  map.addLayer({ id: 'tracks-line', type: 'line', source: id, layout: { visibility: 'none' },
    paint: { 'line-color': '#7CFC00', 'line-width': 1, 'line-opacity': 0.7 } });
}

function prospectStyle(map, id) {
  map.addLayer({
    id: 'prospects-dot', type: 'circle', source: id, layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 4, 10, 11],
      'circle-color': ['case', ['==', ['get', 'cgs_corroborated'], true], '#4dff88', '#ff5db1'],
      'circle-opacity': 0.6, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1,
    },
  });
  map.on('click', 'prospects-dot', (e) => prospectPopup(map, e.features[0]));
  map.on('mouseenter', 'prospects-dot', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'prospects-dot', () => (map.getCanvas().style.cursor = ''));
}

/* ---------- popups ---------- */
function sitePopup(map, f) {
  const p = f.properties, [lon, lat] = f.geometry.coordinates;
  const depth = (p.depth_min_m != null) ? `${p.depth_min_m} to ${p.depth_max_m} m` : '—';
  const verified = (p.verified === false || p.verified === 'false');
  const dives = (p.n_dives) ? `<br>${p.n_dives} logged dive(s)` : '';
  const alt = (p.alt_names) ? `<br><small>also: ${esc(p.alt_names)}</small>` : '';
  const html = `<b>${esc(p.name)}</b>${verified ? ' <i style="color:#ff9f6b">(unverified)</i>' : ''}<br>
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

/* ---------- teaching sidebar ---------- */
function buildSiteList(map, gj) {
  const ul = document.getElementById('site-list');
  ul.innerHTML = '';
  (gj.features || []).forEach((f) => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const li = document.createElement('li');
    if (p.verified === false) li.className = 'unverified';
    const depth = (p.depth_min_m != null) ? `${p.depth_min_m}–${p.depth_max_m} m` : '';
    li.innerHTML = `${esc(p.name)}<span class="d"> ${depth}</span>`;
    li.onclick = () => {
      map.flyTo({ center: [lon, lat], zoom: 14, pitch: 60, bearing: -20, duration: 2000 });
      if (!document.getElementById('t-3d').checked) {
        document.getElementById('t-3d').checked = true;
        set3D(map, true, parseFloat(document.getElementById('ex').value));
      }
      setTimeout(() => sitePopup(map, f), 2100);
    };
    ul.appendChild(li);
  });
}

/* ---------- toggles ---------- */
function wireToggles(map) {
  const vis = (id, on) => map.getLayer(id) && map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  const ex = document.getElementById('ex');
  const exval = document.getElementById('exval');
  const t3 = document.getElementById('t-3d');
  t3.onchange = () => set3D(map, t3.checked, parseFloat(ex.value));
  ex.oninput = () => { exval.textContent = (+ex.value).toFixed(1) + '×'; if (t3.checked) set3D(map, true, +ex.value); };

  bind('t-relief', (on) => vis('color-relief', on));
  bind('t-hill', (on) => vis('hillshade', on));
  bind('t-contour', (on) => { vis('contour-lines', on); vis('contour-labels', on); });
  bind('t-sites', (on) => { vis('sites-dot', on); vis('sites-label', on); });
  bind('t-tracks', (on) => vis('tracks-line', on));
  bind('t-prospects', (on) => vis('prospects-dot', on));
  bind('t-geology', (on) => { vis('geology-fill', on); vis('geology-line', on); });
  bind('t-isobaths', (on) => { vis('isobath-line', on); vis('isobath-label', on); });
  bind('t-entries', (on) => vis('entries-dot', on));

  function bind(elId, fn) {
    const el = document.getElementById(elId);
    if (!el) return;
    fn(el.checked);
    el.onchange = () => fn(el.checked);
  }
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
    marker = new maplibregl.Marker({ color: '#00e5ff' }).setLngLat([lng, lat]).addTo(map);
    document.getElementById('clicked').innerHTML = `<code>${lat.toFixed(6)}, ${lng.toFixed(6)}</code><br>${ddm(lat, lng)}`;
    const btn = document.getElementById('copybtn');
    btn.hidden = false;
    btn.onclick = () => navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`);
  });
}

/* ---------- distance measure ---------- */
function wireMeasure(map) {
  const el = document.getElementById('t-measure');
  const pts = [];
  const srcId = 'measure-src';
  el.onchange = () => {
    window.__measuring = el.checked;
    map.getCanvas().style.cursor = el.checked ? 'crosshair' : '';
    if (!el.checked) { pts.length = 0; if (map.getSource(srcId)) map.getSource(srcId).setData(fc([])); }
  };
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
      const d = totalKm(pts), b = bearing(pts[pts.length - 2], pts[pts.length - 1]);
      document.getElementById('clicked').innerHTML = `${(d * 1000).toFixed(0)} m total · last leg bearing ${b.toFixed(0)}°`;
    }
    map.getSource(srcId).setData(fc(feats));
  });
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
