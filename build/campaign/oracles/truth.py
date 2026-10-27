"""Generate oracle truth for every corpus item on disk → TE-corpus/_truth/<id>.json, plus the
geodesy set → TE-corpus/_truth/_geodesy.json. Independent references only (GDAL, sarpy, laspy,
OGR, ffprobe/klvdata, pyproj, GeographicLib).

    ../TE-tools/micromamba.exe run -n gw-te python -I build/campaign/oracles/truth.py [--only id,id] [--area sar,dem]
"""
import argparse
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # our own modules only (-I drops cwd and script dir)

import common  # noqa: E402

AREA_KIND = {
    'nitf': 'raster', 'eo': 'raster', 'landsat': 'raster', 'sentinel2': 'raster', 'naip': 'raster', 'dem': 'raster', 'hsi': 'raster',
    'raster': 'raster', 'geopdf': 'raster', 'sar': 'sar', 'lidar': 'lidar', 'vector': 'vector', 'fmv': 'fmv',
}
VECTOR_EXT = ('.geojson', '.json', '.kml', '.kmz', '.zip', '.shp', '.gpkg', '.csv', '.gpx')
LIDAR_EXT = ('.las', '.laz')
FMV_EXT = ('.ts', '.mpg', '.mpeg', '.m2ts', '.mts', '.mp4')


def kind_for(item, path):
    s = path.name.lower()
    if s.endswith(LIDAR_EXT):
        return 'lidar'
    if s.endswith(FMV_EXT):
        return 'fmv'
    if s.endswith('.cphd'):
        return 'cphd'
    if item['area'] == 'sar' and s.endswith(('.nitf', '.ntf')):
        return 'sar'
    if s.endswith(('.tif', '.tiff')):
        return 'raster'
    if item['area'] == 'hsi' and s.endswith('.zip'):
        return None  # spectral-library archives: input to msi.library, no oracle beyond the file itself
    if item['area'] == '3d':
        return None  # glTF / 3D Tiles / CityJSON: checked by re-import in c06, no GDAL oracle
    if item['area'] == 'vector' or (s.endswith(VECTOR_EXT) and item['area'] != 'raster'):
        return 'vector'
    return AREA_KIND.get(item['area'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only')
    ap.add_argument('--area')
    a = ap.parse_args()
    only = set(a.only.split(',')) if a.only else None
    areas = set(a.area.split(',')) if a.area else None
    import raster, sar, lidar, vector, fmv, geodesy  # noqa: E401
    mods = {'raster': raster, 'sar': sar, 'cphd': sar.Cphd, 'lidar': lidar, 'vector': vector, 'fmv': fmv}
    done, failed, centres = 0, [], []
    for item in common.manifest()['items']:
        if (only and item['id'] not in only) or (areas and item['area'] not in areas):
            continue
        per_file = {}
        for p in common.files(item):
            k = kind_for(item, p)
            if not k:
                continue
            try:
                try:
                    per_file[p.name] = {'kind': k, **mods[k].describe(p)}
                except Exception:
                    if not p.name.lower().endswith('.gpkg'):
                        raise
                    per_file[p.name] = {'kind': 'raster', **raster.describe(p)}  # tile/coverage GeoPackage
                if k == 'sar':  # SAR files also get GDAL's view of the NITF wrapper
                    try:
                        per_file[p.name]['gdal'] = raster.describe(p, stats=False)
                    except Exception as e:  # noqa: BLE001
                        per_file[p.name]['gdal'] = {'error': str(e)}
                c = per_file[p.name].get('corners', {}) or {}
                if 'c' in c:
                    centres.append(tuple(c['c']))
            except Exception as e:  # noqa: BLE001 - a file the oracle cannot read is itself a finding to compare
                per_file[p.name] = {'kind': k, 'error': f'{type(e).__name__}: {e}'}
                failed.append(f"{item['id']}/{p.name}")
                common.log(traceback.format_exc(limit=1))
        if per_file:
            common.write_truth(item['id'], 'files', per_file)
            done += 1
    if not only and not areas:
        (common.TRUTH).mkdir(parents=True, exist_ok=True)
        (common.TRUTH / '_geodesy.json').write_text(json.dumps(geodesy.build([c for c in centres if abs(c[0]) <= 90])), encoding='utf-8')
    print(json.dumps({'items': done, 'oracleErrors': failed, 'truth': str(common.TRUTH)}, indent=1))


if __name__ == '__main__':
    main()
