"""Format census of the T&E corpus: classify every primary/sidecar file of build/campaign/corpus.json
into format and variant keys (build/campaign/formats.json) by reading headers with GDAL, ffprobe and
plain byte sniffing → reports/campaign/format-census.json. coverage.mjs counts samples per key from it.
Headers only: nothing is decoded or executed. Results are cached by path, size and mtime.

    ../TE-tools/micromamba.exe run -n gw-te python -I build/campaign/census.py [--only id,id] [--fresh]
"""
import argparse
import json
import os
import re
import sqlite3
import struct
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from osgeo import gdal

gdal.UseExceptions()
gdal.SetConfigOption('GDAL_PAM_ENABLED', 'NO')  # never write .aux.xml next to corpus files

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MANIFEST = HERE / 'corpus.json'
OUT = REPO / 'reports' / 'campaign' / 'format-census.json'
CORPUS = Path(os.environ.get('TE_CORPUS', REPO.parent / 'TE-corpus')).resolve()
SAMPLES = (REPO.parent / 'Research' / 'samples').resolve()
FIELD = Path(os.environ.get('TE_FIELD', REPO.parent / 'Research' / 'Additional Data Samples')).resolve()
FFPROBE = os.environ.get('FFPROBE', 'ffprobe')

WORLD = {'.jpg': ('.jgw', '.jpgw', '.wld'), '.jpeg': ('.jgw', '.wld'), '.png': ('.pgw', '.pngw', '.wld'), '.gif': ('.gfw', '.gifw', '.wld'),
         '.bmp': ('.bpw', '.bmpw', '.wld'), '.webp': ('.wld', '.webpw'), '.jp2': ('.j2w', '.wld'), '.tif': ('.tfw', '.tifw', '.wld')}
RPF_EXT = re.compile(r'\.(on\d|gn\d|jn\d|tp\d|lf\d|tl\d|jg\d|i[1-5][0-9a-j]|ovr)$', re.I)
CIB_EXT = re.compile(r'\.i[1-5][0-9a-j]$', re.I)
GEOJP2_UUID = bytes.fromhex('b14bf8bd083d4b43a5ae8cd7d5a6ce03')
LAS_PDRF_MASK = 0x3F


def item_dir(it):
    if it.get('origin') == 'research-samples':
        return SAMPLES / it['dir']
    if it.get('origin') == 'field-data':
        return FIELD / it['dir']
    return CORPUS / it['id']


def head(p, n=4096):
    with open(p, 'rb') as f:
        return f.read(n)


def scan(p, needles, limit=256 << 20):
    """Which byte strings occur in the first `limit` bytes (chunked, overlapping)."""
    found, tail = set(), b''
    with open(p, 'rb') as f:
        read = 0
        while read < limit and len(found) < len(needles):
            b = f.read(8 << 20)
            if not b:
                break
            buf = tail + b
            for n in needles:
                if n not in found and n in buf:
                    found.add(n)
            tail, read = buf[-64:], read + len(b)
    return found


def tiff_compression(p, h):
    """Compression tag (259) of IFD0 of a classic TIFF, read without GDAL; None if not found."""
    bo = '<' if h[:2] == b'II' else '>'
    if h[2:4] not in (b'*\x00', b'\x00*'):
        return None
    with open(p, 'rb') as f:
        f.seek(struct.unpack(bo + 'I', h[4:8])[0])
        n = struct.unpack(bo + 'H', f.read(2))[0]
        for _ in range(min(n, 512)):
            tag, typ, _cnt, val = struct.unpack(bo + 'HHI4s', f.read(12))
            if tag == 259:
                return struct.unpack(bo + 'H', val[:2])[0] if typ == 3 else struct.unpack(bo + 'I', val)[0]
    return None


def tiff_keys(p, h):
    k = ['gtiff']
    if h[2:4] in (b'\x2b\x00', b'\x00\x2b'):
        k.append('gtiff.bigtiff')
    if h[:2] == b'MM':
        k.append('gtiff.bigendian')
    try:
        raw = tiff_compression(p, h)
    except (OSError, struct.error):
        raw = None
    try:
        return tiff_gdal_keys(p, list(k))
    except RuntimeError:
        # Old-style JPEG negatives can make GDAL throw; the header still says what they are.
        return k + ['gtiff.unreadable'] + (['gtiff.codec.ojpeg'] if raw == 6 else [])


def tiff_gdal_keys(p, k):
    ds = gdal.Open(str(p))
    st = ds.GetMetadata('IMAGE_STRUCTURE') or {}
    if st.get('LAYOUT') == 'COG':
        k.append('gtiff.cog')
    c = st.get('COMPRESSION', 'NONE').lower()
    c = 'jpeg' if 'jpeg' in c and c != 'ojpeg' else c  # 'YCbCr JPEG' is TIFF compression 7
    k.append(f'gtiff.codec.{c}')
    if ds.RasterCount:
        b = ds.GetRasterBand(1)
        dt = gdal.GetDataTypeName(b.DataType).lower()
        if dt.startswith('c'):
            k.append(f'gtiff.complex.{dt}')
        k.append('gtiff.tiled' if b.GetBlockSize()[1] > 1 and b.GetBlockSize()[0] < ds.RasterXSize else 'gtiff.striped')
        if b.GetOverviewCount():
            k.append('gtiff.overviews')
    if ds.RasterCount >= 30:
        k.append('raster.cube')
    if ds.GetMetadata('RPC'):
        k.append('rpc.gtiff')
    if ds.GetGCPCount():
        k.append('georef.gcps')
    if not ds.GetProjection() and not ds.GetGCPCount() and not ds.GetMetadata('RPC'):
        k.append('georef.none')
    return k


def nitf11_codecs(p):
    """IC of each image segment of a NITF 1.1 file, read from the headers without GDAL."""
    with open(p, 'rb') as f:
        b = f.read(1 << 20)
        o = 9 + 2 + 4 + 10 + 14 + 80 + 1 + 40 + 40 + 40 + 20 + 20
        o += 6 + (40 if b[o:o + 6] == b'999998' else 0)  # FSDWNG (+ FSDEVT)
        o += 5 + 5 + 1 + 27 + 18 + 12
        hl, numi = int(b[o:o + 6]), int(b[o + 6:o + 9])
        o += 9
        out, pos = [], hl
        for i in range(numi):
            lish, li = int(b[o + 16 * i:o + 16 * i + 6]), int(b[o + 16 * i + 6:o + 16 * i + 16])
            f.seek(pos)
            s = f.read(lish)
            pos += lish + li
            if s[:2] != b'IM':
                continue
            q = 2 + 10 + 14 + 17 + 80 + 1 + 40 + 40 + 40 + 20 + 20
            q += 6 + (40 if s[q:q + 6] == b'999998' else 0)  # ISDWNG (+ ISDEVT)
            q += 1 + 42 + 8 + 8 + 3 + 8 + 8 + 2 + 1
            q += 1 + (60 if s[q:q + 1] not in (b'N', b' ') else 0)  # ICORDS (+ IGEOLO)
            q += 1 + 80 * int(s[q:q + 1])  # NICOM + ICOMn
            out.append(s[q:q + 2].decode('ascii'))
    return out


def nitf_keys(p, h):
    v = h[:9]
    ver = {b'NITF01.10': 'nitf.v11', b'NITF02.00': 'nitf.v20', b'NITF02.10': 'nitf.v21', b'NSIF01.00': 'nsif.v10'}.get(v, 'nitf.unknown')
    k = ['nitf', ver]
    if ver == 'nitf.v11':
        # The app refuses 1.1 and GDAL misreads its headers (and can hang in the TRE parser), so parse them here.
        # Only compressed IC values are recorded: they are refused-codec negatives (U_0001a.ntf is ARIDPCM, C2).
        try:
            return k + sorted({f'nitf.ic.{ic.lower()}' for ic in nitf11_codecs(p) if ic not in ('NC', 'NM')})
        except (ValueError, IndexError):
            return k + ['nitf.unreadable']
    if ver == 'nitf.unknown':
        return k
    if RPF_EXT.search(p.name):
        k.append('rpf.frame')
    if CIB_EXT.search(p.name):
        k.append('rpf.cib')
    try:
        ds = gdal.Open(str(p))
    except RuntimeError:
        return k + ['nitf.unreadable']
    subs = ds.GetSubDatasets() or []
    if len(subs) > 1:
        k.append('nitf.multiimage')
    dss = [ds] + [gdal.Open(s[0]) for s in subs[1:16]]
    for d in dss:
        md = d.GetMetadata() or {}
        ic = md.get('NITF_IC')
        if ic:
            k.append(f'nitf.ic.{ic.lower()}')
        if md.get('NITF_IMODE'):
            k.append(f'nitf.imode.{md["NITF_IMODE"].lower()}')
        for name in (d.GetMetadata('TRE') or {}):
            k.append(f'tre.{name.upper()}')
        if d.GetMetadata('RPC'):
            k.append('rpc.nitf')
    for x in ds.GetMetadata('xml:DES') or []:
        # The root xmlns is the version; the DES subheader's specification URN can name an older one (Sandia FARAD: 1.1.0 vs 1.2.1).
        m = re.search(r'<(?:\w+:)?(?:SICD|SIDD)\b[^>]*xmlns(?::\w+)?="urn:(SICD|SIDD):(\d+(?:\.\d+)*)"', x) or re.search(r'urn:(SICD|SIDD):(\d+(?:\.\d+)*)', x)
        if m:
            k += [f'sar.{m.group(1).lower()}', f'sar.{m.group(1).lower()}.v{m.group(2)}']
            if m.group(1) == 'SICD' and len(re.findall(r'<(?:\w+:)?ChanParameters', x)) >= 4:
                k.append('sar.sicd.quadpol')
    for name in list(k):
        if name == 'tre.MTIMSA':
            k.append('nitf.mie4nitf')
        if name in ('tre.RSMIDA', 'tre.RSMPCA', 'tre.RSMGGA'):
            k.append('sensor.rsm')
    return k


def jp2_keys(p, h):
    k = ['jp2']
    found = scan(p, [GEOJP2_UUID, b'gml.root-instance'], limit=4 << 20)
    if GEOJP2_UUID in found:
        k.append('jp2.geojp2')
    if b'gml.root-instance' in found:
        k.append('jp2.gmljp2')
    # HTJ2K: a CAP marker (FF50) in the codestream main header, after SOC+SIZ and before the first SOT.
    with open(p, 'rb') as f:
        buf = f.read(4 << 20)
    soc = buf.find(b'\xff\x4f\xff\x51')
    sot = buf.find(b'\xff\x90', soc + 4) if soc >= 0 else -1
    if soc >= 0 and b'\xff\x50' in buf[soc + 4:sot if sot > 0 else soc + 65536]:
        k.append('jp2.htj2k')
    if h[:4] == b'\xff\x4f\xff\x51':
        k.append('jp2.codestream')
    return k


def picture_keys(p):
    e = p.suffix.lower()
    k = [f'img.{e[1:].replace("jpeg", "jpg")}']
    if any(p.with_suffix(w).exists() or p.with_suffix(w.upper()).exists() for w in WORLD.get(e, ())):
        k.append(f'img.{e[1:].replace("jpeg", "jpg")}.world')
    return k


def pdf_keys(p):
    # Georeferencing dictionaries often sit in compressed object streams, so ask GDAL whether the
    # page is georeferenced and use the byte scan only to tell LGIDict from ISO 32000 encoding.
    found = scan(p, [b'/LGIDict', b'/OCProperties'], limit=96 << 20)
    k = ['pdf'] + (['pdf.layers'] if b'/OCProperties' in found else [])
    try:
        ds = gdal.Open(str(p))
        geo = bool(ds.GetProjection()) or bool(ds.GetGCPCount())
    except RuntimeError:
        geo = False
    if not geo:
        return k + ['pdf.nogeo']
    return k + ['geopdf.lgidict' if b'/LGIDict' in found else 'geopdf.iso32000']


def envi_keys(p):
    t = p.read_text(errors='replace')[:20000]
    if not t.lstrip().startswith('ENVI'):
        return []
    if re.search(r'file type\s*=\s*ENVI Spectral Library', t, re.I):
        return ['speclib.envi-sli']
    k = ['envi']
    m = re.search(r'interleave\s*=\s*(\w+)', t, re.I)
    if m:
        k.append(f'envi.{m.group(1).lower()}')
    if re.search(r'byte order\s*=\s*1', t, re.I):
        k.append('envi.bigendian')
    if re.search(r'map info', t, re.I):
        k.append('envi.mapinfo')
    if re.search(r'wavelength\s*=', t, re.I):
        k.append('envi.wavelengths')
    return k


def las_keys(p, h):
    k = ['las']
    if p.name.lower().endswith('.copc.laz') or b'copc' in h[375:600]:
        k.append('copc')
    if p.suffix.lower() == '.laz':
        k.append('laz')
    if len(h) > 105 and h[:4] == b'LASF':
        k.append(f'las.v{h[24]}{h[25]}')
        k.append(f'las.pdrf{h[104] & LAS_PDRF_MASK}')
    return k


def shp_keys(p, h):
    k = ['vec.shp']
    if len(h) >= 36:
        t = struct.unpack('<i', h[32:36])[0]
        k.append({11: 'vec.shp.z', 13: 'vec.shp.z', 15: 'vec.shp.z', 18: 'vec.shp.z', 21: 'vec.shp.m', 23: 'vec.shp.m', 25: 'vec.shp.m', 28: 'vec.shp.m', 31: 'vec.shp.multipatch'}.get(t, 'vec.shp.2d'))
    if p.with_suffix('.cpg').exists():
        k.append('vec.shp.cpg')
    return k


def zip_keys(p):
    try:
        with zipfile.ZipFile(p) as z:
            names = [n.lower() for n in z.namelist()]
    except (zipfile.BadZipFile, OSError):
        return ['zip.corrupt']
    k = ['zip']
    if any(n.endswith('.shp') for n in names):
        k += ['vec.shp', 'vec.shp.zip']
    if any(n.endswith('.gpkg') for n in names):
        k.append('vec.gpkg.zip')
    if any(re.search(r'\.(tif|ntf|nsf|jp2|dt[012]|hgt|sid)$', n) for n in names):
        k.append('zip.imagery')
    if any(n.endswith('.zip') for n in names):
        k.append('zip.nested')
    if any(re.search(r'dim_.*\.xml$', n) for n in names):
        k.append('dimap.zip')
    return k


def gpkg_keys(p):
    k = ['gpkg']
    try:
        con = sqlite3.connect(f'file:{p.as_posix()}?mode=ro&immutable=1', uri=True)
        for (dt,) in con.execute('select distinct data_type from gpkg_contents'):
            k.append({'features': 'gpkg.features', 'tiles': 'gpkg.tiles', '2d-gridded-coverage': 'gpkg.coverage'}.get(dt, f'gpkg.{dt}'))
        con.close()
    except sqlite3.Error:
        k.append('gpkg.corrupt')
    return k


def json_keys(p):
    if p.stat().st_size > 64 << 20:
        t = head(p, 1 << 16).decode('utf-8', 'replace')
    else:
        t = p.read_text(errors='replace')
    s = t.lstrip()[:4000]
    if '"CityJSON"' in s or re.search(r'"type"\s*:\s*"CityJSON"', t):  # delft.json puts type after CityObjects
        return ['cityjson']
    if '"asset"' in s and '"root"' in s or p.name == 'tileset.json':
        k = ['tiles3d.tileset']
        if '"implicitTiling"' in t:
            k.append('tiles3d.implicit')
        return k
    if p.name == 'layer.json' and ('tilejson' in s or 'quantized-mesh' in t):
        return ['qmesh.layer'] + (['qmesh.geodetic'] if 'EPSG:4326' in t else ['qmesh.mercator'])
    if p.name == 'ept.json':
        return ['ept']
    if re.search(r'"type"\s*:\s*"(FeatureCollection|Feature)"', s):
        k = ['vec.geojson'] + (['vec.geojson.jsonext'] if p.suffix.lower() == '.json' else [])
        if re.search(r'"crs"\s*:', s):
            k.append('vec.geojson.legacycrs')
        return k
    return []


def csv_keys(p):
    t = head(p, 8192).decode('utf-8', 'replace')
    hdr = t.splitlines()[0].lower() if t else ''
    cols = [c.strip(' "') for c in re.split(r'[,;\t]', hdr)]
    k = []
    if any(c in ('wkt', 'geometry', 'the_geom') for c in cols) or re.search(r'"?(POINT|POLYGON|LINESTRING|CIRCULARSTRING|COMPOUNDCURVE)\s*\(', t):
        k.append('vec.csv.wkt')
    if any(c in ('lon', 'longitude', 'x', 'long', 'lng') for c in cols) and any(c in ('lat', 'latitude', 'y') for c in cols):
        k.append('vec.csv.lonlat')
    if any(c in ('class', 'label', 'category') for c in cols) and any(c in ('confidence', 'score', 'conf') for c in cols):
        k.append('det.csv')
    if any(c in ('sensor_latitude', 'platform_latitude', 'sensorlatitude') for c in cols) or p.name.lower() == 'fmv.csv' or {'lat', 'lon', 'hae', 'heading', 'hfov'} <= set(cols):
        k.append('fmv.platformcsv')
    # Control files as triangulation.js / dem-tools.js read them: id + lat + lon + an ellipsoid or orthometric height.
    if any(c in ('id', 'name', 'point') for c in cols) and {'lat', 'lon'} <= set(cols) and any(c in ('hae', 'h', 'height', 'elev', 'z', 'msl') for c in cols):
        k.append('control.gcp')
    return k


def video_keys(p):
    k = ['fmv.video']
    try:
        r = subprocess.run([FFPROBE, '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,codec_tag_string', '-show_entries', 'format=format_name', '-of', 'json', str(p)],
                           capture_output=True, text=True, timeout=120)
        info = json.loads(r.stdout or '{}')
    except (subprocess.SubprocessError, json.JSONDecodeError, OSError):
        return k + ['fmv.probe-failed']
    fmt = info.get('format', {}).get('format_name', '')
    if 'mpegts' in fmt:
        k.append('fmv.ts')
    if 'mp4' in fmt:
        k.append('fmv.mp4')
    for s in info.get('streams', []):
        if s.get('codec_type') == 'video':
            k.append(f'fmv.codec.{s.get("codec_name")}')
        if s.get('codec_type') == 'data' and (s.get('codec_name') in ('klv', 'smpte_klv') or s.get('codec_tag_string') == 'KLVA'):
            k.append('fmv.klv')
    if 'fmv.klv' in k and has_vmti(p):
        k.append('fmv.vmti')
    return k


UAS_KEY = bytes([0x06, 0x0e, 0x2b, 0x34, 0x02, 0x0b, 0x01, 0x01, 0x0e, 0x01, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00])


def ber(b, o):
    if b[o] < 128:
        return b[o], 1
    n = b[o] & 0x7f
    return int.from_bytes(b[o + 1:o + 1 + n], 'big'), 1 + n


def has_vmti(p):
    """True when an ST 0601 packet in the first 60 s of KLV carries Item 74 (ST 0903 VMTI)."""
    ffmpeg = str(Path(FFPROBE).with_name('ffmpeg' + Path(FFPROBE).suffix))
    try:
        b = subprocess.run([ffmpeg, '-v', 'error', '-t', '60', '-i', str(p), '-map', '0:d:0', '-c', 'copy', '-f', 'data', '-'], capture_output=True, timeout=120).stdout
    except (subprocess.SubprocessError, OSError):
        return False
    o = b.find(UAS_KEY[:7])
    while 0 <= o < len(b) - 17:
        if b[o + 8:o + 16] != UAS_KEY[8:]:
            o = b.find(UAS_KEY[:7], o + 1)
            continue
        n, ll = ber(b, o + 16)
        q, end = o + 16 + ll, min(len(b), o + 16 + ll + n)
        while q < end:
            t = 0
            while q < end and b[q] & 0x80:
                t, q = t * 128 + (b[q] & 0x7f), q + 1
            if q >= end:
                break
            t, q = t * 128 + b[q], q + 1
            if t == 74:
                return True
            m, ml = ber(b, q)
            q += ml + m
        o = b.find(UAS_KEY[:7], end)
    return False


def classify(it, rel, p):
    n, e = p.name.lower(), p.suffix.lower()
    h = head(p)
    if it['id'] == 'robustness-gdal-autotest-seeds':
        # Deliberately malformed seeds (OSS-Fuzz repros, bad TRE lengths) can hang GDAL: header bytes only.
        return ['robustness.seed'] + (['nitf'] if h[:4] in (b'NITF', b'NSIF') else ['gtiff'] if h[:2] in (b'II', b'MM') else ['dted'] if e.startswith('.dt') else [])
    if n.endswith('.hgt.gz') or e == '.hgt':
        return ['hgt', f'hgt.size{p.stat().st_size}' if e == '.hgt' else 'hgt.gz']
    if h[:4] in (b'II*\x00', b'MM\x00*', b'II+\x00', b'MM\x00+'):
        return tiff_keys(p, h)
    if n == 'a.toc':  # bare or NITF-wrapped (GDAL zone9); either way a table of contents, not an image
        return ['rpf.toc']
    if h[:4] in (b'NITF', b'NSIF'):
        return nitf_keys(p, h)
    if h[:12] == b'\x00\x00\x00\x0cjP  \r\n\x87\n' or h[:4] == b'\xff\x4f\xff\x51':
        return jp2_keys(p, h)
    if h[:4] == b'msid':
        return ['refused.mrsid']
    if e == '.ecw':
        return ['refused.ecw']
    if h[:5] == b'CPHD/':
        return ['refused.cphd']
    if h[:16].startswith(b'EHFA_HEADER_TAG'):
        return ['refused.hfa']
    if h[:4] == b'\x89HDF':
        return ['hdf5'] + (['hdf5.netcdf4'] if e == '.nc' else [])
    if h[:3] == b'CDF':
        return ['refused.netcdf3']
    if h[:4] == b'LASF':
        return las_keys(p, h)
    if h[:4] == b'%PDF':
        return pdf_keys(p)
    if e in ('.dt0', '.dt1', '.dt2'):
        return ['dted', f'dted.l{e[-1]}'] + (['dted.hdr1'] if h[:4] == b'HDR1' else [])
    if e == '.dhm':
        return ['dted', 'dted.dhm']
    if e in ('.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'):
        return picture_keys(p)
    if e == '.hdr':
        return envi_keys(p)
    if re.match(r'dim_.*\.xml$', n):
        return ['dimap'] + (['dimap.v2'] if b'DIMAP_V2' in head(p, 1 << 16).upper() or b'METADATA_FORMAT VERSION="2' in head(p, 1 << 16).upper() else [])
    if e == '.rpb':
        return ['dg.rpb']
    if e == '.til':
        return ['dg.til']
    if e == '.imd':
        return ['dg.imd']
    if re.search(r'_mtl\.(txt|xml|json)$', n):
        return ['meta.landsat-mtl']
    if re.match(r'mtd_msil[12][ac]\.xml$', n):
        return ['meta.s2-mtd']
    if e == '.shp':
        return shp_keys(p, h)
    if e == '.zip':
        return zip_keys(p)
    if e == '.gpkg':
        return gpkg_keys(p)
    if e in ('.kml',):
        return ['vec.kml']
    if e == '.kmz':
        return ['vec.kmz']
    if e == '.gml':
        return ['vec.gml'] + (['vec.gml.v32'] if b'gml/3.2' in head(p, 16384) else ['vec.gml.v2'] if b'gml/2' in head(p, 16384) else [])
    if e == '.gpx':
        return ['vec.gpx']
    if n.endswith('.gwrecipe.json'):  # before the .json branch
        return ['app.recipe']
    if n.endswith('.gwt.json'):
        return ['app.template']
    if e in ('.json', '.geojson'):
        return json_keys(p)
    if e == '.csv':
        return csv_keys(p)
    if e == '.parquet':
        return ['vec.geoparquet']
    if e == '.fgb':
        return ['vec.flatgeobuf']
    if e == '.mbtiles':
        return ['refused.mbtiles']
    if e == '.pmtiles' and h[:7] == b'PMTiles':
        return ['pmtiles', {1: 'pmtiles.mvt', 2: 'pmtiles.png', 3: 'pmtiles.jpeg', 4: 'pmtiles.webp', 5: 'pmtiles.avif'}.get(h[99], 'pmtiles.unknown')]
    if e in ('.glb', '.gltf'):
        # Whole .gltf: Blender writes extensionsUsed at the end of the JSON.
        t = (head(p, 64 << 20) if e == '.gltf' else head(p, 1 << 16)).decode('utf-8', 'replace')
        k = ['gltf', f'gltf{e}']
        for ext_name, key in (('KHR_draco_mesh_compression', 'gltf.draco'), ('KHR_texture_basisu', 'gltf.ktx2'), ('EXT_meshopt_compression', 'gltf.meshopt'),
                              ('KHR_meshopt_compression', 'gltf.meshopt')):
            if ext_name in t:
                k.append(key)
        return k
    if e in ('.b3dm', '.i3dm', '.pnts', '.cmpt'):
        return [f'tiles3d.{e[1:]}']
    if e == '.subtree':
        return ['tiles3d.subtree']
    if e == '.3tz':
        return ['tiles3d.3tz']
    if e == '.terrain':
        return ['qmesh.tile']
    if e == '.bpf':
        return ['pc.bpf']
    if e in ('.xyz', '.pts'):
        return ['pc.ascii']
    if e == '.txt' and it.get('area') == 'lidar':
        # a point row needs x, y, z; per-point class truth (US3D *_CLS.txt) is one column
        with open(p, 'rb') as fh:
            row = fh.readline(4096).decode('latin-1').strip()
        return ['pc.ascii'] if len(re.split(r'[,;\t| ]+', row)) >= 3 else []
    if e in ('.ts', '.m2ts', '.mts', '.mpg', '.mpeg', '.mp4'):
        return video_keys(p)
    if e in ('.klv',) or (e == '.bin' and it.get('area') == 'fmv'):
        return ['fmv.klv.raw']
    if e in ('.gmti', '.4607'):
        return ['gmti.4607']
    if e == '.4676' or n.endswith('.4676.xml'):
        return ['tracks.4676']
    if e == '.srt':
        return ['fmv.srt']
    if e == '.gwb':
        return ['app.project']
    if e == '.gwpack':
        return ['app.pack']
    if n.endswith('.gwrecipe.json'):
        return ['app.recipe']
    if n.endswith('.gwt.json'):
        return ['app.template']
    if e in ('.pptx', '.potx'):
        return ['app.pptx-template']
    if e == '.sli':
        return ['speclib.envi-sli.data']
    if e in ('.img', '.dat', '.bsq', '.bil', '.bip', '.raw', '.pix') and (p.with_suffix('.hdr').exists() or Path(str(p) + '.hdr').exists()):
        return ['envi.data']
    if e in ('.cub',):
        return ['refused.isis']
    return []


def save(out, partial=False):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Temp file + replace, retried: a reader or scanner holding the file open made a long --fresh run die with EINVAL.
    tmp = OUT.with_suffix('.json.tmp')
    tmp.write_text(json.dumps({'version': 1, 'partial': partial, 'files': out}, indent=0), encoding='utf-8')
    for attempt in range(10):
        try:
            os.replace(tmp, OUT)
            return
        except OSError:
            if attempt == 9:
                raise
            time.sleep(1 + attempt)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--only', default='')
    ap.add_argument('--fresh', action='store_true')
    a = ap.parse_args()
    only = set(filter(None, a.only.split(',')))
    items = json.loads(MANIFEST.read_text(encoding='utf-8'))['items']
    cache = {} if a.fresh or not OUT.exists() else {f'{r["id"]}/{r["file"]}': r for r in json.loads(OUT.read_text(encoding='utf-8'))['files']}
    out = []
    for it in items:
        if it.get('service'):
            continue
        for f in it['files']:
            key = f'{it["id"]}/{f["name"]}'
            if f.get('role') == 'archive' and not f.get('extract') and not f['name'].lower().endswith('.zip'):
                continue
            p = item_dir(it).joinpath(*f['name'].split('/'))
            if not p.is_file():
                continue
            st = p.stat()
            c = cache.get(key)
            if c and c['bytes'] == st.st_size and c['mtime'] == int(st.st_mtime) and (not only or it['id'] not in only):
                out.append(c)
                continue
            t0 = time.time()
            try:
                keys = classify(it, f['name'], p)
            except Exception as ex:  # noqa: BLE001 - one bad file must not stop the census
                keys = [f'census.error:{type(ex).__name__}']
            if time.time() - t0 > 5:
                print(f'  slow {time.time() - t0:.0f}s {key}', file=sys.stderr, flush=True)
            out.append({'id': it['id'], 'file': f['name'], 'role': f.get('role'), 'bytes': st.st_size, 'mtime': int(st.st_mtime), 'keys': sorted(set(keys))})
            if len(out) % 50 == 0:
                save(out, partial=True)
    save(out)
    print(f'census: {len(out)} files, {len({k for r in out for k in r["keys"]})} distinct keys -> {OUT.relative_to(REPO)}')


if __name__ == '__main__':
    main()
