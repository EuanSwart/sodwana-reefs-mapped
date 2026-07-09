# Feasibility: ML + spatial splining/smoothing to improve fused-DEM accuracy

**Question asked:** can machine learning combined with spatial splining/smoothing, plus additional
sources like Copernicus Marine, improve on the current fused DEM's accuracy — particularly the
failing 15–25 m band?

**Bottom line: yes, worth one bounded prototyping iteration — but as a *residual-correction* layer
on top of the existing SDB model, not a new primary model.** Expected gain is modest (this is
still bounded by the same optical-noise-floor physics that produced the 15–25 m "wall" in the
first place), and every claim must clear the same track-holdout RMSE gates already in
`pipeline/validate.py` before being trusted. $0 budget is achievable — no new paid services or
Python packages are required (scipy + scikit-learn are already project dependencies, see below).

## 1. Where we actually stand today

- 0–15 m RMSE 1.35 m → **PASS**. 15–25 m RMSE 4.90 m → **FAIL** ("optical wall": passive Sentinel-2
  signal hits its noise floor below ~18 m in Sodwana's water column — a physical limit, not a
  tuning miss).
- Copernicus Marine `phy_wk` (wave-kinematics SDB, different physics from passive optical) was
  already tried as a **naive band-conditional override**: replace SDB with Copernicus wherever
  SDB's own predicted depth falls in 15–25 m. Result: 15–25 m RMSE got *worse* (4.90 m → 5.06 m).
  Root cause (already diagnosed and logged): "SDB says 15–25 m" selects by *depth*, not by *SDB
  error* — at the 35 holdout points the override touched, SDB was already accurate (1.13 m RMSE)
  and got swapped for Copernicus's own systematically-biased value (2.96 m RMSE at those same
  points). Copernicus's *better aggregate* accuracy across its whole footprint said nothing about
  whether it was better at the specific spots being overridden. This is disabled by default
  (`fusion.copernicus_phy_wk_enabled: false`) but the code is left in place.
- Lesson already banked in CLAUDE.md: a source's own standalone accuracy is not a valid selection
  criterion for *where to trust it more than another source* — you need a local
  disagreement/uncertainty signal, not a depth threshold.

## 2. What "ML + spatial splining" concretely means here, and what's proven elsewhere

Searched current (2025) literature on SDB accuracy improvement via geostatistical/ML fusion. Three
patterns recur and map directly onto this project's situation:

1. **Two-scale residual correction — ML for the large-scale trend, kriging for the small-scale
   residual field.** A random-forest (or similar) model predicts the large-scale depth trend, then
   **kriging is applied to the *residuals* between predicted and true depth at held-out points**,
   and that smooth error-correction surface is added back to the prediction. This is the closest
   published analogue to our exact situation, and it does NOT repeat the spatial-leakage trap we
   already hit: that trap was including `x,y` as *direct predictive features* in the primary
   depth model, which let XGBoost memorize train-track locations. Kriging the *residual* field
   is a fundamentally different operation — it's explicitly modeling the spatial autocorrelation
   of *error*, evaluated the same way (track-holdout RMSE), not a feature fed into depth
   prediction. ([MDPI, 2025](https://www.mdpi.com/2072-4292/17/15/2594))
2. **Active-lidar + passive-optical iterative fusion** (ICESat-2-style "real" photons blended with
   Sentinel-2-derived "pseudo-photons") — conceptually similar to what `05_fuse_dem.py` already
   does (ATL24 lidar tier + SDB tier), but iterates the fusion rather than doing single-pass
   fill-only compositing. Higher effort to port, lower near-term ROI given our track density.
   ([Tandfonline, 2025](https://www.tandfonline.com/doi/full/10.1080/17538947.2025.2543568))
3. **Deep-learning / multi-model fusion constrained by habitat classification** (e.g. reef-mask-
   aware blending, Mamba-based fusion) — interesting for prospect corroboration, but a much bigger
   lift (new model family, more training data than we have) for uncertain payoff at our AOI scale.
   ([MDPI, 2025](https://doi.org/10.3390/rs17132134))

Recommendation: **pursue (1) only**, as a bounded next iteration. (2) and (3) are logged here as
known techniques, not queued.

## 3. Concrete proposal

**Step A — residual correction via kriging or thin-plate spline (no new dependencies).**
`scipy.interpolate.RBFInterpolator` (thin-plate-spline kernel) and `sklearn.gaussian_process.
GaussianProcessRegressor` (which *is* kriging, framed as ML) are already available — `scipy` and
`scikit-learn` are existing pipeline dependencies (`pipeline/05_fuse_dem.py` already uses
`scipy.interpolate.griddata`; `pipeline/04_train_sdb.py` already imports `sklearn.linear_model`).
No `pykrige` or other new package needed.

- Compute residuals (`SDB_predicted − ATL24_truth`) at **TRAIN-split** photon locations only
  (never touch the holdout — same by-track discipline as everywhere else in this project).
- Fit a smooth correction surface over those residuals (GP regression is preferred over plain RBF
  because it comes with a **per-pixel uncertainty estimate for free** — see Step B).
- Add the correction surface back to the SDB depth grid.
- Re-run `pipeline/validate.py` (the existing by-track holdout gate) — same PASS/FAIL bar as
  today, no exceptions. If 15–25 m still fails, report the honest number; do not lower the gate.

**Step B — use the GP's own uncertainty as the Copernicus-blending criterion.** This directly fixes
the failure mode from the earlier Copernicus attempt: instead of "override where SDB predicts
15–25 m" (a depth-based rule that doesn't track SDB's actual error), use **local prediction
variance from the residual-GP** as the trust signal — blend in Copernicus (or any other source)
only where the GP itself reports high uncertainty, weighted inverse-variance style. This is a
principled fix to the exact bug already diagnosed, not a guess.

**Step C — re-evaluate Copernicus `phy_wk` under this new criterion**, reusing the existing
`reports/eval_scratch/rmse_against_holdout.py` harness (already built and portable across
sessions — see the 2026-07-09/07-10 data-source evaluation notes). Only wire it back into
`fusion.copernicus_phy_wk_enabled` if it demonstrably beats the current 4.90 m honestly, on the
same held-out gate.

## 4. Risks / what NOT to do

- **Do not let a smoothing step fabricate detail the data doesn't support.** The 15–25 m wall is a
  real physical noise floor, not a gridding artifact — a correction surface must still pass the
  same track-holdout RMSE gate; "looks smoother" is not a success criterion on its own (violates
  the project's honesty rule).
- **Do not reintroduce the x,y spatial-leakage trap.** Kriging/GP residual correction is safe
  *only* if it operates on the residual field with train/holdout split enforced exactly like the
  primary model — same rule, same discipline, just applied one layer downstream.
- Expect a **modest** improvement, not a fix. Two independent physical sensors already told us
  15–25 m depth is hard here (Sentinel-2 passive optics *and* Copernicus wave-kinematics both
  degrade in that band); a residual-correction layer can only extract a bit more out of what
  signal already exists, not remove a genuine noise floor.

## 5. Suggested next step (bounded, with exit criterion — per project loop convention)

One `sdb-modeler` iteration, capped: prototype Step A+B on top of the current best XGBoost model,
score against the existing by-track ATL24 holdout via `rmse_against_holdout.py`. Exit criteria:
15–25 m gate (≤2.5 m) passes → wire in and document; improves but still fails → report the honest
number in `reports/accuracy_report.md` and stop (matches the existing 6-iteration loop policy);
no improvement or worse → discard and document why, same as the Copernicus band-override attempt.

## Sources

- [Satellite-Derived Bathymetry Using Sentinel-2 and Airborne Hyperspectral Data: A Deep Learning Approach with Adaptive Interpolation (MDPI, 2025)](https://www.mdpi.com/2072-4292/17/15/2594)
- [Satellite-derived bathymetry based on iterative fusion of active lidar photons and passive pseudo-photons (Tandfonline, 2025)](https://www.tandfonline.com/doi/full/10.1080/17538947.2025.2543568)
- [Multi-Model Synergistic Satellite-Derived Bathymetry Fusion Approach Based on Mamba Coral Reef Habitat Classification (MDPI, 2025)](https://doi.org/10.3390/rs17132134)
- [Blending physical and artificial intelligence models to improve satellite-derived bathymetry mapping (ScienceDirect, 2025)](https://www.sciencedirect.com/science/article/pii/S1574954125003371)
