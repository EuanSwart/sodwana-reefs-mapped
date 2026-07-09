/* Sodwana Bay bathymetry — Plan Route pure-logic module.
 *
 * NO DOM, NO maplibre imports, NO `map` object. Imported by app.js
 * (a <script type="module">). All geometry/reporting logic for the
 * "Plan Route" feature lives here so it can be reasoned about and
 * tested in isolation.
 *
 * Depth convention (project-wide): seafloor depths are NEGATIVE metres.
 * Never flip the sign. Land / nodata is encoded in the DEM tiles as a
 * +10 m sentinel; any decoded elevation >= 9.5 is treated as no-data
 * (depthM: null) — never a fabricated depth.
 *
 * Sampling uses NEAREST-NEIGHBOUR pixel lookup only (no bilinear): the
 * fused raster is already authoritative, and bilinear blending across the
 * +10 m land sentinel near coastlines would fabricate plausible-but-wrong
 * depths, violating this project's "never interpolate detail the data
 * doesn't support" principle (see CLAUDE.md).
 */

/* ------------------------------------------------------------------ *
 * Great-circle geometry.
 * haversineKm / bearingDeg / totalKm are extracted verbatim (same
 * formulas, same units) from app.js's former local `haversine`,
 * `bearing`, `totalKm` so the existing measure-distance tool keeps
 * identical behaviour after app.js switches to importing these.
 * ------------------------------------------------------------------ */

/** @param {[number,number]} a @param {[number,number]} b  a,b = [lon,lat] -> km */
export function haversineKm(a, b) {
  const R = 6371, toR = (x) => x * Math.PI / 180;
  const dlat = toR(b[1] - a[1]), dlon = toR(b[0] - a[0]);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dlon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** @param {[number,number]} a @param {[number,number]} b  a,b = [lon,lat] -> initial bearing 0..360 (0=N) */
export function bearingDeg(a, b) {
  const toR = (x) => x * Math.PI / 180, toD = (x) => x * 180 / Math.PI;
  const y = Math.sin(toR(b[0] - a[0])) * Math.cos(toR(b[1]));
  const x = Math.cos(toR(a[1])) * Math.sin(toR(b[1])) - Math.sin(toR(a[1])) * Math.cos(toR(b[1])) * Math.cos(toR(b[0] - a[0]));
  return (toD(Math.atan2(y, x)) + 360) % 360;
}

/** @param {[number,number][]} pts -> summed great-circle km over consecutive pairs */
export function totalKm(pts) {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += haversineKm(pts[i - 1], pts[i]);
  return s;
}

/**
 * Break a polyline of waypoints into legs with per-leg distance (metres)
 * and initial bearing.
 * @param {[number,number][]} waypoints
 * @returns {{legs:{index:number,from:[number,number],to:[number,number],distanceM:number,bearingDeg:number}[], totalM:number}}
 */
export function routeLegs(waypoints) {
  const legs = [];
  let totalM = 0;
  const wp = waypoints || [];
  for (let i = 1; i < wp.length; i++) {
    const from = wp[i - 1], to = wp[i];
    const distanceM = haversineKm(from, to) * 1000;
    totalM += distanceM;
    legs.push({ index: i, from, to, distanceM, bearingDeg: bearingDeg(from, to) });
  }
  return { legs, totalM };
}

/* ------------------------------------------------------------------ *
 * Accuracy bands — map a depth to the confidence tier it falls in.
 * Values verified against config/params.yaml (rmse caps 1.5 / 2.5) and
 * reports/accuracy_report.md (measured 0-15 m RMSE 1.35 PASS; 15-25 m
 * RMSE 4.90, the documented optical wall). Ordered shallow -> deep.
 * ------------------------------------------------------------------ */
export const ACCURACY_BANDS = [
  { key: 'validated',    maxAbs: 15,       label: '0-15 m · validated',         rmse: 1.35, status: 'PASS' },
  { key: 'optical-wall', maxAbs: 25,       label: '15-25 m · optical wall',     rmse: 4.90, status: 'high uncertainty (documented FAIL, gate 2.5 m)' },
  { key: 'coarse',       maxAbs: Infinity, label: '>25 m · coarse global fill', rmse: null, status: 'GEBCO/GMRT ~120-450 m — smooth fill only' },
];

/**
 * @param {number|null} depthM  negative metres, or null
 * @returns {object|null} first band whose maxAbs >= |depthM|, or null if depthM is null
 */
export function bandForDepth(depthM) {
  if (depthM == null) return null;
  const a = Math.abs(depthM);
  for (const band of ACCURACY_BANDS) {
    if (a <= band.maxAbs) return band;
  }
  return ACCURACY_BANDS[ACCURACY_BANDS.length - 1];
}

/* ------------------------------------------------------------------ *
 * Slippy-map (Web Mercator) tiling math.
 * ------------------------------------------------------------------ */
function lonLatToPixel(lon, lat, z, width, height) {
  const n = 2 ** z;
  const xf = (lon + 180) / 360 * n;
  const tx = Math.floor(xf);
  let px = Math.floor((xf - tx) * width);
  const latRad = lat * Math.PI / 180;
  const yf = (1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2 * n;
  const ty = Math.floor(yf);
  let py = Math.floor((yf - ty) * height);
  // defensive clamp — a sample exactly on a tile's far edge can round to width/height
  if (px < 0) px = 0; else if (px > width - 1) px = width - 1;
  if (py < 0) py = 0; else if (py > height - 1) py = height - 1;
  return { tx, ty, px, py };
}

const SENTINEL_MIN = 9.5; // decoded elevation >= this == land/nodata sentinel (+10 m) -> invalid
const PROFILE_ZOOM = 15;  // matches the DemSource maxzoom used in app.js

/* ------------------------------------------------------------------ *
 * sampleRouteProfile — honesty-sensitive DEM sampler along a route.
 * MUST NEVER THROW: any per-sample fetch/decode failure records that
 * sample as depthM: null and continues.
 * ------------------------------------------------------------------ */

/**
 * Sample the fused DEM along a route, nearest-neighbour, at z=15.
 * @param {{getDemTile:(z:number,x:number,y:number,ac?:any)=>Promise<{width:number,height:number,data:Float32Array}>}} demSource
 * @param {[number,number][]} waypoints  [lon,lat] pairs
 * @param {{spacingM?:number,maxSamples?:number}} [opts]
 * @returns {Promise<object>} Profile object (see contract)
 */
export async function sampleRouteProfile(demSource, waypoints, opts) {
  const options = opts || {};
  const wp = waypoints || [];
  const { legs, totalM } = routeLegs(wp);

  const emptyStats = {
    entry: { depthM: null, band: null },
    exit: { depthM: null, band: null },
    max: { depthM: null, band: null, dM: null },
    avg: { depthM: null },
    sampleCount: 0, validCount: 0, invalidCount: 0,
  };
  if (wp.length < 1) {
    return { ok: false, totalM: 0, samples: [], stats: emptyStats, bandsCrossed: [] };
  }

  // spacing: default ~12 m, capped so long routes don't exceed maxSamples.
  const spacingM = Math.max(options.spacingM ?? 12, totalM / (options.maxSamples ?? 600));

  // Build the ordered list of sample positions (lon,lat,dM) along the route.
  // Always include the exact entry (dM=0) and exact exit (dM=totalM).
  const positions = [];
  if (wp.length === 1 || totalM === 0) {
    positions.push({ lon: wp[0][0], lat: wp[0][1], dM: 0 });
  } else {
    let cumBefore = 0; // cumulative distance at the start of the current leg
    positions.push({ lon: wp[0][0], lat: wp[0][1], dM: 0 });
    for (const leg of legs) {
      const legLen = leg.distanceM;
      const [lon0, lat0] = leg.from, [lon1, lat1] = leg.to;
      if (legLen > 0) {
        // first step strictly inside this leg, past the leg-start vertex
        let d = spacingM * Math.ceil((cumBefore + 1e-6) / spacingM) - cumBefore;
        for (; d < legLen - 1e-6; d += spacingM) {
          const t = d / legLen;
          positions.push({
            lon: lon0 + (lon1 - lon0) * t,
            lat: lat0 + (lat1 - lat0) * t,
            dM: cumBefore + d,
          });
        }
      }
      cumBefore += legLen;
      // leg endpoint (exact vertex / final exit)
      positions.push({ lon: lon1, lat: lat1, dM: cumBefore });
    }
  }

  // Sample the DEM at each position, caching tiles within this call.
  const tileCache = new Map(); // `${z}/${tx}/${ty}` -> tile | null (null == known-failed)
  const samples = [];
  for (const pos of positions) {
    let depthM = null;
    try {
      // tx/ty do not depend on tile width/height, so a provisional 256-sized
      // pixel calc selects the correct tile; px/py are recomputed against the
      // tile's ACTUAL returned width/height below.
      const provisional = lonLatToPixel(pos.lon, pos.lat, PROFILE_ZOOM, 256, 256);
      const key = `${PROFILE_ZOOM}/${provisional.tx}/${provisional.ty}`;
      let tile = tileCache.get(key);
      if (tile === undefined) {
        try {
          tile = await demSource.getDemTile(PROFILE_ZOOM, provisional.tx, provisional.ty, new AbortController());
        } catch {
          tile = null;
        }
        tileCache.set(key, tile);
      }
      if (tile && tile.data && tile.width && tile.height) {
        const { px, py } = lonLatToPixel(pos.lon, pos.lat, PROFILE_ZOOM, tile.width, tile.height);
        const elev = tile.data[py * tile.width + px];
        if (typeof elev === 'number' && Number.isFinite(elev) && elev < SENTINEL_MIN) {
          depthM = elev;
        }
      }
    } catch {
      depthM = null; // never throw
    }
    samples.push({ dM: pos.dM, lon: pos.lon, lat: pos.lat, depthM, band: bandForDepth(depthM) });
  }

  // Aggregate stats — nulls are never treated as 0.
  let validCount = 0, sum = 0;
  let deepest = null; // most-negative valid sample
  for (const s of samples) {
    if (s.depthM == null) continue;
    validCount++;
    sum += s.depthM;
    if (deepest === null || s.depthM < deepest.depthM) deepest = s;
  }
  const sampleCount = samples.length;
  const invalidCount = sampleCount - validCount;
  const first = samples[0];
  const last = samples[samples.length - 1];

  const stats = {
    entry: { depthM: first.depthM, band: first.band },
    exit: { depthM: last.depthM, band: last.band },
    max: deepest
      ? { depthM: deepest.depthM, band: deepest.band, dM: deepest.dM }
      : { depthM: null, band: null, dM: null },
    avg: { depthM: validCount ? sum / validCount : null },
    sampleCount, validCount, invalidCount,
  };

  // bandsCrossed — unique band keys in traversal order, skipping nulls.
  const bandsCrossed = [];
  for (const s of samples) {
    if (s.band && !bandsCrossed.includes(s.band.key)) bandsCrossed.push(s.band.key);
  }

  return { ok: validCount > 0, totalM, samples, stats, bandsCrossed };
}

/* ------------------------------------------------------------------ *
 * formatRouteReport — plain-text, copy-into-textarea report (no HTML).
 * ------------------------------------------------------------------ */

function fmtDepth(depthM) {
  if (depthM == null) return 'no data';
  return `${depthM.toFixed(1)} m`;
}
function fmtLonLat(pt) {
  return `${pt[0].toFixed(6)}, ${pt[1].toFixed(6)}`; // lon, lat
}
function fmtHeading(deg) {
  return `${String(Math.round(deg)).padStart(3, '0')}°`;
}
function bandTag(band) {
  if (!band) return '';
  return ` [${band.label} — ${band.status}]`;
}
function depthLine(reading) {
  // reading = { depthM, band }
  if (!reading || reading.depthM == null) return 'no data (land / outside coverage)';
  return `${fmtDepth(reading.depthM)}${bandTag(reading.band)}`;
}

/**
 * @param {[number,number][]} waypoints
 * @param {{legs:any[],totalM:number}} legsResult
 * @param {object} profile  result of sampleRouteProfile
 * @returns {string} plain text (no HTML)
 */
export function formatRouteReport(waypoints, legsResult, profile) {
  const wp = waypoints || [];
  const L = [];
  L.push('Sodwana Bay — Planned Route');
  L.push('==============================');
  L.push('');

  // Entry point
  if (wp.length) {
    const entryDepth = profile && profile.stats ? profile.stats.entry : null;
    L.push(`Entry point: ${fmtLonLat(wp[0])}`);
    L.push(`  depth: ${depthLine(entryDepth)}`);
  } else {
    L.push('Entry point: (no waypoints)');
  }
  L.push('');

  // Waypoint list
  L.push('Waypoints:');
  wp.forEach((pt, i) => {
    L.push(`  ${i + 1}. ${fmtLonLat(pt)}`);
  });
  L.push('');

  // Per-leg breakdown
  const legs = (legsResult && legsResult.legs) || [];
  if (legs.length) {
    L.push('Legs:');
    legs.forEach((leg) => {
      L.push(`  Leg ${leg.index} -> ${leg.index + 1}: heading ${fmtHeading(leg.bearingDeg)}, distance ${Math.round(leg.distanceM)} m`);
    });
    L.push('');
  }

  // Total distance
  const totalM = (legsResult && legsResult.totalM) || 0;
  L.push(`Total distance: ${Math.round(totalM)} m (${(totalM / 1000).toFixed(2)} km)`);
  L.push('');

  // Depth summary
  const stats = profile && profile.stats;
  L.push('Depth summary:');
  if (stats) {
    L.push(`  Entry:   ${depthLine(stats.entry)}`);
    if (stats.max && stats.max.depthM != null) {
      L.push(`  Deepest: ${fmtDepth(stats.max.depthM)}${bandTag(stats.max.band)} (at ${Math.round(stats.max.dM)} m along route)`);
    } else {
      L.push('  Deepest: no data (land / outside coverage)');
    }
    L.push(`  Average: ${stats.avg && stats.avg.depthM != null ? fmtDepth(stats.avg.depthM) : 'no data (land / outside coverage)'}`);
    L.push(`  Exit:    ${depthLine(stats.exit)}`);
    L.push(`  (${stats.validCount}/${stats.sampleCount} samples had depth data)`);
  } else {
    L.push('  no depth profile available');
  }

  // Honesty caveat
  const crossed = (profile && profile.bandsCrossed) || [];
  if (crossed.includes('optical-wall') || crossed.includes('coarse')) {
    L.push('');
    L.push('Note: this route crosses into lower-confidence depth bands (see per-reading');
    L.push('labels above) — treat depths beyond 15 m as indicative, not precise.');
  }

  return L.join('\n');
}
