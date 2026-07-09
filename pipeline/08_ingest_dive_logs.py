#!/usr/bin/env python3
"""08 — Ingest cleaned Garmin dive-log reef clusters into the map's dive sites.

Reads the CLEANED, CLUSTERED output of the external dive-log tool (extract_reefs.py):
`data/dive_logs/reef_candidates.csv` — one row per spatial cluster of dive-entry GPS fixes,
with a candidate reef name, dive count, centroid, and max/min recorded depth.

**Never parses the raw `Dive-ACTIVITY*.json` files** — that is the upstream tool's job; this
script consumes only its cleaned CSV output.

These are Euan's OWN logged dives, so per the project rule "Euan's GPS names override all
sources" the named clusters are written as VERIFIED dive sites. Outputs:
  data/dive_sites.geojson        named reef sites (centroid, depth range, n_dives, alt names)
  data/dive_entries.geojson      individual entry-point fixes (for a density overlay)
  site/data/<both>               web copies the static site fetches

Honesty note: the cluster's depth is the DEEPEST point reached on the dive; the coordinate is the
ENTRY GPS fix. They are not the same spot, so these depths are site CONTEXT (a depth range), NOT
per-pixel depth truth — they are never used to train or validate the bathymetry model.

CRS: EPSG:4326 throughout. Idempotent.
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import base_arg_parser, ensure_dir, load_aoi, load_params, log  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE_DATA = ROOT / "site" / "data"


def _fix_mojibake(s: str) -> str:
    """Repair UTF-8-as-latin1 mangling from the CSV (e.g. 'Wayneâ€™s' -> Wayne's)."""
    if not s:
        return s
    try:
        return s.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def _in_aoi(aoi, lon: float, lat: float) -> bool:
    return aoi.lon_min <= lon <= aoi.lon_max and aoi.lat_min <= lat <= aoi.lat_max


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _describe(name, depth_max, n_dives):
    d = f"~{depth_max:.0f} m max" if depth_max is not None else "depth n/a"
    n = f"{n_dives} logged dive(s)" if n_dives else "logged dive"
    return f"{name}: {d}, from {n} (Garmin dive log)."


def build_sites(rows, aoi):
    """Cluster rows -> dive-site point features (named clusters verified: Euan's own logs)."""
    feats = []
    for r in rows:
        try:
            lon = float(r["centroid_lon"]); lat = float(r["centroid_lat"])
        except (KeyError, ValueError):
            continue
        if not _in_aoi(aoi, lon, lat):
            continue
        name = _fix_mojibake((r.get("candidate_reef") or "UNNAMED").strip())
        depth_max = _num(r.get("max_depth_m"))   # positive magnitude in the CSV
        depth_min = _num(r.get("min_depth_m"))
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
            "properties": {
                "name": name,
                "depth_min_m": -depth_max if depth_max is not None else None,  # seafloor negative
                "depth_max_m": -depth_min if depth_min is not None else None,
                "n_dives": int(float(r.get("n_dives", 0) or 0)),
                "alt_names": _fix_mojibake((r.get("alt_names") or "").strip()),
                "source": "garmin_dive_log",
                "verified": name.upper() != "UNNAMED",
                "description": _describe(name, depth_max, r.get("n_dives")),
            },
        })
    feats.sort(key=lambda f: f["geometry"]["coordinates"][1], reverse=True)  # N->S
    return feats


def _load_geojson_tolerant(path: Path):
    """Load a geojson, salvaging complete features if the file is truncated/malformed.

    The upstream reef_points.geojson can arrive truncated (copied mid-write). Rather than fail the
    whole ingest, recover every fully-closed brace object that is a Feature; drop trailing partials.
    """
    text = path.read_text(encoding="utf-8", errors="replace").replace("\r", "")
    try:
        return json.loads(text).get("features", [])
    except json.JSONDecodeError:
        pass
    feats, depth, start = [], 0, None
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start is not None:
                chunk = text[start:i + 1]
                if '"Feature"' in chunk:
                    try:
                        feats.append(json.loads(chunk))
                    except json.JSONDecodeError:
                        pass
                start = None
    log(f"salvaged {len(feats)} complete features from truncated {path.name}")
    return feats


def build_entries(aoi):
    """Pass individual entry-point fixes through for a density overlay (clipped to AOI)."""
    src = DATA / "dive_logs" / "reef_points.geojson"
    if not src.exists():
        return None
    out = []
    for f in _load_geojson_tolerant(src):
        c = f.get("geometry", {}).get("coordinates")
        if not c or not _in_aoi(aoi, c[0], c[1]):
            continue
        p = f.get("properties", {})
        md = p.get("max_depth_m")
        out.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(c[0], 6), round(c[1], 6)]},
            "properties": {
                "reef": _fix_mojibake(p.get("reef") or ""),
                "cluster": p.get("cluster"),
                "max_depth_m": -abs(md) if isinstance(md, (int, float)) else None,
            },
        })
    return {"type": "FeatureCollection", "name": "dive_entries", "features": out}


def main() -> int:
    ap = base_arg_parser(__doc__)
    args = ap.parse_args()
    aoi = load_aoi(args.aoi)
    _ = load_params(args.params)
    csv_path = DATA / "dive_logs" / "reef_candidates.csv"
    if not csv_path.exists():
        log(f"{csv_path} missing — copy the cleaned reef_candidates.csv there (not raw JSON).")
        return 0
    with csv_path.open(encoding="utf-8", errors="replace") as fh:
        rows = list(csv.DictReader(fh))
    feats = build_sites(rows, aoi)
    entries = build_entries(aoi)
    n_verified = sum(1 for f in feats if f["properties"]["verified"])
    log(f"clusters read={len(rows)} in-AOI sites={len(feats)} verified(named)={n_verified}")

    if args.dry_run:
        log("[dry-run] would write dive_sites.geojson + dive_entries.geojson")
        return 0

    ensure_dir(SITE_DATA)
    sites_gj = {"type": "FeatureCollection", "name": "sodwana_dive_sites",
                "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
                "_note": "From Euan's Garmin dive logs (cleaned/clustered). Named clusters = verified.",
                "features": feats}
    for dst in (DATA / "dive_sites.geojson", SITE_DATA / "dive_sites.geojson"):
        dst.write_text(json.dumps(sites_gj, indent=2), encoding="utf-8")
    if entries is not None:
        for dst in (DATA / "dive_entries.geojson", SITE_DATA / "dive_entries.geojson"):
            dst.write_text(json.dumps(entries, indent=1), encoding="utf-8")
        log(f"wrote dive_entries.geojson ({len(entries['features'])} entry fixes)")
    log(f"wrote dive_sites.geojson ({len(feats)} sites) -> data/ and site/data/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
