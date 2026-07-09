#!/usr/bin/env python3
"""09 — Ingest CGS (Council for Geoscience) seafloor geology + bathymetry for the AOI.

Source: CGS Maputaland (NRF Innovation Fund) Marine Geoscience 2005 survey, delivered as two
GeoPackages in `data/geology/`:
  * cgs_geology_sodwana.gpkg   — 679 substrate polygons, class in `geology`
    (Prominent/Scattered/Reef, Coarse Shelly Sediment, Sand).
  * cgs_bathymetry_sodwana.gpkg — real depth isobaths (`contour`, already NEGATIVE metres,
    0 to -95 m at 5 m spacing). Survey depth exactly in the band where optical SDB fails.

Outputs (EPSG:4326):
  site/data/cgs_geology.geojson    substrate polygons (clipped to AOI, simplified for web)
  site/data/cgs_isobaths.geojson   depth contours (clipped, simplified, labelled)
  data/geology/cgs_reef_mask.geojson   reef-class polygons only (for prospect corroboration)
  data/raw/cgs_isobath_points_4326.csv lon,lat,depth_m densified contour vertices (fusion input)

The isobaths become a fusion tier BELOW the optical wall (see 05); substrate corroborates
prospect leads (see 06). Neither is used to train the SDB model — they are independent sources.
Idempotent; requires geopandas + shapely.
"""
from __future__ import annotations

import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
GEO = ROOT / "data" / "geology"
RAW = ROOT / "data" / "raw"
SITE_DATA = ROOT / "site" / "data"

REEF_CLASSES = {"Reef", "Prominent Reef", "Scattered Reef"}


def _densify(line, step_deg: float):
    """Yield (lon, lat) vertices along a (multi)line at ~step_deg spacing."""
    from shapely.geometry import LineString, MultiLineString

    parts = line.geoms if isinstance(line, MultiLineString) else [line]
    for part in parts:
        if not isinstance(part, LineString) or part.is_empty:
            continue
        n = max(2, int(part.length / step_deg) + 1)
        for i in range(n + 1):
            p = part.interpolate(i / n, normalized=True)
            yield p.x, p.y


def main() -> int:
    ap = base_arg_parser(__doc__)
    args = ap.parse_args()
    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    import geopandas as gpd  # noqa: E402
    from shapely.geometry import box

    aoi_box = box(aoi.lon_min, aoi.lat_min, aoi.lon_max, aoi.lat_max)
    geol_p = GEO / "cgs_geology_sodwana.gpkg"
    bath_p = GEO / "cgs_bathymetry_sodwana.gpkg"
    if not geol_p.exists() or not bath_p.exists():
        log(f"CGS gpkgs missing in {GEO} — copy cgs_geology_sodwana.gpkg + cgs_bathymetry_sodwana.gpkg.")
        return 0

    # --- geology polygons ---
    geo = gpd.read_file(geol_p).to_crs(4326)
    geo = geo[geo.intersects(aoi_box)].copy()
    geo["geometry"] = geo.intersection(aoi_box)
    geo["geology"] = geo["geology"].fillna("(unlabelled)")
    keep = geo[["geology", "geometry"]].copy()
    simp = float(params.get("cgs", {}).get("simplify_deg", 0.00015))

    # --- isobaths ---
    iso = gpd.read_file(bath_p).to_crs(4326)
    iso = iso[iso.intersects(aoi_box)].copy()
    iso["geometry"] = iso.intersection(aoi_box)
    iso = iso[iso["contour"].notna()].copy()

    if args.dry_run:
        log(f"[dry-run] geology polys={len(keep)} isobaths={len(iso)} "
            f"reef polys={int(keep['geology'].isin(REEF_CLASSES).sum())}")
        return 0

    ensure_dir(SITE_DATA)
    ensure_dir(RAW)
    ensure_dir(GEO)

    keep_web = keep.copy()
    keep_web["geometry"] = keep_web.simplify(simp, preserve_topology=True)
    keep_web.to_file(SITE_DATA / "cgs_geology.geojson", driver="GeoJSON")
    log(f"wrote site/data/cgs_geology.geojson ({len(keep_web)} substrate polygons)")

    reef = keep[keep["geology"].isin(REEF_CLASSES)].copy()
    reef.to_file(GEO / "cgs_reef_mask.geojson", driver="GeoJSON")
    log(f"wrote data/geology/cgs_reef_mask.geojson ({len(reef)} reef-class polygons)")

    iso_web = iso.copy()
    iso_web["geometry"] = iso_web.simplify(simp, preserve_topology=True)
    iso_web[["contour", "geometry"]].rename(columns={"contour": "depth_m"}).to_file(
        SITE_DATA / "cgs_isobaths.geojson", driver="GeoJSON")
    log(f"wrote site/data/cgs_isobaths.geojson ({len(iso_web)} contours)")

    # --- densified isobath points for fusion ---
    step = float(params.get("cgs", {}).get("isobath_densify_deg", 0.0002))  # ~20 m
    pts_path = RAW / "cgs_isobath_points_4326.csv"
    n = 0
    with pts_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["lon", "lat", "depth_m"])
        for _, row in iso.iterrows():
            g = row.geometry
            if g is None or g.is_empty:
                continue
            depth = float(row["contour"])  # already negative
            for lon, lat in _densify(g, step):
                w.writerow([round(lon, 6), round(lat, 6), depth])
                n += 1
    log(f"wrote {pts_path.name} ({n} depth points, {iso['contour'].min():.0f}..{iso['contour'].max():.0f} m)")
    log("Next: rerun 05 (CGS isobath fusion tier) -> 06 -> 07 -> validate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
