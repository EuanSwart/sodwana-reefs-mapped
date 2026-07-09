#!/usr/bin/env python3
"""03 — Build a multi-scene Sentinel-2 median composite over the AOI (SDB input).

Selects the clearest scenes (cloud < params.sentinel2.max_cloud_pct) that actually COVER the AOI,
masks nodata, Hedley-deglints the visible bands on B8, and median-composites B1-B4,B8 at 10 m.

Providers:
  * aws  — KEYLESS default: Element84 earth-search STAC (earth-search.aws.element84.com) over the
    public s3://sentinel-cogs bucket. No account, $0. (GEE not needed.)
  * gee  — Google Earth Engine noncommercial free tier.
  * cdse — Copernicus Data Space STAC.

Scene selection is the highest-leverage knob (turbid/swell scenes poison the composite):
  1. filter candidates whose data footprint actually covers the AOI (two relative orbits image
     MGRS 36JVQ here; one is a western sliver that leaves the east empty — reject those);
  2. of the AOI-covering candidates, take the clearest max_scenes.

Reflectance gotcha: earth-search sentinel-cogs DN do NOT carry the +1000 baseline-04.00 offset the
STAC metadata claims; applying it drives water pixels negative. Use SCALE ONLY (DN*0.0001) and mask
DN==0 as nodata.

Output: data/raw/s2_composite_10m_4326.tif (float32 bands B1..B4,B8; EPSG:4326; NaN nodata).
Requires network + (for gee/cdse) auth. Idempotent — skips if the composite exists unless --force.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"
STAC_AWS = "https://earth-search.aws.element84.com/v1"
S2_BAND_ASSET = {"B1": "coastal", "B2": "blue", "B3": "green", "B4": "red", "B8": "nir"}


def select_scenes(items, aoi, max_scenes):
    """Keep only scenes whose data footprint covers the AOI, then the clearest max_scenes.

    Cloud-only selection can pick all 'sliver' scenes from the partial relative orbit and leave the
    eastern half of the AOI empty — so require footprint coverage of the AOI first.
    """
    from shapely.geometry import box, shape

    aoi_geom = box(aoi.lon_min, aoi.lat_min, aoi.lon_max, aoi.lat_max)
    covering = []
    for it in items:
        try:
            geom = shape(it["geometry"])
            frac = geom.intersection(aoi_geom).area / aoi_geom.area
        except Exception:  # noqa: BLE001
            frac = 0.0
        if frac >= 0.98:
            covering.append(it)
    covering.sort(key=lambda it: it["properties"].get("eo:cloud_cover", 100))
    log(f"scene selection: {len(items)} candidates -> {len(covering)} cover AOI -> keep {min(max_scenes, len(covering))}")
    return covering[:max_scenes]


def build_aws(aoi, params, out: Path, *, dry_run: bool) -> None:
    """Keyless Element84 STAC composite over s3://sentinel-cogs."""
    s2 = params["sentinel2"]
    log(f"AWS STAC {s2['date_start']}..{s2['date_end']} cloud<{s2['max_cloud_pct']}% bands={s2['bands']}")
    if dry_run:
        log(f"[dry-run] would STAC-search sentinel-2-l2a at {STAC_AWS} and median-composite.")
        return
    try:
        import numpy as np
        import rasterio
        import requests
        from rasterio.warp import Resampling, reproject
        from rasterio.transform import from_bounds

        r = requests.post(f"{STAC_AWS}/search", json={
            "collections": ["sentinel-2-l2a"],
            "bbox": list(aoi.bbox),
            "datetime": f"{s2['date_start']}T00:00:00Z/{s2['date_end']}T00:00:00Z",
            "query": {"eo:cloud_cover": {"lt": s2["max_cloud_pct"]}},
            "limit": 200,
        }, timeout=120)
        r.raise_for_status()
        items = r.json()["features"]
        scenes = select_scenes(items, aoi, s2["max_scenes"])
        if not scenes:
            log("No AOI-covering scenes found — widen dates or cloud threshold.")
            return

        res_deg = s2["resample_to_m"] / 111_320.0
        w = int(round((aoi.lon_max - aoi.lon_min) / res_deg))
        h = int(round((aoi.lat_max - aoi.lat_min) / res_deg))
        transform = from_bounds(aoi.lon_min, aoi.lat_min, aoi.lon_max, aoi.lat_max, w, h)
        stacks = {b: [] for b in s2["bands"]}
        for it in scenes:
            for b in s2["bands"]:
                href = it["assets"][S2_BAND_ASSET[b]]["href"]
                dst = np.full((h, w), np.nan, dtype="float32")
                with rasterio.open(href) as src:
                    arr = src.read(1).astype("float32")
                    arr[arr == 0] = np.nan               # DN==0 -> nodata (gotcha)
                    reproject(source=arr, destination=dst,
                              src_transform=src.transform, src_crs=src.crs,
                              dst_transform=transform, dst_crs="EPSG:4326",
                              resampling=Resampling.bilinear)
                stacks[b].append(dst * 0.0001)           # SCALE ONLY, no +1000 offset (gotcha)
        comp = {b: np.nanmedian(np.stack(stacks[b]), axis=0) for b in s2["bands"]}
        # Hedley deglint: subtract B8 from the visible bands.
        for b in ["B1", "B2", "B3", "B4"]:
            comp[b] = comp[b] - comp["B8"]
        prof = {"driver": "GTiff", "height": h, "width": w, "count": len(s2["bands"]),
                "dtype": "float32", "crs": "EPSG:4326", "transform": transform,
                "nodata": float("nan"), "compress": "deflate", "tiled": True}
        ensure_dir(RAW)
        with rasterio.open(out, "w", **prof) as dstf:
            for i, b in enumerate(s2["bands"], 1):
                dstf.write(comp[b].astype("float32"), i)
                dstf.set_band_description(i, b)
        log(f"wrote {out.name} ({len(s2['bands'])} bands, {w}x{h} @ {s2['resample_to_m']} m, {len(scenes)} scenes)")
    except Exception as exc:  # noqa: BLE001
        log(f"AWS STAC composite failed ({exc}). Check network / try provider: gee|cdse.")


def build_gee(aoi, params, out: Path, *, dry_run: bool) -> None:
    """GEE median composite (noncommercial). Requires `earthengine authenticate`."""
    log("GEE provider selected — requires `earthengine authenticate` (noncommercial free tier).")
    if dry_run:
        log("[dry-run] would build COPERNICUS/S2_SR_HARMONIZED median composite and export.")


def build_cdse(aoi, params, out: Path, *, dry_run: bool) -> None:
    """Copernicus Data Space STAC — keyless alternate."""
    log("CDSE provider selected: https://catalogue.dataspace.copernicus.eu/stac")
    if dry_run:
        log("[dry-run] would STAC-search SENTINEL-2 L2A over AOI and median-composite.")


def main() -> int:
    ap = base_arg_parser(__doc__)
    ap.add_argument("--force", action="store_true", help="rebuild even if the composite exists")
    args = ap.parse_args()
    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    ensure_dir(RAW)
    out = RAW / "s2_composite_10m_4326.tif"
    if out.exists() and not args.force and not args.dry_run:
        log(f"exists, skipping (use --force): {out.name}")
        return 0
    provider = params["sentinel2"]["provider"]
    log(f"provider={provider}")
    {"aws": build_aws, "gee": build_gee, "cdse": build_cdse}.get(provider, build_aws)(
        aoi, params, out, dry_run=args.dry_run)
    log("Allen Coral Atlas overlay: export AOI GeoTIFF from https://allencoralatlas.org (QA/overlay only).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
