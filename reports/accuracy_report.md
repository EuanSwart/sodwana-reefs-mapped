# Accuracy report

DEM: `sodwana_fused_10m_4326.tif`

| depth band (m) | n | RMSE (m) | MAE (m) |
|---|---|---|---|
| 0–5 | 1641 | 1.45 | 0.84 |
| 5–10 | 662 | 1.06 | 0.76 |
| 10–15 | 195 | 1.39 | 0.93 |
| 15–20 | 112 | 4.12 | 2.42 |
| 20–25 | 50 | 6.30 | 5.93 |
| 25–30 | 4 | 8.15 | 8.07 |

## Gate windows (vs held-out ATL24)
- 0–15 m: RMSE 1.35 m (cap 1.5)
- 15–25 m: RMSE 4.90 m (cap 2.5)

_Euan's GPS points are validation only and never trained on. Where data is absent, values read N/A rather than being interpolated._
