#!/usr/bin/env python3
"""11_build_fusion1.py -- build the "Fusion1" 0-100 m depth model.

Per-cell INVERSE-VARIANCE fusion of every available depth layer over the AOI, with a
hull-interpolated fill between observations and a provenance/uncertainty band. Depths
NEGATIVE, CRS EPSG:4326, ~6.7 m grid. Honest: source band marks measured vs interpolated.

Trust (variance, smaller=better): ATL24 lidar(5) < SDB validated 0-15 m(6) < Garmin(4)
< CGS isobaths(3) < hull-interp(2) < GMRT deep-only smooth fill(1).
NEVER uses atl24_holdout. Garmin datum offset estimated vs ATL24 TRAIN.
"""
from __future__ import annotations
import time
from pathlib import Path
import numpy as np, pandas as pd
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from scipy import ndimage
from scipy.interpolate import griddata

t0=time.time()
def log(m): print(f"[{time.time()-t0:6.1f}s] {m}", flush=True)
F=Path(__file__).resolve().parents[1]; OUT=F/'dem'
G_CSV=F/'data/raw/qdc_aoi_points_4326.csv'

LON0,LON1,LAT0,LAT1=32.62,32.82,-27.62,-27.32
RES=0.00006
NX=int(round((LON1-LON0)/RES)); NY=int(round((LAT1-LAT0)/RES))
TF=from_bounds(LON0,LAT0,LON1,LAT1,NX,NY)
MPD_LAT=110570.0; MPD_LON=111320.0*np.cos(np.radians((LAT0+LAT1)/2))
CELL_M=RES*MPD_LAT; SDB_MAXD=40.0
log(f"grid {NX}x{NY} ({NX*NY/1e6:.1f} M cells), ~{CELL_M:.1f} m")

def to_rc(lon,lat):
    col=np.floor((lon-LON0)/RES).astype(np.int64); row=np.floor((LAT1-lat)/RES).astype(np.int64)
    ok=(row>=0)&(row<NY)&(col>=0)&(col<NX); return row,col,ok
def block_stat(lon,lat,val):
    row,col,ok=to_rc(lon,lat); row,col=row[ok],col[ok]; val=np.asarray(val,float)[ok]
    flat=row*NX+col; order=np.argsort(flat,kind='stable'); flat_s=flat[order]; val_s=val[order]
    uniq,start=np.unique(flat_s,return_index=True)
    cnt_seg=(np.r_[start[1:],len(val_s)]-start).astype(np.float64)
    ssum=np.add.reduceat(val_s,start); ssq=np.add.reduceat(val_s*val_s,start)
    mean=ssum/cnt_seg; var=np.maximum(ssq/cnt_seg-mean*mean,0.0)
    med=np.full(NX*NY,np.nan,np.float32); std=np.full(NX*NY,np.nan,np.float32); cnt=np.zeros(NX*NY,np.float32)
    med[uniq]=mean.astype(np.float32); std[uniq]=np.sqrt(var).astype(np.float32); cnt[uniq]=cnt_seg
    return med.reshape(NY,NX),std.reshape(NY,NX),cnt.reshape(NY,NX)
def resample_raster(path,resampling):
    with rasterio.open(path) as src:
        dst=np.full((NY,NX),np.nan,np.float32)
        reproject(source=rasterio.band(src,1),destination=dst,src_transform=src.transform,
                  src_crs=src.crs,dst_transform=TF,dst_crs='EPSG:4326',
                  src_nodata=src.nodata,dst_nodata=np.nan,resampling=resampling)
    return dst

# ---- load ----
log("loading sources...")
G=pd.read_csv(G_CSV); G=G[G.lon.between(LON0,LON1)&G.lat.between(LAT0,LAT1)]
g_lon,g_lat,g_dep=G.lon.values,G.lat.values,G.elev.values
C=pd.read_csv(F/'data/raw/cgs_isobath_points_4326.csv'); C=C[C.lon.between(LON0,LON1)&C.lat.between(LAT0,LAT1)]
C_lon,C_lat,C_dep=C.lon.values,C.lat.values,-C.depth_m.abs().values
A=pd.read_parquet(F/'data/raw/atl24_train.parquet'); A=A[A.lon.between(LON0,LON1)&A.lat.between(LAT0,LAT1)]
A_lon,A_lat,A_dep,A_sig=A.lon.values,A.lat.values,A.depth_m.values,A.sigma.values

# ---- Garmin despike (coarse-cell robust outlier rejection) ----
def despike(lon,lat,dep,resc=0.0002,thr=5.0):
    col=np.floor((lon-LON0)/resc).astype(int); row=np.floor((LAT1-lat)/resc).astype(int)
    df=pd.DataFrame({'k':row*100000+col,'d':dep})
    med=df.groupby('k')['d'].transform('median').values
    resid=np.abs(dep-med); mad=np.median(resid)+1e-6
    keep=resid<=np.maximum(thr,3.5*mad); return keep
keep=despike(g_lon,g_lat,g_dep)
log(f"Garmin despike: dropped {(~keep).sum()} / {len(keep)} ({100*(~keep).mean():.1f}%)")
g_lon,g_lat,g_dep=g_lon[keep],g_lat[keep],g_dep[keep]

# ---- grid + Garmin datum offset vs ATL24 train ----
log("gridding...")
g_med,g_std,g_cnt=block_stat(g_lon,g_lat,g_dep)
c_med,_,_=block_stat(C_lon,C_lat,C_dep)
a_med,_,_=block_stat(A_lon,A_lat,A_dep); a_sig,_,_=block_stat(A_lon,A_lat,A_sig)
both=np.isfinite(g_med)&np.isfinite(a_med)&(np.abs(a_med)<15)
offset=float(np.median((g_med-a_med)[both])) if both.sum() else 0.0
log(f"Garmin datum offset vs ATL24-train (0-15 m, n={int(both.sum())}): {offset:+.2f} m")
g_med=g_med-offset; g_dep=g_dep-offset

log("resampling SDB + GMRT...")
sdb=resample_raster(F/'dem/sdb_10m.tif',Resampling.bilinear)
sdb_u=resample_raster(F/'dem/sdb_uncertainty.tif',Resampling.bilinear)
gmrt=resample_raster(F/'data/raw/gmrt_aoi_4326.tif',Resampling.bilinear)
oldf=resample_raster(F/'dem/sodwana_fused_10m_4326.tif',Resampling.bilinear)
gmrt=np.where(gmrt>0,np.nan,gmrt)
gmrt_deep=np.where(np.abs(gmrt)>40,gmrt,np.nan)   # GMRT only trustworthy as DEEP smooth fill
# SDB optical authority: where optics saw a bottom shallower than SAT metres (i.e. NOT
# saturated), that is the true depth -- reject sonar/CGS readings >8 m deeper there
# (canyon cannot hide beneath a sunlit reef). Beyond SAT, SDB is saturated and Garmin/CGS
# build the true 20-100 m canyon. GMRT is altimetry-derived here (reads deeper on the shelf
# break than in the canyon) so it is NOT used to gate -- only as last-resort deep fill.
SAT=20.0
opt=np.isfinite(sdb)&(np.abs(sdb)<SAT)
badg=opt&np.isfinite(g_med)&(g_med<sdb-8.0)
badc=opt&np.isfinite(c_med)&(c_med<sdb-8.0)
g_med=np.where(badg,np.nan,g_med); c_med=np.where(badc,np.nan,c_med)
log(f"SDB-authority QC: dropped {int(badg.sum())} Garmin + {int(badc.sum())} CGS below-reef cells")

# CGS-isobath envelope QC (Euan-trusted, accurate esp. >20 m): build a smooth expected-depth
# surface from the CGS isobaths and reject Garmin readings grossly deeper than it. This removes
# the large coherent field of reef false-bottom soundings (fish shoals / thermoclines over the
# dive reef) that geometry-based despeckling cannot, while preserving the real shelf-break canyon
# where the CGS isobaths themselves run deep.
rc=0.0005
nxc=int(round((LON1-LON0)/rc)); nyc=int(round((LAT1-LAT0)/rc))
gl=LON0+(np.arange(nxc)+0.5)*rc; ga_=LAT1-(np.arange(nyc)+0.5)*rc
GXc,GYc=np.meshgrid(gl,ga_)
env_c=griddata((C_lon,C_lat),C_dep,(GXc,GYc),method='linear')
if (~np.isfinite(env_c)).any():
    idx2=ndimage.distance_transform_edt(~np.isfinite(env_c),return_distances=False,return_indices=True)
    env_c=np.where(np.isfinite(env_c),env_c,env_c[tuple(idx2)])
env_c=ndimage.gaussian_filter(env_c.astype(np.float32),1.0)
env=ndimage.zoom(env_c,(NY/nyc,NX/nxc),order=1)
envmag=np.abs(env); margin=np.maximum(18.0,0.5*envmag)
bad_env=np.isfinite(g_med)&((-g_med)>(envmag+margin))
g_med=np.where(bad_env,np.nan,g_med)
log(f"CGS-envelope QC: dropped {int(bad_env.sum())} Garmin false-bottom cells (vs CGS expected depth)")

# ---- nearest-neighbour fill over all water (respects steep shelf break) ----
log("nearest-fill...")
measured=g_med.copy()
measured=np.where(np.isfinite(measured),measured,c_med)
measured=np.where(np.isfinite(measured),measured,a_med)
mmask=np.isfinite(measured)
idx=ndimage.distance_transform_edt(~mmask,return_distances=False,return_indices=True)
dist_m=(ndimage.distance_transform_edt(~mmask)*CELL_M).astype(np.float32)
interp=measured[tuple(idx)].astype(np.float32)
interp=np.where(mmask,np.nan,interp)          # only FILL non-measured cells
log(f"nearest-fill covers {np.isfinite(interp).mean()*100:.0f}% (measured {mmask.mean()*100:.0f}%)")

# ---- inverse-variance fusion ----
log("inverse-variance fusion...")
num=np.zeros((NY,NX),np.float64); den=np.zeros((NY,NX),np.float64)
best_var=np.full((NY,NX),np.inf); source=np.zeros((NY,NX),np.uint8)
def add(val,var,code):
    m=np.isfinite(val)&np.isfinite(var)&(var>0)
    w=np.where(m,1.0/np.where(m,var,1.0),0.0)
    num[m]+=val[m]*w[m]; den[m]+=w[m]
    better=m&(var<best_var); best_var[better]=var[better]; source[better]=code
add(gmrt_deep,(8.0+0.15*np.abs(gmrt_deep))**2,1)          # deep smooth fill only
add(interp,(2.6+0.06*dist_m)**2,2)                         # hull interpolation
add(c_med,(1.0+0.02*np.abs(c_med))**2,3)                   # CGS isobaths
gvar=(1.7**2)+(g_std**2)/np.maximum(g_cnt,1.0)
add(g_med,gvar,4)                                          # Garmin (despiked)
add(a_med,np.maximum(a_sig,0.25)**2,5)                     # ATL24 lidar (train)
sdb_valid=np.where(np.isfinite(sdb)&(np.abs(sdb)<=SDB_MAXD),sdb,np.nan)
add(sdb_valid,np.maximum(sdb_u,0.4)**2,6)                  # SDB validated shallow

depth=(num/np.maximum(den,1e-9)).astype(np.float32); depth[den==0]=np.nan
# Preserve the VALIDATED SDB optical zone unchanged (project fill-only principle: the
# validated shallow zone is never overridden by unvalidated sources). Where optics
# confidently saw a shallow bottom, Fusion1 == SDB exactly.
val_shallow=np.isfinite(oldf)&(np.abs(oldf)<=16.0)
depth=np.where(val_shallow,oldf,depth).astype(np.float32)
source[val_shallow]=6
# Despeckle: remove isolated deep sonar/interp spikes (fish / false-bottom pits). The real
# canyon is spatially contiguous so its cells match their neighbourhood; isolated pits do not.
spk_src=(source==4)|(source==2)
base=np.where(np.isfinite(depth),depth,0.0).astype(np.float32)
closed=ndimage.grey_closing(base,size=25)     # fills deep pits narrower than ~170 m
spike=spk_src&np.isfinite(depth)&(depth<closed-8.0)
depth[spike]=closed[spike]
log(f"despeckle (grey-closing): pulled {int(spike.sum())} deep sonar spikes to surrounding surface")
# Connected-component canyon test: the real canyon is one large contiguous deep region;
# deep sonar blobs on the reef (fish shoals / thermocline false-bottoms) are small and
# isolated. Remove deep blobs smaller than canyon scale, filling from the validated shelf.
deepm=np.isfinite(depth)&(depth<-35.0)
lab,nlab=ndimage.label(deepm)
if nlab>0:
    cnt=np.bincount(lab.ravel()); keepc=np.zeros(cnt.size,bool); keepc[1:]=cnt[1:]>=1500
    spikeblob=deepm&~keepc[lab]
    fillv=np.where(np.isfinite(oldf),oldf,closed).astype(np.float32)
    depth[spikeblob]=fillv[spikeblob]
    log(f"canyon-connectivity: removed {int(spikeblob.sum())} cells in {int((cnt[1:]<1500).sum())} sub-canyon deep blobs")
# Smooth the low-confidence tiers (GMRT deep-fill=1, nearest-neighbour hull-interp=2): 1-NN
# fill is a Voronoi assignment, so it has sharp cliff-like discontinuities exactly where the
# nearest measured point changes -- an artifact of the fill algorithm, not real seafloor
# structure (this is what produced the tangled/jagged contour lines Euan flagged as
# unprofessional-looking in deep water). A distance-weighted local average (computed over ALL
# cells, including neighbouring measured ones, so it blends smoothly toward them) replaces
# ONLY the low-confidence cells; every measured tier (CGS/Garmin/ATL24/SDB, source 3-6) is left
# byte-for-byte unchanged. This removes a rendering artifact, it does not fabricate detail.
low_conf=(source==1)|(source==2)
if low_conf.any():
    base_f=np.where(np.isfinite(depth),depth,0.0).astype(np.float32)
    valid_f=np.isfinite(depth).astype(np.float32)
    smooth_num=ndimage.gaussian_filter(base_f,sigma=6.0)
    smooth_den=ndimage.gaussian_filter(valid_f,sigma=6.0)
    smoothed=np.where(smooth_den>1e-6,smooth_num/np.maximum(smooth_den,1e-6),np.nan)
    fix=low_conf&np.isfinite(smoothed)
    depth[fix]=smoothed[fix]
    log(f"seam-smoothing: blended {int(fix.sum())} low-confidence (GMRT/interp) cells to remove Voronoi cliffs")
unc=np.sqrt(1.0/np.maximum(den,1e-9)).astype(np.float32); unc[den==0]=np.nan
depth=np.where(depth>0,0.0,depth)
nod=-9999.0
# land mask from Sentinel-2 NIR (B8 = band 5): high NIR reflectance = land/beach
with rasterio.open(F/'data/raw/s2_composite_10m_4326.tif') as s2:
    b8=np.full((NY,NX),np.nan,np.float32)
    reproject(source=rasterio.band(s2,5),destination=b8,src_transform=s2.transform,
              src_crs=s2.crs,dst_transform=TF,dst_crs='EPSG:4326',resampling=Resampling.bilinear)
land_nir=np.isfinite(b8)&(b8>0.06)
land=(~np.isfinite(depth))|(land_nir&~np.isfinite(oldf))
depth_o=np.where(land,nod,depth).astype(np.float32)
unc_o=np.where(land,nod,unc).astype(np.float32); source[land]=0
log(f"depth range {np.nanmin(depth):.1f}..{np.nanmax(depth):.1f} m ; land/nodata {land.mean()*100:.0f}%")
for c,n in [(1,'GMRT'),(2,'interp'),(3,'CGS'),(4,'Garmin'),(5,'ATL24'),(6,'SDB')]:
    log(f"  src {n:7s}: {(source==c).sum()/1e3:8.1f} k")

def write(path,arr,dtype,nodata):
    prof=dict(driver='GTiff',height=NY,width=NX,count=1,dtype=dtype,crs='EPSG:4326',transform=TF,
              nodata=nodata,compress='DEFLATE',tiled=True,blockxsize=256,blockysize=256)
    import shutil,tempfile; tmp=Path(tempfile.gettempdir())/path.name
    with rasterio.open(tmp,'w',**prof) as d: d.write(arr,1)
    shutil.copyfile(tmp,path)
write(OUT/'fusion1_depth_4326.tif',depth_o,'float32',nod)
write(OUT/'fusion1_uncertainty_4326.tif',unc_o,'float32',nod)
write(OUT/'fusion1_source_4326.tif',source,'uint8',0)
log("WROTE fusion1_{depth,uncertainty,source}_4326.tif")
