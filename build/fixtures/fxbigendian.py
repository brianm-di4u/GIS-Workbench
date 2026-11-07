"""TE-060: a big-endian ("MM") tiled JPEG/YCbCr GeoTIFF whose tile tables lie beyond the first
header read, like the DigitalGlobe/Maxar tile sets in the field data (geotiff.js read them as
little-endian). Written by GDAL; the truth is GDAL's view of the same file.

Run in the oracle environment:  python -I build/fixtures/fxbigendian.py [outdir]

Outputs (fixtures/formats):
  te060_bigendian_jpeg.tif        1024 × 1024 RGB, 32 × 32 tiles (1024 tiles), JPEG Q90, YCbCr,
                                  EPSG:4326, ENDIANNESS=BIG
  te060_bigendian_jpeg.json       size, tile count and a few decoded RGB pixels (GDAL)
"""

import json
import os
import sys

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', 'fixtures', 'formats')
os.makedirs(out, exist_ok=True)
N = 1024
y, x = np.mgrid[0:N, 0:N]
rgb = [((x // 4) % 256).astype(np.uint8), ((y // 4) % 256).astype(np.uint8), (((x + y) // 8) % 256).astype(np.uint8)]
mem = gdal.GetDriverByName('MEM').Create('', N, N, 3, gdal.GDT_Byte)
mem.SetGeoTransform([10.0, 1e-4, 0, 20.0, 0, -1e-4])
srs = osr.SpatialReference()
srs.ImportFromEPSG(4326)
mem.SetProjection(srs.ExportToWkt())
for b in range(3):
    mem.GetRasterBand(b + 1).WriteArray(rgb[b])
path = os.path.join(out, 'te060_bigendian_jpeg.tif')
gdal.Translate(path, mem, creationOptions=['TILED=YES', 'BLOCKXSIZE=32', 'BLOCKYSIZE=32', 'COMPRESS=JPEG', 'JPEG_QUALITY=90', 'PHOTOMETRIC=YCBCR', 'ENDIANNESS=BIG'])
ds = gdal.Open(path)
with open(path, 'rb') as f:
    assert f.read(2) == b'MM', 'not big-endian'
px = {f'{c},{r}': [int(ds.GetRasterBand(b + 1).ReadAsArray(c, r, 1, 1)[0, 0]) for b in range(3)] for c, r in [(5, 5), (500, 300), (1000, 1000)]}
json.dump({'width': ds.RasterXSize, 'height': ds.RasterYSize, 'tiles': (N // 32) ** 2, 'pixels': px, 'gdal': gdal.__version__}, open(os.path.join(out, 'te060_bigendian_jpeg.json'), 'w'), indent=1)
print(path, os.path.getsize(path), 'bytes')
