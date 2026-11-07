"""FX-21 raster group, HFA part (SDP-2.1 §4 P9): synthetic ERDAS Imagine files written by GDAL's HFA
driver — every pixel type GDAL writes (u1/u2/u4 through NBITS, u8, s8, u16, s16, u32, s32, f32,
f64, c64, c128), RLE (COMPRESSED=YES), an .ige spill file (USE_SPILL=YES), internal overviews, .rrd overviews
(HFA_USE_RRD), several bands, no-data, and CRSs the reader maps (UTM WGS 84, NAD83 State Plane LCC
in feet, LAEA ETRS89, geographic WGS 84). Invoked by raster.mjs:

    python -I raster_hfa.py <outdir>

Prints a JSON list of {file, sidecars, w, h, bands, type, epsg, checksum} as GDAL reads each file back.
"""
import json
import os
import sys

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
gdal.SetConfigOption('GDAL_PAM_ENABLED', 'NO')


def pattern(w, h, k, lo, hi, dtype):
    """Deterministic content: gradients, a checker and runs (RLE-friendly), within [lo, hi]."""
    if np.issubdtype(np.dtype(dtype), np.complexfloating):
        part = np.float32 if np.dtype(dtype) == np.complex64 else np.float64
        return (pattern(w, h, k, lo, hi, part) + 1j * pattern(w, h, k + 5, lo, hi, part)).astype(dtype)
    y, x = np.mgrid[0:h, 0:w]
    v = (x * 7 + y * 3 + k * 11) % 97 + ((x // 9 + y // 5) % 2) * 40 + np.where((y % 23) < 6, 0, x // 17)
    v = lo + (v.astype(np.float64) % (hi - lo + 1))
    if np.issubdtype(np.dtype(dtype), np.floating):
        v = v + (x % 4) * 0.25 - 0.5
    return v.astype(dtype)


def srs(code):
    s = osr.SpatialReference()
    s.ImportFromEPSG(code)
    return s.ExportToWkt()


def make(out, name, w, h, nb, gtype, dtype, lo, hi, epsg=32611, gt=None, opts=(), nbits=None, nodata=None, ovr=None, rrd=False):
    path = os.path.join(out, name)
    for ext in ('.img', '.ige', '.rrd', '.rde'):
        p = path[:-4] + ext
        if os.path.exists(p):
            os.remove(p)
    co = list(opts) + ([f'NBITS={nbits}'] if nbits else [])
    ds = gdal.GetDriverByName('HFA').Create(path, w, h, nb, gtype, co)
    if gt is None:
        gt = (440720.0, 30.0, 0.0, 3751320.0, 0.0, -30.0) if epsg != 4326 else (-105.5, 0.001, 0.0, 39.6, 0.0, -0.001)
    ds.SetGeoTransform(gt)
    if epsg:
        ds.SetProjection(srs(epsg))
    for k in range(nb):
        b = ds.GetRasterBand(k + 1)
        a = pattern(w, h, k, lo, hi, dtype)
        if nodata is not None:
            a[0:3, 0:5] = nodata
            b.SetNoDataValue(nodata)
        b.WriteArray(a)
    ds.FlushCache()
    if ovr:
        if rrd:
            gdal.SetConfigOption('HFA_USE_RRD', 'YES')
        ds.BuildOverviews('NEAREST', ovr)
        gdal.SetConfigOption('HFA_USE_RRD', None)
    ds = None
    ds = gdal.Open(path)
    side = [os.path.basename(path[:-4] + e) for e in ('.ige', '.rrd') if os.path.exists(path[:-4] + e)]
    s = ds.GetSpatialRef()
    return {'file': name, 'sidecars': side, 'w': ds.RasterXSize, 'h': ds.RasterYSize, 'bands': ds.RasterCount,
            'type': gdal.GetDataTypeName(ds.GetRasterBand(1).DataType), 'epsg': s.GetAuthorityCode(None) if s else None,
            'overviews': ds.GetRasterBand(1).GetOverviewCount(), 'checksum': [ds.GetRasterBand(i + 1).Checksum() for i in range(ds.RasterCount)]}


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    B, U16, I16, U32, I32, F32, F64 = gdal.GDT_Byte, gdal.GDT_UInt16, gdal.GDT_Int16, gdal.GDT_UInt32, gdal.GDT_Int32, gdal.GDT_Float32, gdal.GDT_Float64
    I8 = getattr(gdal, 'GDT_Int8', None)
    res = [
        make(out, 'hfa_u8.img', 200, 150, 1, B, np.uint8, 0, 255),
        make(out, 'hfa_u8_rle.img', 200, 150, 1, B, np.uint8, 0, 255, opts=['COMPRESSED=YES']),
        make(out, 'hfa_u1_rle.img', 130, 70, 1, B, np.uint8, 0, 1, nbits=1, opts=['COMPRESSED=YES']),
        make(out, 'hfa_u2.img', 130, 70, 1, B, np.uint8, 0, 3, nbits=2),
        make(out, 'hfa_u4_rle.img', 130, 70, 1, B, np.uint8, 0, 15, nbits=4, opts=['COMPRESSED=YES']),
        make(out, 'hfa_u16_rle.img', 300, 200, 1, U16, np.uint16, 1000, 61000, opts=['COMPRESSED=YES'], nodata=0),
        make(out, 'hfa_s16.img', 300, 200, 1, I16, np.int16, -3000, 3000, epsg=2229, gt=(6500000.0, 100.0, 0.0, 1900000.0, 0.0, -100.0), nodata=-32768),
        make(out, 'hfa_u32.img', 100, 80, 1, U32, np.uint32, 0, 2000000),
        make(out, 'hfa_s32_rle.img', 100, 80, 1, I32, np.int32, -100000, 100000, opts=['COMPRESSED=YES']),
        make(out, 'hfa_f32_rle.img', 257, 129, 1, F32, np.float32, -50, 4000, epsg=3035, gt=(4321000.0, 25.0, 0.0, 3210000.0, 0.0, -25.0), opts=['COMPRESSED=YES'], nodata=-9999.0),
        make(out, 'hfa_f64.img', 90, 60, 1, F64, np.float64, -1e6, 1e6, epsg=4326),
        make(out, 'hfa_rgb.img', 160, 120, 3, B, np.uint8, 0, 255, epsg=32610),
        make(out, 'hfa_spill.img', 300, 220, 2, U16, np.uint16, 0, 4000, opts=['USE_SPILL=YES']),
        make(out, 'hfa_ovr.img', 600, 400, 1, B, np.uint8, 0, 255, ovr=[2, 4, 8]),
        make(out, 'hfa_ovr_rrd.img', 600, 400, 1, I16, np.int16, -500, 500, ovr=[2, 4], rrd=True),
        make(out, 'hfa_c64.img', 300, 200, 1, gdal.GDT_CFloat32, np.complex64, -2000, 2000, ovr=[2, 4]),
        make(out, 'hfa_c128.img', 90, 60, 2, gdal.GDT_CFloat64, np.complex128, -1e6, 1e6),
    ]
    if I8 is not None:
        res.append(make(out, 'hfa_s8.img', 64, 40, 1, I8, np.int8, -100, 100))
    json.dump(res, sys.stdout, indent=1)


if __name__ == '__main__':
    main()
