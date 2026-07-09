# New data source evaluation — 2026-07-09

Scope: on top of `reports/data_sources.md`, hunt for further free bathymetry/reef data for
Sodwana Bay, actually test access + AOI coverage, and where real depth values are obtainable,
score them against the held-out ATL24 validation points (`data/raw/atl24_holdout.parquet`,
2875 points, never used to train the project's SDB model) using the same gates as
`pipeline/validate.py` (0-15 m RMSE ≤1.5 m, 15-25 m RMSE ≤2.5 m).

Run via two subagents this session: a data-scout pass (research + live testing), then an
independent qa-validator pass (re-ran the scout's own test harness against a fresh synthetic
file, checked git status for unintended edits, fact-checked the non-obvious claims). Corrections
from QA are folded in below.

## UPDATE 2026-07-10: real RMSE numbers obtained

Euan supplied the de Wet & Compton grid directly and Copernicus Marine credentials; this
session's network also reached `overpass-api.de` (still 406/blocked) and Copernicus (worked) —
network reachability varies session to session, it is not a fixed property of this sandbox.
Both remaining candidates now have real, harness-verified numbers below. Bug fixed in
`reports/eval_scratch/rmse_against_holdout.py`: `HOLDOUT_PATH` had a hardcoded prior-session
sandbox path (`/sessions/zen-practical-volta/...`) that would not resolve elsewhere; now derived
relative to the script's own location.

### de Wet & Compton (2021) — REJECTED, real numbers now in

File Euan provided (`data/raw/Willem de Wet Bathymetry of Southern Africa Continental Shelf.grd`)
is an Arc/Info ASCII Grid, whole-southern-Africa-shelf extent (8001x4668, ~333 m cells),
depths already negative-down (no sign flip needed). AOI clip
(`reports/eval_scratch/convert_dewet_compton.py` -> `data/raw/dewet_compton_points.csv`, 4082
points) scored against the ATL24 holdout:

```
0-15 m:  n=2679, RMSE=41.31 m, bias=-5.92 m   FAIL (gate 1.5 m)
15-25 m: n=159,  RMSE=336.51 m, bias=-256.63 m FAIL (gate 2.5 m)
```

**Verdict: reject.** Confirms the original suspicion — a national-scale ~333 m grid cannot
resolve reef-scale nearshore bathymetry; the huge 15-25 m error/bias suggests real
canyon/shelf-edge features at this coarse resolution land in totally different depth context
than the true nearshore position. Reference/regional-context value only, not a fusion candidate.
`dewet_compton` fusion tier in `config/params.yaml` stays empty (correctly — wiring this in would
make the map worse, not better).

### Copernicus Marine `phy_wk` (wave-kinematics SDB) — promising, still fails gate, worth a note

Registration confirmed valid (`copernicusmarine login --check-credentials-valid`). Subset of
`cmems_obs-sdb_glo_phy_wk_my_100m-l4-s2_static` / `height` variable over the AOI: real data
exists over Sodwana (2259 of 55296 grid cells non-nodata, depths -10.5 to -34.9 m, mean -20.5 m
— sitting exactly in the project's failing 15-25 m band).

```
0-15 m:  n=126, RMSE=3.59 m, bias=-2.83 m FAIL (gate 1.5 m)
15-25 m: n=45,  RMSE=2.95 m, bias=-1.40 m FAIL (gate 2.5 m)
```

**Verdict: fails both gates, but 15-25 m RMSE 2.95 m is far better than the current fusion's own
optical-wall number (4.90 m)** — almost passing, and the bias is consistent-sign (predicts
~1.4-2.8 m deeper than ATL24 truth), which smells like a vertical datum offset (e.g. chart datum
vs. the geoid/ellipsoid ATL24 uses) rather than random noise.

### UPDATE 2026-07-10: implemented in fusion, tested, REGRESSED, disabled

Euan asked to wire this into the core DEM for the 15-25 m band. Implemented in
`pipeline/05_fuse_dem.py`: a band-conditional override where Copernicus phy_wk replaces SDB only
in cells where **SDB's own predicted value** falls in `fusion.copernicus_band_m` ([-25,-15] m) —
the only depth signal available at inference time (no ground truth to condition on). Result after
a full `pipeline/05_fuse_dem.py` + `pipeline/validate.py` run:

```
GATE 15-25 m: RMSE=5.06 <= 2.5 -> FAIL   (was 4.90 before this change -- WORSE)
```

Root cause, found by sampling the fused DEM's `source` band at each holdout point: at the 35
holdout points where the override actually fired, **SDB itself was already accurate there**
(RMSE 1.13 m) — swapping in Copernicus made those specific points worse (RMSE 2.96 m, dragged
down by its own ~1.2 m bias). Copernicus's *aggregate* accuracy across its whole footprint being
better than SDB's aggregate does NOT mean it's better at the specific locations "SDB says
15-25 m" selects — that heuristic tracks depth, not SDB error, and this AOI's Copernicus coverage
happened to overlap a patch where SDB was doing fine, not the patches where SDB is actually wrong.

**Per the project's own honesty rule, this is not shippable as-is: it's a real, measured
regression against the holdout gate, not an improvement.** Disabled via
`fusion.copernicus_phy_wk_enabled: false` in `config/params.yaml` (code kept, documented, not
deleted) after confirming `validate.py` reproduces the exact known baseline again (0-15 m RMSE
1.35 PASS, 15-25 m RMSE 4.90 FAIL). If revisited, the fix is a better selection criterion — e.g. a
local SDB/Copernicus disagreement or uncertainty mask instead of raw SDB depth value — re-tested
against the holdout before re-enabling, not assumed from the standalone/aggregate number alone.

### OSM Overpass seamark depths — still blocked, confirmed query bug in original instructions

Direct API calls (`overpass-api.de` and the `kumi.systems` mirror) still return 406/timeout from
this sandbox even with corrected syntax and a browser user-agent — same sandbox-network
limitation as before, now double-confirmed on a different session. Separately: the query handed
to Euan for `overpass-turbo.eu` had a real bug (a typographic minus sign `−` instead of ASCII
hyphen `-` in the bbox numbers), which is what threw his parse error — corrected version handed
back, not yet run. Still unresolved either way.

## Sources tested

### 1. Copernicus Marine — `BATHYMETRY_GLO_PHY_COASTAL_L4_MY_016_001`
(the product asked about earlier this session)

| | |
|---|---|
| Access | Free registered account required for real data (`copernicusmarine` toolbox confirmed to work once authenticated — reached the login prompt, stopped there). WMTS `GetCapabilities` (no-auth) reachable and returned real layer metadata, but that's global-schema metadata, not proof of AOI coverage. `GetFeatureInfo` (would return one real pixel) blocked by a tool-side URL length limit this session. |
| License/cost | Free, commercial use permitted, guaranteed to at least June 2028. |
| Format/res | NetCDF-4, 100 m, EPSG:4326. 4 bands: `phy_comp` (merged), `phy_irte` (optical RTE — same physics as our own optical wall), `phy_it` (intertidal), `phy_wk` (**wave-kinematics — different physics, the only band with a real chance of seeing past 15-20 m**). |
| AOI coverage | **Unconfirmed.** Not rejected — just not yet checked with real data. |
| RMSE 0-15 / 15-25 m | Not computable this session. |
| Verdict | **Pending — needs your 2-minute free registration.** Register at data.marine.copernicus.eu/register, hand credentials to a future session (or run `copernicusmarine subset` yourself), then `phy_wk` specifically is worth testing against the 15-25 m gap. |

### 2. de Wet & Compton (2021) SA continental shelf bathymetry — genuinely new, high value
- Free zip download (~28 MB, no login) at `johnscompton.com/maps/`, from the MSc thesis behind
  ~7 million DAFF single-beam soundings covering the whole SA shelf. This is the actual source
  the project's fusion config already has an empty tier for (`dewet_compton` in
  `config/params.yaml` — currently wired to nothing, `data/raw/dewet_compton_points.csv` doesn't
  exist).
- Paper: de Wet & Compton, *Geo-Marine Letters* (2021) 41:40, DOI `10.1007/s00367-021-00701-y` —
  verified real via search.
- Could not be downloaded this session (sandbox has no generic binary-fetch path to that host).
- **Verdict: best action item from this whole pass.** National-scale synthesis so density right
  over the ~600 km² AOI is unknown and probably sparse next to the local CGS 2005 survey already
  in the fusion stack — but it's free, no-login, and the fusion slot already exists. Download the
  zip, drop `lon,lat,depth_m` into `data/raw/dewet_compton_points.csv`, then run
  `reports/eval_scratch/rmse_against_holdout.py` before deciding its fusion priority.

### 3. OpenStreetMap seamark depth data (Overpass API)
- Keyless, ODbL-licensed. Blocked this session by the sandbox's `web_fetch` tool returning empty
  bodies on the Overpass endpoint (both `overpass-api.de` and a mirror) — not a source-side block.
- OSM depth tags are conventionally positive-down; would need sign negation to match this
  project's negative-depth convention.
- **Verdict: worth a 2-minute manual check at overpass-turbo.eu**, but expect low density —
  recreational OSM tagging off a remote KZN coastline is typically sparse. Reference/cross-check
  tier at best, not a fix for the 15-25 m gap.

### 4. NOAA ETOPO 2022 (15 arc-second global relief)
- Free, public domain, keyless.
- **Rejected as redundant** — same resolution class as the already-integrated GEBCO/GMRT tier;
  both are dominated by satellite-altimetry infill in this AOI's sparse offshore water. Not worth
  a separate fusion tier.

### 5. UKZN integrated KZN bathymetric GIS (Young, 2009 MSc thesis)
- Free PDF, no login, at UKZN ResearchSpace. Synthesizes 32 historical surveys (CGS, SA Navy,
  ACEP) 1911–2006, but as a **thesis document**, not a standalone downloadable grid, and its
  resolution (1:3,000,000 regional, up to 1:45,000 near-shore) is coarser than what's already
  integrated.
- **Verdict: reference only** — useful bibliography of which historical KZN surveys exist, not a
  fusion candidate.

### Checked and rejected outright
- **iSimangaliso Wetland Park downloads** — visitor PDF park maps only, no GIS/bathymetry layers.
- **SA Navy Hydrographic Office (SANHO)** — 109 charts / 57 ENCs, sold commercially through chart
  agents, no free bulk download. **Violates the $0 budget rule — excluded.**
- **DAFF raw ~7M soundings** (underlying de Wet & Compton) — no public bulk download found,
  request-only, same status as the already-scouted ACEP multibeam. Flagged as a future
  institutional-ask alongside that request, not pursued further this session.

## What's retained in the project from this session

**Only one artifact persists on disk:** `reports/eval_scratch/rmse_against_holdout.py` — a
reusable, independently-verified RMSE-by-depth-band test harness (matches the project's own
validate.py gates), ready to score any of the above the moment real depth values exist. No raw
data files were downloaded or kept (nothing cleared the sandbox's network restrictions this
session), and no pipeline code was touched — `pipeline/`, `site/`, `config/`, and both
`data/raw/atl24_train.parquet` and `data/ground_truth/gps_points.csv` are all confirmed
unmodified (checked via `git status`/`git diff` by the qa-validator pass).

## How to actually finish this (needs Euan, non-blocking)

1. **de Wet & Compton zip** — free, no login, ~28 MB: `johnscompton.com/maps/`. Highest value for
   least effort.
2. **Copernicus Marine free registration** — 2 minutes at `data.marine.copernicus.eu/register`,
   then either hand credentials to a session for `copernicusmarine subset`, or run one
   `GetFeatureInfo` WMTS query yourself in a browser (no URL-length limit there) to check `phy_wk`
   coverage over the AOI.
3. Optional: paste an Overpass-turbo export of `seamark:type=depth_contour`/`sounding` over the
   AOI bbox into `data/raw/` if it turns out non-empty.

None of these are blocking — the project's gates and honest 15-25 m "optical wall" number stand
as-is until one of them produces real, tested data.
