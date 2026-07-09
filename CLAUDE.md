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
