"""Shared helpers for the Sodwana bathymetry pipeline.

Conventions enforced across all scripts:
  * Elevation: land POSITIVE, seafloor NEGATIVE metres. A positive value over water is a bug.
  * Processing CRS EPSG:4326; tiles/web EPSG:3857. State CRS in every raster filename (_4326/_3857).
  * All tunables come from config/params.yaml; the bounding box comes only from config/aoi.geojson.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_AOI = REPO_ROOT / "config" / "aoi.geojson"
DEFAULT_PARAMS = REPO_ROOT / "config" / "params.yaml"


@dataclass(frozen=True)
class AOI:
    """Area of interest bounds in EPSG:4326 (lon/lat)."""

    lon_min: float
    lat_min: float
    lon_max: float
    lat_max: float

    @property
    def bbox(self) -> tuple[float, float, float, float]:
        """(west, south, east, north) — the order GDAL/mercantile/STAC expect."""
        return (self.lon_min, self.lat_min, self.lon_max, self.lat_max)

    @property
    def polygon(self) -> list[list[float]]:
        """Closed lon/lat ring, e.g. for SlideRule/STAC polygon queries."""
        return [
            [self.lon_min, self.lat_min],
            [self.lon_max, self.lat_min],
            [self.lon_max, self.lat_max],
            [self.lon_min, self.lat_max],
            [self.lon_min, self.lat_min],
        ]


def load_aoi(path: str | Path = DEFAULT_AOI) -> AOI:
    """Read the single-source-of-truth AOI polygon and return its bounds.

    CRS: EPSG:4326 (CRS84 lon/lat). Never hardcode the box anywhere else.
    """
    data = json.loads(Path(path).read_text())
    feat = data["features"][0]
    coords = feat["geometry"]["coordinates"][0]
    lons = [c[0] for c in coords]
    lats = [c[1] for c in coords]
    return AOI(min(lons), min(lats), max(lons), max(lats))


def load_params(path: str | Path = DEFAULT_PARAMS) -> dict[str, Any]:
    """Load config/params.yaml as a plain dict."""
    return yaml.safe_load(Path(path).read_text())


def base_arg_parser(description: str) -> argparse.ArgumentParser:
    """Every pipeline script accepts --aoi and --params (per CLAUDE.md convention)."""
    p = argparse.ArgumentParser(description=description)
    p.add_argument("--aoi", default=str(DEFAULT_AOI), help="AOI geojson (single source of truth)")
    p.add_argument("--params", default=str(DEFAULT_PARAMS), help="params.yaml")
    p.add_argument("--dry-run", action="store_true", help="report what would happen; write nothing")
    return p


def ensure_dir(path: str | Path) -> Path:
    """mkdir -p and return the Path."""
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def log(msg: str) -> None:
    """Uniform, greppable stdout logging."""
    print(f"[pipeline] {msg}", flush=True)


def assert_no_positive_over_water(arr, nodata: float, *, name: str = "raster") -> None:
    """Guard the depth convention. Raises if any valid pixel is a positive 'depth'.

    Land is masked out before fusion, so within the marine DEM every valid value
    must be <= 0. Call this in fusion/derivative steps to catch sign-flip bugs early.
    """
    import numpy as np

    valid = arr[(arr != nodata) & np.isfinite(arr)]
    if valid.size and float(np.nanmax(valid)) > 0.0:
        n = int((valid > 0).sum())
        raise ValueError(
            f"{name}: {n} pixels have POSITIVE depth over water — sign bug. "
            "Depths must be negative metres (see CLAUDE.md)."
        )


import contextlib as _contextlib
import os as _os
import shutil as _shutil
import tempfile as _tempfile


@_contextlib.contextmanager
def raster_writer(final_path, **profile):
    """Open a GeoTIFF for writing on a NATIVE temp path, then copy over `final_path` on close.

    Some mounts (e.g. the Windows folder mount) forbid unlink/rename, so GDAL's
    delete-then-create overwrite fails with 'Operation not permitted'. Writing to the system
    temp dir (deletion allowed) and copying the finished file over the destination
    (open-truncate-write, which the mount permits) sidesteps that. Overviews are internal to the
    GTiff, so they travel with the copy. Behaves like `rasterio.open(final, 'w', **profile)`.
    """
    import rasterio

    final_path = Path(final_path)
    final_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(_tempfile.gettempdir()) / f".{final_path.stem}.{_os.getpid()}.tif"
    ds = rasterio.open(tmp, "w", **profile)
    try:
        yield ds
    finally:
        ds.close()
        _shutil.copyfile(tmp, final_path)
        with _contextlib.suppress(OSError):
            tmp.unlink()
