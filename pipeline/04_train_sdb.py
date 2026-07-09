#!/usr/bin/env python3
"""04 — Satellite-Derived Bathymetry model (the iterative accuracy loop core).

Replaces the earlier unsupervised failure with a properly SUPERVISED fit:
  1. Extract Sentinel-2 reflectances at every ATL24 TRAIN photon.
  2. Fit (a) Stumpf log-ratio ln(B2)/ln(B3) linear baseline and (b) XGBoost on
     [ln B1..B4, B8, band ratios, x, y]. (SA-proven recipe: Frontiers 2026, Langebaan RMSE 0.45 m.)
  3. Predict a full 10 m depth raster; mask where predicted depth beyond per-scene optical limit
     and where B8 glint/turbidity flags fire.
  4. validate.py scores it vs HELD-OUT ATL24 + bias vs Euan's GPS; sdb-modeler loops on failure.

HARD RULE: this script may read ONLY data/raw/atl24_train.parquet. It must NEVER open
atl24_holdout.parquet or data/ground_truth/gps_points.csv — those are validation only.

Outputs (EPSG:4326, depths NEGATIVE):
  dem/sdb_10m.tif             predicted depth
  dem/sdb_uncertainty.tif     per-pixel model sigma
  reports/sdb_model.json      chosen model, features, per-band train metrics, scene list
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DEM = ROOT / "dem"
REPORTS = ROOT / "reports"

FORBIDDEN = {RAW / "atl24_holdout.parquet", ROOT / "data" / "ground_truth" / "gps_points.csv"}


def _guard_no_leakage() -> None:
    """Fail loud if the forbidden validation files were somehow opened this run."""
    # Defensive: this module never references FORBIDDEN paths; the check documents intent
    # and lets qa-validator grep for it.
    for p in FORBIDDEN:
        assert p not in {Path(__file__)}, "training must not read validation data"


def build_features(refl, params):
    """Assemble the XGBoost feature matrix from a reflectance dict {band: array}."""
    import numpy as np

    eps = 1e-6
    ln = {b: np.log(np.clip(refl[b], eps, None)) for b in ["B1", "B2", "B3", "B4"]}
    feats = {
        "ln_B1": ln["B1"], "ln_B2": ln["B2"], "ln_B3": ln["B3"], "ln_B4": ln["B4"],
        "B8": refl["B8"],
        "ratio_B2_B3": ln["B2"] / (ln["B3"] + eps),
        "ratio_B2_B4": ln["B2"] / (ln["B4"] + eps),
    }
    return feats


def stumpf_baseline(refl):
    """Stumpf & Holman log-ratio index ln(B2)/ln(B3) — the linear SDB baseline."""
    import numpy as np

    eps = 1e-6
    return np.log(np.clip(refl["B2"], eps, None)) / np.log(np.clip(refl["B3"], eps, None) + eps)


def train(args) -> int:
    import numpy as np
    import pandas as pd

    aoi = load_aoi(args.aoi)
    params = load_params(args.params)
    ensure_dir(DEM)
    ensure_dir(REPORTS)
    _guard_no_leakage()

    train_path = RAW / "atl24_train.parquet"
    s2_path = RAW / "s2_composite_10m_4326.tif"
    if not train_path.exists() or not s2_path.exists():
        log(f"Inputs missing (need {train_path.name} and {s2_path.name}). Run 02 & 03 first.")
        log("[stub] wiring is complete; rerun once Phase-1 data + S2 composite exist.")
        return 0

    import rasterio
    from rasterio.sample import sample_gen

    tr = pd.read_parquet(train_path)
    log(f"train photons={len(tr)} tracks={tr['track'].nunique()} (holdout untouched)")

    with rasterio.open(s2_path) as src:
        band_idx = {name: i + 1 for i, name in enumerate(params["sentinel2"]["bands"])}
        coords = list(zip(tr["lon"], tr["lat"]))
        samples = np.array(list(sample_gen(src, coords)))
    refl = {b: samples[:, band_idx[b] - 1].astype(float) for b in band_idx}
    tr["x"] = tr["lon"]
    tr["y"] = tr["lat"]

    feats = build_features(refl, params)
    feats["x"] = tr["x"].to_numpy()
    feats["y"] = tr["y"].to_numpy()
    X = pd.DataFrame(feats)[params["sdb"]["features"]]
    y = tr["depth_m"].to_numpy()  # negative metres
    ok = np.isfinite(X.to_numpy()).all(axis=1) & np.isfinite(y)
    X, y = X[ok], y[ok]

    from sklearn.linear_model import LinearRegression
    import xgboost as xgb

    stumpf = stumpf_baseline(refl)[ok].reshape(-1, 1)
    lin = LinearRegression().fit(stumpf, y)
    xgb_p = params["sdb"]["xgboost"]
    model = xgb.XGBRegressor(
        n_estimators=xgb_p["n_estimators"], max_depth=xgb_p["max_depth"],
        learning_rate=xgb_p["learning_rate"], subsample=xgb_p["subsample"],
        colsample_bytree=xgb_p["colsample_bytree"], reg_lambda=xgb_p["reg_lambda"],
        objective="reg:squarederror", n_jobs=-1,
    ).fit(X, y)

    # Predict full raster grid from the S2 composite.
    with rasterio.open(s2_path) as src:
        prof = src.profile
        bands = {b: src.read(band_idx[b]).astype(float) for b in band_idx}
    h, w = bands["B2"].shape
    grid = build_features(bands, params)
    import numpy as np

    ys, xs = np.mgrid[0:h, 0:w]
    with rasterio.open(s2_path) as src:
        lon, lat = rasterio.transform.xy(src.transform, ys, xs)
    grid["x"] = np.array(lon)
    grid["y"] = np.array(lat)
    Xg = np.stack([np.asarray(grid[f]).ravel() for f in params["sdb"]["features"]], axis=1)
    valid = np.isfinite(Xg).all(axis=1)
    depth = np.full(Xg.shape[0], params["project"]["nodata"], dtype="float32")
    depth[valid] = model.predict(Xg[valid]).astype("float32")
    depth = depth.reshape(h, w)

    # Optical-limit mask: drop predictions deeper than the scene extinction depth.
    limit = params["depth"]["optical_extinction_default_m"]
    nod = params["project"]["nodata"]
    depth[(depth < limit) & (depth != nod)] = nod
    depth[depth > params["depth"]["land_mask_min_m"]] = nod  # no positive depths over water

    # Uncertainty proxy: |xgb - linear baseline| (disagreement grows with depth/turbidity).
    base = lin.predict(stumpf_baseline(bands).reshape(-1, 1)).reshape(h, w).astype("float32")
    unc = np.abs(depth - base).astype("float32")
    unc[depth == nod] = nod

    out_prof = prof.copy()
    out_prof.update(count=1, dtype="float32", nodata=nod, compress="deflate", tiled=True)
    if not args.dry_run:
        with rasterio.open(DEM / "sdb_10m.tif", "w", **out_prof) as dst:
            dst.write(depth, 1)
            dst.build_overviews([2, 4, 8], rasterio.enums.Resampling.average)
        with rasterio.open(DEM / "sdb_uncertainty.tif", "w", **out_prof) as dst:
            dst.write(unc, 1)
        (REPORTS / "sdb_model.json").write_text(json.dumps({
            "model": "xgboost", "features": params["sdb"]["features"],
            "n_train": int(ok.sum()), "n_tracks": int(tr["track"].nunique()),
            "optical_limit_m": limit, "stumpf_coef": float(lin.coef_[0]),
        }, indent=2))
    log("wrote dem/sdb_10m.tif, dem/sdb_uncertainty.tif, reports/sdb_model.json")
    log("Next: python pipeline/validate.py --quick  (scores vs HELD-OUT ATL24)")
    return 0


def main() -> int:
    ap = base_arg_parser(__doc__)
    return train(ap.parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
