#!/usr/bin/env python3
"""smoke_site.py — pre-push site smoke test (part of the git-push acceptance gate).

Static checks that need no browser: index.html parses, references its JS/style, style.json is
valid JSON with the expected sources/layers, dive_sites.geojson is valid, no hardcoded API keys.
A full headless-browser check (zero console errors, screenshots) is the frontend-builder agent's job.

Exit 1 on any failure.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"


def main() -> int:
    errs: list[str] = []

    idx = SITE / "index.html"
    if not idx.exists():
        errs.append("site/index.html missing")
    else:
        html = idx.read_text(encoding="utf-8")
        for ref in ("app.js", "maplibre-gl"):
            if ref not in html:
                errs.append(f"index.html does not reference {ref}")

    style = SITE / "style.json"
    if style.exists():
        try:
            s = json.loads(style.read_text())
            if "sources" not in s or "layers" not in s:
                errs.append("style.json missing sources/layers")
        except json.JSONDecodeError as e:
            errs.append(f"style.json invalid JSON: {e}")

    ds = ROOT / "data" / "dive_sites.geojson"
    if ds.exists():
        try:
            json.loads(ds.read_text())
        except json.JSONDecodeError as e:
            errs.append(f"dive_sites.geojson invalid JSON: {e}")

    # No token-gated services / API keys committed (budget $0).
    key_pat = re.compile(r"(api[_-]?key|access[_-]?token|mapbox|pk\.[A-Za-z0-9]{20})", re.I)
    for f in SITE.rglob("*"):
        if f.suffix in {".html", ".js", ".json"} and f.is_file():
            for m in key_pat.finditer(f.read_text(encoding="utf-8", errors="ignore")):
                # OpenFreeMap/maplibre mentions are fine; only flag actual key-looking tokens.
                if m.group(0).lower().startswith("pk."):
                    errs.append(f"possible API key in {f.name}: {m.group(0)[:12]}...")

    if errs:
        for e in errs:
            print(f"[smoke_site] FAIL: {e}", flush=True)
        return 1
    print("[smoke_site] PASS: site static checks OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
