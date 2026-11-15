"""Oracle for the folder-to-cog library recipe (SDP-2.8 §4.5): GDAL converts each fixture raster to
a COG, and this records what CI compares against, in tests/oracles/folder-to-cog/<stem>.json.

  python -I tests/tools/oracles/folder_to_cog.py            write the oracle outputs and provenance
  python -I tests/tools/oracles/folder_to_cog.py --check D  also validate the app's COGs in folder D
                                                             (as gwb-run writes them) and say so

Per raster: size, bands, sample type, geotransform, EPSG code, no-data, the SHA-256 of each band's
full-resolution samples (little-endian, row-major from the north-west corner), the overview sizes,
and whether GDAL's COG validator accepts GDAL's own file. Run offline; CI never runs GDAL.
"""
import hashlib
import json
import os
import sys
import tempfile
from datetime import date

from osgeo import gdal, osr
from osgeo_utils.samples.validate_cloud_optimized_geotiff import validate

gdal.UseExceptions()
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..'))
CASE = os.path.join(ROOT, 'tests', 'oracles', 'folder-to-cog')
# The same layout the app writes (features/convert.js): 512-pixel tiles, DEFLATE, overviews.
CREATE = ['-of', 'COG', '-co', 'BLOCKSIZE=512', '-co', 'COMPRESS=DEFLATE', '-co', 'OVERVIEWS=AUTO']


def describe(path):
    ds = gdal.Open(path)
    srs = ds.GetSpatialRef()
    epsg = None
    if srs is not None:
        srs.AutoIdentifyEPSG()
        epsg = int(srs.GetAuthorityCode(None)) if srs.GetAuthorityCode(None) else None
    bands = []
    for i in range(1, ds.RasterCount + 1):
        b = ds.GetRasterBand(i)
        a = b.ReadAsArray()
        bands.append({
            'type': gdal.GetDataTypeName(b.DataType),
            'nodata': b.GetNoDataValue(),
            'sha256': hashlib.sha256(a.astype(a.dtype.newbyteorder('<')).tobytes()).hexdigest(),
        })
    b1 = ds.GetRasterBand(1)
    overviews = [[b1.GetOverview(k).XSize, b1.GetOverview(k).YSize] for k in range(b1.GetOverviewCount())]
    return {'width': ds.RasterXSize, 'height': ds.RasterYSize, 'geotransform': list(ds.GetGeoTransform()), 'epsg': epsg, 'bands': bands, 'overviews': overviews}


def main():
    case = json.load(open(os.path.join(CASE, 'case.json')))
    inputs = [p for p in case['inputs']['s1']]
    tmp = tempfile.mkdtemp(prefix='gw-oracle-cog-')
    for rel in inputs:
        src = os.path.join(ROOT, rel)
        stem = os.path.splitext(os.path.basename(rel))[0]
        out = os.path.join(tmp, f'{stem}_cog.tif')
        gdal.Translate(out, src, options=gdal.TranslateOptions(format='COG', creationOptions=[c for c in CREATE if '=' in c]))
        warnings, errors, _ = validate(out, full_check=True)
        d = describe(out)
        d['gdal_cog_valid'] = not errors
        json.dump(d, open(os.path.join(CASE, f'{stem}.json'), 'w'), indent=1)
        print(stem, 'valid' if not errors else errors)
    prov = {
        'recipe': 'folder-to-cog',
        'oracle': f'GDAL {gdal.__version__} (COG driver), validate_cloud_optimized_geotiff.py',
        'command': 'gdal_translate ' + ' '.join(CREATE) + ' <input> <stem>_cog.tif',
        'script': 'tests/tools/oracles/folder_to_cog.py',
        'inputs': inputs,
        'date': date.today().isoformat(),
    }
    json.dump(prov, open(os.path.join(CASE, 'provenance.json'), 'w'), indent=1)
    if '--check' in sys.argv:
        d = sys.argv[sys.argv.index('--check') + 1]
        for name in sorted(os.listdir(d)):
            if name.endswith('_cog.tif'):
                w, e, _ = validate(os.path.join(d, name), full_check=True)
                print('app', name, 'valid COG' if not e else e, w or '')


if __name__ == '__main__':
    main()
