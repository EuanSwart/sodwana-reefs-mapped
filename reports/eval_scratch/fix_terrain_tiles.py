#!/usr/bin/env python
"""One-off regeneration of site/tiles/terrain with sane nodata handling.

Root cause: the original build_terrarium() (Fable2 pipeline/06_make_tiles.py) encodes nodata
cells as elevation exactly -32768 m (hidden from the RELIEF layer via alpha=0, which MapLibre's
terrain MESH generation does not respect -- it uses the decoded elevation regardless of alpha).
Adjacent real seafloor (~-20 m) next to a -32768 m "cliff" creates catastrophic vertical spikes
in the 3D/terrain mesh, visible even at pitch=0 because map.setTerrain() is always active for
depth-query purposes.

Fix: nodata cells get the NEAREST real value within FILL_LIMIT_PX pixels (smooth boundary, no
discontinuity), and 0.0 (flat, neutral) beyond that (far offshore/deep land interior - no visual
spike since it's a flat plateau, not a cliff). Alpha is UNCHANGED (still 0 for real nodata) so the
relief colour layer's honesty (transparent = no data) is completely unaffected; only the terrain
MESH shape changes.
"""
from pathlib import Path
import math
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.warp import calculate_default_transform, reproject
from rasterio.windows import from_bounds
from scipy.ndimage import distance_transform_edt

R = 6378137.0
ORIGIN = math.pi * R
AOI = (32.62, -27.62, 32.82, -27.32)  # lon_min, lat_min, lon_max, lat_max
MINZ, MAXZ = 8, 15
FILL_LIMIT_PX = 15  # ~150 m at the 10 m master grid

SRC_DEM = Path("../Fable2/dem/fusion_depth_4326.tif")
OUT_TERRAIN = Path("site/tiles/terrain")


def build_terrarium_safe(dem_path: Path, out_tif: Path):
    with rasterio.open(dem_path) as ds:
        z = ds.read(1).astype("float64")
        nd = ds.nodata
        prof = ds.profile
    valid = (z != nd) & np.isfinite(z)
    dist, idx = distance_transform_edt(~valid, return_distances=True, return_indices=True)
    nearest = z[tuple(idx)]
    filled = np.where(dist <= FILL_LIMIT_PX, nearest, 0.0)
    zsafe = np.where(valid, z, filled)
    v = zsafe + 32768.0
    r = np.floor(v / 256.0)
    g = np.floor(v % 256.0)
    b = np.floor((v - np.floor(v)) * 256.0)
    rgb = np.dstack([r, g, b]).astype("uint8")
    a = np.where(valid, 255, 0).astype("uint8")  # alpha UNCHANGED: still marks real nodata
    rgba = np.dstack([rgb, a])
    p = dict(prof, count=4, dtype="uint8", nodata=None, compress="DEFLATE")
    with rasterio.open(out_tif, "w", **p) as dst:
        for i in range(4):
            dst.write(rgba[..., i], i + 1)


def tile_bounds_3857(x, y, z):
    ts = 2 * ORIGIN / (2 ** z)
    minx = -ORIGIN + x * ts
    maxy = ORIGIN - y * ts
    return minx, maxy - ts, minx + ts, maxy


def lonlat_to_tile(lon, lat, z):
    n = 2 ** z
    xt = int((lon + 180.0) / 360.0 * n)
    latr = math.radians(lat)
    yt = int((1.0 - math.asinh(math.tan(latr)) / math.pi) / 2.0 * n)
    return xt, yt


def to_3857_mosaic(rgba_tif: Path, maxz: int):
    px = (2 * ORIGIN / (2 ** maxz)) / 256.0
    with rasterio.open(rgba_tif) as src:
        dst_t, w, h = calculate_default_transform(
            src.crs, "EPSG:3857", src.width, src.height, *src.bounds, resolution=px)
        out = rgba_tif.with_name(rgba_tif.stem + "_3857.tif")
        prof = dict(driver="GTiff", height=h, width=w, count=4, dtype="uint8",
                    crs="EPSG:3857", transform=dst_t, nodata=None, tiled=True, compress="DEFLATE")
        with rasterio.open(out, "w", **prof) as dst:
            for i in range(1, 5):
                reproject(rasterio.band(src, i), rasterio.band(dst, i),
                          src_crs=src.crs, dst_crs="EPSG:3857", resampling=Resampling.nearest)
    return out


def tile_pyramid(rgba_tif: Path, out_dir: Path):
    mosaic = to_3857_mosaic(rgba_tif, MAXZ)
    count = 0
    lon_min, lat_min, lon_max, lat_max = AOI
    with rasterio.open(mosaic) as ds:
        for z in range(MINZ, MAXZ + 1):
            x0, y0 = lonlat_to_tile(lon_min, lat_max, z)
            x1, y1 = lonlat_to_tile(lon_max, lat_min, z)
            for x in range(x0, x1 + 1):
                for y in range(y0, y1 + 1):
                    minx, miny, maxx, maxy = tile_bounds_3857(x, y, z)
                    win = from_bounds(minx, miny, maxx, maxy, ds.transform)
                    data = ds.read(out_shape=(4, 256, 256), window=win,
                                   resampling=Resampling.nearest, boundless=True, fill_value=0)
                    if data[3].max() == 0:
                        continue
                    # Safety net for a SECOND nodata path: pixels outside the source mosaic's
                    # real extent (common at low zoom, where one tile spans well past the AOI)
                    # get fill_value=0 from the boundless read above -- R=G=B=0 decodes to
                    # elevation -32768 m, the exact same mesh-spike bug the nearest-fill in
                    # build_terrarium_safe() was meant to prevent, just via a different code
                    # path (tile boundary, not source-raster nodata). Force every alpha=0 pixel
                    # (real nodata OR boundless fill) to encode elevation 0 m so NO tile can ever
                    # contain an extreme value, regardless of why the pixel is invalid.
                    invalid = data[3] == 0
                    data[0][invalid] = 128  # R=128,G=0,B=0 -> (128*256+0+0/256)-32768 = 0.0 m
                    data[1][invalid] = 0
                    data[2][invalid] = 0
                    img = Image.fromarray(np.transpose(data, (1, 2, 0)), "RGBA")
                    d = out_dir / str(z) / str(x)
                    d.mkdir(parents=True, exist_ok=True)
                    img.save(d / f"{y}.png")
                    count += 1
    mosaic.unlink(missing_ok=True)
    return count


def main():
    print("building safe terrarium raster...")
    tmp_tif = Path("_terrarium_safe_4326.tif")
    build_terrarium_safe(SRC_DEM, tmp_tif)
    print("tiling...")
    import shutil
    if OUT_TERRAIN.exists():
        shutil.rmtree(OUT_TERRAIN)
    n = tile_pyramid(tmp_tif, OUT_TERRAIN)
    tmp_tif.unlink(missing_ok=True)
    mosaic = tmp_tif.with_name(tmp_tif.stem + "_3857.tif")
    mosaic.unlink(missing_ok=True)
    print(f"done: {n} terrain tiles written to {OUT_TERRAIN}")


if __name__ == "__main__":
    main()
