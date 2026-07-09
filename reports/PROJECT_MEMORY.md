# Sodwana Bay Bathymetry — Project Memory

**Purpose of this file:** a narrative account of the project's arc — why it exists, what has
happened phase by phase, what went wrong and what was learned, where the real opportunities are,
and what's still blocked on Euan. It is written to be read start-to-finish by a new collaborator
(human or a future Claude session with zero prior context) who needs the *story*, not just the
current technical state. See "How to use this file" at the bottom for how it relates to `CLAUDE.md`.

Last written: 2026-07-09, after Phase 1–4 build-out and the first project-improvement research pass.

---

## 1. Objectives

Euan is building a high-resolution, interactive seafloor map of Sodwana Bay, South Africa —
covering Red Sands (near Jesser Point) north through Two/Five/Seven/Nine-Mile Reefs to Mabibi.
Two stated purposes: **scuba training** (so students can see terrain, dive-site locations, and
depth before a briefing, in 2D and 3D) and **reef prospecting** (surfacing probable unmapped/undived
reef structure worth exploring).

Hard constraints that shape every decision:

- **AOI:** lon 32.62→32.82, lat −27.62→−27.32, defined once in `config/aoi.geojson` — never
  hardcoded elsewhere in the codebase.
- **Depths are negative metres everywhere.** Land is positive elevation, seafloor is negative
  depth. A positive value over water is treated as a bug, not a rounding quirk.
- **Budget: $0.** No paid APIs, no token-gated tile services, no paid tier of anything. Google
  Earth Engine is used strictly under its noncommercial free tier; Copernicus Data Space STAC is
  the keyless fallback. This constraint was still intact as of 2026-07-09 — nothing in the pipeline
  requires payment or a paid key.
- **Ground truth is sacred.** Euan's own GPS points (`data/ground_truth/gps_points.csv`, claimed
  ±10 cm accuracy) are validation-only — never used to train or tune any model. The ICESat-2 ATL24
  holdout split is by track, not random, specifically to prevent spatial leakage into the "held-out"
  accuracy numbers.
- **Honesty over prettiness.** The map must never interpolate detail the underlying data doesn't
  support, and must visually show its own resolution boundary. If an accuracy gate can't be met
  after the iteration budget is spent, the project reports the real numbers rather than quietly
  lowering the gate. This principle has already been tested for real (see Section 2) and held.
- **The accuracy gates** (from `SODWANA_BATHYMETRY_PLAN.md` Section 2, vs held-out ATL24, by-track
  split): RMSE ≤ 1.5 m for 0–15 m depths, RMSE ≤ 2.5 m for 15–25 m depths.

The full technical plan lives in `SODWANA_BATHYMETRY_PLAN.md` (10 sections: mission, deliverables,
repo layout, Phase 1 data acquisition, Phase 2 SDB model, Phase 3 fusion, Phase 4 tiles/web app,
agentic workflow, risks/upgrades, kickoff prompt). This memory file assumes that plan as background
and focuses on what actually happened when it was executed.

---

## 2. Progress so far

### Phase 1 — Data acquisition (scripts 01–03)
- `01_fetch_gebco_gmrt.py`: GEBCO/GMRT deep-water base grids. Confirmed these are altimetry-derived
  over this AOI (~120–450 m real resolution, no multibeam swaths present) — used explicitly as
  smooth deep fill only, never presented as detail.
- `02_fetch_atl24.py`: ICESat-2 ATL24 v2 lidar bathymetry via the keyless SlideRule `atl24x`
  endpoint (NSIDC direct download is the documented fallback, needs free Earthdata login via
  `earthaccess`). This is the calibration signal the plan explicitly says the "previous ML-on-satellite
  attempt" lacked.
- `03_fetch_sentinel2.py`: multi-scene Sentinel-2 median composite, Hedley-deglinted visible bands
  + raw B8, all scenes post-2022 to avoid cross-baseline mixing. Output
  `data/raw/s2_composite_10m_4326.tif` — 5-band float32, 1975×3317 @ 10 m, EPSG:4326 — this defines
  the 10 m master grid used throughout Phase 2–3.

### Phase 2 — SDB model training (script 04) — the optical-wall finding
The accuracy loop (documented live in `reports/accuracy_loop.md`) ran 2 of its 6 allotted
iterations, then stopped early with a written rationale rather than burning the rest of the budget:

- **Iteration 0** (baseline features including x,y): 0–15 m RMSE 1.45 m (PASS), 15–25 m RMSE 4.59 m (FAIL).
- **Iteration 1** (dropped x,y — spatial-leakage fix): 0–15 m RMSE 1.37 m (PASS, better), 15–25 m
  RMSE 4.90 m (FAIL, essentially unchanged).

Conclusion, reported honestly rather than smoothed over: the 0–15 m gate passes with margin
(1.35–1.37 m depending on which report you read — `reports/accuracy_report.md`'s per-band table
sums to 1.35 m for the 0–15 m gate). The 15–25 m gate does **not** pass (4.90 m vs a 2.5 m cap) and
this is treated as a genuine physical limit of passive optics in Sodwana's water column, not a
tuning miss — below ~18 m the Sentinel-2 signal is at the noise floor for this clarity/energy
regime. Cross-track interpolation between ATL24 tracks was tested as a way to "fill in" the deep
band and rejected: it both fabricated reef detail between tracks and made RMSE *worse*, so it is
disabled (`fusion.atl24_grid.interpolate=false`). Real 15–25 m depth in the shipped map comes from
ATL24 lidar shown honestly along tracks, not from an invented between-track surface. The gate was
never lowered to make this look like a pass.

### Phase 3 — DEM fusion (script 05) and prospect derivatives (script 06)
- Fusion is **fill-only, priority-stack** (highest-priority source laid first, each subsequent
  source only fills still-empty cells) — this was a deliberate rework from an earlier blend
  approach, specifically to guarantee the validated SDB optical zone can never be silently
  overridden by coarser CGS/GEBCO data.
- Priority order (deepest tiers to fallback): future multibeam drop-in (`data/priority/`, empty for
  now) → ATL24 gridded (train split only, blockmedian) → SDB 10 m → CGS isobaths (deep gap fill) →
  GEBCO/GMRT.
- Land-leakage was found to be a real bug (SDB was predicting spurious negative depths over land
  dunes) and fixed with a Sentinel-2 NIR (B8) land mask, not the coarser GMRT zero-contour (see
  Section 3 for the full story).
- `06_derivatives.py` computes slope, rugosity (currently windowed std-dev, not the more standard
  Vector Ruggedness Measure — see Section 4), and Bathymetric Position Index at 100 m/500 m scales
  to produce ranked prospect leads — cells with high positive BPI + high rugosity, >500 m from any
  known dive site. Each lead is now cross-checked against CGS substrate polygons: on mapped Reef,
  score ×1.5 and tagged "CORROBORATED"; on Sand/Coarse Shelly Sediment, score ×0.5 and tagged
  "likely false positive." Current output: 100 ranked leads, 5 CGS-reef-corroborated.

### CGS geology/bathymetry integration (script 09)
Council for Geoscience 2005 Maputaland Marine Geoscience survey ingested: 679 substrate polygons
(Reef/Prominent/Scattered Reef, Coarse Shelly Sediment, Sand) and 88 real depth isobaths (0 to
−95 m, already negative). Used for: web overlays, a reef mask, deep-gap fill in the fused DEM, and
prospect corroboration. Explicitly **not** used as a depth trainer — naive gridding of the sparse
isobaths in the SDB depth band needed an unexplained ~+28 m median shift to match SDB (a
datum/gridding artifact, not resolved), and when allowed to override SDB it tripled the 15–25 m
RMSE. So it's deep-fill/overlay/corroboration only, never a competing depth source in the band
where SDB is validated.

### Dive-log ingestion (script 08) and prospect model
Ingests the cleaned/clustered `data/dive_logs/reef_candidates.csv` (deliberately never the raw
dive-computer JSON export) into 36 clusters, 33 of them named/verified sites, with Euan's own dive
logs overriding external names where they conflict. Cluster depth is the dive's *maximum* depth at
the entry GPS fix — i.e. site depth-range context for a briefing, not a per-pixel ground truth, and
it is not used to train or validate the DEM. Also emits `data/dive_entries.geojson` (84 entry GPS
fixes) via a salvage parser for a truncated upstream file — see Section 3 for why that parser
initially produced nothing.

### Site build (Phase 4, script 07 + `site/`)
- Tiling: a custom terrarium tiler was written from scratch after discovering the planned
  rio-rgbify approach doesn't work on Windows (see Section 3). Currently 681 tiles / 49 MB at
  z8–z15 — comfortably under the 300 MB budget.
- `site/index.html` + `site/app.js` + vendored MapLibre GL 5.6.0 and maplibre-contour 0.1.0 (no
  CDN dependency, no build step, no keys). Layers: colour-relief depth ramp, hillshade, dynamic
  contours, 3D terrain toggle, dive-site markers with popups, ICESat-2 track overlay (71 tracks),
  prospect leads, CGS substrate/isobath overlays, dive entry points. Coordinate tools (click-to-copy,
  URL-hash deep links) and a distance-measure tool are wired up.
- Verified via headless preview: DEM tiles load, zero console errors, 3D toggle and layer toggles
  work, land renders transparent.

### In flight as of the 2026-07-09 session
The Gotchas log in `CLAUDE.md` and today's commits (`f32545c` "Fix broken site toggles and empty
dive-entry salvage parser", preceded by `8b5c343` "Append gotcha log entries, add project
improvement research, fix report encoding") show active work on: fixing the site's toggle wiring
bug, fixing the dive-entry salvage parser, and a first structured "project improvement research"
pass (`reports/project_improvement_research_2026-07-09.md`, summarized in Section 4 below). As of
this writing there is no `reports/deployment_guide.md` in the repo and no `git remote` configured
(`git remote -v` returns nothing) — see Section 5, GitHub deploy is still an open item, not yet
resolved by a parallel session.

---

## 3. Mistakes and lessons learnt

Each entry: what went wrong, how it was caught, what the durable lesson is. These are pulled from
real events recorded in `CLAUDE.md`'s Gotchas log, not reconstructed from memory.

**Spatial leakage via x,y features (Phase 2).**
The original SDB feature set included raw `x,y` coordinates alongside spectral bands. This let
XGBoost partially memorize train-track *locations* rather than learn the spectral-to-depth
relationship, which inflated apparent accuracy on training data while doing nothing for genuine
held-out generalization. Caught by comparing the by-track holdout RMSE before/after dropping the
features (iteration 0 vs 1 in the accuracy loop). *Lesson: when validation is by-track rather than
random, coordinate features are a leakage channel almost by construction — audit feature sets for
anything that could let a model key off "which survey pass is this" instead of "what does the
signal say."*

**`diveSiteStyle` ReferenceError silently killed all toggle wiring (site).**
`site/app.js` called a function `diveSiteStyle()` in the dive-sites layer loader, but the function
was never actually defined. The resulting `ReferenceError` fired mid-`onLoad()` and — because it
was unhandled — silently aborted everything queued *after* it in the same handler: the ICESat-2
track overlay, prospect leads, dive-site markers, and critically `wireToggles()` /
`wireCoordinates()` / `wireMeasure()`. The visible symptom was "every sidebar checkbox is a no-op,"
which looked like a toggle-specific bug but was actually total silent failure of an unrelated
downstream init function. Fixed by adding the missing style function. *Lesson: an uncaught
exception partway through a sequential init function can produce a bug report that looks narrowly
scoped ("toggles don't work") when the real fault is much earlier and much larger — check
`map.getStyle().layers` (or equivalent "did everything actually register") before chasing the
symptom as reported.*

**Salvage parser silently produced zero recovered features for an unknown length of time
(dive-log ingestion).**
The upstream `reef_points.geojson` file is truncated, so `08_ingest_dive_logs.py` includes a
tolerant salvage parser meant to recover whatever complete JSON objects it can from the broken
file. The original implementation only extracted objects that closed back to brace-depth 0 — but
GeoJSON `Feature` objects live *inside* the outer `FeatureCollection` object, so they never reach
depth 0 on their own and literally zero features were ever salvaged. This shipped silently:
`dive_entries.geojson` had `"features": []` and threw no error, so the failure was invisible unless
someone thought to check the feature count. Fixed by tracking all closing braces via a start-index
stack and filtering candidates for the `"Feature"` type marker, recovering 84 of ~84 entries.
*Lesson: a recovery/salvage code path that has never been tested against real broken input can
silently do nothing — potentially for a very long time, since "produced an empty-but-valid output"
looks identical to "there was nothing to recover" from the outside. Recovery paths need a test with
genuinely malformed input, not just the happy path.*

**GDAL/rasterio cannot overwrite files in place on this Windows mount.**
`unlink`/`rename` return "Operation not permitted" on this specific mounted folder, so any
delete-then-recreate pattern for overwriting a raster fails. Fixed by adding
`_common.raster_writer`, which writes to native `/tmp` first and then copies the file over the
target (copy, not rename/unlink, is allowed). *Lesson: mount/filesystem quirks can break a
completely standard library pattern (safe-overwrite-via-temp-file-and-rename) in ways that look
like a code bug at first; when a well-tested library call fails with a permissions error on a
network/virtual mount, suspect the mount before the library.*

**Host Write/Edit tool truncates files above ~6 KB on this mount.**
Large file writes silently truncated rather than erroring. Workaround: write large files via a
quoted bash heredoc (`cat > f <<'EOF' ... EOF`) and verify line count + `py_compile`/JSON-parse
after, rather than trusting the editor tool's success signal. *Lesson: "the tool reported success"
is not sufficient verification for large writes on an unfamiliar filesystem — always independently
verify size/line-count/parseability after, especially for anything near a suspicious size
threshold.* (This memory file itself was written this way, per the task's own instructions.)

**`git` cannot run in-place on this mount either.**
Same root cause as the unlink issue above — git needs to unlink lock files. Workaround: build/commit
in native filesystem and copy `.git` back. *Lesson: one root-cause filesystem limitation
(no unlink/rename) surfaces as multiple seemingly-unrelated tool failures (rasterio, git) — once you
find the pattern once, check for it everywhere else "delete-then-write" is assumed.*

**rio-rgbify's hard-coded `multiprocessing.get_context("fork")` does not exist on Windows.**
The plan specified rio-rgbify (TechIdiots-LLC maintained fork) for terrarium tile encoding. It
never actually worked on this environment because it unconditionally requests the `"fork"`
multiprocessing context, which Windows does not support. This means the tiling step of the plan, as
literally written, was never viable in Euan's actual environment. Fixed by replacing it entirely
with a self-contained tiler (rasterio `WarpedVRT` + mercantile + PIL, no fork, no external CLI) —
681 tiles/49 MB in ~12 s. *Lesson: a tool being "the maintained fork, verified working" (as the plan
states, correctly, for Linux/Mac) doesn't mean verified for the actual target OS — Windows-specific
multiprocessing limitations are common enough to check explicitly before committing a pipeline
stage to a library.*

**Terrarium tile terracing — the original diagnosis in `CLAUDE.md` was wrong, and the
project-improvement research pass caught it.**
An earlier Gotchas entry guessed that visible terracing in smooth bathymetry was caused by 8-bit
terrarium rounding, and proposed switching to a coarser custom 0.01 m encoding as the fix. The
2026-07-09 research pass checked this against the actual Tilezen/Mapzen terrarium spec and found
terrarium already encodes at ~0.0039 m/step — *finer* than the proposed fix, so switching encodings
as diagnosed would not have solved anything. The real cause is more likely the underlying 10 m
grid's genuine coarseness becoming visible under GPU colour-relief interpolation, or PNG resampling
artifacts — not yet re-diagnosed by inspecting raw decoded pixel values along a slope transect.
*Lesson: a plausible-sounding root-cause guess written into a project's memory file can persist and
get treated as settled fact in later sessions unless something forces a re-check against the actual
spec/data — an adversarial or research-focused review pass is worth running periodically even on
"already solved" problems, not just new ones.* This is still an open re-diagnosis, not yet fixed.

**Land leakage from a missing coastline clip (fusion).**
`coastline_clip` existed as a config parameter with no code behind it — a "configured but not
implemented" trap. The real bug this allowed through: SDB predicted spurious negative (i.e.
"underwater") depths over land dunes, and the existing `assert_no_positive_over_water` validation
check couldn't catch it because the bogus values were still (wrongly) negative, not positive. Fixed
with a real Sentinel-2 NIR (B8 > 0.06) land mask at 10 m, keyless. GMRT's own zero-contour was
considered as a fallback land mask and explicitly rejected — it's coarse enough that its ~55 m
zero-contour sits offshore of real nearshore reef, so using it as the primary land mask would have
masked out genuine shallow reef as if it were land. *Lesson: a config parameter existing is not
evidence the behavior exists — grep for where a param is actually *read*, not just declared, when
auditing whether a described safeguard is real; and a validation assertion needs to be checked
against the specific failure mode it's meant to catch, since "no positive depths over water" does
not catch "wrongly negative depths over what should be land."*

---

## 4. Extensions and open opportunities

This section synthesizes `reports/project_improvement_research_2026-07-09.md` (3 parallel research
subagents + 1 adversarial fact-checker, all claims tagged `[verified]`, `[corrected]`, or
`[unverified]` by that report — those tags are preserved below rather than flattened into
unqualified statements).

**Top opportunity — S2Shores wave-kinematics SDB `[verified: real CNES repo, published accuracy
figures]`.** CNES's open-source toolbox (github.com/CNES/S2Shores) estimates depth from swell
dispersion physics rather than passive-optics reflectance. This is a genuinely different physical
measurement, not the same optical method re-tuned — meaning it isn't subject to the same
extinction-depth noise floor that causes the current 15–25 m gate failure. Reported accuracy
(RMSE 2–5 m) likely still wouldn't cleanly pass the 2.5 m gate, but would be a large improvement
over the current 4.9–6.3 m failure, and Sodwana has real exploitable SE groundswell (8–13 s period)
to drive it. This is the most promising path past the optical wall found so far — worth prototyping
on the Sentinel-2 scenes already in the pipeline.

**Best real-data upgrade — ACEP 2002 multibeam of Jesser and Wright Canyon `[verified — highest
confidence finding of the entire research pass; the source article (Ramsay & Miller, Hydro
International, Jan 2008) was fetched directly and matches the claim almost word-for-word, including
survey dates and instrument]`.** Reson SeaBat 8111 multibeam of 23 KZN submarine canyons including
two explicitly inside the AOI, gridded/contoured by the Council for Geoscience. Not a public
download — requires a direct request via SAEON/MIMS (data.ocean.gov.za), CGS, or the ACEP program
(Marine GeoSolutions / NRF-SAIAB). This is the best-known path to filling the currently-empty
`data/priority/` multibeam tier with real soundings instead of another model estimate, specifically
for the >30 m canyon heads the optical DEM structurally cannot see.

**Roadmap document — UKZN Young (2009) MSc thesis `[verified — record and abstract match exactly]`.**
"An integrated marine GIS bathymetric dataset for KwaZulu-Natal," free PDF via
researchspace.ukzn.ac.za. Integrates 32 datasets (1911–2006) — 15 from Council for Geoscience, 9
from SA Navy, 5 from ACEP — naming exactly which surveys exist and their years for the whole KZN
coast including Sodwana. Recommended as required reading before any further institutional data
request, since it narrows exactly who to ask for what.

**Two low-effort, citable methodology upgrades to `06_derivatives.py` `[verified as real, citable
gaps]`:**
- Swap the rugosity metric from windowed elevation std-dev to **Vector Ruggedness Measure**
  (Sappington et al. 2007) — VRM decouples structural complexity from slope, so a plain std-dev
  currently flags a steep-but-smooth drop-off the same as genuinely rugose reef.
- Test a smaller BPI radius pair (e.g. 30 m/150 m) alongside the current 100 m/500 m — the current
  radii were borrowed from Lundblad et al. (2006)'s American Samoa reef work, and Sodwana's reef
  patches are plausibly smaller than those features. The 92nd-percentile prospect threshold itself
  has no literature precedent either way (not flagged as wrong, just not independently justified).

**What the research pass confirmed should NOT change:** Hedley deglinting, XGBoost regression, the
priority-stack fusion approach (matches NOAA's own National Bathymetric Source practice), and the
ATL24 0.6 confidence threshold (independently confirmed as the value ATL24's own developers derived
by maximizing F-score against NOAA BlueTopo, published in Parrish et al. 2025 / Magruder et al.
2025) are all `[verified]` as sound, current best practice — not weaknesses worth spending iteration
budget on.

**Other DIY / low-cost leads worth acting on, surfaced independently by two separate research
efforts converging on the same idea:**
- **Log your own boat sonar** (fishfinder/Garmin/Deeper/Navionics NMEA or GPX export) on dive-boat
  runs over the 15–30 m reefs — a weekend of this would plausibly beat every satellite source in
  exactly the depth band SDB fails. The fusion pipeline already accepts point-sounding CSVs via the
  `dewet_compton` tier, so this has zero pipeline rework cost.
- **IHO DCDB** (NOAA's crowdsourced global sounding archive) — free CSV, sparse but real coverage
  off Sodwana, contributable as well as consumable.
- Lower priority / reference only: Copernicus Marine coastal SDB product (`[unverified]` whether it
  has non-null pixels for this exact AOI — a quick free check before any integration effort), Allen
  Coral Atlas benthic/bathy layers (`[unverified]` whether classified output exists for Sodwana
  specifically, but if it does it's validation-only since both its layers are capped shallower than
  where SDB already works), current CGS ArcGIS portal (worth a 10-minute check for anything newer
  than the already-ingested 2005 survey, zero new integration cost if found), and several avenues
  the research explicitly could **not** confirm add value for this AOI (EMODnet — Europe only;
  Copernicus Marine HR-OC — European seas only; SANHO charts — imagery sold, no free raw-sounding
  access found; most DFFE/OCIMS MSP layers — confirmed not open-downloadable).

---

## 5. Still open / needs Euan

These are flagged in `CLAUDE.md` as non-blocking but genuinely open — reconfirmed here as of this
session:

1. **Real GPS ground-truth points.** `data/ground_truth/gps_points.csv` still contains only the 2
   example placeholder rows shipped in the template (confirmed by direct read on 2026-07-09) —
   Euan's real ~20–30 points have not yet been supplied. Until they are, any "bias vs Euan's GPS
   points" figure quoted anywhere is meaningless, not a real validation result.
2. **Dive-site coordinate verification.** `data/dive_sites.geojson` currently has 36 sites, 33
   flagged verified (from Euan's own dive logs) — but the plan's two-source rule for
   externally-sourced sites (site-researcher proposes, qa-validator cross-checks) has not been run
   as a dedicated pass; any site not from Euan's own logs should be treated as needing that check.
3. **GitHub repo + Pages deploy.** Confirmed still open as of this session: the repo has 3 local
   commits and `.github/workflows/pages.yml` exists, but `git remote -v` returns nothing — there is
   no GitHub remote configured yet, and no `reports/deployment_guide.md` exists in the repo. This is
   *not* yet resolved by a parallel session (that file was speculatively mentioned as something to
   check for, but it isn't there) — deploy still needs Euan to create/authorize the GitHub repo.
4. **GEE auth**, if Sentinel-2 fetching ever needs to be re-run and GEE (rather than the Copernicus
   Data Space keyless fallback) is the chosen provider — noncommercial registration, still free, but
   requires Euan's action once.
5. Decisions that change the map's meaning (colour-ramp semantics, which prospect polygons to
   publish) are reserved for Euan per `CLAUDE.md`'s "Asking Euan" section — none flagged as pending
   a decision as of this writing, but worth checking before any prospect-layer publish step.

---

## 6. How to use this file

- **`CLAUDE.md`** is the operating manual: project rules, conventions, commands, and a terse
  append-only "Gotchas" log of technical discoveries (parameter choices, exact numbers, mount
  quirks). Keep appending to it every session, for every new technical discovery, as instructed in
  its own "Agentic workflow" section — it is meant to be updated constantly and read as a reference,
  not start-to-finish.
- **This file (`reports/PROJECT_MEMORY.md`)** is the narrative history, lessons-learnt writeup, and
  opportunity roadmap — meant to be read start-to-finish by someone (or some future session) who
  needs to understand the whole arc of the project, not just look up one fact. Update it at the end
  of major sessions or phases (a phase gate passing, a research pass completing, a major bug found
  and fixed) — not after every small edit. When updating, add to the relevant section rather than
  appending a raw log entry, and preserve the `[verified]`/`[corrected]`/`[unverified]` style
  confidence-tagging wherever a claim's certainty matters, per this project's honesty-over-prettiness
  principle.
