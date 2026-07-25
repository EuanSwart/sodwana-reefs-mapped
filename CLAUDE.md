# CLAUDE.md — Sodwana Bay Bathymetry Project

You are building a high-resolution interactive seafloor map of Sodwana Bay (Red Sands → Mabibi) for scuba training and reef prospecting. The full technical plan is in `SODWANA_BATHYMETRY_PLAN.md` — **read it before any work**. This file is your operating manual: how to work, not what to build.

## Non-negotiable facts

- **AOI:** lon 32.62→32.82, lat −27.62→−27.32 (`config/aoi.geojson` is the single source of truth — never hardcode coordinates elsewhere).
- **Depths are NEGATIVE meters.** Elevation convention everywhere: land positive, seafloor negative. Any positive value over water is a bug.
- **CRS:** processing in EPSG:4326, tiles/web in EPSG:3857. Always state CRS in function docstrings and filenames (`_4326`/`_3857`).
- **Budget: $0.** Never introduce a paid API, token-gated tile service, or paid tier. GEE = noncommercial free tier only; fallback is Copernicus Data Space STAC.
- **Ground truth is sacred:** `data/ground_truth/gps_points.csv` (Euan's ±10 cm points) is VALIDATION ONLY. Never train, calibrate, or tune on it. ATL24 holdout split is by track, never random.
- **Honesty over prettiness:** never interpolate detail the data doesn't support. The map must show its resolution boundary. If an accuracy gate can't be met after the loop limit, report the real numbers — do not lower the gate.

## Commands

```bash
source .venv/bin/activate                     # always work inside the venv
python pipeline/validate.py --quick           # fast RMSE check (run after any model/fusion change)
python pipeline/validate.py                   # full gates — must pass before any git push
python -m http.server -d site 8080            # local preview (raster-dem won't load from file://)
python pipeline/07_make_tiles.py --dry-run    # check tile counts/size before committing tiles
```

Pipeline scripts are numbered, idempotent, and CLI-runnable in isolation. If you change a script's inputs/outputs, update its `--help` text and this file's Gotchas if relevant.

## Agentic workflow — how to run this project

### Orchestration rules

1. **You (main agent) are the orchestrator.** Plan with the task list, delegate specialized work to subagents, integrate results. Do not do long research or adversarial review in your own context.
2. **Parallelize independent work.** Phase 1 downloads (GEBCO/GMRT, ATL24, Sentinel-2) run as three parallel subagent tasks. Site build and dive-site research run in parallel after fusion.
3. **Every phase ends with a review gate** (see Reviews). No phase is "done" until its gate passes and the task is marked completed.
4. **Write everything down.** Append discoveries, parameter choices, and failures to the Gotchas section below. Future sessions depend on it.

### Subagents (`.claude/agents/`) — create these on first run

| Agent | Tools | Mandate |
|---|---|---|
| `data-scout` | web, bash, read | Downloads + verifies data (extent, CRS, nodata, checksum vs AOI). Re-run when hunting new/updated sources (ATL24 versions, CGS open-data drops). |
| `sdb-modeler` | bash, read, edit (pipeline/04 only) | Owns the SDB training loop. May read ONLY the training split. Reports RMSE table per iteration. |
| `qa-validator` | read-only + bash | **Adversarial reviewer.** Runs `validate.py`, hunts artifacts (striping, land leakage, blend seams, positive depths, nodata holes), audits dive-site coords against sources. Never edits code — files findings as tasks. |
| `frontend-builder` | bash, edit (site/ only), playwright | Builds/maintains `site/`. Must screenshot-test after every change: headless load, zero console errors, screenshots of 2D/3D/every layer toggle. |
| `site-researcher` | web, read | Compiles dive sites. Two-source rule: coords need ≥2 independent sources or get `"verified": false`. Euan's GPS names override all sources. |

Subagent hygiene: give each a narrow file scope (in frontmatter), pass them the exact task and acceptance criterion, and require a structured result (numbers, file paths, pass/fail) — not prose.

### Loops (bounded, with exit criteria)

- **SDB accuracy loop** (Phase 2): sdb-modeler iterates scene selection → glint correction → features → depth cutoff. Exit: gates pass (RMSE ≤1.5 m @0–15 m, ≤2.5 m @15–25 m vs held-out ATL24) **or** 6 iterations. On timeout: keep best model, write honest error stats to `reports/accuracy_report.md`, continue.
- **Tile QA loop** (Phase 4): render 6 fixed camera views headless → qa-validator inspects → frontend-builder fixes ramp/exaggeration/seams → re-render. Max 3 passes.
- **Dive-site verification loop**: site-researcher proposes → qa-validator cross-checks → unresolved sites marked unverified, never silently dropped.

Never loop without a counter and a written exit criterion. Log each iteration's metrics before the next attempt.

### Hooks (`.claude/settings.json`) — install on first run

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command",
          "command": "f=$(jq -r '.tool_input.file_path' <<< \"$CLAUDE_TOOL_INPUT\" 2>/dev/null); case \"$f\" in *pipeline/*.py) python -m py_compile \"$f\";; *.geojson) python -c \"import json,sys;json.load(open('$f'))\";; esac" }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command",
          "command": "grep -qE 'pipeline/0[45]' <<< \"$CLAUDE_TOOL_INPUT\" && python pipeline/validate.py --quick || true" }]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command",
          "command": "grep -q 'git push' <<< \"$CLAUDE_TOOL_INPUT\" && { python pipeline/validate.py && python pipeline/smoke_site.py; } || true" }]
      }
    ]
  }
}
```

Intent (implement equivalently if the hook API differs from this sketch): (a) instant syntax/JSON gate on every pipeline or geojson edit; (b) auto-run quick validation whenever model/fusion scripts execute; (c) **block `git push` unless full validation + site smoke test pass** — this is the deployment gate. Verify hook syntax against current Claude Code docs before installing; a broken hook that silently no-ops is worse than none.

### Reviews

- **Phase gate:** at the end of every phase, spawn `qa-validator` with fresh context to review outputs adversarially. It must try to break the result, not confirm it. Its findings become tasks; the phase closes only when the list is empty or explicitly deferred with a note here.
- **Self-review before every commit:** diff the changes, re-read against the plan's acceptance criteria (Section 2 of the plan), run `validate.py --quick`.
- **Visual review:** any change touching the DEM, ramp, or tiles requires before/after screenshots saved to `reports/screenshots/` and a one-line verdict in the commit message.

### Skills

If document/report output is requested (accuracy report as PDF, teaching handouts), use the installed `pdf`/`docx`/`pptx` skills — research content first, invoke the skill only when writing the deliverable.

## Coding conventions

- Python 3.11, type hints, `pathlib` everywhere; no bare `except`; every script takes `--aoi config/aoi.geojson` and `--params config/params.yaml`.
- Rasters: GeoTIFF, tiled, LZW/DEFLATE, explicit nodata (never 0 — 0 m is a real depth at the waterline), overviews built.
- All tunables live in `config/params.yaml` — never inline magic numbers in pipeline code.
- `site/` is dependency-free: one `index.html` + vendored `maplibre-gl` + `maplibre-contour`. No build step, no npm, no keys.
- Commits: small, per-phase, imperative messages; `data/raw/` and `*.mbtiles` are gitignored; tiles are committed (they're the product) — keep total <300 MB, use `--dry-run` first.

## Asking Euan

Interrupt him only for: his GPS points CSV, GEE auth (if used), GitHub repo/Pages setup, and any decision that changes the map's meaning (color ramp semantics, which prospect polygons to publish). Everything else: decide, document here, move on.

## Gotchas (append-only — update every session)

- GMRT/GEBCO over the AOI is altimetry-derived (~120–450 m real resolution); treat as smooth fill only, never as detail.
- rio-rgbify: use the maintained fork (acalcutt → TechIdiots-LLC redirect); `-e terrarium` confirmed; its `rio merge` can do tile-level fusion.
- ATL24 v2 live (DOI 10.5067/ATLAS/ATL24.002); SlideRule `atl24x` is keyless; NSIDC direct needs free Earthdata login (`earthaccess` fallback).
- MapLibre raster-dem fails silently on `file://` — always preview via http.server.
- 8-bit terrarium rounding can terrace smooth bathymetry — if visible, switch to `"encoding":"custom"` with 0.01 m interval.
- <append new discoveries below this line>
- [2026-07-09 session] MOUNT QUIRKS on this Windows folder mount: (a) the host Write/Edit tool TRUNCATES files above ~6 KB — write large files with a quoted bash heredoc (`cat > f <<'EOF'`) and verify line count + py_compile after; (b) unlink/rename are "Operation not permitted", so GDAL/rasterio cannot overwrite a raster (delete-then-create fails) → added `_common.raster_writer` (writes to native /tmp, then copyfile over the target; overwrite is allowed); (c) `git` cannot run in-place (needs to unlink lock files) → build the repo in native fs and copy `.git` back.
- [2026-07-09] Integrated CGS Council-for-Geoscience data (`data/geology/`, from updated_map): script 09 ingests the geology gpkg (679 substrate polygons: Reef/Prominent/Scattered Reef, Coarse Shelly Sediment, Sand) + bathymetry gpkg (88 isobaths, 0..-95 m, already negative). Outputs web geojson overlays + `cgs_isobath_points_4326.csv` for fusion + `cgs_reef_mask.geojson`.
- [2026-07-09] Fusion (05) reworked to FILL-ONLY (first-write-wins): highest-priority sources laid first, each fills only still-empty cells. This guarantees the validated SDB optical zone is never overridden by coarser CGS/GEBCO. Gates unchanged & honest: 0–15 m PASS 1.35 m; 15–25 m 4.90 m (optical wall).
- [2026-07-09] CGS isobaths do NOT improve the 15–25 m gate. Naive scipy griddata of sparse contours is unreliable in the SDB band (needed a ~+28 m median shift vs SDB — a datum+gridding artifact) and, when allowed to override SDB, tripled 15–25 m RMSE. So CGS is used for: deep-gap fill (below SDB), the isobath/substrate overlays, and prospect corroboration — NOT as a depth trainer. Honesty rule upheld: no false accuracy claim, gates not lowered.
- [2026-07-09] Dive logs: script 08 ingests the CLEANED/CLUSTERED `reef_candidates.csv` (NEVER the raw Dive-ACTIVITY JSON) → 36 clusters, 33 named/verified sites (Euan's own logs override external names). Fixed UTF-8-as-latin1 mojibake (Wayne's World). Cluster depth = dive MAX at the ENTRY GPS fix, so it's site depth-RANGE context, never per-pixel depth truth (not trained/validated on). Also emits dive_entries.geojson (reef_points.geojson source was truncated -> tolerant salvage loader).
- [2026-07-09] Prospect model (06) now corroborates each lead against CGS substrate: on Reef → score ×1.5 + "CORROBORATED"; on Sand/Coarse Shelly Sediment → ×0.5 "likely false positive". Two-source (morphology × geology) filter. 100 leads, 5 CGS-reef corroborated.
- [2026-07-09] Site: added toggles/overlays for CGS seafloor geology (substrate fill), CGS isobaths (labelled depth contours), and dive entry points; richer site popups (n_dives, alt names) and prospect popups (substrate, rank); ICESat-2 tracks regenerated (71) from the on-disk ATL24 parquet. site/data/ now holds all web geojson the app fetches.
- [2026-07-09] Additional free data sources scouted in reports/data_sources.md (ACEP/SAEON canyon multibeam [request-only, drop into data/priority/], Allen Coral Atlas [keyless via GEE], own boat sonar, IHO DCDB crowdsourced). Partial-AOI coverage is fine — fill-only fusion uses each where it exists.
=0 as nodata (fill). All selected scenes post-2022 so no cross-baseline mix. Verified: B8 over water now ~0.011 (physical), was -0.089.
- Composite output: `data/raw/s2_composite_10m_4326.tif`, 5 float32 bands [B1,B2,B3,B4,B8], 1975×3317 @10 m EPSG:4326, deglinted visible + raw B8, NaN nodata. THIS defines the 10 m master grid for 04/05.
- [2026-07-08 Phase 2-4 LIVE] Accuracy vs held-out ATL24 (by-track): **0–15 m RMSE 1.35 m → PASS**; 15–25 m RMSE 4.90 m → FAIL. This is the OPTICAL WALL, not a tuning miss — below ~18 m the Sentinel-2 signal hits the noise floor in Sodwana's water; 20–25 m RMSE ≈6 m is unreachable via passive optics. Documented honestly in `reports/accuracy_loop.md`; gate NOT lowered. Best SDB features = spectral-only (dropped `x,y`: they let XGBoost memorise train-track locations, inflating held-out error — a spatial-leakage trap). Real 15–25 m depth in the map = ATL24 lidar along tracks, not fabricated between-track surface.
- [2026-07-08] Fusion (05): the ATL24 tier was a STUB (listed in `order`, never gridded). Implemented `grid_atl24()` = blockmedian of TRAIN photons only (holdout stays independent). Cross-track interpolation is OFF (`fusion.atl24_grid.interpolate=false`): tested it, it BOTH fabricates reef between tracks AND worsens RMSE (overrode good SDB). Leave off unless a denser source arrives.
- [2026-07-08] Land leakage was REAL: SDB predicts spurious NEGATIVE depths over land (dunes), which `assert_no_positive_over_water` can't catch. `coastline_clip` was a param with no code. Implemented `_land_mask_from_s2()` = Sentinel-2 B8 (NIR) > `depth.nir_land_threshold` (0.06) → 10 m keyless shoreline. GMRT>0 is a coarse fallback but masks real near-shore reef (its ~55 m zero-contour sits offshore) — do NOT use it as the primary land mask. ~33% of the AOI is land (correctly nodata; not "holes").
- [2026-07-08] 06 perf traps FIXED: (a) rugosity was `generic_filter(np.nanstd)` = ~7M Python calls (minutes) → vectorised std via `uniform_filter` (E[z²]-E[z]²); (b) prospect extraction looped `np.where(lab==i)` over 120k components → vectorised `bincount`+`ndimage.center_of_mass/mean`. Also tightened prospects (92nd pct, min 12 px, 3 px edge-erode, top-100 ranked) — was emitting 28k specks.
- [2026-07-08] 07 tiler REWRITTEN: rio-rgbify (TechIdiots fork) hard-codes `multiprocessing.get_context("fork")` which DOES NOT EXIST on Windows → never worked. Replaced with a self-contained terrarium tiler (rasterio WarpedVRT + mercantile + PIL), no fork/no external CLI. 681 tiles / 49 MB z8–15 in ~12 s. Land/nodata encoded as +10 m sentinel; style ramp adds a `0.5→rgba(...,0)` stop so land renders transparent.
- [2026-07-08] Site (`site/`): vendored maplibre-gl 5.6.0 + maplibre-contour 0.1.0 into `site/vendor/` (was CDN-only). app.js fixes: tiles-present probe used a nonexistent `8/0/0.png` (AOI z8 tile is 151/148) → compute the centre tile; maplibre-contour runs in a Web Worker with no page base URL → relative tile URL threw "Failed to parse URL", must pass an ABSOLUTE url (`new URL('tiles/xyz/', location.href)`). Added `bounds` to the raster-dem + contour sources to stop out-of-AOI 404s. Verified via Claude Preview: DEM tiles load, zero console errors, 3D toggle works, land transparent. `window.__mlmap` exposed for headless tests.
- [2026-07-08] Env additions on Euan's machine: `pip install mbutil` + `git+https://github.com/TechIdiots-LLC/rio-rgbify` (rgbify now unused by 07 but harmless); scipy (from system site-packages) used by 05/06. `.claude/launch.json` added for the preview server (`python -m http.server 8080 -d site`).
- STILL OPEN (needs Euan, non-blocking): (1) real GPS ground-truth points — `data/ground_truth/gps_points.csv` still holds 2 example rows, so the GPS-bias line in validate.py is meaningless; (2) dive-site coords are 7 placeholders all `verified:false` — need the site-researcher 2-source pass (Euan's GPS names override); (3) GitHub repo + Pages for deploy; (4) repo is NOT yet a git repo (`git init` pending). No paid API/auth was needed anywhere — every source is keyless.
- [session 2026-07-08T21:15Z] review pipeline output; append real discoveries here.
- [2026-07-09] Site: `diveSiteStyle` was called in `site/app.js` (dive_sites loadVector) but never defined — a `ReferenceError` thrown mid-`onLoad()` silently killed everything queued after it: ICESat-2 tracks, prospect leads, dive-site markers, AND `wireToggles()`/`wireCoordinates()`/`wireMeasure()` — so every sidebar checkbox was a no-op (not just the CGS ones). Added the missing `diveSiteStyle()` (circle + label layers + click popup, matching the other `*Style` functions' pattern). Root cause of "toggles don't do anything" bug reports — always check `map.getStyle().layers` for a truncated layer list first when a toggle appears dead.
- [2026-07-09] `08_ingest_dive_logs.py`'s `_load_geojson_tolerant` salvage parser (for the truncated upstream `reef_points.geojson`) only extracted objects that closed back to brace-depth 0 — but Feature objects sit inside the outer `FeatureCollection` object, so they never close at depth 0 and 0 features were ever salvaged (silently — `dive_entries.geojson` shipped with `"features": []` and no error). Rewrote to track ALL closing braces via a start-index stack and filter candidates by the `"Feature"` marker; now salvages 84/~84 entry fixes correctly. Lesson: a salvage/recovery code path with no test coverage against real truncated input can silently do nothing for months.
- [session 2026-07-09T06:55Z] review pipeline output; append real discoveries here.
- [2026-07-09] CGS web-layer edges were blocky at dive-site zoom: `cgs.simplify_deg` (script 09) was a flat 0.00015 (~15-17 m at -27.5 lat) applied to BOTH the geology substrate polygons and the isobath contours, discarding real surveyed detail. Measured native vertex density of the source gpkgs directly (`data/geology/cgs_geology_sodwana.gpkg`, `cgs_bathymetry_sodwana.gpkg`): geology polygons (671 in-AOI, 347,059 raw vertices) have median segment length ~1.02 m (p25 0.68 m, p75 1.67 m, p90 8.51 m) — the 2005 survey was digitized far finer than the old web tolerance threw away. Isobaths (81 in-AOI, 27,933 raw vertices) are natively much coarser, median ~21.6 m/segment (p25 10.9 m, p75 32.5 m) — close to the existing `isobath_densify_deg` (~20 m), so they were not being over-simplified the same way. Chose a single shared `simplify_deg: 0.00002` (~2.0-2.2 m): close to the geology median so real reef-edge detail is preserved without inventing precision the survey doesn't have, and well below the isobaths' native spacing so nothing is fabricated there either — simplification only ever removes vertices, never adds them, so this is a pure-honesty-preserving change. `isobath_densify_deg` left unchanged (0.0002, ~20 m) since it already matches the isobaths' own native median vertex spacing; `data/raw/cgs_isobath_points_4326.csv` (fusion input for script 05) came out byte-identical (814,908 bytes, 29,435 points) confirming the depth-fusion tier was untouched by this change. Web outputs: `site/data/cgs_geology.geojson` 673 KB -> 2,133,741 bytes (671 features, ~45.6k vertices vs previous ~13k) and `site/data/cgs_isobaths.geojson` 136 KB -> 416,385 bytes (81 features, ~9.1k vertices vs previous ~2.8k); combined `site/data` now 2.69 MB, total `site/tiles`+`site/data` ~49.1 MB, trivial against the 300 MB budget. `validate.py --quick` re-run afterward reproduces the exact known baseline (0-15 m RMSE 1.35 PASS, 15-25 m RMSE 4.90 FAIL — the documented optical wall, unaffected since script 05 fusion was not touched).
- [session 2026-07-09T10:54Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T10:55Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T10:57Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T10:59Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T11:01Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T11:03Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:21Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:22Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:32Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:45Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:49Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:51Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T13:57Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T15:16Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T15:52Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T15:55Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T15:57Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T15:58Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T16:00Z] review pipeline output; append real discoveries here.
- [2026-07-09] New-data-source evaluation pass (data-scout + qa-validator subagents): tried to get
  real depth values from Copernicus Marine `BATHYMETRY_GLO_PHY_COASTAL_L4_MY_016_001` (100 m
  Sentinel-2 SDB, free-account-gated) and OSM Overpass seamark depths — both blocked this session
  by the sandbox's outbound network allowlist (Copernicus needs login credentials we don't have;
  Overpass's `/api/interpreter` returns empty bodies through this sandbox's `web_fetch`, plus a
  ~250-char URL cap on WMTS `GetFeatureInfo`). Real, actionable find: **de Wet & Compton (2021)
  SA shelf bathymetry** (free 28 MB zip, no login, johnscompton.com/maps/) is the actual data
  behind the `dewet_compton` fusion tier already wired in `config/params.yaml` — that tier has
  never had a file. ETOPO 2022 rejected as redundant with GEBCO/GMRT; SANHO charts rejected
  (paid); iSimangaliso downloads are visitor PDFs only, no GIS. Built and independently re-verified
  a reusable harness `reports/eval_scratch/rmse_against_holdout.py` (matches validate.py's band
  gates, 0-15m<=1.5m/15-25m<=2.5m) so scoring any of these against the ATL24 holdout is a 5-minute
  job once real files exist. Nothing in pipeline/, site/, config/, or the train split/GPS ground
  truth was touched — confirmed via git status. Full writeup: `reports/new_data_sources_evaluation_2026-07-09.md`.
- [2026-07-09] Reviewed 6 papers Euan supplied (3 UKZN ResearchSpace bitstreams + 2 local
  Downloads PDFs + 1 paywalled ScienceDirect abstract) for real bathymetric data. None contain a
  downloadable grid/CSV (all pre-open-data-era theses/papers, maps are physical/image plates), but
  **Green (2009) PhD thesis Appendix 4 confirms a real Reson Seabat 8111 multibeam survey (392 km²,
  29-838m, ~1m resolution) over Leven Point-Island Rock was explicitly withheld from publication**
  ("earmarked for publication at a later date") and names who holds it: Peter Ramsay/Marine
  GeoSolutions (Pty) Ltd (physically collected it), Dr Andrew Green (greena1@ukzn.ac.za, PI), and
  Council for Geoscience Marine Geoscience Unit (co-funded, same CGS already integrated via the
  2005 survey). Salzmann (2013) MSc independently corroborates Green's group holds data over
  exactly Mabibi/Sodwana/Diepgat/Leadsman/Leven canyons. Ramsay's 1991 PhD thesis has a real canyon
  table (Wright Canyon to -453m, White Sands to -353m) but only as a 1991 Surfer paper map, no
  digital soundings recovered, GPS ~48m error (too coarse to fuse as-is). Miller (1998) MSc
  (Lake Sibaya) confirmed out of the ocean AOI entirely, dropped. Full writeup:
  `reports/paper_review_2026-07-09.md`. Extracted PDF text left in the session outputs dir (not
  the repo) at paper_extracts/{miller_1998,green_2009}.txt — not committed, scratch only.
- [2026-07-12] FUSION1 built (`pipeline/11_build_fusion1.py` + `11b_tile_fusion1.py`; full writeup
  `reports/fusion1_report.md`). Decoded Euan's Garmin Quickdraw `possible_contours/` (867 `.qdc`
  tiles) with the keyless `interlark/qdc-converter` (PyPI) -> 1.31 M soundings, 1.13 M in-AOI, 0–328 m
  (`data/raw/`-style export lives in the session outputs `qdc_out/qdc_aoi_points_4326.csv`; NOTE the
  raw .qdc are NOT in the repo, they're in the sibling mount `possible_contours/`). Garmin datum
  offset vs ATL24-train = +0.84 m (draft), subtracted. Fusion = per-cell INVERSE-VARIANCE of
  {validated-old-fused ≤16 m, ATL24-train, Garmin, CGS, hull-nearest-interp, GMRT-deep-only};
  ~6.7 m grid; outputs `dem/fusion1_{depth,uncertainty,source}_4326.tif` + `site/tiles_fusion1/`.
  **Validation vs held-out ATL24: 0–15 m RMSE 1.51 (baseline 1.45, ≈ preserved by reusing the
  validated DEM verbatim ≤16 m); 15–25 m RMSE 4.20 (baseline 4.14 — the SAME optical-wall/shelf-break
  result, gate NOT met, reported honestly, NOT lowered).** The real win is completeness: extends the
  map from a −26 m ceiling to a clean 0→−81 m reef+canyon surface.
  KEY LESSONS (cost ~8 build iterations): (1) GMRT is USELESS as a shelf/canyon discriminator over
  this AOI — altimetry-derived, it reads DEEPER on the shelf break (−340 m) than in the real canyon
  (−165 m). (2) SDB/old-fused is finite EVERYWHERE incl. the canyon (saturates to ~−15..−22 m over
  −150 m water), so "SDB nodata" cannot mark the canyon and an SDB *ceiling* clamp FLATTENS the
  canyon — must use SDB's own *uncertainty*, not its value, and reuse the validated DEM only in its
  confident shallow range. (3) Garmin over the dive reef carries a LARGE spatially-COHERENT field of
  false-bottom returns (39 k-cell connected blobs centred on the reef, not the break) that geometry
  (median/grey-closing/connected-component) alone cannot remove. The filter that worked is the
  **CGS-isobath envelope**: reject Garmin grossly deeper than the CGS-implied depth — CGS says the
  reef is 20–30 m so the −100 m false-bottoms drop out, while the real shelf-break canyon (CGS runs
  deep there) survives. This is the Garmin×CGS combo Euan proposed, and the earlier finding that the
  two agree ~0-bias/1.5 m-MAD at 20–30 m is what makes it trustworthy. (4) Did NOT keep tuning
  thresholds to shave 0-15m from 1.55→1.50 — that would be tuning on the holdout (forbidden); instead
  reused the validated DEM structurally. Site: added a **"Fusion1 model" toggle** (`site/style.json`
  new `fusion1-dem` source + `fusion1-relief`/`fusion1-hill` layers w/ deep ramp; `site/app.js`
  `refreshDemLayers()` swaps relief/hillshade/3D/contours between baseline & Fusion1, deep contour
  DemSource added). MOUNT QUIRK reconfirmed: the host Write tool truncated `site/style.json` at ~2 KB
  (well under the ~6 KB rule-of-thumb) — rewrote via bash heredoc; large `.py`/`.json`/`.yaml` that
  are executed/parsed should ALWAYS be written via `cat <<'EOF'` + verified with py_compile/json.load.
  Deps pulled this session (persist in `~/.local`): qdc-converter, rasterio, pyarrow, mercantile,
  scipy, matplotlib — big wheels (pyarrow 50 MB, rasterio 35 MB) exceeded the 45 s bash cap; got them
  via parallel resumable `curl -C -` into `~/.cache/wheels` then `pip install --no-index`. Also: bash
  background procs (`nohup &`) DO NOT survive between tool calls (fresh PID namespace each call), but
  `~/.local` installs and `~/.cache` downloads DO persist.
- [2026-07-12] Fusion1 5 m HD reef inset: `pipeline/11c_build_fusion1_inset.py` + `11d_tile_fusion1_inset.py`
  (copies of 11/11b with grid = lon 32.660–32.735 / lat −27.620–−27.400, RES 0.000045 ~5 m; captures 81 %
  of Garmin, the 2–9-mile reef zone). Outputs `dem/fusion1_inset_*` + `site/tiles_fusion1_inset/` (706 tiles
  z12–16). In-strip validation IDENTICAL to 6.7 m (0-15m 1.29 PASS / 15-25m 3.86) — finer grid = detail, not
  accuracy (data-limited). Wired as auto HD overlay: style.json `fusion1hd-dem` source (bounds-limited,
  minzoom 12) + `fusion1hd-relief/hill`; app.js `refreshDemLayers()` shows them when Fusion1 active so the
  reef sharpens on zoom-in with no extra toggle. 3D mesh still uses the 6.7 m `fusion1-dem` (MapLibre setTerrain
  is single-source); HD only refines the relief/hillshade paint. Compare render: `reports/fusion1_inset_compare.png`.
 a full bottom-left panel to a slim,
  semi-transparent (opacity .72→1 on hover) bottom-center strip — JS logic in `wireCoordinates()`
  untouched, only position/style. (6) CGS isobath label text-color was reusing the SAME depth-ramp
  expression as the line color (`isobathStyle()`), so deep isobaths (-60 to -95 m) rendered in
  near-black navy text against a dark halo — illegible. Fixed to a fixed light `#eafaff` text color
  (matching `contour-labels`' already-working pattern) + halo width bumped 1.4→1.6; the isobath
  *line* color still uses the depth ramp, only the label text changed. **Bug found + fixed along the
  way**: MapLibre's own controls (nav/scale/attribution) carry an explicit `z-index:2`, which was
  painting OVER this app's panels (no z-index set) regardless of DOM order — surfaced by the
  collapsed legend chip sinking invisibly behind the attribution control. Added `z-index:3` to the
  shared `.panel` class. **Second bug found + fixed** (self-inflicted by moving the scale bar to
  bottom-left in this same session): `#sidebar`'s `max-height:calc(100% - 24px)` lets it grow
  almost full-viewport-tall with a long site list, and since it's later in the DOM than the map's
  control containers it was covering the relocated scale bar even after the z-index fix (sidebar is
  also `.panel`, same z-index, DOM order still decides ties). Capped sidebar `max-height` to
  `calc(100% - 90px)` to always leave bottom clearance; `overflow:auto` already handles scrolling
  within that cap, so no site-list content is lost. Verified via Playwright screenshots (9 states +
  all layer toggles, saved locally to `reports/screenshots/` — NOT committed to git, 16 MB of JPEGs
  isn't worth the repo bloat for a UI-only change; the project's own screenshot-commit rule only
  applies to DEM/ramp/tile changes) and independently re-checked via Claude Preview DOM inspection
  (sidebar/scale-bar/readout computed styles, legend collapse toggle, zero console errors).
- [2026-07-10] Wrote `reports/ml_spline_fusion_feasibility_2026-07-09.md`: feasibility check on
  using ML + spatial splining/smoothing (+ Copernicus) to improve fused-DEM accuracy. Recommends
  **residual kriging/GP correction on top of the existing SDB model** (not a new primary model) —
  found published precedent (2025 SDB literature) for exactly this two-scale pattern (ML for
  large-scale trend, kriging the *residuals* for the small-scale field) and confirmed it does NOT
  repeat the x,y spatial-leakage trap from the original SDB training (that trap was `x,y` as
  *predictive features*; residual kriging is geostatistical interpolation of the *error* field,
  evaluated by the same track-holdout gate). Also proposes using the residual-GP's own per-pixel
  uncertainty as the Copernicus-blending criterion instead of the depth-threshold rule that already
  failed (see the 2026-07-10 Copernicus band-override entry above) — a principled fix to that
  exact diagnosed bug. No new dependencies needed: `scipy.interpolate.RBFInterpolator` and
  `sklearn.gaussian_process.GaussianProcessRegressor` are both available via already-installed
  packages. Not implemented — flagged as one bounded `sdb-modeler` iteration for a future session,
  with the same exit criteria as the existing accuracy loop (pass → wire in + document; improves
  but still fails → report the honest number, same as today; no improvement → discard + document).
- [session 2026-07-09T21:45Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T22:18Z] review pipeline output; append real discoveries here.
- [session 2026-07-09T22:20Z] review pipeline output; append real discoveries here.
- [2026-07-10] Evaluated 10 ACEP Algoa cruises (2002-2006) + 20 SAEON catalogue entries Euan
  supplied — full writeup `reports/data_sources_ACEP_SAEON_evaluation_2026-07-10.md`. Nothing
  integrated. Key finds: (1) all 4 Sodwana-Bay Algoa cruises (107/119/127/134) predate every
  digital catalogue by ~a decade; per ACEP's own policy their data is DVD-archive-only at SAIAB,
  request-only. The real bathymetry behind that whole program was never an Algoa-cruise product —
  it's the March 2002 Marine GeoSolutions Reson SeaBat 8111 survey (Ramsay & Miller 2008, Hydro
  International), the SAME still-unpublished dataset already flagged in the 2026-07-09 Green(2009)
  paper review (Green/Ramsay/CGS) — confirms that's the one real lead, actionable only via direct
  email request, not a portal search. (2) 18/20 SAEON "ACEP Smart Zones MPA" site entries
  (Tongaat Pinnacles, Lens Ledge, uMdloti*, Richards Bay, Zinkwazi, Blood Reef, etc.) are confirmed
  130-4,700 km SOUTH of the AOI via each record's own geoLocation bbox (SAEON GraphQL/DataCite),
  not assumption, plus separately "Embargoed"-licensed behind an external Wix page regardless.
  (3) Two national-scale SAEON products DO cover the AOI bbox and are worth a decision from Euan:
  the SA mainland 100 m bathymetric grid (Manikam et al. 2024) has a working keyless download
  (~888 MB, `repository.saeon.ac.za/index.php/s/E7P3mx9YqTmFeAb`) — not pulled yet (size + same
  CGS/UKZN authors as our existing 2005 survey, real chance of redundancy, needs Euan's go-ahead
  before spending the download); the SA mainland submarine-canyons shapefile (also Manikam/Green/
  Sink et al., directly relevant to our canyon-corroboration work) has a bbox covering the AOI but
  BOTH its download links return "Share not found" — a genuine dead link, not a network block;
  recommended next step is emailing SANBI contact J.Currie@sanbi.org.za or retrying later (per the
  standing lesson that this sandbox's link/network reachability is not fixed and has flipped
  session-to-session before, e.g. Copernicus).
- [2026-07-10] Follow-up on the above: tried to actually pull #14 (SA 100m bathy grid) and
  re-check #3 (canyon shapefile) at repository.saeon.ac.za. Installed rasterio/fiona in the
  sandbox but **the download never started — this session's sandbox proxy returns an explicit
  `403 blocked-by-allowlist` for both `repository.saeon.ac.za` and `catalogue.saeon.ac.za`**,
  confirmed domain-specific (github.com returned 200 in the same test batch, so it's not a
  general outage). This is a different failure mode than the earlier research pass in the same
  session, which reached SAEON's GraphQL/DataCite metadata APIs fine — the block appears to sit
  specifically on the Nextcloud share-download paths, not the whole saeon.ac.za domain family.
  Per the standing lesson (sandbox reachability isn't fixed, e.g. Copernicus flipped between
  sessions) it's worth a retry later, but a `blocked-by-allowlist` proxy response reads as a
  deliberate block rather than a transient one, so don't assume it'll clear on its own.
  Practical path if this recurs: have Euan download the file via his own browser and drop it in
  the project folder — gdalinfo/fiona inspection needs zero network access once the file is
  local.
- [2026-07-10] Photogrammetry scouting: the real, active Sodwana-specific project is SAAMBR/ORI's
  "Virtual Reefs" (Sam Hofmeyr & Dr Dave Pearton) — GoPro-video SfM 3D reef reconstruction,
  producing DEMs + rugosity metrics on actual Sodwana reefs, presented at SAMSS 2022 ("Photogrammetry
  For Coral Reef Monitoring and Understanding Rugosity of Coral Reefs In South Africa") and written
  up on saambr.org.za ("Virtual Reefs – recreating Sodwana Bay's coral reefs in 3D"). No public
  dataset/repository found (no Zenodo/Figshare/Dryad hit, no peer-reviewed paper with a data
  availability statement located) — as of this search it looks like an internal ORI research
  effort, contact would have to go through SAAMBR/ORI directly. Nearest published analogue with an
  open-access paper: Cerrano et al. 2017 (MDPI Remote Sensing 9(7):705, "High Resolution Orthomosaics
  of African Coral Reefs") — but that's a 1655 m² SfM test site at Ponta do Ouro, Mozambique, ~55 km
  north of our AOI's northern edge (lat -26.83 vs our -27.32 boundary), same soft-coral/Acropora reef
  type as Sodwana so methodologically transferable but not a data source for our AOI. Not pursued
  further (no files, no integration) — flagged here in case Euan wants to reach out to ORI/SAAMBR
  for actual model exports (would be reef-surface detail/rugosity, not raw bathymetry, so any use
  would be corroborative like the CGS reef mask, not a depth-fusion input).
- [2026-07-10] Surveyed alternative *types* of data beyond more bathymetry surveys (full detail:
  `reports/data_sources.md` "2026-07-10 addendum"). Best new lead: **S2Shores**
  (github.com/CNES/S2Shores, Apache-2.0) — an open-source wave-kinematics bathymetry tool that derives
  depth from wave dispersion physics on paired Sentinel-2 frames, NOT light penetration, so it doesn't
  share our optical-wall failure mode. Runs on Sentinel-2 L1C products we already pull, takes our
  `config/aoi.geojson` directly as a `--roi_file`, no login/cost. Its published companion global
  product is validated at RMSE 2-5 m in the 10-40 m band (our exact 15-25 m gate failure), but that
  published grid is only 1 km resolution (too coarse for reef detail, coarse-reference use only);
  running the actual toolbox on our own 10 m scenes is untested — flagged as a bounded sdb-modeler
  iteration for a future session (same pass/partial/no-improvement exit criteria as the existing
  accuracy loop), not yet run. Also checked: Garmin Quickdraw Community (free crowdsourced recreational
  sonar, needs an interactive account/map-click to check Sodwana coverage, not sandbox-testable); IHO
  DCDB/NOAA NCEI (same `blocked-by-allowlist` sandbox pattern as SAEON earlier today — `ncei.noaa.gov`
  and its ArcGIS REST endpoint are both blocked this session); DEA National Coastal Assessment LiDAR
  (real SA government program, no Sodwana-specific public dataset found, contact-only lead like
  Green/Ramsay). No files integrated, nothing downloaded.
- [2026-07-10] Implemented Euan's top-2 recommended options from reports/data_sources.md.
  **#1 de Wet & Compton (2021):** re-confirmed the prior rejection independently
  (reports/eval_scratch/rmse_against_holdout.py against the existing data/raw/dewet_compton_points.csv):
  RMSE 48.35 m (0-15m) / 334.76 m (15-25m) vs holdout — consistent with the already-documented
  41/336m rejection (small numeric difference is noise, same catastrophic conclusion). Root cause
  understood, not just observed: rasterio confirms the .grd's CRS/extent/resolution assumptions are
  correct (bounds lon 12-36, lat -38..-24, ~333m cells, matches "EPSG:4326 implied"), so this is not a
  georeferencing bug — it's a genuine resolution failure. A 333m national-shelf grid cannot resolve
  Sodwana's canyon-adjacent reef terrain (canyons drop to -450m+ within a few km of 15-25m reef, per
  the already-documented Green/Ramsay canyon surveys), so nearest-neighbour matching smears canyon
  depth onto shallow holdout points. Same failure family as GEBCO/GMRT ("treat as smooth fill only,
  never as detail"), just worse here since the AOI sits right on a canyon edge. Remains un-integrated.
  **#2 Bathymetrix-AI (github.com/Nasef2017/Bathymetrix-AI):** ported both novel ideas and tested
  end-to-end (pipeline/04 -> 05 -> validate.py), not just point-wise. RANSAC-filtering TRAIN photons
  on the Stumpf log-ratio (drops ~8% as outliers) genuinely improved the 15-25m gate 4.90 -> 4.14m
  (still FAILS the 2.5m cap, but a real ~15% reduction) while 0-15m stayed passing (1.37 -> 1.45,
  thinner margin, cap 1.5). Kept enabled (`sdb.ransac_filter_enabled: true`). k-NN residual spatial-
  stacking ("Phase 4") was tested alongside it (k=5,8,15) and REJECTED: no meaningful gain on 15-25m,
  slightly hurt 0-15m at low k — documented in reports/accuracy_loop.md iteration 2, not wired in,
  same honest-rejection pattern as Copernicus phy_wk. Also fixed a real reproducibility bug found
  along the way: pipeline/04's XGBRegressor had no `random_state`, so re-running it without any real
  change could silently produce different numbers by chance (confirmed: an unseeded reimplementation
  reproduced the same qualitative pattern but different exact RMSE, e.g. 5.22m not 4.90m) — now seeded
  from `sdb.split_seed`. New eval script: reports/eval_scratch/residual_correction_experiment.py.
  **Mount bug found live in production files, not just reports:** `config/params.yaml` and
  `pipeline/05_fuse_dem.py` were BOTH found silently truncated mid-statement on the bash-visible copy
  (yaml.safe_load / py_compile both failed) despite the Read tool showing complete files — the same
  truncation bug from the 2026-07-09 Gotcha, but it turns out the bash view of a large file can go
  stale/truncated independent of *this session's* own edits (`05_fuse_dem.py` had not been touched
  this session at all and was still broken on the bash side). Also separately, the Edit tool itself
  re-truncated `pipeline/04_train_sdb.py` and `config/params.yaml` mid-session, twice, right after a
  successful heredoc fix. Net practical rule that held up under repeated testing this session: for
  files that are actually EXECUTED via bash (pipeline/*.py, config/*.yaml), only trust a `cat > file
  <<'EOF'` heredoc rewrite, verified immediately after with `wc -c` + `py_compile`/`yaml.safe_load` —
  never the Edit tool for these. For CLAUDE.md itself (never executed, only read), the Edit tool
  and the Read tool stayed reliable and consistent all session; it was bash's `cat`/`wc -c` view of
  THIS file specifically that lagged/staled — harmless since nothing runs it, but confusing if you
  go looking for your own prior edits via bash instead of the Read tool. Also hit the documented
  rasterio `Operation not permitted` overwrite issue in `pipeline/04_train_sdb.py` itself: it was
  writing `sdb_10m.tif`/`sdb_uncertainty.tif` via raw `rasterio.open(path, "w", ...)` instead of
  `_common.raster_writer` — fixed to match `05_fuse_dem.py`'s existing pattern.
- [2026-07-10] Closed out the two crowdsourced-sonar leads flagged in the 2026-07-10 "alternative
  data types" Gotcha (Garmin Quickdraw Community, C-MAP Genesis Social Map) — both are DEAD ENDS,
  not sandbox-testable, and Euan confirmed he owns no compatible hardware. **Garmin Quickdraw:**
  the old browser flow (connect.garmin.com/start/quickdraw/) now hard-redirects to the ActiveCaptain
  app store page — confirmed live via Claude-in-Chrome navigate, not just a search claim. Community
  contour download is app-only now (phone + free Garmin account, Quickdraw Community → Search for
  Contours), and even then the output is a proprietary sync-to-chartplotter format with no
  independent export step. **C-MAP Genesis Social Map:** genesismaps.com/Dashboard/socialmap loads
  with NO login wall (confirmed live — defaulted to a real crowdsourced contour view over Cape Town,
  so the SA region has at least some coverage), but the actual per-chart download is gated behind a
  "Plotter Details" form requiring a real registered Lowrance/Simrad/B&G unit's Serial Number + 9-digit
  alphanumeric Content ID (both read from the physical device's System→About screen) — there is no
  account-only or web-only download path, this is a hard hardware gate, confirmed via screenshot Euan
  sent, and Euan has no such unit. Neither source integrated, nothing downloaded. Lesson for future
  crowdsourced-sonar leads (Navionics SonarChart Live has the same community-upload model): check for
  a physical-device-registration requirement before spending session time on the web UI — both of
  these looked like ordinary account-gated downloads until the actual download step.
- [session 2026-07-25T07:05Z] review pipeline output; append real discoveries here.
- [session 2026-07-25T11:53Z] review pipeline output; append real discoveries here.
- [session 2026-07-25T14:53Z] review pipeline output; append real discoveries here.
- [2026-07-25] **Retired Fusion1, adopted Fusion2, full site rewrite.** A sibling repo,
  `EuanSwart/sodwana-reef-map` (checked out locally as `../Fable2`), is an independent rewrite of
  this same project with a cleaner reconciled-DEM pipeline (ATL24 > Garmin > CGS > SDB > GMRT
  inverse-variance fusion, 0 to -328 m, with a proper `fusion_reduced` low-confidence mask) and a
  genuinely more polished site (glass-panel icon-button/sliding-sheet design, theme toggle, its own
  localStorage-based "My dive sites"). Per Euan's explicit direction: made that DEM ("Fusion2") the
  site's ONE primary depth layer — retired `site/tiles/` (old baseline), `site/tiles_fusion1*`, and
  `pipeline/11*_fusion1*.py` entirely (deleted; the seam-smoothing fix from earlier this same session
  is now moot since Fusion1 no longer exists) — and rebuilt `site/index.html`/`style.css`/`app.js`
  from that sibling repo's design, porting in every Fable-only feature that design didn't have yet:
  prospect leads, dive entry points, the admin sheet (sha256 password gate, curated
  `dive_sites.geojson` CRUD/import/export — distinct from the sibling design's visitor-personal "My
  dive sites"), route planning (depth-profile SVG + honesty warnings), and the measure tool. Data
  files (`cgs_geology.geojson`, `contours.geojson` — supersedes the old separate isobaths layer —
  `dive_sites.geojson`, `icesat2_tracks.geojson`, and the `tiles/relief`+`tiles/terrain` tile
  pyramids) were copied from the sibling repo as-is; `prospects.geojson`/`dive_entries.geojson`
  stayed from this repo. **Validation boundary, stated honestly:** Fusion2's accuracy (0-15 m RMSE
  1.47 PASS; 15-25 m ~4.8 m documented data-limited waiver, shown hatched) is validated by the
  sibling repo's OWN `pipeline/04_validate.py` and gates, not this repo's `validate.py` (which still
  only knows about the old SDB/GEBCO fusion in `dem/sodwana_fused_10m_4326.tif` — untouched this
  session, still PASS/FAIL 1.45/4.14 on its own inputs). This repo does not re-validate Fusion2; if
  that DEM changes, re-check the sibling repo's own gates, don't assume.
- [2026-07-25] Route/measure depth-sampling was rewritten to use `map.queryTerrainElevation()`
  (same API the sibling design's own live depth-readout pill already used in production) instead of
  the old maplibre-contour `DemSource.getDemTile()` tile-fetch approach — removes the
  `vendor/index.mjs` dependency entirely (deleted, unused now) and works because the new `terrain`
  raster-dem source uses the same `encoding:"terrarium"` Fable always used. Also: MapLibre's
  `text-field` symbol layers throw "requires a style glyphs property" if the style has no `glyphs`
  URL — the sibling design deliberately has NONE (all text, including route waypoint numbers, is
  DOM `Marker` elements styled via the `.dlbl` class, not vector-tile symbol layers). Follow that
  convention for any future on-map text; don't add a `text-field` layer without also wiring a real
  glyphs endpoint.
- [2026-07-25] The Windows-mount Write/Edit truncation gotcha (files >~6 KB) bit `site/app.js` again
  (now ~63 KB) — writing directly via bash heredoc also failed this time with `ENAMETOOLONG` (the
  whole heredoc command exceeded the shell's argv length limit). Fix that worked: `Write` the full
  file to the session's scratchpad directory (a different mount, not subject to the truncation
  quirk) via the Write tool, then `cp` it into `site/` with plain `cp` (a filesystem copy, not a
  Write/Edit call, so the quirk never triggers) — verified byte-identical with `wc -c` before/after
  and `node --check` for syntax. Use this path for any future single-file rewrite over ~6 KB;
  smaller incremental `Edit` calls remain reliable regardless of total file size.
- [2026-07-25] Adding 3 more top-bar icon buttons (measure/route/admin, on top of the sibling
  design's original 4) overflowed the `.top-controls` row on mobile (375 px) enough to overlap the
  brand card. Fixed with a mobile-only media-query change: `.top-controls` gets
  `flex-wrap:wrap;justify-content:flex-end;max-width:calc(100vw - 100px)` (wraps to 2 rows, stays
  right-anchored, never reaches into the brand's space) and the brand's subtitle/title text is
  hidden below 640 px (just the logo mark shows) so there's no horizontal collision even before
  wrapping. If more top-bar actions are added later, re-check this at 375 px before shipping.
- [session 2026-07-25T16:56Z] review pipeline output; append real discoveries here.
- [2026-07-25] **Found and fixed the "shattered tile" / spike rendering bug Euan flagged.** Root
  cause was in the sibling repo's `pipeline/06_make_tiles.py:build_terrarium()`: nodata cells are
  hidden from the *visual* relief layer via alpha=0, but MapLibre's TERRAIN MESH ignores alpha and
  uses the decoded RGB elevation regardless — nodata decoded to exactly -32768 m, so any pixel next
  to real seafloor (~-20 m) became a ~32,748 m vertical cliff in the mesh. Since `map.setTerrain()`
  is always active (needed for `queryTerrainElevation()` depth reads, not just the 3D toggle), this
  distorted the "2D" view too, not only 3D. Two-part fix: (1) `set3D()`/the initial `map.on('load')`
  now use `exaggeration: 0` in the non-3D state (flattens the mesh completely for 2D; does NOT
  affect `queryTerrainElevation({exaggerated:false})` readings — that flag always returns the raw
  decoded value independent of the terrain's configured exaggeration). (2) Regenerated
  `site/tiles/terrain/` (`reports/eval_scratch/fix_terrain_tiles.py`, one-off, needs the sibling
  repo's `dem/fusion_depth_4326.tif` checked out at `../Fable2`) with nodata cells given the NEAREST
  real value within 15 px (~150 m) — smooth coastal transition instead of a cliff — and, separately,
  a second nodata path found while verifying: tile-boundary "boundless" reads at low zoom (a z8 tile
  spans ~156 km, well past the ~22×33 km AOI) fill out-of-mosaic pixels via `fill_value=0`, which
  ALSO decodes to -32768 — fixed by forcing every alpha=0 pixel (real nodata OR boundless fill) to
  encode exactly 0 m post-tiling, so no tile can ever contain an extreme value regardless of why a
  pixel is invalid. Verified exhaustively (not just spot-checked): scanned all 682 regenerated
  tiles' decoded elevation — max absolute value is now 328 m (matches the DEM's real max depth),
  down from 32768 m. This same architecture bug (alpha-based nodata + terrain-ignores-alpha) likely
  exists in the sibling repo's own site too if it's ever used at a zoomed-out 3D view spanning tile
  edges or large land masses — worth flagging upstream. Relief tiles were NOT touched (their
  alpha-based nodata is genuinely honored by the plain `raster` layer type, no mesh involved).
- [2026-07-25] This session's live-preview verification hit a real tooling limit worth recording:
  the preview browser tab went to `document.hidden=true`/`visibilityState:"hidden"` mid-session
  (confirmed via `requestAnimationFrame` never firing even once, for a brand-new minimal test map
  with zero relation to this site) and stayed that way through multiple full `preview_stop`/
  `preview_start` cycles, different server configs/ports, and hard navigations — nothing available
  fixed it (browsers deliberately can't be un-backgrounded from in-page JS; `window.focus()` is a
  no-op for this). The terrain-tile fix above was therefore verified via direct numeric inspection
  of the decoded tile data (Python/PIL/numpy), not a live screenshot — treat that as a real but
  lower-confidence verification tier than the usual screenshot workflow, and re-screenshot once the
  preview tab is confirmed visible again in a future session.
