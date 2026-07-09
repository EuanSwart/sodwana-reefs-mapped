#!/usr/bin/env python3
"""
Reusable RMSE-vs-holdout harness for testing NEW candidate depth sources against the
project's own held-out ATL24 validation methodology (see pipeline/validate.py and
config/params.yaml `gates:`).

STATUS (2026-07-09, data-scout session): written but UNUSED this session -- no candidate
source yielded actual downloadable depth values (see reports/data_sources.md and this
session's findings appended to CLAUDE.md Gotchas for exactly why each candidate was
blocked). Kept here so a future session can drop in real values (e.g. once the
de Wet & Compton 2021 zip or a credentialed Copernicus Marine subset is obtained) without
re-deriving the RMSE-by-band logic from scratch.

Usage:
    python rmse_against_holdout.py --source my_source_points.csv
    # CSV must have columns: lon, lat, depth_m (negative metres, same convention as the
    # project). Nearest-neighbour match to the ATL24 holdout points within --max-dist-m.

Never trains/tunes on this holdout -- read-only comparison, matching the project's own
by-track holdout split (data/raw/atl24_holdout.parquet, 2875 points, NEVER used to train
the project's SDB model). Gates for comparison (config/params.yaml):
    0-15 m band RMSE <= 1.5 m to "pass"
    15-25 m band RMSE <= 2.5 m to "pass"
"""
import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HOLDOUT_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "atl24_holdout.parquet"
GATE_0_15_M = 1.5
GATE_15_25_M = 2.5
BAND_EDGES = [0, 15, 25, 9999]  # depth magnitude bands, matches project's two headline gates


def load_holdout() -> pd.DataFrame:
    df = pd.read_parquet(HOLDOUT_PATH)
    assert (df["depth_m"] <= 0).all(), "holdout depths must be negative-down; a positive value is a bug"
    return df


def nearest_match(source: pd.DataFrame, holdout: pd.DataFrame, max_dist_m: float) -> pd.DataFrame:
    """Nearest-neighbour match source points (lon,lat,depth_m) to holdout points.
    Flat-earth approx is fine at this AOI's small extent (~22 km x 33 km).
    Pure numpy (no scipy dependency) -- brute-force chunked, fine up to tens of
    thousands of points; switch to scipy.spatial.cKDTree if a source is far larger."""
    lat0 = holdout["lat"].mean()
    m_per_deg_lat = 111_320.0
    m_per_deg_lon = 111_320.0 * np.cos(np.radians(lat0))

    src_xy = np.column_stack([
        source["lon"].to_numpy() * m_per_deg_lon,
        source["lat"].to_numpy() * m_per_deg_lat,
    ])
    hold_xy = np.column_stack([
        holdout["lon"].to_numpy() * m_per_deg_lon,
        holdout["lat"].to_numpy() * m_per_deg_lat,
    ])
    n_hold = hold_xy.shape[0]
    best_idx = np.empty(n_hold, dtype=np.int64)
    best_dist = np.empty(n_hold, dtype=np.float64)
    chunk = 500
    for start in range(0, n_hold, chunk):
        end = min(start + chunk, n_hold)
        d2 = ((hold_xy[start:end, None, :] - src_xy[None, :, :]) ** 2).sum(axis=2)
        idx = d2.argmin(axis=1)
        best_idx[start:end] = idx
        best_dist[start:end] = np.sqrt(d2[np.arange(end - start), idx])

    out = holdout.copy().reset_index(drop=True)
    out["source_depth_m"] = source["depth_m"].to_numpy()[best_idx]
    out["match_dist_m"] = best_dist
    return out[out["match_dist_m"] <= max_dist_m]


def rmse_by_band(matched: pd.DataFrame) -> None:
    depth_abs = matched["depth_m"].abs()
    print(f"n matched (within max-dist): {len(matched)}")
    for lo, hi in zip(BAND_EDGES[:-1], BAND_EDGES[1:]):
        band = matched[(depth_abs >= lo) & (depth_abs < hi)]
        if len(band) == 0:
            print(f"  {lo}-{hi} m: n=0, RMSE not computable (no points in band)")
            continue
        band_err = band["source_depth_m"] - band["depth_m"]
        rmse = float(np.sqrt(np.mean(band_err ** 2)))
        bias = float(np.mean(band_err))
        gate = GATE_0_15_M if hi == 15 else (GATE_15_25_M if hi == 25 else None)
        verdict = "" if gate is None else (" PASS" if rmse <= gate else f" FAIL (gate {gate} m)")
        print(f"  {lo}-{hi} m: n={len(band)}, RMSE={rmse:.2f} m, bias={bias:+.2f} m{verdict}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", required=True, type=Path, help="CSV with lon,lat,depth_m columns")
    ap.add_argument("--max-dist-m", type=float, default=100.0,
                     help="max nearest-neighbour match distance (metres); default 100 m")
    args = ap.parse_args()

    if not args.source.exists():
        print(f"ERROR: {args.source} not found -- no candidate source data was available "
              f"this session; see CLAUDE.md Gotchas for what was tried.", file=sys.stderr)
        return 1

    source = pd.read_csv(args.source)
    for col in ("lon", "lat", "depth_m"):
        if col not in source.columns:
            print(f"ERROR: --source CSV missing required column '{col}'", file=sys.stderr)
            return 1
    if (source["depth_m"] > 0).any():
        print("WARNING: source has positive depth_m values -- check sign convention "
              "(this project uses negative-down; OSM seamark soundings, for example, are "
              "typically positive-down and need negation before use).", file=sys.stderr)

    holdout = load_holdout()
    matched = nearest_match(source, holdout, args.max_dist_m)
    rmse_by_band(matched)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
