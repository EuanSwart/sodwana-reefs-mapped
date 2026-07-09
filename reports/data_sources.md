# Additional depth & reef data sources for the Sodwana map

Scope note: the fusion pipeline is designed so *any* of these can be dropped in without rework.
A GeoTIFF goes in `data/priority/` (highest priority, auto-fused by `05`); point soundings go in a
`lon,lat,depth_m` CSV wired as the `dewet_compton` tier; polygons/contours are ingested like the CGS
data in `09`. Partial-AOI coverage is fine — first-write-wins fusion just uses each source where it
exists. Depths are negative metres everywhere.

## Already integrated this session
- **CGS Maputaland Marine Geoscience 2005** (Council for Geoscience) — seafloor substrate polygons
  (Reef / Prominent / Scattered Reef, Coarse Shelly Sediment, Sand) + real depth isobaths (0 to −95 m).
  Now drives the geology + isobath overlays and prospect corroboration; isobaths fill deep gaps.
  Re-pullable from the CGS ArcGIS FeatureServer (see `pipeline/09` / `updated_map/update.py`).
- **ICESat-2 ATL24** lidar and **Sentinel-2 SDB** — the core depth model.
- **Your Garmin dive-log clusters** — 36 named sites as verified markers + depth-range context.

## High-value upgrades to pursue (ranked)

### 1. ACEP / SAEON canyon multibeam  ★ best deep-water upgrade
Metre-scale multibeam of the Sodwana submarine canyons (Jesser, Wright, Diepgat, Chaka, Leadsman,
Leven, Mabibi, White Sands) exists from the African Coelacanth Ecosystem Programme surveys, processed
with the Council for Geoscience. It is **request-only** (not a public download). This is the single
biggest improvement available for the >30 m canyon heads the optical DEM cannot see.
- Request via SAEON / MIMS data portal (data.ocean.gov.za → request data), CGS, or ACEP.
- Drop any delivered GeoTIFF into `data/priority/` and rerun `05→07` — it becomes the top tier automatically.
- Covers the canyon heads/slopes, not the whole AOI — exactly what "partial coverage is fine" is for.

### 2. Allen Coral Atlas  ★ best shallow-reef-tops upgrade (keyless)
5 m benthic-habitat + geomorphic-zonation maps, plus bathymetry to ~10–15 m, over shallow coral reefs.
Free: download per-area with a free login at allencoralatlas.org, **or** pull keyless from Google
Earth Engine (`ACA/reef_habitat/v2_0`). Best over the shallow reef tops (Two-Mile, Quarter-Mile,
Red Sands). Use as: a benthic overlay, an independent QA cross-check of the SDB shallows, and a second
hard-bottom source to strengthen prospect corroboration (like the CGS substrate step). Verify Sodwana
falls in a mapped region first.

### 3. Your own boat sonar  ★ best DIY upgrade
A weekend logging a fishfinder / Garmin / Deeper / Navionics unit on dive-boat runs over Two-Mile,
Five-Mile and the 20–35 m reefs beats every satellite in exactly the band SDB fails (15–30 m). Export
NMEA/GPX → a `lon,lat,depth_m` CSV → wire as the point-sounding tier (`dewet_compton`). Tide-correct to
chart datum if possible. This is the highest-leverage thing *you* can do without waiting on anyone.

### 4. IHO DCDB crowdsourced bathymetry (keyless)
NOAA-hosted global archive of depth soundings logged by vessels; free CSV download via the DCDB Viewer.
Coverage off Sodwana is sparse but real — worth a look for any ski-boat/charter tracks, and you can
contribute your own via a Trusted Node / OpenCPN / Navionics logging. Feeds the same point-sounding tier.

## Lower-priority / reference
- **GEBCO 2024/2025** — already the coarse deep base (~450 m here; smooth fill only, never detail).
- **Published research bathymetry** — Ramsay, *Marine geology of the Sodwana Bay shelf*; Green et al.
  canyon studies; and the 2024 *Ocean Dynamics* paper "Refining the role of bathymetry… at Sodwana Bay"
  (check its supplementary data). These are mostly figures, not downloadable grids, but good ground-truth
  for canyon positions and shelf morphology.
- **Navionics SonarChart / community edits** — recreational sonar-derived contours over the reefs;
  viewable in-app but proprietary (not a bulk free download). Useful as a visual sanity check.
- **EMODnet Bathymetry** — excellent, but Europe-only; not applicable to South Africa.

## What each can and cannot do
- **Improve depth** (fuse into the DEM): canyon multibeam (deep), your sonar logs (15–30 m band),
  DCDB soundings (sparse), Allen Coral Atlas bathy (shallow QA).
- **Improve the reef / prospect model** (not depth): Allen Coral Atlas benthic classes and CGS substrate
  — two-source hard-bottom corroboration of prospect leads.
- **Context / QA only**: GEBCO, published figures, Navionics.

Sources: see the linked references in the session summary.
