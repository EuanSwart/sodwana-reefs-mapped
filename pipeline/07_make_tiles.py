#!/usr/bin/env python3
"""07 — Terrarium-encoded raster-DEM tiles for the web map.

Self-contained cross-platform terrarium tiler (rasterio WarpedVRT-style reproject + mercantile +
PIL). Avoids rio-rgbify, whose fork hard-codes multiprocessing 'fork' (absent on Windows).
Reprojects the EPSG:3857 fused DEM into z8..z15 XYZ tiles under site/tiles/xyz/{z}/{x}/{y}.png.
z15 ~ 3 m/px at this latitude — matches the data honestly, invents no detail.

Land/nodata is encoded as a +10 m sentinel; the style ramp renders anything just above 0 m as
transparent, so land shows the basemap rather than a flat blob.

--dry-run reports tile counts and estimated payload (must stay < params.tiles.max_payload_mb).

Output: site/tiles/xyz/{z}/{x}/{y}.png  (committed — it's the product).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DEM = ROOT / "dem"
SITE_TILES = ROOT / "site" / "tiles"


def _tile_count(aoi, zmin, zmax) -> int:
    """Number of XYZ tiles covering the AOI across the zoom range."""
    total = 0
    for z in range(zmin, zmax + 1):
        n = 2 ** z

        def xtile(lon):
            return int((lon + 180.0) / 360.0 * n)

        def ytile(lat):
            r = math.radians(lat)
            return int((1.0 - math.asinh(math.tan(r)) / math.pi) / 2.0 * n)

        x0, x1 = xtile(aoi.lon_min), xtile(aoi.lon_max)
        y0, y1 = ytile(aoi.lat_max), ytile(aoi.lat_min)
        total += (abs(x1 - x0) + 1) * (abs(y1 - y0) + 1)
    return total


def make(args) -> int:
    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    t = params["tiles"]
    zmin, zmax = t["min_zoom"], t["max_zoom"]
    n_tiles = _tile_count(aoi, zmin, zmax)
    est_mb = n_tiles * 12 / 1024
    log(f"z{zmin}-z{zmax}: ~{n_tiles} tiles, est ~{est_mb:.1f} MB (cap {t['max_payload_mb']} MB)")
    if est_mb > t["max_payload_mb"]:
        log("WARNING: estimated payload exceeds cap — reduce max_zoom or AOI before committing.")

    src = DEM / "sodwana_fused_10m_3857.tif"
    if args.dry_run:
        log(f"[dry-run] source={src.name} encoding={t['encoding']} -> {SITE_TILES}")
        return 0
    if not src.exists():
        log(f"{src.name} missing — run 05 first. [stub] tiling wiring complete.")
        return 0

    xyz = SITE_TILES / "xyz"
    ensure_dir(xyz)
    n = _tile_dem(src, xyz, zmin, zmax, params)
    log(f"wrote {n} terrarium PNG tiles -> site/tiles/xyz/{{z}}/{{x}}/{{y}}.png")
    return 0


# Land/nodata sentinel elevation (positive -> clearly not seafloor). The style ramp renders any
# elevation just above 0 as transparent, so land shows the basemap, not a flat white blob.
LAND_FILL_M = 10.0


def _terrarium_encode(elev):
    """Encode a float elevation array (NaN=nodata) to a terrarium RGB uint8 image."""
    import numpy as np

    e = np.where(np.isfinite(elev), elev, LAND_FILL_M).astype("float64")
    v = np.clip(e + 32768.0, 0.0, 65535.999)
    r = np.floor(v / 256.0)
    g = np.floor(v - r * 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    return np.dstack([r, g, b]).astype("uint8")


def _tile_dem(src_path, out_root, zmin, zmax, params):
    """For each XYZ tile intersecting the AOI, resample the EPSG:3857 fused DEM into a 256x256
    window, terrarium-encode, and write a PNG. No rio-rgbify/multiprocessing 'fork'."""
    import mercantile
    import numpy as np
    import rasterio
    from PIL import Image
    from rasterio.transform import from_bounds
    from rasterio.warp import Resampling, reproject

    aoi = load_aoi()
    written = 0
    with rasterio.open(src_path) as src:
        src_band = rasterio.band(src, 1)
        src_nodata = src.nodata
        for z in range(zmin, zmax + 1):
            for tile in mercantile.tiles(aoi.lon_min, aoi.lat_min, aoi.lon_max, aoi.lat_max, [z]):
                b = mercantile.xy_bounds(tile)
                dst_transform = from_bounds(b.left, b.bottom, b.right, b.top, 256, 256)
                dst = np.full((256, 256), np.nan, dtype="float32")
                reproject(
                    source=src_band, destination=dst,
                    src_transform=src.transform, src_crs=src.crs, src_nodata=src_nodata,
                    dst_transform=dst_transform, dst_crs="EPSG:3857", dst_nodata=np.nan,
                    resampling=Resampling.bilinear,
                )
                if not np.isfinite(dst).any():
                    continue
                rgb = _terrarium_encode(dst)
                tdir = out_root / str(z) / str(tile.x)
                tdir.mkdir(parents=True, exist_ok=True)
                Image.fromarray(rgb, "RGB").save(tdir / f"{tile.y}.png")
                written += 1
    return written


def main() -> int:
    ap = base_arg_parser(__doc__)
    return make(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
