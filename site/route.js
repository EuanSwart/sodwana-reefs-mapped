/* Sodwana Bay Reef Map — Plan Route logic. Author: Euan Swart.
 * Plain script (not a module) exposing window.SodwanaRoute, matching app.js's IIFE style.
 * Depth convention: seafloor depths are NEGATIVE metres. Never flip the sign.
 * Depth sampling uses map.queryTerrainElevation against the 'terrain' raster-dem source —
 * same API app.js's own depth-readout pill already relies on in production. */
(function () {
  'use strict';

  /** @param {[number,number]} a @param {[number,number]} b  a,b = [lon,lat] -> km */
  function haversineKm(a, b) {
    var R = 6371, toR = function (x) { return x * Math.PI / 180; };
    var dlat = toR(b[1] - a[1]), dlon = toR(b[0] - a[0]);
    var h = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.pow(Math.sin(dlon / 2), 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** initial bearing 0..360 (0=N) */
  function bearingDeg(a, b) {
    var toR = function (x) { return x * Math.PI / 180; }, toD = function (x) { return x * 180 / Math.PI; };
    var y = Math.sin(toR(b[0] - a[0])) * Math.cos(toR(b[1]));
    var x = Math.cos(toR(a[1])) * Math.sin(toR(b[1])) - Math.sin(toR(a[1])) * Math.cos(toR(b[1])) * Math.cos(toR(b[0] - a[0]));
    return (toD(Math.atan2(y, x)) + 360) % 360;
  }

  function totalKm(pts) {
    var s = 0;
    for (var i = 1; i < pts.length; i++) s += haversineKm(pts[i - 1], pts[i]);
    return s;
  }

  function routeLegs(waypoints) {
    var legs = [], totalM = 0, wp = waypoints || [];
    for (var i = 1; i < wp.length; i++) {
      var from = wp[i - 1], to = wp[i];
      var distanceM = haversineKm(from, to) * 1000;
      totalM += distanceM;
      legs.push({ index: i, from: from, to: to, distanceM: distanceM, bearingDeg: bearingDeg(from, to) });
    }
    return { legs: legs, totalM: totalM };
  }

  // Accuracy bands, matching the reconciled DEM's own validated gates
  // (0-15 m RMSE 1.47 PASS; 15-25 m RMSE ~4.8, documented data-limited waiver).
  var ACCURACY_BANDS = [
    { key: 'validated', maxAbs: 15, label: '0-15 m · validated', rmse: 1.47, status: 'PASS' },
    { key: 'optical-wall', maxAbs: 25, label: '15-25 m · reduced confidence', rmse: 4.8, status: 'data-limited waiver (documented, hatched on map)' },
    { key: 'coarse', maxAbs: Infinity, label: '>25 m · sparse data', rmse: null, status: 'canyon/deep zone — fewer soundings, treat as indicative' },
  ];

  function bandForDepth(depthM) {
    if (depthM === null || depthM === undefined) return null;
    var a = Math.abs(depthM);
    for (var i = 0; i < ACCURACY_BANDS.length; i++) if (a <= ACCURACY_BANDS[i].maxAbs) return ACCURACY_BANDS[i];
    return ACCURACY_BANDS[ACCURACY_BANDS.length - 1];
  }

  // A queried elevation counts as real seafloor if it's finite, below sea level with a
  // small tolerance, and not implausibly deep (guards against a stray decode artifact) —
  // same sanity bounds app.js's own live depth-readout pill already uses.
  function validDepth(el) {
    return typeof el === 'number' && isFinite(el) && el < 5 && el > -2500;
  }

  /**
   * Sample depth along a route using the map's already-loaded terrain tiles.
   * MUST NEVER THROW: any per-sample query failure records depthM: null and continues.
   * @param {maplibregl.Map} map
   * @param {[number,number][]} waypoints  [lon,lat] pairs
   * @param {{spacingM?:number,maxSamples?:number}} [opts]
   */
  function sampleRouteProfile(map, waypoints, opts) {
    var options = opts || {};
    var wp = waypoints || [];
    var lr = routeLegs(wp), legs = lr.legs, totalM = lr.totalM;

    var emptyStats = {
      entry: { depthM: null, band: null }, exit: { depthM: null, band: null },
      max: { depthM: null, band: null, dM: null }, avg: { depthM: null },
      sampleCount: 0, validCount: 0, invalidCount: 0,
    };
    if (wp.length < 1) return { ok: false, totalM: 0, samples: [], stats: emptyStats, bandsCrossed: [] };

    var spacingM = Math.max(options.spacingM || 12, totalM / (options.maxSamples || 400));
    var positions = [];
    if (wp.length === 1 || totalM === 0) {
      positions.push({ lon: wp[0][0], lat: wp[0][1], dM: 0 });
    } else {
      var cumBefore = 0;
      positions.push({ lon: wp[0][0], lat: wp[0][1], dM: 0 });
      for (var li = 0; li < legs.length; li++) {
        var leg = legs[li], legLen = leg.distanceM;
        var lon0 = leg.from[0], lat0 = leg.from[1], lon1 = leg.to[0], lat1 = leg.to[1];
        if (legLen > 0) {
          var d = spacingM * Math.ceil((cumBefore + 1e-6) / spacingM) - cumBefore;
          for (; d < legLen - 1e-6; d += spacingM) {
            var t = d / legLen;
            positions.push({ lon: lon0 + (lon1 - lon0) * t, lat: lat0 + (lat1 - lat0) * t, dM: cumBefore + d });
          }
        }
        cumBefore += legLen;
        positions.push({ lon: lon1, lat: lat1, dM: cumBefore });
      }
    }

    var samples = [];
    for (var i = 0; i < positions.length; i++) {
      var pos = positions[i], depthM = null;
      try {
        var el = map.queryTerrainElevation({ lng: pos.lon, lat: pos.lat }, { exaggerated: false });
        if (validDepth(el)) depthM = el;
      } catch (e) { depthM = null; }
      samples.push({ dM: pos.dM, lon: pos.lon, lat: pos.lat, depthM: depthM, band: bandForDepth(depthM) });
    }

    var validCount = 0, sum = 0, deepest = null;
    for (var s = 0; s < samples.length; s++) {
      var sm = samples[s];
      if (sm.depthM === null) continue;
      validCount++; sum += sm.depthM;
      if (deepest === null || sm.depthM < deepest.depthM) deepest = sm;
    }
    var sampleCount = samples.length;
    var first = samples[0], last = samples[samples.length - 1];
    var stats = {
      entry: { depthM: first.depthM, band: first.band },
      exit: { depthM: last.depthM, band: last.band },
      max: deepest ? { depthM: deepest.depthM, band: deepest.band, dM: deepest.dM } : { depthM: null, band: null, dM: null },
      avg: { depthM: validCount ? sum / validCount : null },
      sampleCount: sampleCount, validCount: validCount, invalidCount: sampleCount - validCount,
    };
    var bandsCrossed = [];
    for (var c = 0; c < samples.length; c++) {
      var b = samples[c].band;
      if (b && bandsCrossed.indexOf(b.key) === -1) bandsCrossed.push(b.key);
    }
    return { ok: validCount > 0, totalM: totalM, samples: samples, stats: stats, bandsCrossed: bandsCrossed };
  }

  function fmtDepth(depthM) { return depthM === null ? 'no data' : depthM.toFixed(1) + ' m'; }
  function fmtLonLat(pt) { return pt[1].toFixed(6) + ', ' + pt[0].toFixed(6); } // lat, lon
  function fmtHeading(deg) { var r = Math.round(deg); return (r < 10 ? '00' : r < 100 ? '0' : '') + r + '°'; }
  function bandTag(band) { return band ? ' [' + band.label + ' — ' + band.status + ']' : ''; }
  function depthLine(reading) {
    if (!reading || reading.depthM === null) return 'no data (land / outside coverage)';
    return fmtDepth(reading.depthM) + bandTag(reading.band);
  }

  function formatRouteReport(waypoints, legsResult, profile) {
    var wp = waypoints || [], L = [];
    L.push('Sodwana Bay — Planned Route');
    L.push('==============================');
    L.push('');
    if (wp.length) {
      var entryDepth = profile && profile.stats ? profile.stats.entry : null;
      L.push('Entry point: ' + fmtLonLat(wp[0]));
      L.push('  depth: ' + depthLine(entryDepth));
    } else { L.push('Entry point: (no waypoints)'); }
    L.push('');
    L.push('Waypoints:');
    wp.forEach(function (pt, i) { L.push('  ' + (i + 1) + '. ' + fmtLonLat(pt)); });
    L.push('');
    var legs = (legsResult && legsResult.legs) || [];
    if (legs.length) {
      L.push('Legs:');
      legs.forEach(function (leg) {
        L.push('  Leg ' + leg.index + ' -> ' + (leg.index + 1) + ': heading ' + fmtHeading(leg.bearingDeg) + ', distance ' + Math.round(leg.distanceM) + ' m');
      });
      L.push('');
    }
    var totalM = (legsResult && legsResult.totalM) || 0;
    L.push('Total distance: ' + Math.round(totalM) + ' m (' + (totalM / 1000).toFixed(2) + ' km)');
    L.push('');
    var stats = profile && profile.stats;
    L.push('Depth summary:');
    if (stats) {
      L.push('  Entry:   ' + depthLine(stats.entry));
      if (stats.max && stats.max.depthM !== null) {
        L.push('  Deepest: ' + fmtDepth(stats.max.depthM) + bandTag(stats.max.band) + ' (at ' + Math.round(stats.max.dM) + ' m along route)');
      } else { L.push('  Deepest: no data (land / outside coverage)'); }
      L.push('  Average: ' + (stats.avg && stats.avg.depthM !== null ? fmtDepth(stats.avg.depthM) : 'no data (land / outside coverage)'));
      L.push('  Exit:    ' + depthLine(stats.exit));
      L.push('  (' + stats.validCount + '/' + stats.sampleCount + ' samples had depth data)');
    } else { L.push('  no depth profile available'); }
    var crossed = (profile && profile.bandsCrossed) || [];
    if (crossed.indexOf('optical-wall') !== -1 || crossed.indexOf('coarse') !== -1) {
      L.push('');
      L.push('Note: this route crosses into lower-confidence depth bands (see per-reading');
      L.push('labels above) — treat depths beyond 15 m as indicative, not precise.');
    }
    return L.join('\n');
  }

  // Pure SVG depth-profile chart. X = distance along route, Y = depth (0 at top).
  // Line breaks at null-depth samples; each contiguous run is coloured by its worst
  // (highest-uncertainty) band so the chart never overstates confidence.
  function routeProfileSVG(profile) {
    var W = 300, H = 156, plotX0 = 38, plotX1 = 292, plotY0 = 10, plotY1 = 108;
    var samples = (profile && profile.samples) || [];
    var totalM = (profile && profile.totalM) || 0;
    var dataMin = 0;
    for (var i = 0; i < samples.length; i++) if (samples[i].depthM !== null && samples[i].depthM < dataMin) dataMin = samples[i].depthM;
    var yBottom = Math.min(-25, dataMin);
    function xFor(dM) { return totalM > 0 ? plotX0 + (dM / totalM) * (plotX1 - plotX0) : (plotX0 + plotX1) / 2; }
    function yFor(d) { return plotY0 + (yBottom !== 0 ? (0 - d) / (0 - yBottom) : 0) * (plotY1 - plotY0); }
    var bandColor = { validated: '#35c2d6', 'optical-wall': '#ffb238', coarse: '#ff6b6b' };
    function bandIdx(k) { for (var i = 0; i < ACCURACY_BANDS.length; i++) if (ACCURACY_BANDS[i].key === k) return i; return 0; }

    var P = [];
    P.push('<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="display:block;background:transparent">');
    var ticks = [0, -15, -25];
    if (dataMin < -25) ticks.push(Math.round(dataMin));
    ticks.forEach(function (t) {
      if (t < yBottom - 0.001) return;
      var y = yFor(t);
      P.push('<line x1="' + plotX0 + '" y1="' + y.toFixed(1) + '" x2="' + plotX1 + '" y2="' + y.toFixed(1) + '" stroke="var(--border)" stroke-width="0.6"' + (t === 0 ? '' : ' stroke-dasharray="3 3"') + '/>');
      P.push('<text x="' + (plotX0 - 4) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="var(--ink-dim)">' + t + ' m</text>');
    });
    P.push('<text x="' + plotX0 + '" y="' + (plotY1 + 12) + '" font-size="9" fill="var(--ink-dim)">0 m</text>');
    P.push('<text x="' + plotX1 + '" y="' + (plotY1 + 12) + '" text-anchor="end" font-size="9" fill="var(--ink-dim)">' + Math.round(totalM) + ' m</text>');

    var runs = [], cur = null;
    for (var s = 0; s < samples.length; s++) {
      if (samples[s].depthM === null) { cur = null; continue; }
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(samples[s]);
    }
    runs.forEach(function (run) {
      var worst = 0;
      run.forEach(function (s2) { var i2 = s2.band ? bandIdx(s2.band.key) : 0; if (i2 > worst) worst = i2; });
      var color = bandColor[ACCURACY_BANDS[worst].key] || '#35c2d6';
      if (run.length === 1) {
        P.push('<circle cx="' + xFor(run[0].dM).toFixed(1) + '" cy="' + yFor(run[0].depthM).toFixed(1) + '" r="1.8" fill="' + color + '"/>');
      } else {
        var pts = run.map(function (s3) { return xFor(s3.dM).toFixed(1) + ',' + yFor(s3.depthM).toFixed(1); }).join(' ');
        P.push('<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>');
      }
    });
    if (!runs.length) P.push('<text x="' + (W / 2) + '" y="' + ((plotY0 + plotY1) / 2) + '" text-anchor="middle" font-size="10" fill="var(--ink-dim)">no depth data along this route</text>');

    var lx = plotX0, ly = H - 8;
    ACCURACY_BANDS.forEach(function (b) {
      var col = bandColor[b.key];
      P.push('<rect x="' + lx + '" y="' + (ly - 8) + '" width="9" height="9" rx="2" fill="' + col + '"/>');
      P.push('<text x="' + (lx + 12) + '" y="' + ly + '" font-size="8" fill="var(--ink-dim)">' + b.key + '</text>');
      lx += 12 + b.key.length * 4.4 + 10;
    });
    P.push('</svg>');
    return P.join('');
  }

  window.SodwanaRoute = {
    haversineKm: haversineKm, bearingDeg: bearingDeg, totalKm: totalKm, routeLegs: routeLegs,
    ACCURACY_BANDS: ACCURACY_BANDS, bandForDepth: bandForDepth,
    sampleRouteProfile: sampleRouteProfile, formatRouteReport: formatRouteReport, routeProfileSVG: routeProfileSVG,
  };
})();
