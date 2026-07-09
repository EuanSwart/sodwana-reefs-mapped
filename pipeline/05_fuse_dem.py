#!/usr/bin/env python3
"""05 — Fuse all sources into one seamless bathymetric DEM.

Priority-stack (highest wins). Priority order from params.fusion.priority:
  1. data/priority/*.tif   (future multibeam — empty now but wired in; drop a GeoTIFF -> rerun 05-07)
  2. ATL24 photons gridded along-track (train split only, real along-track lidar, no interpolation)
  3. Copernicus Marine phy_wk (wave-kinematics SDB), BAND-CONDITIONAL: only overrides SDB where
     SDB's own value falls in params.fusion.copernicus_band_m (default -25..-15 m). Measured
     (reports/new_data_sources_evaluation_2026-07-09.md) RMSE 2.95 m there vs SDB's own 4.90 m —
     a real improvement but still fails the project's 2.5 m gate; kept honest via `uncertainty`
     band (sigma=2.95) and logged coverage, not presented as passing.
  4. sdb_10m.tif           (0 -> params.fusion.sdb_fusion_cutoff_m; SDB is unreliable past the optical wall)
  5. CGS 2005 isobaths gridded (real survey depth in the 15-95 m band where optical SDB fails)
  6. de Wet & Compton points (deep, sparse) — evaluated 2026-07-10, REJECTED (RMSE 41/336 m vs
     holdout; a national ~333 m grid can't resolve reef-scale bathymetry) — never wired in.
  7. GEBCO/GMRT resampled  (everything else, beyond CGS)

Carries `source` and `uncertainty` bands. Land is masked from the Sentinel-2 NIR (B8) composite
(keyless 10 m shoreline); no positive depths over water.

Output: dem/sodwana_fused_10m_4326.tif (3 bands: elevation[neg m], source[code], uncertainty[m]) + a 3857 copy.
CRS: processing/output EPSG:4326, plus an EPSG:3857 web copy. Idempotent: rebuilds from whatever
inputs currently exist; missing tiers are skipped and logged.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import (  # noqa: E402
    assert_no_positive_over_water, base_arg_parser, ensure_dir, load_aoi, load_params, log, raster_writer,
)

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PRIORITY = ROOT / "data" / "priority"
DEM = ROOT / "dem"

SOURCE_CODES = {"priority_multibeam": 1, "atl24": 2, "sdb": 3, "cgs_isobath": 4,
                "dewet_compton": 5, "gebco_gmrt": 6, "copernicus_phy_wk": 7}
SOURCE_SIGMA = {"priority_multibeam": 0.3, "atl24": 0.5, "sdb": 1.5, "cgs_isobath": 2.5,
                "dewet_compton": 3.0, "gebco_gmrt": 8.0, "copernicus_phy_wk": 2.95}


def grid_atl24(train_path, ref_transform, ref_shape, params):
    """Grid ATL24 TRAIN photons (real along-track lidar). blockmedian per cell; no cross-track
    interpolation by default. Reads ONLY the train split so the holdout stays independent."""
    import numpy as np
    import pandas as pd
    import rasterio
    from scipy.interpolate import griddata
    from scipy.ndimage import distance_transform_edt

    h, w = ref_shape
    if not Path(train_path).exists():
        return np.full(ref_shape, np.nan, dtype="float32")
    df = pd.read_parquet(train_path)
    rows, cols = rasterio.transform.rowcol(ref_transform, df["lon"].to_numpy(), df["lat"].to_numpy())
    rows, cols = np.asarray(rows), np.asarray(cols)
    inb = (rows >= 0) & (rows < h) & (cols >= 0) & (cols < w)
    rows, cols, depth = rows[inb], cols[inb], df["depth_m"].to_numpy()[inb]
    if depth.size == 0:
        return np.full(ref_shape, np.nan, dtype="float32")
    flat = rows.astype(np.int64) * w + cols.astype(np.int64)
    order = np.argsort(flat)
    flat_s, depth_s = flat[order], depth[order]
    uniq, start = np.unique(flat_s, return_index=True)
    ends = list(start[1:]) + [len(depth_s)]
    cell_depth = np.array([np.median(depth_s[s:e]) for s, e in zip(start, ends)])
    cr, cc = (uniq // w).astype(int), (uniq % w).astype(int)
    block = np.full(ref_shape, np.nan, dtype="float32")
    block[cr, cc] = cell_depth
    n_real = int(np.isfinite(block).sum())
    if not params["fusion"].get("atl24_grid", {}).get("interpolate", False):
        log(f"ATL24 grid: {len(df)} train photons -> {n_real} real cells (no interpolation)")
        return block
    gy, gx = np.mgrid[0:h, 0:w]
    interp = griddata(np.column_stack([cr, cc]), cell_depth, (gy, gx), method="linear")
    dist_px = distance_transform_edt(~np.isfinite(block))
    interp[dist_px > params["fusion"]["blend_zone_m"] / params["project"]["grid_res_m"]] = np.nan
    return interp.astype("float32")


def grid_cgs_isobaths(csv_path, ref_transform, ref_shape, params):
    """Grid CGS 2005 isobath points into a smooth survey surface. Interpolating between 5 m
    isobaths is legitimate (real surveyed contours). griddata('linear') returns NaN outside the
    survey hull, so we never extrapolate. Reads data/raw/cgs_isobath_points_4326.csv (script 09)."""
    import numpy as np
    import pandas as pd
    import rasterio
    from scipy.interpolate import griddata

    h, w = ref_shape
    if not Path(csv_path).exists():
        return np.full(ref_shape, np.nan, dtype="float32")
    df = pd.read_csv(csv_path)
    rows, cols = rasterio.transform.rowcol(ref_transform, df["lon"].to_numpy(), df["lat"].to_numpy())
    rows, cols = np.asarray(rows, float), np.asarray(cols, float)
    depth = df["depth_m"].to_numpy(float)
    gy, gx = np.mgrid[0:h, 0:w]
    method = params["fusion"].get("cgs_grid", {}).get("method", "linear")
    surf = griddata(np.column_stack([rows, cols]), depth, (gy, gx), method=method)
    log(f"CGS isobath grid: {len(df)} points ({depth.min():.0f}..{depth.max():.0f} m) -> "
        f"{int(np.isfinite(surf).sum())} cells")
    return surf.astype("float32")


def _land_mask_from_s2(ref_transform, ref_shape, ref_crs, params):
    """Land mask from Sentinel-2 NIR (B8): land = B8 > nir_land_threshold (keyless 10 m shoreline)."""
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, reproject

    s2 = RAW / "s2_composite_10m_4326.tif"
    if not s2.exists():
        return None
    bands = params["sentinel2"]["bands"]
    b8_idx = bands.index("B8") + 1 if "B8" in bands else len(bands)
    dst = np.full(ref_shape, np.nan, dtype="float32")
    with rasterio.open(s2) as src:
        reproject(source=rasterio.band(src, b8_idx), destination=dst,
                  src_transform=src.transform, src_crs=src.crs,
                  dst_transform=ref_transform, dst_crs=ref_crs, resampling=Resampling.bilinear)
    thr = params["depth"].get("nir_land_threshold", 0.06)
    return np.isfinite(dst) & (dst > thr)


def _resample_to_grid(path, ref_transform, ref_shape, ref_crs):
    """Reproject/resample a raster's band 1 onto the reference 10 m grid (EPSG:4326)."""
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, reproject

    dst = np.full(ref_shape, np.nan, dtype="float32")
    with rasterio.open(path) as src:
        reproject(source=rasterio.band(src, 1), destination=dst,
                  src_transform=src.transform, src_crs=src.crs,
                  dst_transform=ref_transform, dst_crs=ref_crs, resampling=Resampling.bilinear)
        if src.nodata is not None:
            dst[dst == src.nodata] = np.nan
    return dst


def _load_copernicus_phy_wk(nc_path, ref_transform, ref_shape, ref_crs):
    """Resample the Copernicus Marine phy_wk (wave-kinematics SDB, 100 m) onto the reference grid.
    Real Sentinel-2-derived bathymetry using wave-kinematics physics (different failure mode than
    this project's own passive-optical SDB). Obtained via `copernicusmarine subset` with a free
    account (see reports/new_data_sources_evaluation_2026-07-09.md). The NetCDF export carries no
    CRS tag, but its lat/lon coordinates confirm EPSG:4326 -- passed explicitly below."""
    import numpy as np
    import rasterio
    from rasterio.warp import Resampling, reproject

    if not Path(nc_path).exists():
        return None
    dst = np.full(ref_shape, np.nan, dtype="float32")
    with rasterio.open(f'NETCDF:"{nc_path}":height') as src:
        reproject(source=rasterio.band(src, 1), destination=dst,
                  src_transform=src.transform, src_crs=ref_crs,
                  dst_transform=ref_transform, dst_crs=ref_crs, resampling=Resampling.bilinear)
    return dst


def _align_cgs_to_sdb(cgs, sdb, params):
    """Harmonize the CGS 2005 isobath vertical datum to the SDB/ATL24 reference.

    CGS survey depths sit on a different vertical datum (chart datum vs ATL24 orthometric), a
    systematic offset of several metres. Estimate it as the median (SDB - CGS) over the band where
    both are reliable and shift CGS by that constant. This is datum harmonization, not tuning on
    validation data (SDB is the model output; the ATL24 holdout is never read here).
    """
    import numpy as np
    if cgs is None or sdb is None:
        return cgs
    lo, hi = params["fusion"].get("cgs_align_band_m", [-25.0, -12.0])
    both = np.isfinite(cgs) & np.isfinite(sdb) & (sdb <= hi) & (sdb >= lo)
    if int(both.sum()) < 500:
        log("CGS datum align: insufficient overlap -> no shift")
        return cgs
    offset = float(np.median(sdb[both] - cgs[both]))
    log(f"CGS datum align: median(SDB-CGS)={offset:+.2f} m over {int(both.sum())} cells -> shifting CGS")
    return cgs + offset


def fuse(args) -> int:
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds

    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    ensure_dir(DEM)
    nod = params["project"]["nodata"]
    res_deg = params["project"]["grid_res_m"] / 111_320.0
    w = int(round((aoi.lon_max - aoi.lon_min) / res_deg))
    h = int(round((aoi.lat_max - aoi.lat_min) / res_deg))
    ref_transform = from_bounds(aoi.lon_min, aoi.lat_min, aoi.lon_max, aoi.lat_max, w, h)
    ref_crs = "EPSG:4326"
    log(f"reference grid {w}x{h} @ ~{params['project']['grid_res_m']} m, EPSG:4326")

    if args.dry_run:
        log("[dry-run] would fuse tiers gebco/cgs_isobath/sdb/atl24/priority -> dem/sodwana_fused_10m_4326.tif")
        return 0

    elev = np.full((h, w), np.nan, dtype="float32")
    source = np.zeros((h, w), dtype="uint8")

    def lay(name, arr):
        """First-write-wins: a source only fills cells still empty. Highest-priority sources are
        laid first, so trustworthy SDB/ATL24 are never overridden by the coarser CGS/GEBCO fill —
        those only patch the gaps SDB leaves (deep/offshore/turbid), never the validated bands."""
        if arr is None:
            return
        empty = ~np.isfinite(elev)
        m = empty & np.isfinite(arr) & (arr != nod)
        elev[m] = arr[m]
        source[m] = SOURCE_CODES[name]
        log(f"filled '{name}': {int(m.sum())} px")

    # highest priority laid FIRST (first-write-wins). SDB/ATL24 own the validated optical zone;
    # CGS then fills deeper/offshore gaps; GMRT/GEBCO is the last-resort coarse fill.
    prio = sorted(PRIORITY.glob("*.tif"))
    if prio:
        lay("priority_multibeam", _resample_to_grid(prio[0], ref_transform, (h, w), ref_crs))
    lay("atl24", grid_atl24(RAW / "atl24_train.parquet", ref_transform, (h, w), params))
    sdb_p = DEM / "sdb_10m.tif"
    sdb_arr = _resample_to_grid(sdb_p, ref_transform, (h, w), ref_crs) if sdb_p.exists() else None
    cop_arr = (_load_copernicus_phy_wk(RAW / "copernicus_phy_wk_aoi.nc", ref_transform, (h, w), ref_crs)
               if params["fusion"].get("copernicus_phy_wk_enabled", False) else None)
    if cop_arr is not None and sdb_arr is not None:
        lo, hi = params["fusion"].get("copernicus_band_m", [-25.0, -15.0])
        # Band membership judged from SDB's OWN predicted value (no ground truth available at
        # inference time) -- this is the best available conditioning signal, not a perfect one.
        band = np.isfinite(sdb_arr) & (sdb_arr <= hi) & (sdb_arr >= lo) & np.isfinite(cop_arr)
        cop_masked = np.where(band, cop_arr, np.nan).astype("float32")
        lay("copernicus_phy_wk", cop_masked)
        log(f"copernicus phy_wk band override [{lo},{hi}] m: {int(band.sum())} px eligible")
    if sdb_arr is not None:
        lay("sdb", sdb_arr)
    cgs_arr = grid_cgs_isobaths(RAW / "cgs_isobath_points_4326.csv", ref_transform, (h, w), params)
    if params["fusion"].get("cgs_datum_align", False):
        cgs_arr = _align_cgs_to_sdb(cgs_arr, sdb_arr, params)
    lay("cgs_isobath", cgs_arr)
    gmrt = RAW / "gmrt_aoi_4326.tif"
    if gmrt.exists():
        lay("gebco_gmrt", _resample_to_grid(gmrt, ref_transform, (h, w), ref_crs))

    if not np.isfinite(elev).any():
        log("No input rasters produced data (run 01/03/04/09). Nothing fused.")
        return 0

    land = _land_mask_from_s2(ref_transform, (h, w), ref_crs, params)
    if land is not None:
        elev[land] = np.nan
        source[land] = 0
        log(f"masked {int(land.sum())} land px from S2 NIR")
    elev[elev > params["depth"]["land_mask_min_m"]] = np.nan

    filled = np.where(np.isfinite(elev), elev, nod).astype("float32")
    assert_no_positive_over_water(filled, nod, name="fused DEM")

    unc = np.full((h, w), nod, dtype="float32")
    for name, code in SOURCE_CODES.items():
        unc[source == code] = SOURCE_SIGMA[name]

    out = DEM / "sodwana_fused_10m_4326.tif"
    prof = {"driver": "GTiff", "height": h, "width": w, "count": 3, "dtype": "float32",
            "crs": ref_crs, "transform": ref_transform, "nodata": nod,
            "compress": "deflate", "tiled": True}
    with raster_writer(out, **prof) as dst:
        dst.write(filled, 1)
        dst.write(source.astype("float32"), 2)
        dst.write(unc, 3)
        dst.set_band_description(1, "elevation_m_negative_down")
        dst.set_band_description(2, "source_code")
        dst.set_band_description(3, "uncertainty_m")
        dst.build_overviews([2, 4, 8, 16], rasterio.enums.Resampling.average)
    log(f"wrote {out.name}")

    from rasterio.warp import Resampling, calculate_default_transform, reproject
    dst3857 = DEM / "sodwana_fused_10m_3857.tif"
    with rasterio.open(out) as src:
        t, wj, hj = calculate_default_transform(src.crs, "EPSG:3857", src.width, src.height, *src.bounds)
        p2 = src.profile.copy()
        p2.update(crs="EPSG:3857", transform=t, width=wj, height=hj)
        with raster_writer(dst3857, **p2) as dst:
            for b in range(1, 4):
                reproject(source=rasterio.band(src, b), destination=rasterio.band(dst, b),
                          src_transform=src.transform, src_crs=src.crs,
                          dst_transform=t, dst_crs="EPSG:3857", resampling=Resampling.bilinear)
    log(f"wrote {dst3857.name} (web CRS)")

    tot = int((source > 0).sum())
    if tot:
        inv = {v: k for k, v in SOURCE_CODES.items()}
        comp = {inv[c]: f"{100*int((source==c).sum())/tot:.1f}%" for c in np.unique(source) if c}
        log(f"source composition: {comp}")
    return 0


def main() -> int:
    ap = base_arg_parser(__doc__)
    return fuse(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
