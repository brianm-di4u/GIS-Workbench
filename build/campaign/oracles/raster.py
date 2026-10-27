"""Raster truth from GDAL: size, bands, data type, CRS, corners, RPC, NITF header fields and TREs,
band statistics. Feeds c01-ingest metadata comparison and c03/c05/c09 checks."""
import os

from osgeo import gdal, osr

gdal.UseExceptions()
gdal.SetConfigOption('GDAL_PAM_ENABLED', 'NO')  # never write .aux.xml into a data folder
gdal.SetConfigOption('CPL_VSIL_GZIP_WRITE_PROPERTIES', 'NO')  # nor /vsigzip/ .properties index caches

RASTER_EXT = {'.ntf', '.nitf', '.nsf', '.r0', '.tif', '.tiff', '.jp2', '.j2k', '.dt0', '.dt1', '.dt2', '.hgt', '.gz',
              '.jpg', '.png', '.img', '.hdr', '.pdf', '.gpkg', '.toc', '.jn1', '.nc', '.h5', '.he5'}


def corners(ds, native=False, srs=None):
    """Corner and centre latitude/longitude: on WGS 84, or (native) on the CRS's own geographic
    datum with no datum transformation, for datums the app equates with WGS 84 (NAD83: IMP-12)."""
    gt = ds.GetGeoTransform(can_return_null=True)
    srs = srs or ds.GetSpatialRef()
    if not gt or not srs:
        return None
    w, h = ds.RasterXSize, ds.RasterYSize
    wgs = osr.SpatialReference()
    if native:
        wgs = srs.CloneGeogCS()
    else:
        wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(srs, wgs)
    out = {}
    for name, (px, py) in {'ul': (0, 0), 'ur': (w, 0), 'lr': (w, h), 'll': (0, h), 'c': (w / 2, h / 2)}.items():
        x = gt[0] + px * gt[1] + py * gt[2]
        y = gt[3] + px * gt[4] + py * gt[5]
        lon, lat, _ = tr.TransformPoint(x, y)
        out[name] = [lat, lon]
    return out


def ichipb(ds):
    """ICHIPB TRE → (chip→full, full→chip) affine functions on corner-origin pixel coordinates,
    or None. Field layout per STDI-0002 (OP_* chip corners, FI_* full-image corners)."""
    raw = (ds.GetMetadata('TRE') or {}).get('ICHIPB')
    if not raw or len(raw) < 224:
        return None
    import numpy as np
    o = 2 + 10 + 2 + 2
    vals = []
    for _ in range(16):
        vals.append(float(raw[o:o + 12]))
        o += 12
    op = np.array(vals[:8]).reshape(4, 2)  # (row, col)
    fi = np.array(vals[8:]).reshape(4, 2)
    A = np.c_[op[:, 1], op[:, 0], np.ones(4)]
    cx, *_ = np.linalg.lstsq(A, fi[:, 1], rcond=None)
    cy, *_ = np.linalg.lstsq(A, fi[:, 0], rcond=None)
    M = np.array([[cx[0], cx[1], cx[2]], [cy[0], cy[1], cy[2]], [0, 0, 1]])
    Mi = np.linalg.inv(M)
    fwd = lambda x, y: tuple((M @ [x, y, 1])[:2])  # noqa: E731
    inv = lambda x, y: tuple((Mi @ [x, y, 1])[:2])  # noqa: E731
    return fwd, inv


def describe(path, stats=True):
    p = str(path)
    if p.lower().endswith('.hdr'):  # ENVI: GDAL opens the data file next to the header
        p = p[:-4]
    if p.endswith('.gz') and not p.endswith('.tar.gz'):
        p = '/vsigzip/' + p
    ds = gdal.Open(p)
    srs = ds.GetSpatialRef()
    # GDAL reads a PNG/JPEG world file but not the .prj beside it; take the CRS from it, as the app does.
    prj = os.path.splitext(str(path))[0] + '.prj'
    if srs is None and ds.GetGeoTransform(can_return_null=True) and os.path.exists(prj):
        srs = osr.SpatialReference()
        srs.SetFromUserInput(open(prj, encoding='utf-8', errors='replace').read())
    md = {dom: ds.GetMetadata(dom) for dom in (ds.GetMetadataDomainList() or []) if dom not in ('xml:TRE', 'xml:DES', 'DERIVED_SUBDATASETS')}
    out = {
        'driver': ds.GetDriver().ShortName,
        'width': ds.RasterXSize, 'height': ds.RasterYSize, 'bands': ds.RasterCount,
        'dtype': gdal.GetDataTypeName(ds.GetRasterBand(1).DataType) if ds.RasterCount else None,
        'epsg': srs.GetAuthorityCode(None) if srs else None,
        'wkt': srs.ExportToWkt() if srs else None,
        'geotransform': ds.GetGeoTransform(can_return_null=True),
        'corners': corners(ds, srs=srs),
        'cornersNative': corners(ds, native=True, srs=srs) if srs and any(t in (srs.GetAttrValue('DATUM') or '').upper().replace('_', '') for t in ('NAD83', 'NORTHAMERICANDATUM1983')) else None,
        'gcps': len(ds.GetGCPs() or []),
        'rpc': ds.GetMetadata('RPC') or None,
        'subdatasets': len(ds.GetSubDatasets() or []),
        'overviews': ds.GetRasterBand(1).GetOverviewCount() if ds.RasterCount else 0,
        'metadata': {k: v for k, v in md.items() if k in ('', 'IMAGE_STRUCTURE', 'TRE', 'NITF_METADATA', 'IMD')},
        'nodata': [ds.GetRasterBand(i + 1).GetNoDataValue() for i in range(ds.RasterCount)],
        # The app expands palettes to RGB and complex SAR to derived bands, so band counts differ by design.
        'palette': bool(ds.RasterCount and ds.GetRasterBand(1).GetColorTable()),
        'complex': bool(ds.RasterCount and gdal.DataTypeIsComplex(ds.GetRasterBand(1).DataType)),
    }
    # Phase 3: ground positions of a 3×3 pixel grid through GDAL's RPC transformer at three
    # heights (HEIGHT_OFF and ± half HEIGHT_SCALE), for the app's RPC model to reproduce.
    if out['rpc']:
        try:
            r = out['rpc']
            h0 = float(r.get('HEIGHT_OFF', 0))
            hs = float(r.get('HEIGHT_SCALE', 0))
            # GDAL evaluates NITF RPCs in the chip's own pixel space and ignores ICHIPB; apply the
            # chip → full-image affine here (TE campaign, Phase 3).
            chip = ichipb(ds)
            grid = []
            for h in (h0, h0 - hs / 2, h0 + hs / 2):
                tr = gdal.Transformer(ds, None, ['METHOD=RPC', f'RPC_HEIGHT={h}'])
                for fy in (0.1, 0.5, 0.9):
                    for fx in (0.1, 0.5, 0.9):
                        px, py = fx * ds.RasterXSize, fy * ds.RasterYSize
                        fpx, fpy = chip[0](px, py) if chip else (px, py)
                        ok, (lon, lat, _) = tr.TransformPoint(0, fpx, fpy, 0)
                        if not ok:
                            continue
                        # Exact pair: ground → image is the RPC's own (non-iterative) direction.
                        # GDAL adds RPC_HEIGHT to z, so z stays 0 (TE harness H-03).
                        ok2, (ix, iy, _) = tr.TransformPoint(1, lon, lat, 0)
                        if ok2:
                            cx, cy = chip[1](ix, iy) if chip else (ix, iy)
                            grid.append({'x': cx, 'y': cy, 'h': h, 'lat': lat, 'lon': lon})
            out['rpcGrid'] = grid
            out['ichipb'] = bool(chip)
        except Exception as e:  # noqa: BLE001
            out['rpcGrid'] = {'error': str(e)}
    if ds.GetDriver().ShortName == 'NITF':
        base = ds.GetMetadata('')
        out['nitf'] = {k: base.get(k) for k in ('NITF_FHDR', 'NITF_IC', 'NITF_IMODE', 'NITF_NBPP', 'NITF_ABPP', 'NITF_PVTYPE', 'NITF_IREP',
                                                 'NITF_ICAT', 'NITF_ICORDS', 'NITF_IGEOLO', 'NITF_FSCLAS', 'NITF_ISCLAS', 'NITF_IID1', 'NITF_IID2')}
        out['tres'] = sorted(ds.GetMetadata('TRE').keys())
    if stats and ds.RasterCount and ds.RasterXSize * ds.RasterYSize <= 64e6:
        out['stats'] = []
        for i in range(min(ds.RasterCount, 16)):
            b = ds.GetRasterBand(i + 1)
            try:
                mn, mx, mean, sd = b.ComputeStatistics(False)
                out['stats'].append({'min': mn, 'max': mx, 'mean': mean, 'std': sd})
            except RuntimeError as e:
                out['stats'].append({'error': str(e)})
    return out
