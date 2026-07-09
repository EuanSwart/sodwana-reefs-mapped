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
