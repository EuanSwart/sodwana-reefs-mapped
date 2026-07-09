# Sodwana Bay High-Resolution Bathymetry — Claude Code Execution Plan

**Project:** Interactive seafloor map of Sodwana Bay, Red Sands → Mabibi, for scuba training and discovery of unmapped reef.
**Owner:** Euan (swart.euan@gmail.com)
**Budget:** R0 / $0. Every data source, tool, and host in this plan is free.
**Delivery:** GitHub Pages site (also runs locally), MapLibre GL with toggleable 3D terrain.

---

## 1. Mission and honest constraints

Build the highest-resolution bathymetric DEM achievable today with free, immediately-downloadable data, and serve it as an interactive 2D/3D web map with depth colors, hillshade, contours, dive-site markers, click-to-copy coordinates, and a "prospecting" layer that highlights probable undived reef structure.

**Resolution reality (verified July 2026):**

| Zone | Best free source | Resolution | Depth range |
|---|---|---|---|
| Shallow reef (0 to ~25–30 m) | Sentinel-2 SDB calibrated on ICESat-2 ATL24 | **10 m grid** | 0 to ~25 m reliable, ~30 m in clearest scenes |
| Along ICESat-2 tracks | ATL24 refraction-corrected lidar photons | ~0.7 m along-track (profiles, not a grid) | 0 to ~30–40 m |
| Reef tops (context) | Allen Coral Atlas bathymetry + 5 m benthic habitat | 10 m / 5 m | 0 to ~15 m |
| Deep (>30 m) | GEBCO 2025 / GMRT | ~120–450 m | all |
| Ground truth | Euan's ~20–30 GPS points, depth ±10 cm | points | across reef system |

- **<5 m gridded data at 30–50 m depth does not exist as a free download.** The metre-scale ACEP/Council for Geoscience multibeam of the Sodwana canyons is request-only (MIMS/CGS/SAEON). Per project decision we do **not** wait on it, but the pipeline is designed so a multibeam GeoTIFF can be dropped into `data/priority/` later and the whole map rebuilds around it automatically (Section 6, fusion).
- The previous ML-on-satellite attempt likely failed because it lacked real depth training data. **ATL24 fixes this**: NASA's 2025 global nearshore bathymetry product gives thousands of real lidar seafloor depths along tracks crossing the AOI — that is the calibration signal that was missing. Euan's 20–30 ±10 cm points are reserved as an **independent validation set** (never used in training).

**AOI (define once in `config/aoi.geojson`, used everywhere):**
lon 32.62 → 32.82, lat −27.62 → −27.32 (covers Red Sands south of Jesser Point through Two/Five/Seven/Nine-Mile Reefs to Mabibi; extends offshore past the canyon heads).

---

## 2. Final deliverables

1. `dem/sodwana_fused_10m.tif` — fused bathymetric DEM (EPSG:3857 + a 4326 copy), depths negative, with a per-pixel `source` and `uncertainty` band.
2. `site/` — static web app: MapLibre GL v5, terrarium raster-dem tiles, layers: depth color-relief, hillshade (igor), dynamic contours (maplibre-contour), dive-site markers, ICESat-2 track overlay, "prospect" anomaly layer, satellite/benthic overlays. URL-hash deep links (`#lat,lon,zoom`) so any view/site is shareable as a coordinate link.
3. `data/dive_sites.geojson` — named reef/dive sites with verified coordinates, depth ranges, descriptions.
4. `reports/accuracy_report.md` — RMSE/MAE vs held-out ATL24 and vs Euan's GPS points, per depth band.
5. GitHub repo with Pages enabled; site live at `https://<user>.github.io/sodwana-bathymetry/`.

**Acceptance criteria (the build loop exits only when all pass):**
- DEM covers full AOI with no nodata holes; 10 m cell size in the SDB zone.
- SDB RMSE ≤ 1.5 m for 0–15 m depths and ≤ 2.5 m for 15–25 m vs held-out ATL24; report bias vs Euan's points.
- Site loads on GitHub Pages with zero API keys, zero console errors; 3D toggle, coordinate copy, and all layers work; total tile payload < 300 MB.
- Every dive-site coordinate cross-checked against ≥2 independent sources or flagged `unverified`.

---

## 3. Repo layout

```
sodwana-bathymetry/
├── CLAUDE.md                  # project memory: conventions, AOI, gotchas discovered
├── config/
│   ├── aoi.geojson
│   └── params.yaml            # depth limits, RMSE gates, tile zooms (8–15), color ramp
├── data/
│   ├── raw/                   # downloads (gitignored)
│   ├── ground_truth/gps_points.csv     # Euan's points: lat, lon, depth_m, name
│   ├── priority/              # future multibeam drop-in (empty for now)
│   └── dive_sites.geojson
├── pipeline/                  # numbered Python scripts, each idempotent + CLI-runnable
│   ├── 01_fetch_gebco_gmrt.py
│   ├── 02_fetch_atl24.py
│   ├── 03_fetch_sentinel2.py
│   ├── 04_train_sdb.py
│   ├── 05_fuse_dem.py
│   ├── 06_derivatives.py      # slope, rugosity, BPI → prospect layer
│   ├── 07_make_tiles.py
│   └── validate.py            # accuracy gates; exit 1 on failure
├── site/                      # index.html, app.js, style.json, tiles/
├── reports/
├── .claude/
│   ├── agents/                # subagent definitions (Section 8)
│   └── settings.json          # hooks (Section 8)
└── .github/workflows/pages.yml
```

**Environment:** Python 3.11 venv. `pip install rasterio rio-rgbify sliderule geopandas scikit-learn xgboost pygmt requests mercantile pillow scipy earthengine-api geemap`. GDAL ≥3.8 via conda-forge (`conda install -c conda-forge gdal`) or OSGeo4W on Windows; on Claude Code's Linux side `apt install gdal-bin python3-gdal`. No paid services anywhere. Google Earth Engine is used under its **noncommercial free tier** (registration, no billing) — with the Copernicus Data Space `openeo`/STAC API as the keyless fallback if GEE registration is unwanted.

---

## 4. Phase 1 — Data acquisition (scripts 01–03, parallelizable)

**01 — Base grids.**
- GEBCO 2025 sub-grid for AOI: https://download.gebco.net/ (NetCDF/GeoTIFF, no login).
- GMRT GridServer GeoTIFF for AOI: https://www.gmrt.org/services/gridserverinfo.php (~120 m here; verified no multibeam swaths in AOI, it's altimetry base — treat as smooth deep-water fill only).
- de Wet & Compton (2021) SA shelf single-beam grid: https://www.johnscompton.com/maps/ — clip to AOI; sparse on this coast but real soundings; use as extra deep control points.

**02 — ICESat-2 ATL24 (the key dataset).**
- Use SlideRule Python client (`pip install sliderule`), `atl24x` endpoint, polygon = AOI. Docs: https://docs.slideruleearth.io/user_guide/icesat2.html . Free public service; product page https://nsidc.org/data/atl24/ (v2 confirmed live, DOI 10.5067/ATLAS/ATL24.002; direct NSIDC download needs only a free Earthdata login — fallback if SlideRule is down: `earthaccess` Python library).
- Filter: `confidence ≥ medium`, flag surface/subsurface classes, drop daytime high-background passes if noisy.
- Output: `atl24_points.parquet` (lat, lon, ortho depth, sigma, beam, date). Expect thousands of usable seafloor photons across ~10–30 accumulated track crossings since 2018.
- Split 70/30 by *track* (not randomly) into train/holdout to avoid spatial leakage.

**03 — Sentinel-2 composite.**
- GEE (noncommercial) or Copernicus Data Space: build a **multi-scene median composite** of the clearest scenes (cloud <5%, low sun-glint, calm sea state; use SCL/QA masking + Hedley glint correction on B8). Typically the best 10–20 scenes from 2019–2026. Bands: B1–B4, B8 at 10–20 m, resampled to 10 m.
- Also pull Allen Coral Atlas layers for the AOI (free account, GeoTIFF export via "My Areas": https://allencoralatlas.org) — 10 m bathy (to ~15 m) and 5 m benthic class — used as a QA cross-check and a map overlay, not as training truth.

**Ground truth intake:** Claude Code asks Euan to paste his ~20–30 points into `data/ground_truth/gps_points.csv` at the start of Phase 1 (template provided: `name,lat,lon,depth_m,tide_note`). Apply tide correction to chart datum using SANHO tide tables for Richards Bay/Sodwana if tide notes exist; else document ±1 m tidal uncertainty.

---

## 5. Phase 2 — SDB model (script 04, iterative loop)

This replaces the failed ML attempt with a properly supervised one:

1. Extract Sentinel-2 reflectances at every ATL24 training point.
2. Fit two models: (a) Stumpf log-ratio `ln(B2)/ln(B3)` linear baseline; (b) **XGBoost** on features `[ln B1..B4, B8, band ratios, x, y]`. Reference for the exact SA-proven recipe (Sentinel-2 × ATL24 × XGBoost, RMSE 0.45 m at Langebaan): https://www.frontiersin.org/journals/remote-sensing/articles/10.3389/frsen.2026.1751006/full
3. Predict full 10 m depth raster; mask where predicted depth > optical limit (fit per-scene extinction depth, typically 22–28 m here) and where B8 glint/turbidity flags fire.
4. **Accuracy loop (agentic):** `validate.py` computes RMSE per 5 m depth band vs held-out ATL24 tracks + bias vs Euan's GPS points. If gates fail → the sdb-modeler agent iterates: adjust scene selection, glint correction, features, depth cutoff. Max 6 iterations, then report best model and its verified error honestly.
5. Output: `sdb_10m.tif` + `sdb_uncertainty.tif` (per-pixel model σ).

---

## 6. Phase 3 — DEM fusion (script 05)

Priority-stack fusion into one seamless DEM (highest priority wins, feathered 300 m blend zones via delta-surface / distance-weighted blending):

1. `data/priority/*.tif` (future multibeam — empty now, but wired in)
2. ATL24 photons gridded along-track (only where dense enough; pyGMT `blockmedian` + `surface` with tension 0.35)
3. `sdb_10m.tif` (0 to optical limit)
4. de Wet & Compton points (deep, sparse)
5. GEBCO/GMRT resampled (everything else, i.e. >~30 m)

Carry `source` and `uncertainty` bands through. Fill residual nodata with `gdal_fillnodata`. Sanity checks: monotonic offshore deepening in sand plains, canyon positions vs published canyon coordinates (Jesser, Wright, Diepgat), zero land leakage (clip with OSM coastline).

**Prospecting layer (script 06):** from the fused DEM compute slope, TRI/rugosity, and Bathymetric Position Index at 100 m and 500 m scales. Cells with high positive BPI + high rugosity that are **>500 m from any known dive site** = "prospect polygons" — candidate unmapped/undived reef. Also difference SDB against Allen Coral Atlas benthic "rock/coral" classes: hard-bottom signatures outside named sites get flagged. Export `prospects.geojson` ranked by score, each with centroid coordinates ready to punch into a GPS. *(These are leads, not guarantees — the layer states its confidence.)*

---

## 7. Phase 4 — Tiles + web app (script 07 + `site/`)

**Tiles:** `gdalwarp` DEM to EPSG:3857 → terrarium-encoded PNG tiles z8–z15 with rio-rgbify (maintained fork, verified July 2026: https://github.com/acalcutt/rio-rgbify → redirects to TechIdiots-LLC/rio-rgbify; `-e terrarium` flag confirmed, and its `rio merge` command can alternatively perform the Section 6 raster fusion at tile level; explode MBTiles → z/x/y with mb-util). z15 ≈ 3 m/px at this latitude — matches data honestly without inventing detail. Optional single-file `terrain.pmtiles` (https://docs.protomaps.com/pmtiles/maplibre) if repo file-count matters.

**App (`site/index.html`, one page, no build step, no keys):** MapLibre GL JS v5 (≥5.24) from CDN + vendored copy for offline.
- Sources: local `raster-dem` (terrarium) driving **terrain** (3D toggle + exaggeration slider ×1–×3), **hillshade** (igor), **color-relief** (native layer; ramp: white 0 m → cyan −10 → blue −30 → navy −60 → near-black −120).
- **maplibre-contour** (https://github.com/onthegomap/maplibre-contour): client-side contours from the same tiles, 5 m interval (1 m at high zoom), labeled.
- Basemap: OpenFreeMap liberty (keyless, https://openfreemap.org) — degrades gracefully offline since the AOI is mostly ocean.
- Dive-site markers from `dive_sites.geojson` with popups (name, depth range, description, "copy coords", "open in Google Maps" link). ICESat-2 track lines and prospect polygons as toggleable overlays with the same coordinate tools.
- Coordinate UX: live cursor lat/lon readout; click → marker + copyable decimal + DDM (degrees decimal-minutes, what dive-boat GPS units use); URL hash `#zoom/lat/lon` for shareable deep links; simple distance-measure tool (great for "reef is 250 m at bearing 40° from the buoy" briefings).
- Teaching mode: a sidebar list of named reefs; clicking flies the camera to the site in 3D.

**Dive-site compilation:** a research subagent compiles Sodwana sites (Quarter-Mile, Two-Mile, Five-Mile, Seven-Mile, Nine-Mile, Red Sands, and northward sites toward Mabibi) from ≥2 independent public sources each (wikivoyage/wikipedia dive-guide pages, published papers, operator sites); anything single-sourced is marked `"verified": false` and rendered hollow. Euan's own GPS names/points override everything.

**Deploy:** `.github/workflows/pages.yml` publishes `site/` on push to main. Local dev: `python -m http.server -d site` (raster-dem won't load from `file://`).

---

## 8. Claude Code agentic workflow

Run the build with Claude Code from the repo root. `CLAUDE.md` carries the AOI, params, and every gotcha discovered (append as you go — it is the project memory).

**Subagents (`.claude/agents/*.md`):**

| Agent | Model/tools | Job |
|---|---|---|
| `data-scout` | web + bash | Phase 1 downloads; verifies checksums/extents; re-searches for new free sources (rerun quarterly — ATL24 v2+ releases and any CGS open-data drop land here) |
| `sdb-modeler` | bash, python | Owns Phase 2 loop; may only read train split; iterates until `validate.py` passes or 6 attempts |
| `qa-validator` | read-only + bash | Adversarial checker: runs `validate.py`, inspects DEM for artifacts (striping, land leakage, seams at blend zones), verifies dive-site coords against sources. **Never edits pipeline code** — reports issues only |
| `frontend-builder` | bash, playwright | Builds `site/`, then screenshot-tests: loads page headless, asserts no console errors, screenshots 2D/3D/each layer for visual review |
| `site-researcher` | web | Dive-site coordinate compilation with 2-source rule |

**Hooks (`.claude/settings.json`):**
- `PostToolUse` on `Edit|Write` matching `pipeline/*.py` → `python -m py_compile` the file (instant syntax gate).
- `PostToolUse` on `Bash` matching `pipeline/0[4-5]*` → auto-run `python pipeline/validate.py --quick` and surface the RMSE table to the transcript.
- `PreToolUse` on `Bash` matching `git push` → run full `validate.py` + `frontend-builder` smoke test; block push on failure (this is the acceptance gate).
- `Stop` hook → append session discoveries to `CLAUDE.md` "Gotchas" section.

**Loops:** the Phase 2 accuracy loop (above) and a tile-QA loop: render 6 fixed camera views headless → frontend-builder inspects screenshots → fixes ramp/exaggeration/seams → re-renders, max 3 passes.

**Orchestration order:** Phase 1 scripts in parallel (three data-scout tasks) → Phase 2 loop → Phase 3 → Phases 4 site + site-researcher in parallel → qa-validator full pass → deploy. Keep scripts idempotent so any phase can rerun alone.

---

## 9. Risks & later upgrades

- **Optical wall at ~25–30 m:** 30–50 m detail comes only from ATL24 track profiles until better data arrives. The map shows an honest "resolution boundary" line so students see where data quality changes.
- **Turbidity/swell scenes** can poison the composite — scene selection is the highest-leverage knob in Phase 2.
- **GEE registration** required (free, noncommercial); fallback: Copernicus Data Space STAC (keyless).
- **Upgrades that slot in with zero rework:** (1) email MIMS (https://data.ocean.gov.za/support/request-data/), Council for Geoscience, and SAEON for the ACEP canyon multibeam — drop any GeoTIFF into `data/priority/` and rerun 05–07; (2) log a fishfinder (any NMEA/Deeper/Garmin unit) on dive-boat runs — a weekend of transects over 30–50 m reef beats every satellite; script 05 already accepts point CSVs; (3) IHO DCDB crowdsourced bathymetry recheck (https://www.ncei.noaa.gov/maps/iho_dcdb/).

---

## 10. Kickoff prompt for Claude Code

> Read SODWANA_BATHYMETRY_PLAN.md in full. Initialize the repo per Section 3, create the subagents and hooks per Section 8, then execute Phases 1→5 in order, using the accuracy gates in Section 2 as hard exit criteria. Ask Euan only for: (1) his GPS points CSV, (2) GEE auth if used, (3) GitHub repo creation/Pages enablement. Do not mark any phase complete until validate.py passes for it.
