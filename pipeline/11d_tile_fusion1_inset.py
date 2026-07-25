#!/usr/bin/env python3
"""11b_tile_fusion1.py -- terrarium XYZ tiles for the Fusion1 DEM (separate layer).
Reprojects fusion1_depth_4326.tif into z8..z15 tiles under site/tiles_fusion1/xyz/{z}/{x}/{y}.png.
Same encoding as pipeline/07 so the site style/ramp works unchanged. Land(nodata)-> +10 m sentinel
-> transparent. Also copies fusion1_source (provenance) as a lightweight overlay is handled separately.
"""
import math,sys
from pathlib import Path
import numpy as np, mercantile, rasterio
from PIL import Image
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject
ROOT=Path(__file__).resolve().parents[1]
SRC=ROOT/'dem'/'fusion1_inset_depth_4326.tif'
OUT=ROOT/'site'/'tiles_fusion1_inset'/'xyz'
LON0,LON1,LAT0,LAT1=32.660,32.735,-27.620,-27.400
ZMIN,ZMAX=12,16
LAND_FILL_M=10.0
def enc(elev):
    e=np.where(np.isfinite(elev),elev,LAND_FILL_M).astype('float64')
    v=np.clip(e+32768.0,0.0,65535.999)
    r=np.floor(v/256.0); g=np.floor(v-r*256.0); b=np.floor((v-np.floor(v))*256.0)
    return np.dstack([r,g,b]).astype('uint8')
n=0
with rasterio.open(SRC) as src:
    sb=rasterio.band(src,1); snod=src.nodata
    for z in range(ZMIN,ZMAX+1):
        for tile in mercantile.tiles(LON0,LAT0,LON1,LAT1,[z]):
            b=mercantile.xy_bounds(tile)
            dtf=from_bounds(b.left,b.bottom,b.right,b.top,256,256)
            dst=np.full((256,256),np.nan,'float32')
            reproject(source=sb,destination=dst,src_transform=src.transform,src_crs=src.crs,
                      src_nodata=snod,dst_transform=dtf,dst_crs='EPSG:3857',dst_nodata=np.nan,
                      resampling=Resampling.bilinear)
            if not np.isfinite(dst).any(): continue
            d=OUT/str(z)/str(tile.x); d.mkdir(parents=True,exist_ok=True)
            Image.fromarray(enc(dst),'RGB').save(d/f"{tile.y}.png")
            n+=1
print("wrote",n,"Fusion1 tiles ->",OUT)
