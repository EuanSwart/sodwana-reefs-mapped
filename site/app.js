/* Sodwana Bay Bathymetry - map application. Author: Euan Swart. */
(function () {
  'use strict';

  var MINUS = String.fromCharCode(0x2212);   // proper minus sign
  var AOI = [32.62, -27.62, 32.82, -27.32];
  var CENTER = [32.72, -27.47];
  var TILE_MINZOOM = 8, TILE_MAXZOOM = 15;
  var USER_SITES_KEY = 'sodwana-user-sites-v1';
  var OFFICIAL_ID = 'official';

  // ADMIN_HASH is the SHA-256 of the admin password. Only the hash lives in this file;
  // the password itself is never stored anywhere. To change it, run in a console:
  //   (async p => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
  //     new TextEncoder().encode(p)))].map(x => x.toString(16).padStart(2,'0')).join(''))('newpass')
  var ADMIN_HASH = 'daca69b7c5b72a8a68a5884a118d3176593827173a232f1c284eeeb5a0d6b50a';
  function sha256(str) {
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (x) { return x.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function depthLabel(m) {
    if (m === null || m === undefined || !isFinite(m)) return MINUS;
    var v = Math.round(m * 10) / 10;
    if (v > 0) return MINUS + '0.0 m';
    return MINUS + Math.abs(v).toFixed(1) + ' m';
  }
  function fmtLL(lng, lat) { return lat.toFixed(4) + ', ' + lng.toFixed(4); }
  function byId(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fc(features) { return { type: 'FeatureCollection', features: features }; }
  function downloadBlob(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function uid() { return 'id' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  var style = {
    version: 8,
    name: 'Sodwana Bay',
    sources: {
      relief: {
        type: 'raster',
        tiles: ['tiles/relief/{z}/{x}/{y}.png'],
        tileSize: 256, minzoom: TILE_MINZOOM, maxzoom: TILE_MAXZOOM, bounds: AOI,
        attribution: 'Sodwana Bay Bathymetry | Euan Swart'
      },
      terrain: {
        type: 'raster-dem',
        tiles: ['tiles/terrain/{z}/{x}/{y}.png'],
        tileSize: 256, minzoom: TILE_MINZOOM, maxzoom: TILE_MAXZOOM, bounds: AOI,
        encoding: 'terrarium'
      },
      contours: { type: 'geojson', data: 'data/contours.geojson' },
      cgs_geology: { type: 'geojson', data: 'data/cgs_geology.geojson' },
      dive_sites: { type: 'geojson', data: fc([]) },
      icesat2: { type: 'geojson', data: 'data/icesat2_tracks.geojson' },
      prospects: { type: 'geojson', data: 'data/prospects.geojson' },
      dive_entries: { type: 'geojson', data: 'data/dive_entries.geojson' },
      user_sites: { type: 'geojson', data: fc([]) },
      measure_src: { type: 'geojson', data: fc([]) },
      route_src: { type: 'geojson', data: fc([]) }
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#070d15' } },
      { id: 'relief', type: 'raster', source: 'relief',
        paint: { 'raster-opacity': 1, 'raster-resampling': 'linear' } },
      { id: 'geology-fill', type: 'fill', source: 'cgs_geology',
        layout: { visibility: 'none' },
        paint: {
          'fill-color': ['match', ['get', 'geology'],
            'Prominent Reef', '#c1440e', 'Reef', '#e8722c', 'Scattered Reef', '#f2b134',
            'Coarse Shelly Sediment', '#b9a67d', 'Sand', '#e3d7b4', '#9aa7b0'],
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.08, 12, 0.28, 15, 0.42]
        } },
      { id: 'geology-line', type: 'line', source: 'cgs_geology',
        layout: { visibility: 'none' },
        paint: { 'line-color': '#00121f', 'line-width': 0.3, 'line-opacity': 0.4 } },
      { id: 'contour-waiver', type: 'line', source: 'contours',
        filter: ['==', ['get', 'confident'], 0],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#93c6d6', 'line-opacity': 0.42, 'line-dasharray': [2, 2.2],
          'line-width': ['interpolate', ['linear'], ['zoom'],
            10, ['case', ['==', ['get', 'emphasis'], 1], 1.2, 0.6],
            15, ['case', ['==', ['get', 'emphasis'], 1], 2.4, 1.1]]
        } },
      { id: 'contour-confident', type: 'line', source: 'contours',
        filter: ['all', ['==', ['get', 'confident'], 1], ['==', ['get', 'emphasis'], 0]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#bfe9f2', 'line-opacity': 0.5,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 15, 1.1]
        } },
      { id: 'contour-emphasis', type: 'line', source: 'contours',
        filter: ['all', ['==', ['get', 'confident'], 1], ['==', ['get', 'emphasis'], 1]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#e2f6fb', 'line-opacity': 0.82,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.3, 15, 2.6]
        } },
      { id: 'icesat2-line', type: 'line', source: 'icesat2',
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': '#39e6ff', 'line-opacity': 0.7,
          'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.6, 15, 1.8] } },
      { id: 'entries-circle', type: 'circle', source: 'dive_entries',
        layout: { visibility: 'none' },
        paint: { 'circle-radius': 2.6, 'circle-color': '#5ad1ff', 'circle-opacity': 0.4,
          'circle-stroke-color': '#052a3a', 'circle-stroke-width': 0.4 } },
      { id: 'prospects-circle', type: 'circle', source: 'prospects',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'score'], 0, 4, 10, 11],
          'circle-color': ['case', ['==', ['get', 'cgs_corroborated'], true], '#4dff88', '#ff5db1'],
          'circle-opacity': 0.6, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1
        } },
      { id: 'dive-circle', type: 'circle', source: 'dive_sites',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 15, 7],
          'circle-color': ['case', ['==', ['get', 'verified'], false], '#ffb238', '#35c2d6'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.6, 'circle-opacity': 0.95
        } },
      { id: 'user-circle', type: 'circle', source: 'user_sites',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3.5, 15, 7],
          'circle-color': '#ffb238', 'circle-stroke-color': '#7a3f00',
          'circle-stroke-width': 1.6, 'circle-opacity': 0.95
        } },
      { id: 'measure-line', type: 'line', source: 'measure_src', filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#35c2d6', 'line-width': 2, 'line-dasharray': [2, 1.4] } },
      { id: 'measure-pts', type: 'circle', source: 'measure_src', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 4, 'circle-color': '#35c2d6' } },
      { id: 'route-line', type: 'line', source: 'route_src', filter: ['==', '$type', 'LineString'],
        paint: { 'line-color': '#4dff88', 'line-width': 3, 'line-opacity': 0.95 } },
      { id: 'route-pts', type: 'circle', source: 'route_src', filter: ['==', '$type', 'Point'],
        paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': '#4dff88', 'circle-stroke-width': 2 } }
    ]
  };

  var map = new maplibregl.Map({
    container: 'map', style: style, center: CENTER, zoom: 12,
    minZoom: 8, maxZoom: 17, maxPitch: 75, pitch: 0, bearing: 0,
    maxBounds: [[AOI[0] - 0.15, AOI[1] - 0.15], [AOI[2] + 0.15, AOI[3] + 0.15]],
    attributionControl: false, hash: true
  });
  window.__map = map;
  map.on('error', function (e) { console.warn('map resource issue (non-fatal):', e && e.error && e.error.message); });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 110, unit: 'metric' }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  var state = {
    exag: 1.5, is3d: false, contours: true, sites: true, geology: false,
    adminMode: false, previewAsVisitor: false,
    layerConfig: {}, officialFC: fc([]),
  };

  function isEffectiveAdmin() { return state.adminMode && !state.previewAsVisitor; }

  map.on('load', function () {
    // exaggeration 0 (not 1) in the default 2D view — see the comment in set3D() for why:
    // nonzero exaggeration displaces the mesh at nodata/land edges into visible spikes.
    map.setTerrain({ source: 'terrain', exaggeration: 0 });
    wireLayerToggles();
    wireDepthReadout();
    wireGeologyPopups();
    wireUserSitePopups();
    wireProspectPopups();
    fetch('data/layer_config.json').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
      .then(function (cfg) {
        state.layerConfig = cfg || {};
        state.adminMode = (function () { try { return sessionStorage.getItem('sb-admin') === '1'; } catch (e) { return false; } })();
        renderVisitorGating();
        buildDiveLabels();
        refreshUserSitesSource();
        wireAdmin();
        initMeasure();
        initRoute();
      });
    map.on('moveend', updateContourLabels);
    map.on('zoom', refreshSiteLabels);
    updateContourLabels();
  });

  function setVis(ids, on) {
    ids.forEach(function (id) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    });
  }
  function wireLayerToggles() {
    byId('t-relief').addEventListener('change', function (e) { setVis(['relief'], e.target.checked); });
    byId('t-contours').addEventListener('change', function (e) {
      state.contours = e.target.checked;
      setVis(['contour-waiver', 'contour-confident', 'contour-emphasis'], state.contours);
      updateContourLabels();
    });
    byId('t-sites').addEventListener('change', function (e) {
      state.sites = e.target.checked;
      setVis(['dive-circle'], state.sites);
      refreshSiteLabels();
    });
    byId('t-user-sites').addEventListener('change', function (e) { setVis(['user-circle'], e.target.checked); });
    byId('t-entries').addEventListener('change', function (e) { setVis(['entries-circle'], e.target.checked); });
    byId('t-prospects').addEventListener('change', function (e) { setVis(['prospects-circle'], e.target.checked); });
    byId('t-lidar').addEventListener('change', function (e) { setVis(['icesat2-line'], e.target.checked); });
    byId('t-geology').addEventListener('change', function (e) {
      state.geology = e.target.checked;
      setVis(['geology-fill', 'geology-line'], state.geology);
    });
    byId('t-3d').addEventListener('change', function (e) { set3D(e.target.checked); });
    byId('exag').addEventListener('input', function (e) {
      state.exag = parseFloat(e.target.value);
      byId('exag-val').innerHTML = state.exag.toFixed(1) + '&times;';
      if (state.is3d) map.setTerrain({ source: 'terrain', exaggeration: state.exag });
    });
  }
  function set3D(on) {
    state.is3d = on;
    byId('exag-row').hidden = !on;
    if (on) {
      map.setTerrain({ source: 'terrain', exaggeration: state.exag });
      map.easeTo({ pitch: 62, duration: 700 });
    } else {
      // exaggeration 0, not 1: nodata/land cells in the terrain tile decode via their
      // ALPHA channel (see pipeline/06_make_tiles.py's build_terrarium), not a value
      // sentinel, so a fully-transparent pixel's RGB still decodes to a real (very
      // negative) elevation. With any nonzero exaggeration that displaces the terrain
      // mesh even at pitch 0, producing wild spiked/shattered geometry at nodata edges.
      // Zero exaggeration flattens the mesh completely for the 2D view; it does not
      // affect queryTerrainElevation() readings since every call here passes
      // {exaggerated:false} (raw decoded value, independent of this setting).
      map.setTerrain({ source: 'terrain', exaggeration: 0 });
      map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
    }
  }

  // ---- Visitor layer gating: a layer's toggle row is hidden from non-admins when
  // layer_config.json marks it false. Admin always sees every toggle. ----
  function renderVisitorGating() {
    var KEYMAP = { relief: 't-relief', contours: 't-contours', sites: 't-sites', 'user-sites': 't-user-sites',
      entries: 't-entries', prospects: 't-prospects', lidar: 't-lidar', geology: 't-geology', '3d': 't-3d' };
    Object.keys(KEYMAP).forEach(function (key) {
      var input = byId(KEYMAP[key]);
      if (!input) return;
      var row = input.closest('.row');
      var visitorHidden = !isEffectiveAdmin() && state.layerConfig[key] === false;
      if (row) row.hidden = visitorHidden;
    });
  }

  function wireDepthReadout() {
    var elDepth = byId('ro-depth'), elLL = byId('ro-ll'), pending = null;
    function update(lngLat) {
      var el = null;
      try { el = map.queryTerrainElevation(lngLat, { exaggerated: false }); } catch (err) { el = null; }
      if (el !== null && el !== undefined && isFinite(el) && el < 5 && el > -2500) {
        elDepth.textContent = 'Depth: ' + depthLabel(el);
      } else {
        elDepth.textContent = 'Depth: ' + MINUS;
      }
      elLL.textContent = fmtLL(lngLat.lng, lngLat.lat);
    }
    function schedule(lngLat) {
      if (pending) cancelAnimationFrame(pending);
      pending = requestAnimationFrame(function () { pending = null; update(lngLat); });
    }
    map.on('mousemove', function (e) { schedule(e.lngLat); });
    map.on('click', function (e) {
      if (window.__measuring || window.__routing) return;
      update(e.lngLat);
    });
  }

  function sitePopupHtml(p) {
    var dmin = parseFloat(p.depth_min_m), dmax = parseFloat(p.depth_max_m), depthStr;
    if (isFinite(dmin) && isFinite(dmax)) {
      depthStr = (dmin === dmax) ? depthLabel(dmax)
        : depthLabel(Math.min(dmin, dmax)) + ' to ' + depthLabel(Math.max(dmin, dmax));
    } else { depthStr = MINUS; }
    var html = '<div class="site-pop"><h3>' + esc(p.name) + '</h3>' +
      '<div class="depth">' + depthStr + '</div>';
    if (p.description) html += '<p class="desc">' + esc(p.description) + '</p>';
    var meta = [];
    if (p.alt_names) meta.push('Also: ' + esc(p.alt_names));
    if (p.n_dives) meta.push(esc(p.n_dives) + ' logged dive(s)');
    if (p.collection) meta.push(esc(p.collection));
    if (meta.length) html += '<p class="meta">' + meta.join(' &middot; ') + '</p>';
    html += '</div>';
    return html;
  }

  function wireDiveSitePopups() {
    map.on('click', 'dive-circle', function (e) {
      var f = e.features[0]; if (!f) return;
      new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '260px' })
        .setLngLat(f.geometry.coordinates.slice()).setHTML(sitePopupHtml(f.properties)).addTo(map);
    });
    map.on('mouseenter', 'dive-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'dive-circle', function () { map.getCanvas().style.cursor = ''; });
  }

  function wireGeologyPopups() {
    map.on('click', 'geology-fill', function (e) {
      var f = e.features[0]; if (!f) return;
      var name = f.properties.geology || 'Unclassified';
      var html = '<div class="site-pop"><h3>CGS substrate</h3>' +
        '<div class="desc">' + esc(name) + '</div></div>';
      new maplibregl.Popup({ closeButton: true, offset: 8, maxWidth: '220px' })
        .setLngLat(e.lngLat).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'geology-fill', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'geology-fill', function () { map.getCanvas().style.cursor = ''; });
  }

  function wireUserSitePopups() {
    map.on('click', 'user-circle', function (e) {
      var f = e.features[0]; if (!f) return;
      new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '260px' })
        .setLngLat(f.geometry.coordinates.slice()).setHTML(sitePopupHtml(f.properties)).addTo(map);
    });
    map.on('mouseenter', 'user-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'user-circle', function () { map.getCanvas().style.cursor = ''; });
  }

  function wireProspectPopups() {
    map.on('click', 'prospects-circle', function (e) {
      var f = e.features[0]; if (!f) return;
      var p = f.properties;
      var html = '<div class="site-pop"><h3>Prospect lead #' + esc(p.rank) + '</h3>' +
        '<div class="depth">score ' + esc(p.score) + '</div>' +
        '<p class="desc">~' + esc(p.mean_depth_m) + ' m &middot; ' + esc(p.km_from_known_site) + ' km from nearest known site' +
        (p.cgs_substrate && p.cgs_substrate !== 'unknown' ? '<br>CGS substrate: <b>' + esc(p.cgs_substrate) + '</b>' : '') + '</p>' +
        '<p class="meta">' + esc(p.confidence || 'lead - ground-truth before diving') + '</p></div>';
      new maplibregl.Popup({ closeButton: true, offset: 8, maxWidth: '240px' })
        .setLngLat(f.geometry.coordinates.slice()).setHTML(html).addTo(map);
    });
    map.on('mouseenter', 'prospects-circle', function () { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'prospects-circle', function () { map.getCanvas().style.cursor = ''; });
  }

  var siteMarkers = [];
  var officialFC = null;   // populated once data/dive_sites.geojson loads; shared with My-sites + Admin
  function officialForDisplay() {
    var feats = (officialFC && officialFC.features || []).filter(function (f) {
      return isEffectiveAdmin() || f.properties.hidden !== true;
    });
    return fc(feats);
  }
  function applyOfficialSites() {
    var src = map.getSource('dive_sites');
    if (src) src.setData(officialForDisplay());
    rebuildSiteMarkers();
    renderCollections();
    renderSiteList();
    renderAdminSiteList();
  }
  function rebuildSiteMarkers() {
    siteMarkers.forEach(function (m) { m.remove(); });
    siteMarkers = [];
    (officialForDisplay().features || []).forEach(function (f) {
      var el = document.createElement('div');
      el.className = 'dlbl site';
      el.textContent = f.properties.name;
      var m = new maplibregl.Marker({ element: el, anchor: 'top', offset: [0, 7] })
        .setLngLat(f.geometry.coordinates).addTo(map);
      siteMarkers.push(m);
    });
    refreshSiteLabels();
  }
  function buildDiveLabels() {
    fetch('data/dive_sites.geojson').then(function (r) { return r.json(); }).then(function (loaded) {
      officialFC = loaded;
      wireDiveSitePopups();
      applyOfficialSites();
    }).catch(function () {});
  }
  function refreshSiteLabels() {
    var show = state.sites && map.getZoom() >= 11;
    siteMarkers.forEach(function (m) { m.getElement().style.display = show ? '' : 'none'; });
  }

  var contourMarkers = [];
  function clearContourLabels() { contourMarkers.forEach(function (m) { m.remove(); }); contourMarkers = []; }
  function updateContourLabels() {
    clearContourLabels();
    if (!state.contours || map.getZoom() < 13) return;
    var feats;
    try { feats = map.queryRenderedFeatures({ layers: ['contour-emphasis', 'contour-waiver'] }); }
    catch (e) { return; }
    var seen = {}, count = 0;
    for (var i = 0; i < feats.length && count < 60; i++) {
      var f = feats[i], p = f.properties;
      if (p.emphasis != 1) continue;
      var g = f.geometry; if (!g) continue;
      var line = g.type === 'MultiLineString' ? g.coordinates[0] : g.coordinates;
      if (!line || !line.length) continue;
      var c = line[Math.floor(line.length / 2)];
      var key = Math.round(p.depth) + '@' + c[0].toFixed(3) + ',' + c[1].toFixed(3);
      if (seen[key]) continue; seen[key] = 1;
      var el = document.createElement('div');
      el.className = 'dlbl depth' + (p.confident == 0 ? ' dim' : '');
      el.textContent = MINUS + Math.round(Math.abs(p.depth)) + ' m';
      contourMarkers.push(new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat(c).addTo(map));
      count++;
    }
  }

  /* ---------- panel / sheet plumbing ---------- */
  var panels = { layers: byId('layers'), mysites: byId('mysites'), admin: byId('admin') };
  var aboutPanel = byId('about'), scrim = byId('scrim');
  var sheetButtons = { layers: byId('btn-layers'), mysites: byId('btn-mysites'), admin: byId('btn-admin') };
  function panelKeyFor(panel) {
    for (var k in panels) if (panels[k] === panel) return k;
    return null;
  }
  function openPanel(panel, useScrim) {
    panel.hidden = false;
    if (useScrim) scrim.hidden = false;
    var key = panelKeyFor(panel);
    if (key) { sheetButtons[key].setAttribute('aria-expanded', 'true'); sheetButtons[key].classList.add('active'); }
  }
  function closePanel(panel) {
    panel.hidden = true;
    var key = panelKeyFor(panel);
    if (key) { sheetButtons[key].setAttribute('aria-expanded', 'false'); sheetButtons[key].classList.remove('active'); }
    if (aboutPanel.hidden) scrim.hidden = true;
  }
  function closeAllSheets(except) {
    Object.keys(panels).forEach(function (k) { if (panels[k] !== except && !panels[k].hidden) closePanel(panels[k]); });
  }
  function toggleSheet(panel) {
    if (panel.hidden) { closeAllSheets(panel); openPanel(panel, false); }
    else { closePanel(panel); }
  }
  byId('btn-layers').addEventListener('click', function () { toggleSheet(panels.layers); });
  byId('btn-mysites').addEventListener('click', function () { toggleSheet(panels.mysites); });
  byId('btn-admin').addEventListener('click', function () { toggleSheet(panels.admin); });
  byId('layers-close').addEventListener('click', function () { closePanel(panels.layers); });
  byId('mysites-close').addEventListener('click', function () { closePanel(panels.mysites); });
  byId('admin-close').addEventListener('click', function () { closePanel(panels.admin); });
  byId('btn-about').addEventListener('click', function () { openPanel(aboutPanel, true); });
  byId('about-close').addEventListener('click', function () { closePanel(aboutPanel); });
  scrim.addEventListener('click', function () { closePanel(aboutPanel); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!aboutPanel.hidden) { closePanel(aboutPanel); return; }
    Object.keys(panels).forEach(function (k) { if (!panels[k].hidden) closePanel(panels[k]); });
  });

  /* ---------- My dive sites: user collections (localStorage only, never touches the shipped Official dataset) ---------- */

  function loadUserData() {
    var data = null;
    try {
      var raw = localStorage.getItem(USER_SITES_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { data = null; }
    if (!data || !Array.isArray(data.collections)) {
      data = { version: 1, activeCollectionId: null, collections: [] };
    }
    return data;
  }
  var userData = loadUserData();
  function saveUserData() {
    try { localStorage.setItem(USER_SITES_KEY, JSON.stringify(userData)); } catch (e) {}
  }
  function findCollection(id) {
    for (var i = 0; i < userData.collections.length; i++) if (userData.collections[i].id === id) return userData.collections[i];
    return null;
  }
  function findSiteInCollection(col, id) {
    for (var i = 0; i < col.sites.length; i++) if (col.sites[i].id === id) return col.sites[i];
    return null;
  }
  function selectedCollectionId() { return userData.activeCollectionId || OFFICIAL_ID; }
  function addTargetCollection() {
    var id = selectedCollectionId();
    if (id === OFFICIAL_ID) return null;
    return findCollection(id);
  }
  function uniqueCollectionName(base) {
    var name = base, n = 2;
    while (userData.collections.some(function (c) { return c.name === name; })) { name = base + ' (' + n + ')'; n++; }
    return name;
  }

  function parseLatLon(latIn, lonIn) {
    var lat = parseFloat(latIn), lon = parseFloat(lonIn);
    if (!isFinite(lat) || !isFinite(lon)) return null;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    if (lat < AOI[1] - 2 || lat > AOI[3] + 2 || lon < AOI[0] - 2 || lon > AOI[2] + 2) return null;
    return { lat: lat, lon: lon };
  }
  function parseDepth(v) {
    if (v === undefined || v === null || v === '') return { ok: true, value: null };
    var n = parseFloat(v);
    if (!isFinite(n) || n < -1000 || n > 100) return { ok: false, value: null };
    return { ok: true, value: n };
  }

  function buildUserFC() {
    var feats = [];
    userData.collections.forEach(function (col) {
      col.sites.forEach(function (s) {
        feats.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
          properties: {
            name: s.name, depth_min_m: s.depth_min_m, depth_max_m: s.depth_max_m,
            description: s.description || '', alt_names: '', collection: col.name
          }
        });
      });
    });
    return fc(feats);
  }
  function refreshUserSitesSource() {
    var src = map.getSource('user_sites');
    if (src) src.setData(buildUserFC());
  }

  function siteToProps(s) {
    return { name: s.name, depth_min_m: s.depth_min_m, depth_max_m: s.depth_max_m, description: s.description || '', alt_names: '' };
  }
  function currentListSites() {
    var colId = selectedCollectionId();
    if (colId === OFFICIAL_ID) {
      return (officialFC && officialFC.features || []).filter(function (f) { return f.properties.hidden !== true; }).map(function (f, i) {
        return { id: 'official-' + i, name: f.properties.name, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], props: f.properties, editable: false };
      });
    }
    var col = findCollection(colId);
    if (!col) return [];
    return col.sites.map(function (s) {
      return { id: s.id, name: s.name, lon: s.lon, lat: s.lat, props: siteToProps(s), editable: true };
    });
  }

  function renderCollections() {
    var container = byId('ms-collections');
    if (!container) return;
    var sel = selectedCollectionId();
    var officialCount = (officialFC && officialFC.features && officialFC.features.filter(function (f) { return f.properties.hidden !== true; }).length) || 0;
    var html = '<div class="ms-col' + (sel === OFFICIAL_ID ? ' active' : '') + '" data-id="' + OFFICIAL_ID + '">' +
      '<span class="ms-col-name">Official <span class="ms-col-count">(' + officialCount + ')</span></span>' +
      '<span class="ms-col-badge">read-only</span></div>';
    userData.collections.forEach(function (col) {
      html += '<div class="ms-col' + (sel === col.id ? ' active' : '') + '" data-id="' + esc(col.id) + '">' +
        '<span class="ms-col-name">' + esc(col.name) + ' <span class="ms-col-count">(' + col.sites.length + ')</span></span>' +
        '<button type="button" class="ms-col-rename" data-id="' + esc(col.id) + '" aria-label="Rename ' + esc(col.name) + '">Rename</button>' +
        '<button type="button" class="ms-col-del" data-id="' + esc(col.id) + '" aria-label="Delete ' + esc(col.name) + '">Delete</button>' +
        '</div>';
    });
    container.innerHTML = html;
  }

  var msEditingId = null;
  function renderSiteList() {
    var listId = selectedCollectionId();
    var container = byId('ms-sites'), titleEl = byId('ms-list-title');
    if (!container) return;
    var items = currentListSites();
    var col = findCollection(listId);
    titleEl.textContent = (listId === OFFICIAL_ID ? 'Official' : (col ? col.name : 'Sites')) + ' (' + items.length + ')';
    if (!items.length) {
      container.innerHTML = '<p class="ms-empty">No sites yet.</p>';
      return;
    }
    var html = '';
    items.forEach(function (s) {
      var bits = [];
      var dmin = s.props.depth_min_m, dmax = s.props.depth_max_m;
      if (dmin !== null && dmin !== undefined && isFinite(dmin)) bits.push(dmin);
      if (dmax !== null && dmax !== undefined && isFinite(dmax) && dmax !== dmin) bits.push(dmax);
      var depthStr = bits.length ? bits.map(function (v) { return v + ' m'; }).join(' to ') : MINUS;
      html += '<div class="ms-site' + (s.editable ? ' editable' : '') + (msEditingId === s.id ? ' editing' : '') + '" data-id="' + esc(s.id) + '">' +
        '<input type="checkbox" class="ms-site-check" data-id="' + esc(s.id) + '" aria-label="Select ' + esc(s.name) + ' for export" />' +
        '<span class="ms-site-info"' + (s.editable ? ' tabindex="0" role="button"' : '') + '>' +
        '<span class="ms-site-name">' + esc(s.name) + '</span>' +
        '<span class="ms-site-depth">' + esc(depthStr) + '</span></span>' +
        (s.editable ? '<button type="button" class="ms-site-del" data-id="' + esc(s.id) + '" aria-label="Delete ' + esc(s.name) + '">&times;</button>' : '') +
        '</div>';
    });
    container.innerHTML = html;
  }

  function updateAddSectionState() {
    var col = addTargetCollection();
    var disabled = !col;
    ['ms-f-name', 'ms-f-lat', 'ms-f-lon', 'ms-f-dmin', 'ms-f-dmax', 'ms-f-desc', 'ms-add-submit'].forEach(function (id) {
      byId(id).disabled = disabled;
    });
    byId('ms-add-hint').hidden = !disabled;
    if (disabled && msEditingId) resetAddForm();
  }

  function showAddError(msg) {
    var el = byId('ms-add-error');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg; el.hidden = false;
  }
  function resetAddForm() {
    msEditingId = null;
    byId('ms-add-form').reset();
    byId('ms-add-submit').textContent = 'Add site';
    byId('ms-add-cancel').hidden = true;
    showAddError('');
  }
  function beginEditSite(site) {
    msEditingId = site.id;
    byId('ms-f-name').value = site.name;
    byId('ms-f-lat').value = site.lat;
    byId('ms-f-lon').value = site.lon;
    byId('ms-f-dmin').value = (site.depth_min_m === null || site.depth_min_m === undefined) ? '' : site.depth_min_m;
    byId('ms-f-dmax').value = (site.depth_max_m === null || site.depth_max_m === undefined) ? '' : site.depth_max_m;
    byId('ms-f-desc').value = site.description || '';
    byId('ms-add-submit').textContent = 'Save changes';
    byId('ms-add-cancel').hidden = false;
    showAddError('');
    renderSiteList();
  }
  function handleAddSubmit(e) {
    e.preventDefault();
    showAddError('');
    var col = addTargetCollection();
    if (!col) { showAddError('Select or create a personal collection first.'); return; }
    var name = byId('ms-f-name').value.trim();
    if (!name) { showAddError('Name is required.'); return; }
    var ll = parseLatLon(byId('ms-f-lat').value, byId('ms-f-lon').value);
    if (!ll) { showAddError('Latitude/longitude missing, non-numeric, or outside the Sodwana Bay area (check you have not swapped lat and lon).'); return; }
    var dminR = parseDepth(byId('ms-f-dmin').value.trim());
    if (!dminR.ok) { showAddError('Depth min looks invalid.'); return; }
    var dmaxR = parseDepth(byId('ms-f-dmax').value.trim());
    if (!dmaxR.ok) { showAddError('Depth max looks invalid.'); return; }
    var desc = byId('ms-f-desc').value.trim();

    if (msEditingId) {
      var site = findSiteInCollection(col, msEditingId);
      if (!site) { showAddError('Could not find site to edit.'); return; }
      site.name = name; site.lat = ll.lat; site.lon = ll.lon;
      site.depth_min_m = dminR.value; site.depth_max_m = dmaxR.value; site.description = desc;
    } else {
      col.sites.push({ id: uid(), name: name, lat: ll.lat, lon: ll.lon, depth_min_m: dminR.value, depth_max_m: dmaxR.value, description: desc });
    }
    saveUserData();
    resetAddForm();
    refreshUserSitesSource();
    renderCollections();
    renderSiteList();
  }

  /* ---- file import (hand-rolled CSV parser; GeoJSON via JSON.parse) ---- */
  function parseCSVRows(text) {
    var rows = [], row = [], field = '', inQuotes = false, i = 0, len = text.length;
    while (i < len) {
      var c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      } else {
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { row.push(field); field = ''; i++; continue; }
        if (c === '\r') { i++; continue; }
        if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
        field += c; i++; continue;
      }
    }
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
    return rows;
  }
  var CSV_HEADER_ALIASES = {
    name: ['name', 'site', 'sitename', 'site_name', 'title'],
    lat: ['lat', 'latitude', 'y'],
    lon: ['lon', 'lng', 'long', 'longitude', 'x'],
    depth_min_m: ['depth_min_m', 'depth_min', 'mindepth', 'min_depth', 'min_depth_m'],
    depth_max_m: ['depth_max_m', 'depth_max', 'maxdepth', 'max_depth', 'max_depth_m', 'depth', 'depth_m'],
    description: ['description', 'desc', 'notes', 'note'],
    collection: ['collection', 'folder', 'group', 'category']
  };
  function matchHeader(headers) {
    var idx = {};
    headers.forEach(function (h, i) {
      var key = String(h || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      Object.keys(CSV_HEADER_ALIASES).forEach(function (field) {
        if (idx[field] !== undefined) return;
        if (CSV_HEADER_ALIASES[field].indexOf(key) !== -1) idx[field] = i;
      });
    });
    return idx;
  }
  function parseCSVImport(text, withCollection) {
    var rows = parseCSVRows(text).filter(function (r) { return r.length && !(r.length === 1 && r[0].trim() === ''); });
    if (!rows.length) return { sites: [], skipped: 0, total: 0, error: 'Empty file.' };
    var idx = matchHeader(rows[0]);
    if (idx.lat === undefined || idx.lon === undefined) {
      return { sites: [], skipped: 0, total: rows.length - 1, error: 'Could not find latitude/longitude columns in the header row.' };
    }
    var sites = [], skipped = 0;
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      var name = idx.name !== undefined ? (row[idx.name] || '').trim() : '';
      var ll = parseLatLon(row[idx.lat], row[idx.lon]);
      if (!ll) { skipped++; continue; }
      var dminR = parseDepth(idx.depth_min_m !== undefined ? row[idx.depth_min_m] : '');
      var dmaxR = parseDepth(idx.depth_max_m !== undefined ? row[idx.depth_max_m] : '');
      var desc = idx.description !== undefined ? (row[idx.description] || '').trim() : '';
      var site = {
        id: uid(), name: name || ('Site ' + (sites.length + 1)),
        lat: ll.lat, lon: ll.lon,
        depth_min_m: dminR.ok ? dminR.value : null,
        depth_max_m: dmaxR.ok ? dmaxR.value : null,
        description: desc
      };
      if (withCollection && idx.collection !== undefined) site.collection = (row[idx.collection] || '').trim();
      sites.push(site);
    }
    return { sites: sites, skipped: skipped, total: rows.length - 1 };
  }
  function parseGeoJSONImport(text, withCollection) {
    var data = JSON.parse(text);
    var feats;
    if (data && data.type === 'FeatureCollection' && Array.isArray(data.features)) feats = data.features;
    else if (data && data.type === 'Feature') feats = [data];
    else return { sites: [], skipped: 0, total: 0, error: 'Not a GeoJSON Feature or FeatureCollection.' };
    var sites = [], skipped = 0;
    feats.forEach(function (f) {
      if (!f || !f.geometry || f.geometry.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) { skipped++; return; }
      var lon = f.geometry.coordinates[0], lat = f.geometry.coordinates[1];
      var ll = parseLatLon(lat, lon);
      if (!ll) { skipped++; return; }
      var p = f.properties || {};
      var dminR = parseDepth(p.depth_min_m), dmaxR = parseDepth(p.depth_max_m);
      var site = {
        id: uid(), name: p.name ? String(p.name) : ('Site ' + (sites.length + 1)),
        lat: ll.lat, lon: ll.lon,
        depth_min_m: dminR.ok ? dminR.value : null,
        depth_max_m: dmaxR.ok ? dmaxR.value : null,
        description: p.description ? String(p.description) : ''
      };
      if (withCollection && p.collection) site.collection = String(p.collection);
      sites.push(site);
    });
    return { sites: sites, skipped: skipped, total: feats.length };
  }
  function finishImport(filename, result) {
    var report = byId('ms-import-report');
    if (!result.sites.length) {
      report.hidden = false;
      report.className = 'ms-import-report ms-error';
      report.textContent = result.error || ('No usable rows found (skipped ' + result.skipped + ' of ' + result.total + ').');
      return;
    }
    var baseName = filename.replace(/\.[^.]+$/, '').trim() || 'Imported';
    var col = { id: uid(), name: uniqueCollectionName(baseName), sites: result.sites };
    userData.collections.push(col);
    userData.activeCollectionId = col.id;
    saveUserData();
    refreshUserSitesSource();
    renderCollections();
    renderSiteList();
    updateAddSectionState();
    report.hidden = false;
    report.className = 'ms-import-report';
    var msg = 'Imported ' + result.sites.length + ' site(s) into "' + col.name + '".';
    if (result.skipped) msg += ' Skipped ' + result.skipped + ' row(s) with unusable coordinates.';
    report.textContent = msg;
  }

  /* ---- export ---- */
  function selectedSiteIds(containerId) {
    var boxes = document.querySelectorAll('#' + containerId + ' .ms-site-check:checked');
    var ids = [];
    boxes.forEach(function (b) { ids.push(b.getAttribute('data-id')); });
    return ids;
  }
  function exportGeoJSON() {
    var ids = selectedSiteIds('ms-sites');
    var items = currentListSites().filter(function (s) { return ids.indexOf(s.id) !== -1; });
    if (!items.length) { window.alert('Select at least one site to export.'); return; }
    var out = fc(items.map(function (s) {
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: s.props };
    }));
    downloadBlob('dive-sites-export.geojson', 'application/geo+json', JSON.stringify(out, null, 2));
  }
  function csvEscape(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function exportCSV() {
    var ids = selectedSiteIds('ms-sites');
    var items = currentListSites().filter(function (s) { return ids.indexOf(s.id) !== -1; });
    if (!items.length) { window.alert('Select at least one site to export.'); return; }
    var lines = ['name,lat,lon,depth_min_m,depth_max_m,description'];
    items.forEach(function (s) {
      lines.push([csvEscape(s.props.name), s.lat, s.lon, csvEscape(s.props.depth_min_m), csvEscape(s.props.depth_max_m), csvEscape(s.props.description)].join(','));
    });
    downloadBlob('dive-sites-export.csv', 'text/csv', lines.join('\r\n'));
  }

  function initMySitesUI() {
    renderCollections();
    renderSiteList();
    updateAddSectionState();

    byId('ms-collections').addEventListener('click', function (e) {
      var renameBtn = e.target.closest('.ms-col-rename');
      var delBtn = e.target.closest('.ms-col-del');
      if (renameBtn) {
        var col = findCollection(renameBtn.getAttribute('data-id'));
        if (!col) return;
        var name = window.prompt('Rename collection', col.name);
        if (name === null) return;
        name = name.trim();
        if (!name) return;
        col.name = name;
        saveUserData();
        renderCollections();
        renderSiteList();
        return;
      }
      if (delBtn) {
        var col2 = findCollection(delBtn.getAttribute('data-id'));
        if (!col2) return;
        var ok = window.confirm('Delete collection "' + col2.name + '" and its ' + col2.sites.length + ' site(s)? This cannot be undone.');
        if (!ok) return;
        userData.collections = userData.collections.filter(function (c) { return c.id !== col2.id; });
        if (userData.activeCollectionId === col2.id) userData.activeCollectionId = null;
        saveUserData();
        refreshUserSitesSource();
        renderCollections();
        renderSiteList();
        updateAddSectionState();
        return;
      }
      var row = e.target.closest('.ms-col');
      if (row) {
        userData.activeCollectionId = row.getAttribute('data-id');
        saveUserData();
        renderCollections();
        renderSiteList();
        updateAddSectionState();
      }
    });

    byId('ms-newcol-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var input = byId('ms-newcol-name');
      var name = input.value.trim();
      if (!name) { input.focus(); return; }
      var col = { id: uid(), name: uniqueCollectionName(name), sites: [] };
      userData.collections.push(col);
      userData.activeCollectionId = col.id;
      saveUserData();
      input.value = '';
      renderCollections();
      renderSiteList();
      updateAddSectionState();
    });

    byId('ms-add-form').addEventListener('submit', handleAddSubmit);
    byId('ms-add-cancel').addEventListener('click', function () { resetAddForm(); renderSiteList(); });

    byId('ms-sites').addEventListener('click', function (e) {
      var delBtn = e.target.closest('.ms-site-del');
      if (delBtn) {
        var col = addTargetCollection();
        if (!col) return;
        var id = delBtn.getAttribute('data-id');
        var site = findSiteInCollection(col, id);
        if (!site) return;
        var ok = window.confirm('Delete site "' + site.name + '"?');
        if (!ok) return;
        col.sites = col.sites.filter(function (s) { return s.id !== id; });
        if (msEditingId === id) { msEditingId = null; resetAddForm(); }
        saveUserData();
        refreshUserSitesSource();
        renderCollections();
        renderSiteList();
        return;
      }
      var infoEl = e.target.closest('.ms-site-info');
      if (infoEl) {
        var row = infoEl.closest('.ms-site');
        if (!row || !row.classList.contains('editable')) return;
        var col2 = addTargetCollection();
        if (!col2) return;
        var site2 = findSiteInCollection(col2, row.getAttribute('data-id'));
        if (!site2) return;
        beginEditSite(site2);
      }
    });

    byId('ms-file').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var text = String(reader.result || '');
        var lower = file.name.toLowerCase();
        var result;
        try {
          result = (lower.slice(-8) === '.geojson' || lower.slice(-5) === '.json')
            ? parseGeoJSONImport(text, false)
            : parseCSVImport(text, false);
        } catch (err) {
          result = { sites: [], skipped: 0, total: 0, error: 'Could not parse file: ' + err.message };
        }
        finishImport(file.name, result);
        e.target.value = '';
      };
      reader.onerror = function () {
        finishImport(file.name, { sites: [], skipped: 0, total: 0, error: 'Could not read file.' });
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    byId('ms-select-all').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#ms-sites .ms-site-check');
      var allChecked = boxes.length > 0 && Array.prototype.every.call(boxes, function (b) { return b.checked; });
      boxes.forEach(function (b) { b.checked = !allChecked; });
    });
    byId('ms-export-geojson').addEventListener('click', exportGeoJSON);
    byId('ms-export-csv').addEventListener('click', exportCSV);
  }
  initMySitesUI();

  /* ============================================================
   * ADMIN — site-owner tools. Client-side password gate (sha256 hash only,
   * no backend possible on a static site); edits are session-local until
   * exported and committed. Distinct from "My dive sites" above, which is
   * every visitor's own private localStorage collection.
   * ========================================================== */
  var adEditingId = null;
  function wireAdmin() {
    byId('admin-unlock').addEventListener('click', function () {
      var pw = window.prompt('Admin password:');
      if (pw == null) return;
      sha256(pw).then(function (hash) {
        if (hash !== ADMIN_HASH) { window.alert('Incorrect password.'); return; }
        state.adminMode = true;
        try { sessionStorage.setItem('sb-admin', '1'); } catch (e) {}
        showAdminUnlocked();
        renderVisitorGating();
        applyOfficialSites();
      });
    });
    byId('admin-lock').addEventListener('click', function () {
      state.adminMode = false;
      state.previewAsVisitor = false;
      try { sessionStorage.removeItem('sb-admin'); } catch (e) {}
      byId('previewbar').classList.add('hidden');
      showAdminLocked();
      renderVisitorGating();
      applyOfficialSites();
    });
    byId('admin-preview').addEventListener('click', togglePreviewAsVisitor);
    byId('previewbar-exit').addEventListener('click', togglePreviewAsVisitor);

    byId('ad-add-form').addEventListener('submit', handleAdAddSubmit);
    byId('ad-add-cancel').addEventListener('click', function () { resetAdAddForm(); renderAdminSiteList(); });
    byId('ad-file').addEventListener('change', handleAdImport);
    byId('ad-select-all').addEventListener('click', function () {
      var boxes = document.querySelectorAll('#ad-sites .ms-site-check');
      var allChecked = boxes.length > 0 && Array.prototype.every.call(boxes, function (b) { return b.checked; });
      boxes.forEach(function (b) { b.checked = !allChecked; });
    });
    byId('ad-export-all').addEventListener('click', function () {
      downloadBlob('dive_sites.geojson', 'application/geo+json', JSON.stringify(officialFC, null, 2));
    });
    byId('ad-export-sel').addEventListener('click', function () {
      var ids = selectedSiteIds('ad-sites');
      var feats = (officialFC.features || []).filter(function (f, i) { return ids.indexOf('off-' + i) !== -1; });
      if (!feats.length) { window.alert('Select at least one site to export.'); return; }
      downloadBlob('dive_sites_selected.geojson', 'application/geo+json', JSON.stringify(fc(feats), null, 2));
    });
    byId('ad-export-config').addEventListener('click', function () {
      downloadBlob('layer_config.json', 'application/json', JSON.stringify(state.layerConfig, null, 2));
    });
    byId('ad-sites').addEventListener('click', handleAdSiteListClick);

    if (state.adminMode) showAdminUnlocked(); else showAdminLocked();
    renderAdminLayerConfig();
  }
  function showAdminLocked() { byId('admin-locked').hidden = false; byId('admin-unlocked').hidden = true; }
  function showAdminUnlocked() {
    byId('admin-locked').hidden = true; byId('admin-unlocked').hidden = false;
    byId('admin-preview').textContent = state.previewAsVisitor ? 'Exit preview (back to admin)' : 'Preview as visitor';
    renderAdminSiteList();
    renderAdminLayerConfig();
  }
  function togglePreviewAsVisitor() {
    state.previewAsVisitor = !state.previewAsVisitor;
    byId('previewbar').classList.toggle('hidden', !state.previewAsVisitor);
    byId('admin-preview').textContent = state.previewAsVisitor ? 'Exit preview (back to admin)' : 'Preview as visitor';
    renderVisitorGating();
    applyOfficialSites();
  }
  function renderAdminLayerConfig() {
    var box = byId('ad-layers');
    if (!box || !state.adminMode) return;
    var LABELS = { relief: 'Colour relief', contours: 'Depth contours', sites: 'Dive sites',
      'user-sites': 'My dive sites', entries: 'Dive entry points', prospects: 'Prospect leads',
      lidar: 'Lidar tracks', geology: 'Seafloor geology (CGS)', '3d': '3D terrain' };
    var html = '';
    Object.keys(LABELS).forEach(function (key) {
      var avail = state.layerConfig[key] !== false;
      html += '<label class="row toggle"><span class="row-label">' + LABELS[key] + '</span>' +
        '<input type="checkbox" class="ad-layer-cb" data-key="' + key + '" ' + (avail ? 'checked' : '') + ' />' +
        '<span class="switch" aria-hidden="true"></span></label>';
    });
    box.innerHTML = html;
    box.querySelectorAll('.ad-layer-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        state.layerConfig[cb.getAttribute('data-key')] = cb.checked;
        renderVisitorGating();
      });
    });
  }
  function renderAdminSiteList() {
    var container = byId('ad-sites');
    if (!container || !state.adminMode) return;
    var feats = officialFC && officialFC.features || [];
    if (!feats.length) { container.innerHTML = '<p class="ms-empty">No official sites yet.</p>'; return; }
    var html = '';
    feats.forEach(function (f, i) {
      var p = f.properties, id = 'off-' + i;
      var bits = [];
      if (isFinite(p.depth_min_m)) bits.push(p.depth_min_m);
      if (isFinite(p.depth_max_m) && p.depth_max_m !== p.depth_min_m) bits.push(p.depth_max_m);
      var depthStr = bits.length ? bits.map(function (v) { return v + ' m'; }).join(' to ') : MINUS;
      html += '<div class="ms-site editable' + (adEditingId === id ? ' editing' : '') + (p.hidden === true ? ' ad-hidden' : '') + '" data-id="' + id + '">' +
        '<input type="checkbox" class="ms-site-check" data-id="' + id + '" aria-label="Select ' + esc(p.name) + ' for export" />' +
        '<span class="ms-site-info" tabindex="0" role="button">' +
        '<span class="ms-site-name">' + esc(p.name) + (p.hidden === true ? ' (hidden)' : '') + (p.verified === false ? ' <i>(unverified)</i>' : '') + '</span>' +
        '<span class="ms-site-depth">' + esc(depthStr) + (p.collection ? ' &middot; ' + esc(p.collection) : '') + '</span></span>' +
        '<button type="button" class="ms-site-del" data-id="' + id + '" aria-label="Delete ' + esc(p.name) + '">&times;</button>' +
        '</div>';
    });
    container.innerHTML = html;
  }
  function officialFeatureByRowId(id) {
    var i = parseInt(id.replace('off-', ''), 10);
    return (officialFC.features || [])[i] || null;
  }
  function resetAdAddForm() {
    adEditingId = null;
    byId('ad-add-form').reset();
    byId('ad-add-submit').textContent = 'Add site';
    byId('ad-add-cancel').hidden = true;
    showAdAddError('');
  }
  function showAdAddError(msg) {
    var el = byId('ad-add-error');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.textContent = msg; el.hidden = false;
  }
  function handleAdAddSubmit(e) {
    e.preventDefault();
    showAdAddError('');
    var name = byId('ad-f-name').value.trim();
    if (!name) { showAdAddError('Name is required.'); return; }
    var ll = parseLatLon(byId('ad-f-lat').value, byId('ad-f-lon').value);
    if (!ll) { showAdAddError('Latitude/longitude missing, non-numeric, or outside the Sodwana Bay area.'); return; }
    var dminR = parseDepth(byId('ad-f-dmin').value.trim());
    if (!dminR.ok) { showAdAddError('Depth min looks invalid.'); return; }
    var dmaxR = parseDepth(byId('ad-f-dmax').value.trim());
    if (!dmaxR.ok) { showAdAddError('Depth max looks invalid.'); return; }
    var coll = byId('ad-f-coll').value.trim();
    var desc = byId('ad-f-desc').value.trim();

    if (adEditingId) {
      var f = officialFeatureByRowId(adEditingId);
      if (!f) { showAdAddError('Could not find site to edit.'); return; }
      f.properties.name = name;
      f.geometry.coordinates = [ll.lon, ll.lat];
      f.properties.depth_min_m = dminR.value; f.properties.depth_max_m = dmaxR.value;
      f.properties.collection = coll || undefined;
      f.properties.description = desc || undefined;
    } else {
      officialFC.features.push({
        type: 'Feature',
        properties: { name: name, depth_min_m: dminR.value, depth_max_m: dmaxR.value, collection: coll || undefined, description: desc || undefined, verified: false },
        geometry: { type: 'Point', coordinates: [ll.lon, ll.lat] }
      });
    }
    resetAdAddForm();
    applyOfficialSites();
  }
  function handleAdImport(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var lower = file.name.toLowerCase();
      var result;
      try {
        result = (lower.slice(-8) === '.geojson' || lower.slice(-5) === '.json')
          ? parseGeoJSONImport(text, true)
          : parseCSVImport(text, true);
      } catch (err) {
        result = { sites: [], skipped: 0, total: 0, error: 'Could not parse file: ' + err.message };
      }
      var report = byId('ad-import-report');
      if (!result.sites.length) {
        report.hidden = false; report.className = 'ms-import-report ms-error';
        report.textContent = result.error || ('No usable rows found (skipped ' + result.skipped + ' of ' + result.total + ').');
        e.target.value = ''; return;
      }
      result.sites.forEach(function (s) {
        officialFC.features.push({
          type: 'Feature',
          properties: { name: s.name, depth_min_m: s.depth_min_m, depth_max_m: s.depth_max_m, description: s.description || undefined, collection: s.collection || undefined, verified: false },
          geometry: { type: 'Point', coordinates: [s.lon, s.lat] }
        });
      });
      applyOfficialSites();
      report.hidden = false; report.className = 'ms-import-report';
      var msg = 'Imported ' + result.sites.length + ' site(s) into the official dataset.';
      if (result.skipped) msg += ' Skipped ' + result.skipped + ' row(s) with unusable coordinates.';
      report.textContent = msg;
      e.target.value = '';
    };
    reader.onerror = function () { e.target.value = ''; };
    reader.readAsText(file);
  }
  function handleAdSiteListClick(e) {
    var delBtn = e.target.closest('.ms-site-del');
    if (delBtn) {
      var id = delBtn.getAttribute('data-id');
      var f = officialFeatureByRowId(id);
      if (!f) return;
      var ok = window.confirm('Delete site "' + f.properties.name + '"? This only affects your session until exported.');
      if (!ok) return;
      officialFC.features = officialFC.features.filter(function (x) { return x !== f; });
      if (adEditingId === id) resetAdAddForm();
      applyOfficialSites();
      return;
    }
    var infoEl = e.target.closest('.ms-site-info');
    if (infoEl) {
      var row = infoEl.closest('.ms-site');
      if (!row) return;
      var id2 = row.getAttribute('data-id');
      var f2 = officialFeatureByRowId(id2);
      if (!f2) return;
      adEditingId = id2;
      byId('ad-f-name').value = f2.properties.name || '';
      byId('ad-f-lat').value = f2.geometry.coordinates[1];
      byId('ad-f-lon').value = f2.geometry.coordinates[0];
      byId('ad-f-dmin').value = f2.properties.depth_min_m == null ? '' : f2.properties.depth_min_m;
      byId('ad-f-dmax').value = f2.properties.depth_max_m == null ? '' : f2.properties.depth_max_m;
      byId('ad-f-coll').value = f2.properties.collection || '';
      byId('ad-f-desc').value = f2.properties.description || '';
      byId('ad-add-submit').textContent = 'Save changes';
      byId('ad-add-cancel').hidden = false;
      showAdAddError('');
      renderAdminSiteList();
    }
  }

  /* ============================================================
   * MEASURE — click-to-measure distance tool (top icon button + HUD).
   * ========================================================== */
  function initMeasure() {
    var pts = [];
    var btn = byId('btn-measure'), hud = byId('measure-hud'), stats = byId('measure-hud-stats');
    function reset() {
      pts = [];
      var src = map.getSource('measure_src');
      if (src) src.setData(fc([]));
      stats.textContent = 'Click the map to start measuring';
    }
    function setActive(on) {
      window.__measuring = on;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      hud.hidden = !on;
      map.getCanvas().style.cursor = on ? 'crosshair' : '';
      if (on && window.__routing) { byId('btn-route').click(); }
      if (!on) reset();
    }
    btn.addEventListener('click', function () { setActive(!window.__measuring); });
    byId('measure-done').addEventListener('click', function () { setActive(false); });
    map.on('click', function (e) {
      if (!window.__measuring) return;
      pts.push([e.lngLat.lng, e.lngLat.lat]);
      var feats = pts.map(function (p) { return { type: 'Feature', geometry: { type: 'Point', coordinates: p }, properties: {} }; });
      if (pts.length > 1) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} });
      map.getSource('measure_src').setData(fc(feats));
      if (pts.length > 1) {
        var R = window.SodwanaRoute;
        var dd = R.totalKm(pts), b = R.bearingDeg(pts[pts.length - 2], pts[pts.length - 1]);
        stats.textContent = Math.round(dd * 1000) + ' m total · last leg bearing ' + Math.round(b) + '°';
      } else {
        stats.textContent = '1 point · click again to measure';
      }
    });
  }

  /* ============================================================
   * PLAN ROUTE — click a polyline of waypoints, sample depth along it, and
   * produce a dive-planning summary + exportable report.
   * ========================================================== */
  var routeWp = [];
  var routeNumMarkers = [];
  function initRoute() {
    var btn = byId('btn-route'), hud = byId('route-hud');
    var lastRoute = null;
    function clearRouteNumMarkers() { routeNumMarkers.forEach(function (m) { m.remove(); }); routeNumMarkers = []; }
    function rebuildLayers() {
      var feats = routeWp.map(function (p, i) { return { type: 'Feature', properties: { n: i + 1 }, geometry: { type: 'Point', coordinates: p } }; });
      if (routeWp.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeWp } });
      map.getSource('route_src').setData(fc(feats));
      clearRouteNumMarkers();
      routeWp.forEach(function (p, i) {
        var el = document.createElement('div');
        el.className = 'dlbl route-num';
        el.textContent = String(i + 1);
        routeNumMarkers.push(new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -6] }).setLngLat(p).addTo(map));
      });
    }
    function updateHud() {
      var R = window.SodwanaRoute;
      byId('route-hud-stats').textContent = routeWp.length + (routeWp.length === 1 ? ' point' : ' points') + ' · ' + Math.round(R.totalKm(routeWp) * 1000) + ' m';
      byId('route-confirm').disabled = routeWp.length < 2;
    }
    function reset() {
      routeWp = [];
      var src = map.getSource('route_src');
      if (src) src.setData(fc([]));
      clearRouteNumMarkers();
      updateHud();
    }
    function setActive(on) {
      window.__routing = on;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('active', on);
      hud.hidden = !on;
      map.getCanvas().style.cursor = on ? 'crosshair' : '';
      if (on) {
        if (window.__measuring) byId('btn-measure').click();
        reset();
      } else { reset(); }
    }
    btn.addEventListener('click', function () { setActive(!window.__routing); });
    map.on('click', function (e) {
      if (!window.__routing) return;
      routeWp.push([e.lngLat.lng, e.lngLat.lat]);
      rebuildLayers();
      updateHud();
    });
    byId('route-cancel').addEventListener('click', function () { setActive(false); });
    byId('route-confirm').addEventListener('click', function () {
      if (routeWp.length < 2) return;
      var R = window.SodwanaRoute;
      var wp = routeWp.slice();
      var legsResult = R.routeLegs(wp);
      var profile = R.sampleRouteProfile(map, wp);
      lastRoute = { wp: wp, legsResult: legsResult, profile: profile };
      byId('route-summary-body').innerHTML = buildRouteSummaryHTML(wp, legsResult, profile);
      var ta = byId('route-export-text'); ta.hidden = true; ta.value = '';
      byId('route-export-copy').hidden = true;
      setActive(false);
      openPanel(byId('route-summary'), true);
    });
    byId('route-summary-close').addEventListener('click', function () { closePanel(byId('route-summary')); });
    byId('route-summary-export').addEventListener('click', function () {
      if (!lastRoute) return;
      var R = window.SodwanaRoute;
      var ta = byId('route-export-text');
      ta.value = R.formatRouteReport(lastRoute.wp, lastRoute.legsResult, lastRoute.profile);
      ta.hidden = false;
      byId('route-export-copy').hidden = false;
    });
    byId('route-export-copy').addEventListener('click', function () {
      navigator.clipboard.writeText(byId('route-export-text').value);
    });
  }
  function depthReadingHTML(reading) {
    if (!reading || reading.depthM === null) return 'no data (land / outside coverage)';
    var tag = reading.band ? ' <small style="color:var(--ink-dim)">' + esc(reading.band.label) + ' — ' + esc(reading.band.status) + '</small>' : '';
    return reading.depthM.toFixed(1) + ' m' + tag;
  }
  function buildRouteSummaryHTML(wp, legsResult, profile) {
    var R = window.SodwanaRoute;
    var stats = profile && profile.stats;
    var P = [];
    P.push('<p><b>Entry point</b><br><code>' + wp[0][1].toFixed(6) + ', ' + wp[0][0].toFixed(6) + '</code></p>');
    P.push('<p><b>Waypoints (' + wp.length + ')</b><br>' + wp.map(function (pt) { return pt[1].toFixed(6) + ', ' + pt[0].toFixed(6); }).join('<br>') + '</p>');
    var crossed = (profile && profile.bandsCrossed) || [];
    if (crossed.indexOf('optical-wall') !== -1 || crossed.indexOf('coarse') !== -1) {
      P.push('<p class="warn">This route passes deeper than 15 m. Depths beyond 15 m are lower-confidence.</p>');
    }
    P.push('<div>' + R.routeProfileSVG(profile) + '</div>');
    if (stats) {
      P.push('<p><b>Depth summary</b><br>' +
        'Entry: ' + depthReadingHTML(stats.entry) + '<br>' +
        (stats.max && stats.max.depthM !== null
          ? 'Deepest: ' + depthReadingHTML(stats.max) + ' <small style="color:var(--ink-dim)">(at ' + Math.round(stats.max.dM) + ' m along route)</small><br>'
          : 'Deepest: no data<br>') +
        'Average: ' + (stats.avg && stats.avg.depthM !== null ? stats.avg.depthM.toFixed(1) + ' m' : 'no data') + '<br>' +
        'Exit: ' + depthReadingHTML(stats.exit) + '<br>' +
        '<small style="color:var(--ink-dim)">' + stats.validCount + '/' + stats.sampleCount + ' samples had depth data</small></p>');
    }
    var legs = (legsResult && legsResult.legs) || [];
    if (legs.length) {
      P.push('<p><b>Legs</b><br>' + legs.map(function (leg) {
        return 'Leg ' + leg.index + ': heading ' + String(Math.round(leg.bearingDeg)).padStart(3, '0') + '°, distance ' + Math.round(leg.distanceM) + ' m';
      }).join('<br>') + '<br><b>Total: ' + Math.round(legsResult.totalM) + ' m (' + (legsResult.totalM / 1000).toFixed(2) + ' km)</b></p>');
    }
    return P.join('');
  }

  var THEME_KEY = 'sodwana-theme';
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (!saved) saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    applyTheme(saved);
  })();
  byId('btn-theme').addEventListener('click', function () {
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
  });
})();
