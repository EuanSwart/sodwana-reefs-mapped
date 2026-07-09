# Data Source Review — CGS "Maputaland (NRF Innovation Fund) Marine Geoscience 2005"

**Reviewed:** 2026-07-09 · **Reviewer:** data-scout pass (ad hoc) · **Source:** `maps.geoscience.org.za`, service `Hosted/Maputaland_(NRF_Innovation_Fund)_Marine_Geoscience_2005`, FeatureServer, item `6b216c602db341d48f3e3ead28cc25e3`

## 1. What's actually in the service

Queried the live REST endpoints directly (no auth required — public `Query`-only capability). Two layers, not one:

| Layer | Name | Geometry | Fields | Total features | Features intersecting Sodwana AOI |
|---|---|---|---|---|---|
| 0 | `Maputaland_Bathymetry_5m` | Polyline | `contour` (double), id, lengths | 346 | **118** |
| 1 | `Maputaland_Seafloor_Geology` | Polygon | `geology` (string), `mapkey`, `hectares`, area/perimeter | 2,077 | **1,014** |

The link Euan sent points at layer 1 only (`Seafloor_Geology`), but layer 0 (`Bathymetry_5m`) is arguably the more valuable layer for this project.

**Layer 0 — bathymetry contours:** distinct `contour` values run **0, -5, -10, ... -95** (metres). This is 5 m-interval depth contour lines in the project's own **negative-down convention** — no sign conversion needed. Depth range spans 0 to -95 m, which fully covers both the SDB-reliable zone (0 to -25 m) and the exact band where the project's optical model currently fails its gate.

**Layer 1 — seafloor geology:** polygon classification into 5 substrate classes: `Reef`, `Prominent Reef`, `Scattered Reef`, `Coarse Shelly Sediment`, `Sand`. This is a surveyed reef-extent map, not a derived one.

## 2. Spatial/technical fit

- **Coverage:** service full extent (reprojected from EPSG:3857) is roughly lon 32.59–32.92, lat -27.86 to -26.85 — the Sodwana AOI (32.62–32.82, -27.62 to -27.32) sits entirely inside it. Confirmed empirically: 118/346 contour segments and 1,014/2,077 geology polygons fall inside the AOI bbox.
- **CRS:** native SR is Web Mercator (3857), reprojects cleanly to the project's processing CRS (4326). Trivial `pyproj`/GDAL reproject, no datum ambiguity flagged in the service metadata (assume WGS84, standard for post-1990s CGS work — worth a one-line confirmation, not a blocker).
- **Volume:** trivial. 118 lines + 1,014 polygons for the AOI is a single unpaginated request each (service cap is 2,000/request).
- **Access:** keyless, tokenless, `Query`-only public REST — no paid tier, no API key. Consistent with the project's $0 budget rule.
- **License:** could not confirm programmatically — the portal item-metadata endpoint (`/content/items/...`) returned `403`, and `copyrightText` on the service is an empty string (absence of a restriction, not proof of an open one). Source is Council for Geoscience's own official hosting domain, publicly queryable with no auth wall, which is a good sign, but I'd manually check the "License" tab on the ArcGIS Online item page (or ask CGS directly) before treating this as clear to redistribute/publish — the project's honesty/budget rules don't cover licensing risk, so that check is on you, not a pipeline gate.
- **Vintage:** 2005 survey, ~20 years old. Substrate/reef geology (rock, reef structure) is stable over that timescale; nearshore sand bathymetry can shift — worth a Gotchas note if contour depths are used in sandy zones near the surf line.

## 3. Where this plugs into the existing pipeline

**Layer 0 → `pipeline/05_fuse_dem.py`, `priority_multibeam` tier.** `params.yaml`'s fusion priority stack has this tier wired in but empty (`data/priority/*.tif` — "empty now but wired in"). This is exactly the slot for a real surveyed source. More importantly: the project's one open accuracy failure is the **15–25 m RMSE gate (4.90 m vs 2.5 m target)** — documented in Gotchas as "the optical wall," a hard physical limit of passive Sentinel-2 SDB, not a tuning problem. The CGS contours cover 0 to -95 m, i.e. they span exactly the band where SDB gives up and the DEM currently falls back to sparse ATL24 tracks + smooth GMRT/GEBCO fill. Gridding these contours (e.g. simple triangulation/TIN or GDAL contour-to-raster) to a 10 m raster and dropping it in `data/priority/` is a concrete, low-effort path to closing that gate with real survey data instead of interpolated optical estimate.

Caveat: don't just trust it because it outranks SDB in priority — validate it against the held-out ATL24 split the same way every other tier is validated (never trained on holdout), and log the real RMSE number per the project's honesty rule before keeping it as top priority.

**Layer 1 → `pipeline/06_derivatives.py` prospecting layer, and `site/`.** The algorithmic prospect leads (high BPI + high rugosity, ranked, top-100) are exactly the kind of output a surveyed reef-extent polygon layer can cross-check: leads that fall inside a mapped `Reef`/`Prominent Reef` polygon corroborate the method; leads far from any mapped polygon are the genuinely novel candidates the prospecting layer exists to find. It's also a natural second source for the `site-researcher`/`qa-validator` two-source verification rule on dive-site coordinates. Separately, it's a legitimate standalone map layer: a toggleable "surveyed reef extent" overlay alongside the color-relief bathymetry gives divers real substrate context, which fits the project's stated purpose (scuba training + reef prospecting) directly.

## 4. Recommendation

**Proceed with integration.** Concrete next actions, in order:

1. Pull both layers for the AOI bbox to `data/raw/cgs_bathymetry_contours_5m_4326.geojson` and `data/raw/cgs_seafloor_geology_4326.geojson` (data-scout task — checksum, confirm SR/vintage, log to Gotchas).
2. Grid the contours to a 10 m raster, feed into `05_fuse_dem.py`'s `priority_multibeam` tier, re-run `validate.py --quick` and compare 15–25 m RMSE against the current 4.90 m failure. This is the one change most likely to close the project's only open gate.
3. Feed the geology polygons into `06_derivatives.py` as a cross-check against algorithmic prospects, and add as a toggle layer in `site/`.
4. Before any publish/redistribution step, manually confirm the license on the ArcGIS Online item page — not blocking for internal pipeline use, but blocking for anything public-facing.

No budget, CRS, or convention conflicts found. This is free, keyless, well-aligned with the project's depth convention, and directly addresses the one documented accuracy shortfall.
