"""Hydrology oracle (REQ-GAP-80, SDP-2.7 §4.2 and §7.3): WhiteboxTools run offline on a crop of a
reference DEM. It writes the DEM crop and WhiteboxTools' outputs, which the golden test
(tests/golden/hydro.test.js) and the SCN-68 browser test compare with the `hydro` bundle.
WhiteboxTools is an oracle only, never shipped.

Run with the gw-te Python (GDAL) and a WhiteboxTools binary, for example:
  python -I tests/tools/hydro_oracle.py --dem USGS_1M_13_x48y441_CO_DRCOG_2020_B20.tif \
    --window 481854 4403156 483864 4405076 --res 5 --pour 483659 4403561 --out fixtures/hydro \
    --wbt .../whitebox_tools.exe

Outputs in --out: dem.tif (Float32, the crop), and gzip'd little-endian rasters, row-major from
the north-west corner: dem.f32, fill_raised.bin (FillDepressions with flats kept, as the raised
posts: u32 indices then f32 heights), d8.u8 (D8Pointer of the fill with fix_flats) and d8plain.u8 (of the plain fill), in the app's codes (1..8 = neighbour k-1 counter-clockwise
from east, 0 none), acc.f32 (D8FlowAccumulation in cells), dinf16.u32 (DInfFlowAccumulation in cells × 16, rounded),
strahler.u8, shreve.u32, watershed.u8; and truth.json.
"""

import argparse
import gzip
import json
import os
import subprocess
import tempfile

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()

# WhiteboxTools D8 pointer codes (1 NE, 2 E, 4 SE, …, 128 N) → the app's (neighbour k + 1,
# k counter-clockwise from east: 1 E, 2 NE, 3 N, 4 NW, 5 W, 6 SW, 7 S, 8 SE).
WBT_TO_APP = {1: 2, 2: 1, 4: 8, 8: 7, 16: 6, 32: 5, 64: 4, 128: 3}


def wbt(exe, wd, tool, **kw):
    args = [exe, f"-r={tool}", f"--wd={wd}", "-v=false"]
    for k, v in kw.items():
        dash = "-" if len(k) == 1 else "--"
        args.append(f"{dash}{k}" if v is True else f"{dash}{k}={v}")
    subprocess.run(args, check=True, capture_output=True)


def read(path):
    ds = gdal.Open(path)
    return ds.GetRasterBand(1).ReadAsArray()


def put(out, name, arr, dtype):
    with gzip.open(os.path.join(out, name), "wb", compresslevel=9) as f:
        f.write(np.ascontiguousarray(arr, dtype=dtype).tobytes())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--dem", required=True)
    p.add_argument("--window", nargs=4, type=float, required=True, metavar=("XMIN", "YMIN", "XMAX", "YMAX"))
    p.add_argument("--res", type=float, required=True)
    p.add_argument("--pour", nargs=2, type=float, required=True, metavar=("X", "Y"))
    p.add_argument("--snap", type=float, default=50.0, help="snap distance in metres")
    p.add_argument("--stream-area", type=float, default=1e5, help="stream threshold, m²")
    p.add_argument("--out", required=True)
    p.add_argument("--wbt", required=True)
    p.add_argument("--rasters", action="store_true", help="also write the .gz rasters (the golden fixture)")
    a = p.parse_args()
    os.makedirs(a.out, exist_ok=True)
    wd = tempfile.mkdtemp(prefix="hydro-oracle-")
    dem = os.path.join(a.out, "dem.tif")
    gdal.Warp(dem, a.dem, outputBounds=a.window, xRes=a.res, yRes=a.res, resampleAlg="average" if a.res > 1 else "near", outputType=gdal.GDT_Float32, creationOptions=["COMPRESS=DEFLATE", "PREDICTOR=3", "TILED=NO"])
    ds = gdal.Open(dem)
    gt = ds.GetGeoTransform()
    h, w = ds.RasterYSize, ds.RasterXSize
    z = ds.GetRasterBand(1).ReadAsArray().astype(np.float32)
    nd = ds.GetRasterBand(1).GetNoDataValue()
    if nd is not None:
        z[z == nd] = np.nan
    gdal.Translate(os.path.join(wd, "dem.tif"), dem)
    wbt(a.wbt, wd, "FillDepressions", i="dem.tif", o="fill.tif")
    wbt(a.wbt, wd, "FillDepressions", i="dem.tif", o="fill_ff.tif", fix_flats=True)
    wbt(a.wbt, wd, "D8Pointer", i="fill_ff.tif", o="d8.tif")
    wbt(a.wbt, wd, "D8Pointer", i="fill.tif", o="d8plain.tif")
    wbt(a.wbt, wd, "D8FlowAccumulation", i="d8.tif", o="acc.tif", pntr=True, out_type="cells")
    wbt(a.wbt, wd, "DInfFlowAccumulation", i="fill_ff.tif", o="dinf.tif", out_type="cells")
    acc = read(os.path.join(wd, "acc.tif")).astype(np.float64)
    # The pour point: the post of the largest accumulation within --snap (as the app snaps it).
    px = int((a.pour[0] - gt[0]) / gt[1])
    py = int((a.pour[1] - gt[3]) / gt[5])
    r = int(round(a.snap / a.res))
    sub = acc[max(0, py - r) : py + r + 1, max(0, px - r) : px + r + 1]
    sy, sx = np.unravel_index(int(np.argmax(sub)), sub.shape)
    sy, sx = sy + max(0, py - r), sx + max(0, px - r)
    pp = np.zeros((h, w), np.int32)
    pp[sy, sx] = 1
    drv = gdal.GetDriverByName("GTiff")
    o = drv.Create(os.path.join(wd, "pp.tif"), w, h, 1, gdal.GDT_Int32)
    o.SetGeoTransform(gt)
    o.SetProjection(ds.GetProjection())
    o.GetRasterBand(1).WriteArray(pp)
    o.GetRasterBand(1).SetNoDataValue(0)
    o = None
    wbt(a.wbt, wd, "Watershed", d8_pntr="d8.tif", pour_pts="pp.tif", o="ws.tif")
    thresh = max(2, int(np.ceil(a.stream_area / (a.res * a.res))))
    wbt(a.wbt, wd, "ExtractStreams", flow_accum="acc.tif", o="streams.tif", threshold=thresh)
    wbt(a.wbt, wd, "StrahlerStreamOrder", d8_pntr="d8.tif", streams="streams.tif", o="strahler.tif")
    wbt(a.wbt, wd, "ShreveStreamMagnitude", d8_pntr="d8.tif", streams="streams.tif", o="shreve.tif")
    ws = read(os.path.join(wd, "ws.tif"))
    ws = np.where(ws == 1, 1, 0).astype(np.uint8)
    strahler = read(os.path.join(wd, "strahler.tif"))
    strahler = np.where(np.isfinite(strahler) & (strahler > 0) & (strahler < 255), strahler, 0).astype(np.uint8)
    shreve = read(os.path.join(wd, "shreve.tif"))
    shreve = np.where(np.isfinite(shreve) & (shreve > 0) & (shreve < 1e9), shreve, 0).astype(np.uint32)
    srs = osr.SpatialReference()
    srs.ImportFromWkt(ds.GetProjection())
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(srs, wgs)
    ux, uy = gt[0] + (sx + 0.5) * gt[1], gt[3] + (sy + 0.5) * gt[5]
    lon, lat, _ = tr.TransformPoint(ux, uy)
    plon, plat, _ = tr.TransformPoint(a.pour[0], a.pour[1])
    if a.rasters:
        put(a.out, "dem.f32.gz", z, "<f4")
        # The fill as the posts it raised: u32 index, then f32 height, per post.
        fill = read(os.path.join(wd, "fill.tif")).astype(np.float32).ravel()
        k = np.nonzero(fill != z.ravel())[0].astype("<u4")
        with gzip.open(os.path.join(a.out, "fill_raised.bin.gz"), "wb", compresslevel=9) as f:
            f.write(k.tobytes() + fill[k].astype("<f4").tobytes())
        to_app = np.vectorize(lambda v: WBT_TO_APP.get(int(v), 0) if np.isfinite(v) else 0, otypes=[np.uint8])
        put(a.out, "d8.u8.gz", to_app(read(os.path.join(wd, "d8.tif"))), "u1")
        put(a.out, "d8plain.u8.gz", to_app(read(os.path.join(wd, "d8plain.tif"))), "u1")
        put(a.out, "acc.f32.gz", acc, "<f4")
        put(a.out, "dinf16.u32.gz", np.round(read(os.path.join(wd, "dinf.tif")).astype(np.float64) * 16), "<u4")
        put(a.out, "strahler.u8.gz", strahler, "u1")
        put(a.out, "shreve.u32.gz", shreve, "<u4")
        put(a.out, "watershed.u8.gz", ws, "u1")
    # Stream length: each stream post's step to the next stream post (diagonal steps √2 × res).
    ptr = read(os.path.join(wd, "d8.tif"))
    on = strahler > 0
    length = 0.0
    for code, (dy, dx) in {1: (-1, 1), 2: (0, 1), 4: (1, 1), 8: (1, 0), 16: (1, -1), 32: (0, -1), 64: (-1, -1), 128: (-1, 0)}.items():
        ys, xs = np.nonzero(on & (ptr == code))
        ny, nx = ys + dy, xs + dx
        ok = (ny >= 0) & (nx >= 0) & (ny < h) & (nx < w)
        ok[ok] = on[ny[ok], nx[ok]]
        length += ok.sum() * a.res * (np.sqrt(2) if dx and dy else 1.0)
    # A sample of the oracle's stream posts (about 1,000) as lat, lon, for position checks.
    sy_, sx_ = np.nonzero(strahler > 0)
    step = max(1, len(sy_) // 1000)
    sample = []
    for y, x in zip(sy_[::step], sx_[::step]):
        lo, la, _ = tr.TransformPoint(gt[0] + (x + 0.5) * gt[1], gt[3] + (y + 0.5) * gt[5])
        sample.append([round(la, 7), round(lo, 7)])
    ver = subprocess.run([a.wbt, "--version"], capture_output=True, text=True).stdout.strip().splitlines()[0]
    truth = {
        "oracle": ver,
        "source": os.path.basename(a.dem),
        "epsg": int(srs.GetAuthorityCode(None) or 0),
        "window": a.window,
        "res": a.res,
        "w": w,
        "h": h,
        "geotransform": list(gt),
        "pour": {"utm": a.pour, "lat": plat, "lon": plon, "snap_m": a.snap},
        "snapped": {"px": [int(sx), int(sy)], "utm": [ux, uy], "lat": lat, "lon": lon, "acc_cells": float(acc[sy, sx])},
        "watershed": {"cells": int(ws.sum()), "area_m2": float(ws.sum() * a.res * a.res)},
        "streams": {"threshold_cells": thresh, "area_m2": a.stream_area, "cells": int((strahler > 0).sum()), "max_strahler": int(strahler.max()), "max_shreve": int(shreve.max()), "length_m": round(float(length), 1), "sample": sample},
    }
    with open(os.path.join(a.out, "truth.json"), "w", encoding="utf-8") as f:
        json.dump(truth, f, indent=1)
    print(json.dumps(truth["watershed"]), json.dumps(truth["streams"]))


if __name__ == "__main__":
    main()
