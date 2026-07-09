# Vendored libraries (optional, for full offline use)

The site loads MapLibre GL and maplibre-contour from a CDN fallback (unpkg) if these files are
absent, so it works out of the box. To make it fully offline/keyless-forever, drop these here:

- `maplibre-gl.js`  and `maplibre-gl.css`  — from https://unpkg.com/maplibre-gl@5.6.0/dist/
- `index.mjs`       — maplibre-contour ESM build, from https://unpkg.com/maplibre-contour@0.1.0/dist/

`index.html` references `vendor/maplibre-gl.js` / `.css` first and falls back to the CDN on error;
`app.js` imports `./vendor/index.mjs` first and falls back to the CDN.

No API keys are needed anywhere. The OpenFreeMap basemap is keyless; the terrain/bathymetry tiles
are local (`site/tiles/`).
