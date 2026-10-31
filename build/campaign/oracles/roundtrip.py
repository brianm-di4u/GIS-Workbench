"""Describe files the app wrote (c53 writer round trips) with the independent readers: GDAL for rasters
(size, bands, type, EPSG, geotransform, corners, statistics), OGR for vectors (features, geometry
types, fields, SRS), laspy for point clouds (count, format, CRS). Reads a JSON list of paths on stdin,
writes {path: description} as JSON on stdout.

    TE-tools/mamba/envs/gw-te/python.exe -I build/campaign/oracles/roundtrip.py < paths.json
"""
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # our own modules only (-I drops cwd and script dir)

import common  # noqa: E402

LIDAR_EXT = ('.las', '.laz')
VECTOR_EXT = ('.geojson', '.json', '.kml', '.kmz', '.zip', '.shp', '.gpkg', '.csv', '.gpx', '.gml', '.fgb', '.parquet')


RASTER_IN_ZIP = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.ntf')


def describe(p):
    s = p.name.lower()
    if s.endswith('.zip'):
        # A chip ZIP (image + world file + .prj + record): GDAL reads the image through /vsizip/.
        import zipfile
        names = zipfile.ZipFile(p).namelist()
        img = next((n for n in names if n.lower().endswith(RASTER_IN_ZIP)), None)
        if img:
            import raster
            return {'kind': 'raster', 'member': img, **raster.describe(f'/vsizip/{p}/{img}', stats=True)}
    if s.endswith(LIDAR_EXT):
        import lidar
        return {'kind': 'lidar', **lidar.describe(p)}
    if s.endswith(VECTOR_EXT):
        import vector
        return {'kind': 'vector', **vector.describe(p)}
    import raster
    return {'kind': 'raster', **raster.describe(p, stats=True)}


def main():
    paths = json.load(sys.stdin)
    out = {}
    for x in paths:
        p = Path(x)
        try:
            out[x] = common._finite(describe(p))
        except Exception as e:  # noqa: BLE001 - every failure is reported, none stops the batch
            out[x] = {'error': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc(limit=3)}
    json.dump(out, sys.stdout, default=common._jsonable, allow_nan=False)


if __name__ == '__main__':
    main()
