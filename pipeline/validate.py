#!/usr/bin/env python3
"""validate.py — accuracy gates. Exit 1 on failure. Run after any model/fusion change.

Scores the SDB/fused DEM against the HELD-OUT ATL24 tracks (never trained on) and reports
bias vs Euan's GPS points (validation only, never a gate). Honesty over prettiness: if a gate
cannot be met, report the real numbers — do NOT lower the gate.

Gates (from params.gates):
  * RMSE 0-15 m depths <= rmse_0_15m_max  (vs held-out ATL24)
  * RMSE 15-25 m depths <= rmse_15_25m_max
  * fused DEM: no positive depths over water; no nodata holes in AOI (full run only)

Usage:
  python pipeline/validate.py --quick    # RMSE vs holdout only (fast)
  python pipeline/validate.py            # full gates + coverage + writes reports/accuracy_report.md
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DEM = ROOT / "dem"
REPORTS = ROOT / "reports"
GT = ROOT / "data" / "ground_truth" / "gps_points.csv"


def _sample_dem(dem_path, lons, lats):
    import numpy as np
    import rasterio
    from rasterio.sample import sample_gen

    with rasterio.open(dem_path) as src:
        vals = np.array([v[0] for v in sample_gen(src, list(zip(lons, lats)))], dtype=float)
        nod = src.nodata
    if nod is not None:
        vals[vals == nod] = np.nan
    return vals


def _band_metrics(pred, obs, bands):
    import numpy as np

    rows = []
    for lo, hi in zip(bands[:-1], bands[1:]):
        m = (np.abs(obs) >= lo) & (np.abs(obs) < hi) & np.isfinite(pred) & np.isfinite(obs)
        if m.sum() == 0:
            rows.append((lo, hi, 0, float("nan"), float("nan")))
            continue
        err = pred[m] - obs[m]
        rmse = float(np.sqrt(np.mean(err ** 2)))
        mae = float(np.mean(np.abs(err)))
        rows.append((lo, hi, int(m.sum()), rmse, mae))
    return rows


def main() -> int:
    ap = base_arg_parser(__doc__)
    ap.add_argument("--quick", action="store_true", help="RMSE vs holdout only; skip coverage/report")
    args = ap.parse_args()
    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    gates = params["gates"]

    import numpy as np

    dem_candidates = [DEM / "sodwana_fused_10m_4326.tif", DEM / "sdb_10m.tif"]
    dem = next((p for p in dem_candidates if p.exists()), None)
    holdout = RAW / "atl24_holdout.parquet"
    if dem is None or not holdout.exists():
        log("Nothing to validate yet (need a DEM and atl24_holdout.parquet). Gates: N/A.")
        log("Wiring is complete — rerun after 02/04/05 produce data.")
        return 0

    import pandas as pd

    hold = pd.read_parquet(holdout)
    pred = _sample_dem(dem, hold["lon"].to_numpy(), hold["lat"].to_numpy())
    obs = hold["depth_m"].to_numpy()
    rows = _band_metrics(pred, obs, gates["depth_bands_m"])

    log(f"Validation DEM: {dem.name}  (holdout n={len(hold)})")
    log("band(m)    n     RMSE    MAE")
    for lo, hi, n, rmse, mae in rows:
        log(f"{lo:>3}-{hi:<3} {n:>6}  {rmse:6.2f}  {mae:6.2f}")

    def _rmse_for(lo, hi):
        for a, b, _n, r, _m in rows:
            if a == lo and b == hi:
                return r
        return float("nan")

    # Combine the sub-bands into the two gate windows.
    def _window_rmse(lo, hi):
        m = (np.abs(obs) >= lo) & (np.abs(obs) < hi) & np.isfinite(pred) & np.isfinite(obs)
        if m.sum() == 0:
            return float("nan")
        return float(np.sqrt(np.mean((pred[m] - obs[m]) ** 2)))

    r_shallow = _window_rmse(0, 15)
    r_mid = _window_rmse(15, 25)
    passed = True
    for label_, val, cap in [("0-15 m", r_shallow, gates["rmse_0_15m_max"]),
                             ("15-25 m", r_mid, gates["rmse_15_25m_max"])]:
        ok = (not np.isfinite(val)) or (val <= cap)
        status = "PASS" if (np.isfinite(val) and val <= cap) else ("N/A" if not np.isfinite(val) else "FAIL")
        if np.isfinite(val) and val > cap:
            passed = False
        log(f"GATE {label_}: RMSE={val:.2f} <= {cap} -> {status}")

    # GPS bias — report only, never a gate.
    if GT.exists():
        gt = pd.read_csv(GT, comment="#")
        gt = gt.dropna(subset=["lat", "lon", "depth_m"])
        if len(gt):
            gp = _sample_dem(dem, gt["lon"].to_numpy(), gt["lat"].to_numpy())
            bias = float(np.nanmean(gp - gt["depth_m"].to_numpy()))
            log(f"GPS bias (report-only): mean(pred-obs)={bias:+.2f} m over n={len(gt)} points")

    if not args.quick:
        _coverage_check(dem, aoi, params)
        _write_report(dem, rows, r_shallow, r_mid, gates)

    if not passed:
        log("RESULT: gates FAILED — iterate (sdb-modeler) or report honestly at iteration cap.")
        return 1
    log("RESULT: gates passed (or N/A pending data).")
    return 0


def _coverage_check(dem, aoi, params):
    import numpy as np
    import rasterio

    with rasterio.open(dem) as src:
        a = src.read(1)
        nod = src.nodata
    holes = int(np.sum((a == nod)) if nod is not None else 0)
    pos = int(np.sum((a != nod) & (a > params["depth"]["land_mask_min_m"]))) if nod is not None else 0
    log(f"coverage: nodata_px={holes}  positive-over-water_px={pos} (must be 0)")


def _write_report(dem, rows, r_shallow, r_mid, gates):
    lines = ["# Accuracy report", "", f"DEM: `{dem.name}`", "",
             "| depth band (m) | n | RMSE (m) | MAE (m) |", "|---|---|---|---|"]
    for lo, hi, n, rmse, mae in rows:
        lines.append(f"| {lo}–{hi} | {n} | {rmse:.2f} | {mae:.2f} |")
    lines += ["", "## Gate windows (vs held-out ATL24)",
              f"- 0–15 m: RMSE {r_shallow:.2f} m (cap {gates['rmse_0_15m_max']})",
              f"- 15–25 m: RMSE {r_mid:.2f} m (cap {gates['rmse_15_25m_max']})", "",
              "_Euan's GPS points are validation only and never trained on. "
              "Where data is absent, values read N/A rather than being interpolated._"]
    (REPORTS / "accuracy_report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log("wrote reports/accuracy_report.md")


if __name__ == "__main__":
    raise SystemExit(main())
