#!/usr/bin/env python3
"""
One-off conversion: de Wet & Compton (2021) SA continental shelf bathymetry grid
(Arc/Info ASCII Grid, EPSG:4326 implied, depths already negative-down) -> AOI-clipped
lon,lat,depth_m CSV for the rmse_against_holdout.py eval harness.

Source: data/raw/Willem de Wet Bathymetry of Southern Africa Continental Shelf.grd
(8001x4668, ~333 m cells, whole southern African shelf; nodata=1.7014e38).
Confirmed via rasterio: AOI window has real depth coverage, values already
negative-down (e.g. -0.76 m nearshore down to -805 m), so no sign flip needed.

This is a read-only eval conversion -- NOT wired into pipeline/05 fusion. That is a
separate decision made after reviewing the harness's RMSE-vs-holdout output.
"""
from pathlib import Path

import numpy as np
import pandas as pd
import rasterio
from rasterio.windows import from_bounds

SRC = Path("data/raw/Willem de Wet Bathymetry of Southern Africa Continental Shelf.grd")
OUT = Path("data/raw/dewet_compton_points.csv")
AOI = (32.62, -27.62, 32.82, -27.32)  # lon_min, lat_min, lon_max, lat_max


def main() -> None:
    with rasterio.open(SRC) as ds:
        win = from_bounds(*AOI, transform=ds.transform).round_lengths().round_offsets()
        data = ds.read(1, window=win)
        transform = ds.window_transform(win)
        nodata = ds.nodata

    rows, cols = np.where(data != nodata)
    depths = data[rows, cols].astype(np.float64)
    xs, ys = rasterio.transform.xy(transform, rows, cols)

    df = pd.DataFrame({"lon": xs, "lat": ys, "depth_m": depths})
    assert (df["depth_m"] <= 0).all(), "unexpected positive depth -- sign convention changed?"
    df.to_csv(OUT, index=False)
    print(f"wrote {len(df)} points to {OUT}")
    print(df["depth_m"].describe())


if __name__ == "__main__":
    main()
