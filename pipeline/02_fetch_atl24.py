#!/usr/bin/env python3
"""02 — Fetch ICESat-2 ATL24 refraction-corrected seafloor photons for the AOI.

ATL24 is THE calibration signal the earlier ML attempt lacked: thousands of real lidar seafloor
depths (0 to ~30-40 m) along tracks crossing Sodwana. (v2, DOI 10.5067/ATLAS/ATL24.002.)

Primary: SlideRule (keyless public service). NOTE the plan's `icesat2.atl24x` client function does
NOT exist in the current SlideRule Python client — drive the live SERVER endpoint directly:
    sliderule.run("atl24x", {"srt": -1}, aoi="config/aoi.geojson")
It returns ONLY seafloor photons (class_ph==40). lon/lat come from the `geometry` column (not
plain columns); seafloor height is `ortho_h`; `confidence` is a 0..1 FLOAT.
Fallback: NSIDC direct via `earthaccess` (free Earthdata login), documented, not run here.

Filtering: confidence >= params.sdb.atl24_confidence_min (mapped low=0.3/medium=0.6/high=0.8).
Split 70/30 BY TRACK (rgt+cycle+beam group), never random — spatial leakage inflates accuracy.

Outputs (EPSG:4326):
  data/raw/atl24_points.parquet   all usable photons
  data/raw/atl24_train.parquet    70% of tracks — the ONLY split 04 may read
  data/raw/atl24_holdout.parquet  30% of tracks — validation only
  data/icesat2_tracks.geojson     track lines for the web overlay
Idempotent — skips if outputs exist unless --force.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DATA = ROOT / "data"

CONF_MAP = {"low": 0.3, "medium": 0.6, "high": 0.8}


def fetch_via_sliderule(aoi_path, *, dry_run: bool):
    """Drive the SlideRule `atl24x` server endpoint over the AOI polygon. Returns a GeoDataFrame."""
    log("SlideRule atl24x over AOI polygon (server endpoint, keyless)")
    if dry_run:
        log("[dry-run] would call sliderule.run('atl24x', {'srt': -1}, aoi=...)")
        return None
    try:
        import sliderule

        sliderule.init("slideruleearth.io", verbose=False)
        gdf = sliderule.run("atl24x", {"srt": -1}, aoi=str(aoi_path))
        log(f"SlideRule returned {len(gdf)} seafloor photons")
        return gdf
    except Exception as exc:  # noqa: BLE001 — network/service errors expected & handled
        log(f"SlideRule unavailable ({exc}); use earthaccess fallback (free Earthdata login).")
        return None


def normalize(gdf, params):
    """Coerce to the pipeline schema: lon/lat from geometry, depth NEGATIVE metres, track id, filter."""
    import numpy as np
    import pandas as pd

    df = pd.DataFrame(gdf.drop(columns="geometry")) if hasattr(gdf, "geometry") else pd.DataFrame(gdf)
    if hasattr(gdf, "geometry"):
        df["lon"] = gdf.geometry.x.to_numpy()
        df["lat"] = gdf.geometry.y.to_numpy()
    # seafloor height (ortho) -> negative depth
    if "ortho_h" in df:
        df["depth_m"] = -df["ortho_h"].abs()
    elif "depth_m" in df:
        df["depth_m"] = -df["depth_m"].abs()
    # confidence is a 0..1 float; map the configured label to a float threshold
    thr = CONF_MAP.get(str(params["sdb"]["atl24_confidence_min"]).lower(), 0.6)
    if "confidence" in df:
        df = df[df["confidence"] >= thr]
    # track id from rgt/cycle/spot (or beam)
    def tid(r):
        return f"{r.get('rgt','?')}-{r.get('cycle','?')}-{r.get('spot', r.get('beam','?'))}"
    df["track"] = df.apply(tid, axis=1)
    if "sigma" not in df:
        df["sigma"] = np.nan
    keep = [c for c in ["lat", "lon", "depth_m", "sigma", "confidence", "beam", "spot", "track"] if c in df]
    return df[keep].dropna(subset=["lat", "lon", "depth_m"])


def split_by_track(df, holdout_frac: float, seed: int):
    """Deterministic 70/30 split grouped by whole track (no photon leaks across the split)."""
    def h(t: str) -> float:
        return int(hashlib.md5(f"{seed}:{t}".encode()).hexdigest(), 16) % 10_000 / 10_000.0

    holdout_tracks = {t for t in df["track"].unique() if h(t) < holdout_frac}
    hold = df[df["track"].isin(holdout_tracks)]
    train = df[~df["track"].isin(holdout_tracks)]
    return train, hold


def write_tracks_geojson(df):
    """Emit simple per-track lines (sorted by lat) for the web ICESat-2 overlay."""
    feats = []
    for tid, g in df.groupby("track"):
        g = g.sort_values("lat")
        coords = [[round(lo, 6), round(la, 6)] for lo, la in zip(g["lon"], g["lat"])]
        if len(coords) >= 2:
            feats.append({"type": "Feature", "properties": {"track": tid, "n": len(coords)},
                          "geometry": {"type": "LineString", "coordinates": coords}})
    gj = {"type": "FeatureCollection", "name": "icesat2_tracks", "features": feats}
    (DATA / "icesat2_tracks.geojson").write_text(json.dumps(gj))
    for sd in (ROOT / "site" / "data",):
        if sd.exists():
            (sd / "icesat2_tracks.geojson").write_text(json.dumps(gj))
    log(f"wrote icesat2_tracks.geojson ({len(feats)} tracks)")


def main() -> int:
    ap = base_arg_parser(__doc__)
    ap.add_argument("--force", action="store_true", help="re-fetch even if outputs exist")
    args = ap.parse_args()
    aoi_path = args.aoi
    params = load_params(args.params)
    ensure_dir(RAW)

    all_out = RAW / "atl24_points.parquet"
    if all_out.exists() and not args.force and not args.dry_run:
        log(f"exists, skipping (use --force): {all_out.name}")
        return 0

    gdf = fetch_via_sliderule(aoi_path, dry_run=args.dry_run)
    if gdf is None:
        log("No data fetched (dry-run or service down). Outputs not written.")
        return 0

    df = normalize(gdf, params)
    if df.empty:
        log("WARNING: zero usable ATL24 photons after filtering — check AOI/confidence.")
        return 1

    train, hold = split_by_track(df, params["sdb"]["train_holdout_split"], params["sdb"]["split_seed"])
    df.to_parquet(all_out, index=False)
    train.to_parquet(RAW / "atl24_train.parquet", index=False)
    hold.to_parquet(RAW / "atl24_holdout.parquet", index=False)
    write_tracks_geojson(df)
    log(f"photons={len(df)} tracks={df['track'].nunique()} train={len(train)} holdout={len(hold)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
