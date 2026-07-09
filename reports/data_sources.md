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

## Session 2026-07-09 addendum — new candidates checked (see reports/new_data_sources_evaluation_2026-07-09.md for full detail)

### New, worth pursuing
- **de Wet & Compton (2021) SA shelf bathymetry** — free 28 MB zip, no login, at
  johnscompton.com/maps/. This is the real source behind the `dewet_compton` fusion tier that's
  already wired in `config/params.yaml` but has never had a file. Download → `data/raw/dewet_compton_points.csv`
  (lon,lat,depth_m) → test with `reports/eval_scratch/rmse_against_holdout.py` before trusting it.
- **Copernicus Marine BATHYMETRY_GLO_PHY_COASTAL_L4_MY_016_001** — 100 m Sentinel-2 SDB, free
  account required. 3 of its 4 bands share our own optical-wall weakness; the `phy_wk`
  (wave-kinematics) band uses different physics and is the one worth testing past 15-20 m once
  Euan registers a free account. Coverage over Sodwana not yet confirmed either way.
- **OSM Overpass seamark depths** — keyless, but likely sparse off this coastline; quick manual
  check at overpass-turbo.eu worth doing, expect reference-tier value only.

### Reference only (not fusion candidates)
- UKZN integrated KZN bathymetric GIS (Young 2009 thesis) — coarser than what's already integrated;
  useful only as a bibliography of historical KZN surveys.

### Rejected
- NOAA ETOPO 2022 — same resolution class as already-integrated GEBCO/GMRT, redundant.
- SA Navy Hydrographic Office charts — commercial only, violates $0 budget.
- iSimangaliso Wetland Park downloads — visitor PDF maps only, no GIS data.

## Session 2026-07-09 addendum #2 — six papers reviewed (see reports/paper_review_2026-07-09.md)

### Best new lead: real multibeam data exists, held by named contacts
- **Green, A.N. (2009) PhD thesis** (UKZN) confirms a **Reson Seabat 8111 multibeam survey, 392 km²,
  29-838 m depth, ~1 m resolution**, covering Leven Point→Island Rock (essentially the whole AOI's
  canyon system) — but raw SEG-Y/grid data was explicitly withheld from the thesis (Appendix 4).
  Contacts to chase: **Peter Ramsay, Marine GeoSolutions (Pty) Ltd** (physically collected the data,
  106 Clark Road, Glenwood, Durban 4001); **Dr Andrew Green** (greena1@ukzn.ac.za, PI); **Council for
  Geoscience Marine Geoscience Unit** (Private Bag X112, Pretoria — co-funded, same institution as
  the already-integrated 2005 CGS survey).
- **Salzmann (2013) MSc thesis** independently corroborates: Green's group holds data over Mabibi/
  Sodwana/Diepgat/Leadsman/Leven canyons specifically.

### Reference-only (real canyon numbers, no digital grid)
- **Ramsay (1991) PhD thesis** — canyon table: Wright Canyon to −453 m, White Sands Canyon to
  −353 m, Jesser/Beacon canyons with gradient/orientation data. 1991-era Surfer map, no digital
  soundings found; GPS accuracy ~48 m error (era-appropriate, too coarse to fuse as-is).
- **Ramsay (1994) Marine Geology paper** — paywalled, abstract only; condensed version of the above.

### Out of scope
- **Miller (1998) MSc thesis** — Lake Sibaya is an inland freshwater lake outside the ocean AOI.
  Dropped as a primary source; only useful as a citation pointing back to Ramsay 1991/1996/1997.
