// Dive Drop-Site Editor — standalone tool page, reuses the project's vendored MapLibre +
// the Fusion2 reconciled bathymetry tiles as basemap (better reef context than a generic map).
// All edits live in localStorage; nothing here writes back into the pipeline/repo data.

const DATA_URL = "data/dive_drop_sites_raw.json";
const EDITS_KEY = "sodwana_dive_drop_site_edits_v1";
const AOI_BOUNDS = [32.62, -27.62, 32.82, -27.32];

let RAW = [];              // parsed points from the source md
let EDITS = loadEdits();   // { [id]: { name?: string, removed?: bool } }
let SELECTED = null;
let map;

function loadEdits() {
  try { return JSON.parse(localStorage.getItem(EDITS_KEY)) || {}; }
  catch { return {}; }
}
function saveEdits() {
  localStorage.setItem(EDITS_KEY, JSON.stringify(EDITS));
}

function working(p) {
  const e = EDITS[p.id] || {};
  const name = e.name != null ? e.name : p.suggestedName;
  return {
    ...p,
    name,
    removed: !!e.removed,
    renamed: e.name != null && e.name !== p.suggestedName,
  };
}
function allWorking() { return RAW.map(working); }

function setName(id, name) {
  EDITS[id] = { ...(EDITS[id] || {}), name };
  saveEdits(); refresh();
}
function setRemoved(id, removed) {
  EDITS[id] = { ...(EDITS[id] || {}), removed };
  saveEdits(); refresh();
}
function keepOnlyInCluster(clusterId, keepId) {
  RAW.filter(p => p.clusterId === clusterId).forEach(p => {
    if (p.id !== keepId) EDITS[p.id] = { ...(EDITS[p.id] || {}), removed: true };
  });
  EDITS[keepId] = { ...(EDITS[keepId] || {}), removed: false };
  saveEdits(); refresh(); select(keepId);
}

// ---------------------------------------------------------------- map style
function buildStyle() {
  return {
    version: 8,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      basemap: { type: "vector", url: "https://tiles.openfreemap.org/planet" },
      "fusion2-relief": {
        type: "raster", tiles: ["tiles/relief/{z}/{x}/{y}.png"],
        tileSize: 256, minzoom: 8, maxzoom: 15, bounds: AOI_BOUNDS,
      },
      "fusion2-terrain": {
        type: "raster-dem", tiles: ["tiles/terrain/{z}/{x}/{y}.png"],
        encoding: "terrarium", tileSize: 256, minzoom: 8, maxzoom: 15, bounds: AOI_BOUNDS,
      },
      "drop-sites": { type: "geojson", data: emptyFC() },
    },
    layers: [
      { id: "bg", type: "background", paint: { "background-color": "#0a0f1c" } },
      { id: "ocean-fill", type: "fill", source: "basemap", "source-layer": "water", paint: { "fill-color": "#0a1b3a" } },
      {
        id: "fusion2-relief", type: "raster", source: "fusion2-relief",
        paint: { "raster-opacity": 1, "raster-resampling": "linear" },
      },
      {
        id: "fusion2-hill", type: "hillshade", source: "fusion2-terrain",
        paint: { "hillshade-method": "igor", "hillshade-exaggeration": 0.6,
          "hillshade-shadow-color": "#00101c", "hillshade-highlight-color": "#eaffff" },
      },
      {
        id: "coastline", type: "line", source: "basemap", "source-layer": "boundary",
        filter: ["==", ["get", "maritime"], 1], paint: { "line-color": "#3a5a80", "line-width": 0.6 },
      },
      // duplicate-cluster halo, drawn under the main point circles
      {
        id: "pt-halo", type: "circle", source: "drop-sites",
        filter: ["all", ["==", ["get", "clusterUnresolved"], true], ["==", ["get", "removed"], false]],
        paint: { "circle-radius": 11, "circle-color": "#ff9f3f", "circle-opacity": 0.35 },
      },
      {
        id: "pt-circle", type: "circle", source: "drop-sites",
        paint: {
          "circle-radius": ["case", ["get", "selected"], 8, 5.5],
          "circle-color": [
            "case",
            ["get", "removed"], "#4a5a72",
            ["get", "hasError"], "#ff5d6c",
            ["get", "renamed"], "#4dff88",
            ["get", "clusterUnresolved"], "#ff9f3f",
            "#8fd9ff",
          ],
          "circle-opacity": ["case", ["get", "removed"], 0.35, 0.95],
          "circle-stroke-width": ["case", ["get", "selected"], 2.5, 1],
          "circle-stroke-color": ["case", ["get", "selected"], "#ffffff", "#08131f"],
        },
      },
      {
        id: "pt-label", type: "symbol", source: "drop-sites",
        minzoom: 13,
        filter: ["==", ["get", "removed"], false],
        layout: {
          "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"],
          "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true,
        },
        paint: { "text-color": "#eafaff", "text-halo-color": "#08131f", "text-halo-width": 1.2 },
      },
    ],
  };
}

function emptyFC() { return { type: "FeatureCollection", features: [] }; }

function pointsToFC(pts) {
  return {
    type: "FeatureCollection",
    features: pts.map(p => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: {
        id: p.id, name: p.name, removed: p.removed, renamed: p.renamed,
        clusterUnresolved: !!p.clusterUnresolved, hasError: p.flags.includes("error"),
        selected: p.id === SELECTED,
      },
    })),
  };
}

// ---------------------------------------------------------------- render
function refresh() {
  const pts = allWorking();
  const clusterActiveCounts = computeClusterActiveCounts(pts);
  for (const p of pts) p.clusterUnresolved = p.clusterId != null && (clusterActiveCounts.get(p.clusterId) || 0) >= 2;
  if (map && map.getSource("drop-sites")) {
    map.getSource("drop-sites").setData(pointsToFC(pts));
  }
  renderStats(pts, clusterActiveCounts);
  renderList(pts);
  renderEditPanel(pts);
}

function computeClusterActiveCounts(pts) {
  const m = new Map();
  for (const p of pts) {
    if (!p.clusterId || p.removed) continue;
    m.set(p.clusterId, (m.get(p.clusterId) || 0) + 1);
  }
  return m;
}

function renderStats(pts, clusterActiveCounts) {
  const active = pts.filter(p => !p.removed).length;
  const removed = pts.length - active;
  const renamed = pts.filter(p => p.renamed && !p.removed).length;
  const clusters = [...clusterActiveCounts.values()].filter(n => n >= 2).length;
  document.getElementById("stats").innerHTML =
    `<span><b>${pts.length}</b> total</span>` +
    `<span><b>${active}</b> in export</span>` +
    `<span><b>${renamed}</b> renamed</span>` +
    `<span><b>${removed}</b> removed</span>` +
    `<span><b>${clusters}</b> unresolved clusters</span>`;
}

function renderList(pts) {
  const q = document.getElementById("search").value.trim().toLowerCase();
  const list = document.getElementById("list");
  const byZone = new Map();
  for (const p of pts) {
    if (q && !(p.name.toLowerCase().includes(q) || p.zone.toLowerCase().includes(q) || p.origName.toLowerCase().includes(q))) continue;
    if (!byZone.has(p.zone)) byZone.set(p.zone, []);
    byZone.get(p.zone).push(p);
  }
  let html = "";
  for (const [zone, items] of byZone) {
    html += `<div class="zone-group"><div class="zone-title">${esc(zone)}</div>`;
    for (const p of items) {
      const cls = ["pt-row"];
      if (p.id === SELECTED) cls.push("sel");
      if (p.removed) cls.push("removed");
      if (p.renamed) cls.push("renamed");
      if (p.clusterUnresolved) cls.push("dup");
      if (p.flags.includes("error")) cls.push("err");
      const badge = p.clusterUnresolved ? `<span class="badge" title="duplicate cluster">⧉</span>` : "";
      html += `<li class="${cls.join(" ")}" data-id="${p.id}"><span class="nm">${esc(p.name)}</span>${badge}</li>`;
    }
    html += `</div>`;
  }
  list.innerHTML = html || `<div style="padding:10px;color:var(--ink-faint);font-size:12px;">No matches.</div>`;
  list.querySelectorAll(".pt-row").forEach(row => {
    row.addEventListener("click", () => select(row.dataset.id, true));
  });
}

function toDMM(lat, lon) {
  const f = (v, pos, neg) => {
    const hemi = v >= 0 ? pos : neg;
    v = Math.abs(v);
    const deg = Math.floor(v);
    const min = (v - deg) * 60;
    return `${hemi}${deg}°${min.toFixed(3)}'`;
  };
  return `${f(lat, "N", "S")} ${f(lon, "E", "W")}`;
}

function renderEditPanel(pts) {
  const panel = document.getElementById("editpanel");
  const placeholder = document.getElementById("placeholder");
  const p = pts.find(x => x.id === SELECTED);
  if (!p) { panel.classList.remove("show"); placeholder.classList.remove("hidden"); return; }
  placeholder.classList.add("hidden");
  panel.classList.add("show");

  const idx = pts.findIndex(x => x.id === SELECTED);
  const flagPills = p.flags.map(f => `<span class="flag-pill ${f}">${f}</span>`).join("");

  let sibHtml = "";
  if (p.clusterId) {
    const sibs = pts.filter(x => x.clusterId === p.clusterId);
    sibHtml = `<hr class="sep"><div class="field"><label>Duplicate cluster (${sibs.length} points)</label>
      <ul class="sib-list">${sibs.map(s => `
        <li class="sib">
          <span class="snm" data-goto="${s.id}" title="${esc(s.origName)} (${esc(s.zone)})">${esc(s.name)}${s.removed ? " (removed)" : ""}</span>
          <button class="btn small" data-keeponly="${s.id}">Keep only this</button>
        </li>`).join("")}</ul>
      <div class="ro">Click "Keep only this" to remove the other ${sibs.length - 1} and keep one site.</div>
      </div>`;
  }

  panel.innerHTML = `
    <div class="navrow">
      <button class="btn small" id="nav-prev" ${idx <= 0 ? "disabled" : ""}>← Prev</button>
      <button class="btn small" id="nav-next" ${idx >= pts.length - 1 ? "disabled" : ""}>Next →</button>
    </div>
    <h2>${esc(p.origName)}</h2>
    <div class="ro">${esc(p.zone)} · ${p.depth ? esc(p.depth) : "depth unrecorded"}</div>
    <div class="flagrow">${flagPills}</div>

    <div class="field">
      <label>New name (&lt;x&gt; Mile - Reef Name)</label>
      <input type="text" id="name-input" value="${esc(p.name)}" />
    </div>

    <div class="field">
      <label>Coordinates</label>
      <div class="ro">${toDMM(p.lat, p.lon)}<br>${p.lat.toFixed(6)}, ${p.lon.toFixed(6)}</div>
    </div>

    ${p.remarks ? `<div class="field"><label>Source remark</label><div class="ro">${esc(p.remarks)}</div></div>` : ""}
    ${p.sourceNotes ? `<div class="field"><label>Source note</label><div class="ro">${esc(p.sourceNotes)}</div></div>` : ""}

    <label class="removechk">
      <input type="checkbox" id="removed-chk" ${p.removed ? "checked" : ""} />
      Remove (duplicate / bad point) — excluded from GPX export
    </label>
    ${sibHtml}
  `;

  document.getElementById("name-input").addEventListener("input", (e) => setName(p.id, e.target.value));
  document.getElementById("removed-chk").addEventListener("change", (e) => setRemoved(p.id, e.target.checked));
  document.getElementById("nav-prev").addEventListener("click", () => { if (idx > 0) select(pts[idx - 1].id, true); });
  document.getElementById("nav-next").addEventListener("click", () => { if (idx < pts.length - 1) select(pts[idx + 1].id, true); });
  panel.querySelectorAll("[data-goto]").forEach(el => el.addEventListener("click", () => select(el.dataset.goto, true)));
  panel.querySelectorAll("[data-keeponly]").forEach(el => el.addEventListener("click", () => keepOnlyInCluster(p.clusterId, el.dataset.keeponly)));
}

function select(id, fly) {
  SELECTED = id;
  refresh();
  if (fly) {
    const p = RAW.find(x => x.id === id);
    if (p && map) map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14), duration: 400 });
  }
  const row = document.querySelector(`.pt-row[data-id="${id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------- export
function depthMeters(depthStr) {
  if (!depthStr) return null;
  const m = depthStr.match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function buildGPX(pts) {
  const active = pts.filter(p => !p.removed);
  const wpts = active.map(p => {
    const d = depthMeters(p.depth);
    const eleLine = d != null ? `\n    <ele>${(-d).toFixed(1)}</ele>` : "";
    const descParts = [p.zone, p.renamed ? `orig: ${p.origName}` : null, p.remarks, p.depth]
      .filter(Boolean).join(" · ");
    return `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${eleLine}\n` +
      `    <name>${escXml(p.name)}</name>\n` +
      (descParts ? `    <desc>${escXml(descParts)}</desc>\n` : "") +
      `    <sym>Waypoint</sym>\n` +
      `  </wpt>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<gpx version="1.1" creator="Sodwana Dive Site Editor" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    `${wpts}\n</gpx>\n`;
}
function escXml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

function wireTopbar() {
  document.getElementById("btn-export-gpx").addEventListener("click", () => {
    const pts = allWorking();
    download(`sodwana_dive_sites_${new Date().toISOString().slice(0, 10)}.gpx`, buildGPX(pts), "application/gpx+xml");
  });
  document.getElementById("btn-export-json").addEventListener("click", () => {
    download(`sodwana_dive_site_edits_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(EDITS, null, 2), "application/json");
  });
  document.getElementById("btn-import-json").addEventListener("click", () => document.getElementById("file-import").click());
  document.getElementById("file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try {
      EDITS = JSON.parse(await file.text());
      saveEdits(); refresh();
    } catch (err) { alert("Could not read that file as edit-backup JSON: " + err.message); }
    e.target.value = "";
  });
  document.getElementById("btn-reset").addEventListener("click", () => {
    if (!confirm("Discard all renames and removals? This clears local edits (does not affect the source file).")) return;
    EDITS = {}; saveEdits(); SELECTED = null; refresh();
  });
  document.getElementById("search").addEventListener("input", () => renderList(allWorking()));
}

// ---------------------------------------------------------------- boot
async function boot() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}: ${res.status}`);
  RAW = await res.json();

  // Sidebar/list/stats only depend on RAW + EDITS, not the map — render them immediately so
  // renaming/removing works even while the remote basemap (tiles.openfreemap.org) is still loading.
  wireTopbar();
  refresh();

  map = new maplibregl.Map({
    container: "map",
    style: buildStyle(),
    center: [(AOI_BOUNDS[0] + AOI_BOUNDS[2]) / 2, (AOI_BOUNDS[1] + AOI_BOUNDS[3]) / 2],
    zoom: 12.5,
    maxBounds: [[AOI_BOUNDS[0] - 0.05, AOI_BOUNDS[1] - 0.05], [AOI_BOUNDS[2] + 0.05, AOI_BOUNDS[3] + 0.05]],
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    refresh(); // push current GeoJSON into the now-ready map source
    map.on("click", "pt-circle", (e) => {
      const id = e.features[0].properties.id;
      select(id, false);
    });
    map.on("mouseenter", "pt-circle", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "pt-circle", () => (map.getCanvas().style.cursor = ""));
  });
}

boot().catch(err => {
  document.getElementById("placeholder").textContent = "Failed to load: " + err.message;
  console.error(err);
});
