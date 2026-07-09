#!/usr/bin/env python3
"""01 — Fetch base grids (deep-water fill) for the AOI.

Sources (all keyless/free):
  * GMRT GridServer  — GeoTIFF for the AOI bbox (~120 m over Sodwana; altimetry base,
    NO multibeam swaths here — treat as SMOOTH DEEP-WATER FILL ONLY, never as detail).
  * GEBCO 2025       — global grid; sub-set for the AOI. Manual/no-login download at
    https://download.gebco.net/ ; this script fetches the GMRT copy automatically and
    documents the GEBCO fallback (GEBCO's bulk endpoint needs a form POST).
  * de Wet & Compton (2021) SA shelf single-beam — sparse real soundings, manual grab
    from https://www.johnscompton.com/maps/ , dropped into data/raw/ as extra deep control.

Output: data/raw/gmrt_aoi_4326.tif  (EPSG:4326, depths NEGATIVE metres, explicit nodata).
CRS: input/output EPSG:4326. Idempotent — skips download if the file already exists and is valid.
"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

GMRT_URL = "https://www.gmrt.org/services/GridServer"
RAW = Path(__file__).resolve().parent.parent / "data" / "raw"


def fetch_gmrt(aoi, out: Path, *, dry_run: bool) -> Path:
    """Download a GMRT GeoTIFF clipped to the AOI bbox (EPSG:4326)."""
    params = {
        "west": aoi.lon_min,
        "east": aoi.lon_max,
        "south": aoi.lat_min,
        "north": aoi.lat_max,
        "format": "geotiff",
        "layer": "topo",
        "resolution": "max",
    }
    log(f"GMRT request bbox=({aoi.lon_min},{aoi.lat_min},{aoi.lon_max},{aoi.lat_max})")
    if dry_run:
        log(f"[dry-run] would GET {GMRT_URL} -> {out}")
        return out
    if out.exists() and out.stat().st_size > 1024:
        log(f"exists, skipping: {out.name}")
        return out
    resp = requests.get(GMRT_URL, params=params, timeout=180)
    resp.raise_for_status()
    ctype = resp.headers.get("Content-Type", "")
    if "tiff" not in ctype and not resp.content[:4] in (b"II*\x00", b"MM\x00*"):
        raise RuntimeError(f"GMRT did not return a GeoTIFF (Content-Type={ctype!r}).")
    out.write_bytes(resp.content)
    log(f"wrote {out} ({out.stat().st_size/1e6:.2f} MB)")
    return out


def main() -> int:
    ap = base_arg_parser(__doc__)
    args = ap.parse_args()
    aoi = load_aoi(args.aoi)
    _ = load_params(args.params)  # reserved for future nodata/res knobs
    ensure_dir(RAW)
    out = RAW / "gmrt_aoi_4326.tif"
    fetch_gmrt(aoi, out, dry_run=args.dry_run)
    log(
        "GEBCO manual fallback: https://download.gebco.net/ -> data/raw/gebco_aoi_4326.tif ; "
        "de Wet & Compton points: https://www.johnscompton.com/maps/ -> data/raw/dewet_compton_points.csv"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
