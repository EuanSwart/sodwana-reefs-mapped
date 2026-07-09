# Sodwana Bay High-Resolution Bathymetry

Free, interactive seafloor map of Sodwana Bay (Red Sands → Mabibi) for scuba training and reef
prospecting. Fused from Sentinel-2 satellite-derived bathymetry calibrated on ICESat-2 ATL24 lidar,
with GEBCO/GMRT deep-water fill. **Budget: $0** — no paid APIs, no keys, no token-gated tiles.

See `SODWANA_BATHYMETRY_PLAN.md` for the full technical plan and `CLAUDE.md` for the operating manual.

## Quick start

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt          # GDAL >=3.8 installed separately (conda-forge / apt gdal-bin)

# Phase 1 — data (keyless bits run now; Sentinel-2 needs GEE/CDSE auth)
python pipeline/01_fetch_gebco_gmrt.py       # GMRT GeoTIFF for the AOI
python pipeline/02_fetch_atl24.py            # ICESat-2 ATL24 via SlideRule (keyless)
python pipeline/03_fetch_sentinel2.py        # needs `earthengine authenticate` OR provider: cdse

# Phase 2–4 — model, fuse, derive, tile
python pipeline/04_train_sdb.py
python pipeline/05_fuse_dem.py
python pipeline/06_derivatives.py
python pipeline/07_make_tiles.py --dry-run   # check tile count/size first
python pipeline/07_make_tiles.py

# Validate + preview
python pipeline/validate.py                  # accuracy gates (exit 1 on failure)
python -m http.server -d site 8080           # open http://localhost:8080  (raster-dem won't load from file://)
```

## What's here

| Path | What |
|---|---|
| `config/aoi.geojson` | The AOI bounding box — single source of truth, never hardcode elsewhere |
| `config/params.yaml` | Every tunable: depth limits, RMSE gates, tile zooms, colour ramp |
| `pipeline/01–07 + validate.py` | Numbered, idempotent, CLI-runnable scripts (`--aoi`, `--params`, `--dry-run`) |
| `site/` | Dependency-free MapLibre GL app: 3D terrain, hillshade, colour depth, contours, dive sites, coordinate tools |
| `data/dive_sites.geojson` | Named reefs (starter set — unverified until the two-source rule is applied) |
| `data/ground_truth/gps_points.csv` | Euan's ±10 cm points — **validation only, never trained on** |
| `.claude/agents/` | Subagents: data-scout, sdb-modeler, qa-validator, frontend-builder, site-researcher |
| `.claude/settings.json` | Hooks: syntax gate on edits, auto-validate on model runs, block `git push` unless gates pass |
| `reports/` | `accuracy_report.md` (RMSE/MAE vs held-out ATL24) + screenshots |

## Honest constraints

- Reliable to ~25–30 m depth (optical limit). Below that, detail comes only from ICESat-2 track
  profiles until better data arrives. The map shows its resolution boundary rather than inventing detail.
- Depths are **negative metres** everywhere. A positive value over water is a bug.
- Drop a multibeam GeoTIFF into `data/priority/` and rerun `05→07` — the whole map rebuilds around it.

## Deploy

Push to `main`; `.github/workflows/pages.yml` publishes `site/` to GitHub Pages after the smoke test.

## Extra data layers (added this session)

Beyond the core SDB × ATL24 × GEBCO fusion, the map now integrates:

- **Your Garmin dive logs** — `pipeline/08_ingest_dive_logs.py` reads the cleaned/clustered
  `data/dive_logs/reef_candidates.csv` (never the raw dive JSON) into 36 named reef sites
  (33 verified from your own logs), with dive counts and depth ranges.
- **CGS seafloor geology + isobaths** — `pipeline/09_ingest_cgs.py` ingests the Council for
  Geoscience 2005 survey (`data/geology/*.gpkg`): substrate polygons (Reef / Sand / …) and real
  depth contours (0 to −95 m). These become map overlays, fill deep gaps in the DEM, and
  corroborate prospect leads (a lead on mapped Reef is boosted; on Sand, demoted).
- **More free sources to add** — `reports/data_sources.md` scouts ACEP/SAEON canyon multibeam,
  Allen Coral Atlas, IHO DCDB, and boat-sonar logging, with exactly where each plugs in.

Run order for the new steps: `08` and `09` (ingest) → `05` (re-fuse) → `06` (prospects) →
`07` (re-tile). Accuracy gates are unchanged and honest: 0–15 m RMSE 1.35 m (PASS); 15–25 m 4.90 m
(the optical wall — CGS isobaths don't beat SDB there, so they're used for overlays/deep-fill/
corroboration, not to fake an improvement).
