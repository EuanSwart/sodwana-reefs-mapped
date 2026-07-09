#!/usr/bin/env python3
"""06 — Terrain derivatives + prospecting layer.

From the fused DEM compute slope, TRI/rugosity, and Bathymetric Position Index (BPI) at
params.prospect.bpi_inner_m and bpi_outer_m scales. Cells with high positive BPI + high
rugosity that are > min_dist_from_known_site_m from any known dive site = "prospect polygons"
(candidate unmapped/undived reef). Each lead is then cross-checked against CGS seafloor-geology
substrate: a lead on mapped Reef is corroborated (boost); one on Sand is likely false (demote).

Outputs (EPSG:4326):
  dem/slope_4326.tif, dem/rugosity_4326.tif, dem/bpi_4326.tif
  data/prospects.geojson + site/data/prospects.geojson (ranked; each has centroid coords + substrate)

Prospects are LEADS, not guarantees — each feature carries a confidence score and states it.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log, raster_writer  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEM = ROOT / "dem"
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"


def _focal_mean(a, size):
    from scipy.ndimage import uniform_filter

    return uniform_filter(a, size=size, mode="nearest")


def derive(args) -> int:
    import numpy as np
    import rasterio

    params = load_params(args.params)
    _ = load_aoi(args.aoi)
    fused = DEM / "sodwana_fused_10m_4326.tif"
    if not fused.exists():
        log(f"{fused.name} missing — run 05 first. [stub] wiring complete.")
        return 0
    ensure_dir(DATA)
    nod = params["project"]["nodata"]

    with rasterio.open(fused) as src:
        z = src.read(1).astype("float32")
        prof = src.profile
        transform = src.transform
    z = np.where(z == nod, np.nan, z)

    gy, gx = np.gradient(z)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))
    # Vectorized rugosity: std = sqrt(E[z^2] - E[z]^2) via C-level uniform_filter (never a
    # per-pixel np.nanstd callback — that is ~7M Python calls and takes minutes).
    zz = np.nan_to_num(z)
    mean3 = _focal_mean(zz, 3)
    sqmean3 = _focal_mean(zz * zz, 3)
    rug = np.sqrt(np.maximum(sqmean3 - mean3 * mean3, 0.0)).astype("float32")
    res_m = params["project"]["grid_res_m"]
    outer = max(5, int(params["prospect"]["bpi_outer_m"] / res_m) | 1)
    bpi = np.nan_to_num(z) - _focal_mean(np.nan_to_num(z), outer)

    if args.dry_run:
        log("[dry-run] would write slope/rugosity/bpi rasters + prospects.geojson")
        return 0

    oprof = prof.copy()
    oprof.update(count=1, dtype="float32", nodata=nod, compress="deflate", tiled=True)
    for name, arr in [("slope_4326", slope), ("rugosity_4326", rug), ("bpi_4326", bpi)]:
        out = arr.astype("float32")
        out[~np.isfinite(z)] = nod
        with raster_writer(DEM / f"{name}.tif", **oprof) as dst:
            dst.write(out, 1)
    log("wrote slope/rugosity/bpi rasters")

    # Prospect scoring.
    from scipy.ndimage import binary_erosion

    pp = params["prospect"]
    valid = np.isfinite(z)
    erode = int(pp.get("edge_erode_px", 3))
    if erode > 0:
        valid = binary_erosion(valid, iterations=erode)
    rug_thr = np.nanpercentile(rug[valid], pp["rugosity_percentile"])
    bpi_thr = np.nanpercentile(bpi[valid], pp["bpi_percentile"])
    cand = valid & (rug > rug_thr) & (bpi > bpi_thr)

    sites_path = DATA / "dive_sites.geojson"
    known = []
    if sites_path.exists():
        gj = json.loads(sites_path.read_text())
        known = [f["geometry"]["coordinates"] for f in gj.get("features", [])]

    from scipy import ndimage as ndi

    lab, n = ndi.label(cand)
    sizes = np.bincount(lab.ravel())
    keep = np.nonzero(sizes >= int(pp.get("min_area_px", 12)))[0]
    keep = keep[keep != 0]
    feats = []
    if keep.size:
        centroids = ndi.center_of_mass(cand, lab, keep)
        rug_means = np.atleast_1d(ndi.mean(rug, lab, keep))
        bpi_means = np.atleast_1d(ndi.mean(bpi, lab, keep))
        depth_means = np.atleast_1d(ndi.mean(zz, lab, keep))
        min_dist_m = params["prospect"]["min_dist_from_known_site_m"]
        for k, (cy, cx) in enumerate(centroids):
            lon, lat = rasterio.transform.xy(transform, cy, cx)
            min_dist_km = _min_dist_km(lon, lat, known) if known else 999.0
            if min_dist_km * 1000 < min_dist_m:
                continue
            score = float(np.clip((rug_means[k] / (rug_thr + 1e-6)) *
                                  (bpi_means[k] / (bpi_thr + 1e-6)), 0, 10))
            feats.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                "properties": {
                    "score": round(score, 2),
                    "mean_depth_m": round(float(depth_means[k]), 1),
                    "area_px": int(sizes[keep[k]]),
                    "km_from_known_site": round(min_dist_km, 2),
                    "confidence": "lead — high rugosity+BPI, unverified; ground-truth before diving",
                },
            })

    _corroborate_with_cgs(feats)
    feats.sort(key=lambda f: -f["properties"]["score"])
    max_leads = int(pp.get("max_leads", 100))
    if len(feats) > max_leads:
        log(f"ranked {len(feats)} candidate clusters -> keeping top {max_leads} by score")
        feats = feats[:max_leads]
    for rank, f in enumerate(feats, 1):
        f["properties"]["rank"] = rank
    gj_out = {"type": "FeatureCollection", "name": "prospects",
              "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
              "features": feats}
    ensure_dir(SITE_DATA)
    for dst in (DATA / "prospects.geojson", SITE_DATA / "prospects.geojson"):
        dst.write_text(json.dumps(gj_out, indent=2))
    n_corr = sum(1 for f in feats if f["properties"].get("cgs_corroborated"))
    log(f"wrote prospects.geojson ({len(feats)} leads; {n_corr} CGS-reef corroborated)")
    return 0


def _corroborate_with_cgs(feats):
    """Tag each prospect with CGS seafloor substrate and adjust its score.

    A high-rugosity/BPI lead on CGS-mapped Reef substrate is independently corroborated (x1.5);
    one on Sand / Coarse Shelly Sediment is likely a false positive (x0.5). Turns the prospect
    layer from optical-shape-only into a two-source (morphology x geology) filter. Leads stay LEADS.
    """
    if not feats:
        return
    allg_path = SITE_DATA / "cgs_geology.geojson"
    if not allg_path.exists():
        log("CGS corroboration skipped (run 09 first)")
        return
    try:
        import geopandas as gpd
        from shapely.geometry import Point
        allg = gpd.read_file(allg_path)
    except Exception as exc:  # noqa: BLE001
        log(f"CGS corroboration skipped ({exc})")
        return
    reef_classes = {"Reef", "Prominent Reef", "Scattered Reef"}
    sindex = allg.sindex
    for f in feats:
        pt = Point(f["geometry"]["coordinates"])
        substrate = "unknown"
        for idx in sindex.intersection(pt.bounds):
            if allg.geometry.iloc[idx].contains(pt):
                substrate = str(allg.iloc[idx]["geology"])
                break
        on_reef = substrate in reef_classes
        f["properties"]["cgs_substrate"] = substrate
        f["properties"]["cgs_corroborated"] = bool(on_reef)
        if on_reef:
            f["properties"]["score"] = round(f["properties"]["score"] * 1.5, 2)
            f["properties"]["confidence"] = (
                f"lead CORROBORATED by CGS '{substrate}' substrate; ground-truth before diving")
        elif substrate in {"Sand", "Coarse Shelly Sediment"}:
            f["properties"]["score"] = round(f["properties"]["score"] * 0.5, 2)
            f["properties"]["confidence"] = (
                f"weak lead — CGS maps '{substrate}' (soft bottom) here; likely false positive")


def _min_dist_km(lon, lat, known):
    import math

    def hav(a, b):
        (lo1, la1), (lo2, la2) = a, b
        r = 6371.0
        dlat, dlon = math.radians(la2 - la1), math.radians(lo2 - lo1)
        x = math.sin(dlat / 2) ** 2 + math.cos(math.radians(la1)) * math.cos(math.radians(la2)) * math.sin(dlon / 2) ** 2
        return 2 * r * math.asin(math.sqrt(x))

    return min(hav((lon, lat), (k[0], k[1])) for k in known)


def main() -> int:
    ap = base_arg_parser(__doc__)
    return derive(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
