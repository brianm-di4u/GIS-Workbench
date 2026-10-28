"""Phase 3 accuracy references the first pass planned but never ran (TE-master-plan §5.2), for
tests/campaign/c22-accuracy-gaps.spec.js. Each check writes _truth/<item>.<check>.json and, where
the spec compares rasters, float32 GeoTIFFs under _truth/acc/ (Node reads them with geotiff.js).

    ../TE-tools/micromamba.exe run -n gw-te python -I build/campaign/oracles/accuracy.py [terrain toa thermal classify change ccd]

  terrain   gdaldem hillshade / slope / aspect (Horn) on the UTM 13N GLO-30 crop
  toa       numpy TOA reflectance and NDVI from the Landsat 8 MTL and the Sentinel-2 L1C MTD
  thermal   numpy brightness temperature (MTL radiance, K1/K2) on Landsat 8 B10 and B11
  classify  stratified Indian Pines split and scikit-learn reference classifiers on it
  change    (delivered pair, and a co-located 2048² crop written to _truth/acc/)
            GDAL bilinear warp of the Maxar post image onto the pre grid and the documented
            chg.detect method (Deming fit, |difference|, 3×3 mean, median + k·MAD, opening,
            8-connected blobs) re-implemented in numpy/scipy
  ccd       sarpy chips of the Umbra Bingham pair, FFT co-registration, linear (flat-earth)
            phase removal and 5×5 sample coherence in numpy
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # our own modules only (-I drops cwd and script dir)

import numpy as np  # noqa: E402
from osgeo import gdal, osr  # noqa: E402

import common  # noqa: E402

gdal.UseExceptions()
gdal.SetConfigOption('GDAL_PAM_ENABLED', 'NO')
ACC = common.TRUTH / 'acc'


def item(i):
    return next(x for x in common.manifest()['items'] if x['id'] == i)


def path(item_id, name):
    it = item(item_id)
    f = next(f for f in it['files'] if f['name'].split('/')[-1] == name)
    return common.item_dir(it).joinpath(*f['name'].split('/'))


def save(item_id, check, data):
    p = common.TRUTH / f'{item_id}.{check}.json'
    p.write_text(json.dumps(common._finite(data), indent=1, default=common._jsonable), encoding='utf-8')
    common.log(f'wrote {p}')
    return p


def write_f32(name, arr, x0=0, y0=0):
    """A window as a plain float32 GeoTIFF (no georeferencing; the window origin is in the JSON)."""
    ACC.mkdir(parents=True, exist_ok=True)
    p = ACC / name
    ds = gdal.GetDriverByName('GTiff').Create(str(p), arr.shape[1], arr.shape[0], 1, gdal.GDT_Float32, ['COMPRESS=DEFLATE'])
    ds.GetRasterBand(1).WriteArray(arr.astype(np.float32))
    ds.GetRasterBand(1).SetNoDataValue(float('nan'))
    ds = None
    return str(p.relative_to(common.TRUTH)).replace('\\', '/')


def centre_window(ds, n=512):
    w, h = ds.RasterXSize, ds.RasterYSize
    return w // 2 - n // 2, h // 2 - n // 2, n, n


# ---- 4. hillshade, slope, aspect vs gdaldem ----

def terrain():
    iid = 'derived-dem-utm13-viewshed'
    dem = path(iid, 'dem_utm13_30m.tif')
    ACC.mkdir(parents=True, exist_ok=True)
    ds = gdal.Open(str(dem))
    gt = ds.GetGeoTransform()
    w, h = ds.RasterXSize, ds.RasterYSize
    # Grid-north angle at the centre, measured as the app does (geodesic azimuth of the pixel above).
    srs = ds.GetSpatialRef()
    wgs = osr.SpatialReference()
    wgs.ImportFromEPSG(4326)
    wgs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(srs, wgs)
    from pyproj import Geod
    g = Geod(ellps='WGS84')

    def ll(px, py):
        x = gt[0] + px * gt[1] + py * gt[2]
        y = gt[3] + px * gt[4] + py * gt[5]
        return tr.TransformPoint(x, y)[:2]
    c = ll(w / 2, h / 2)
    up = ll(w / 2, h / 2 - 1)
    rot = g.inv(c[0], c[1], up[0], up[1])[0]
    outs = {}
    cmds = []
    for name, mode, opts in (
        ('hillshade', 'hillshade', ['-az', '315', '-alt', '45', '-z', '1']),
        # The app measures aspect (and so lights the surface) from true north; gdaldem from grid north.
        ('hillshade_truenorth', 'hillshade', ['-az', f'{315 - rot:.6f}', '-alt', '45', '-z', '1']),
        ('slope', 'slope', []),
        ('aspect', 'aspect', []),
    ):
        out = ACC / f'{iid}.{name}.tif'
        kw = {'azimuth': float(opts[1]), 'altitude': 45.0, 'zFactor': 1.0} if mode == 'hillshade' else {}
        gdal.DEMProcessing(str(out), str(dem), mode, alg='Horn', **kw)
        outs[name] = str(out.relative_to(common.TRUTH)).replace('\\', '/')
        cmds.append(f'gdaldem {mode} {" ".join(opts)} {dem.name} {out.name}')
    save(iid, 'terrain', {'file': dem.name, 'width': w, 'height': h, 'cell': [gt[1], -gt[5]], 'gridNorthDeg': rot, 'rasters': outs, 'commands': cmds, 'gdal': gdal.__version__})


# ---- 5. TOA reflectance and NDVI ----

def mtl_values(p):
    t = Path(p).read_text(encoding='utf-8', errors='replace')
    return {m.group(1): m.group(2).strip().strip('"') for m in re.finditer(r'^\s*(\w+)\s*=\s*(.+?)\s*$', t, re.M)}


def toa():
    out = {}
    # Landsat 8 Collection 1 L1TP: ρ' = M·DN + A, ρ = ρ' / sin(sun elevation) (USGS LSDS-1574).
    iid = 'landsat8-c1-l1tp-044034-20210508'
    stem = 'LC08_L1TP_044034_20210508_20210518_01_T1'
    mtl = mtl_values(path(iid, f'{stem}_MTL.txt'))
    se = float(mtl['SUN_ELEVATION'])
    bands = {}
    for b in (4, 5):
        ds = gdal.Open(str(path(iid, f'{stem}_B{b}.TIF')))
        x0, y0, n, _ = centre_window(ds)
        dn = ds.GetRasterBand(1).ReadAsArray(x0, y0, n, n).astype(np.float64)
        rho = (float(mtl[f'REFLECTANCE_MULT_BAND_{b}']) * dn + float(mtl[f'REFLECTANCE_ADD_BAND_{b}'])) / np.sin(np.radians(se))
        rho[dn == 0] = np.nan  # fill
        bands[b] = rho
        out.setdefault('landsat', {'item': iid, 'mtl': f'{stem}_MTL.txt', 'window': [x0, y0, n, n], 'sunElevation': se, 'bands': {}})
        out['landsat']['bands'][f'B{b}'] = {'file': f'{stem}_B{b}.TIF', 'mult': float(mtl[f'REFLECTANCE_MULT_BAND_{b}']), 'add': float(mtl[f'REFLECTANCE_ADD_BAND_{b}']),
                                            'raster': write_f32(f'{iid}.toa_B{b}.tif', rho), 'mean': float(np.nanmean(rho))}
    nd = (bands[5] - bands[4]) / (bands[5] + bands[4])
    out['landsat']['ndvi'] = {'raster': write_f32(f'{iid}.ndvi.tif', nd), 'mean': float(np.nanmean(nd))}
    save(iid, 'toa', out['landsat'])

    # Sentinel-2 L1C (PB ≥ 04.00): ρ = (DN + RADIO_ADD_OFFSET) / QUANTIFICATION_VALUE (S2 PSD).
    iid = 's2-l1c-jp2-safe-10seh-20240816'
    from lxml import etree
    mtd = etree.parse(str(path(iid, 'MTD_MSIL1C.xml')))
    q = float(mtd.xpath('//QUANTIFICATION_VALUE')[0].text)
    offs = {int(e.get('band_id')): float(e.text) for e in mtd.xpath('//RADIO_ADD_OFFSET')}
    s2 = {'item': iid, 'mtd': 'MTD_MSIL1C.xml', 'quantification': q, 'offsets': offs, 'bands': {}}
    bands = {}
    for name, bid in (('B04', 3), ('B08', 7)):
        f = f'T10SEH_20240816T184919_{name}.jp2'
        ds = gdal.Open(str(path(iid, f)))
        x0, y0, n, _ = centre_window(ds)
        dn = ds.GetRasterBand(1).ReadAsArray(x0, y0, n, n).astype(np.float64)
        rho = (dn + offs.get(bid, 0.0)) / q
        rho[dn == 0] = np.nan  # NODATA
        bands[name] = rho
        s2['window'] = [x0, y0, n, n]
        s2['bands'][name] = {'file': f, 'bandId': bid, 'raster': write_f32(f'{iid}.toa_{name}.tif', rho), 'mean': float(np.nanmean(rho))}
    nd = (bands['B08'] - bands['B04']) / (bands['B08'] + bands['B04'])
    s2['ndvi'] = {'raster': write_f32(f'{iid}.ndvi.tif', nd), 'mean': float(np.nanmean(nd))}
    save(iid, 'toa', s2)


# ---- 3. thermal brightness temperature ----

def thermal():
    iid = 'landsat8-c1-l1tp-044034-20210508'
    stem = 'LC08_L1TP_044034_20210508_20210518_01_T1'
    mtl = mtl_values(path(iid, f'{stem}_MTL.txt'))
    out = {'item': iid, 'mtl': f'{stem}_MTL.txt', 'bands': {}}
    for b in (10, 11):
        ds = gdal.Open(str(path(iid, f'{stem}_B{b}.TIF')))
        x0, y0, n, _ = centre_window(ds)
        dn = ds.GetRasterBand(1).ReadAsArray(x0, y0, n, n).astype(np.float64)
        ml, al = float(mtl[f'RADIANCE_MULT_BAND_{b}']), float(mtl[f'RADIANCE_ADD_BAND_{b}'])
        k1 = float(mtl.get(f'K1_CONSTANT_BAND_{b}'))
        k2 = float(mtl.get(f'K2_CONSTANT_BAND_{b}'))
        lr = ml * dn + al
        bt = k2 / np.log(k1 / lr + 1)
        bt[dn == 0] = np.nan
        out['window'] = [x0, y0, n, n]
        out['bands'][f'B{b}'] = {'file': f'{stem}_B{b}.TIF', 'radMult': ml, 'radAdd': al, 'k1': k1, 'k2': k2,
                                 'raster': write_f32(f'{iid}.bt_B{b}.tif', bt), 'meanK': float(np.nanmean(bt))}
    save(iid, 'thermal', out)


# ---- 6. Indian Pines classification ----

def classify():
    iid = 'rs-hsi-indian-pines'
    cube_p = path(iid, '19920612_AVIRIS_IndianPine_Site3.tif')
    gt_p = path(iid, '19920612_AVIRIS_IndianPine_Site3_gr.tif')
    cube = gdal.Open(str(cube_p)).ReadAsArray().astype(np.float64)  # (bands, rows, cols)
    truth = gdal.Open(str(gt_p)).ReadAsArray().astype(np.int64)
    nb, H, W = cube.shape
    # Classes large enough for a per-class covariance (≥ nb + 1 training pixels at a 50 % split):
    # the usual 9-class Indian Pines subset.
    counts = {int(k): int(v) for k, v in zip(*np.unique(truth[truth > 0], return_counts=True))}
    keep = [k for k, v in sorted(counts.items()) if v // 2 >= nb + 1]
    rng = np.random.default_rng(20261027)
    train, val = {}, {}
    for k in keep:
        idx = np.flatnonzero(truth.ravel() == k)
        rng.shuffle(idx)
        half = len(idx) // 2
        train[k] = sorted(int(i) for i in idx[:half])
        val[k] = sorted(int(i) for i in idx[half:])
    X = cube.reshape(nb, -1).T
    tr_i = np.concatenate([train[k] for k in keep])
    tr_y = np.concatenate([[k] * len(train[k]) for k in keep])
    va_i = np.concatenate([val[k] for k in keep])
    va_y = np.concatenate([[k] * len(val[k]) for k in keep])
    from sklearn.discriminant_analysis import LinearDiscriminantAnalysis, QuadraticDiscriminantAnalysis
    from sklearn.metrics import accuracy_score, cohen_kappa_score
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from sklearn.svm import SVC
    refs = {}
    for name, clf in (
        ('lda', LinearDiscriminantAnalysis()),
        ('qda_reg0.1', QuadraticDiscriminantAnalysis(reg_param=0.1)),
        ('svm_rbf', make_pipeline(StandardScaler(), SVC(C=100, gamma='scale'))),
    ):
        clf.fit(X[tr_i], tr_y)
        p = clf.predict(X[va_i])
        refs[name] = {'oa': float(accuracy_score(va_y, p)), 'kappa': float(cohen_kappa_score(va_y, p))}
        common.log(name, refs[name])
    save(iid, 'classify', {'file': cube_p.name, 'truthFile': gt_p.name, 'bands': nb, 'width': W, 'height': H, 'seed': 20261027,
                           'classes': keep, 'counts': counts, 'train': {str(k): v for k, v in train.items()}, 'val': {str(k): v for k, v in val.items()},
                           'sklearn': refs})


# ---- 2. chg.detect on the Maxar pre/post pair ----

def deming(a, b, valid, step=7):
    ai, bi = a.ravel()[::step], b.ravel()[::step]
    vi = valid.ravel()[::step]
    ai, bi = ai[vi], bi[vi]
    unsat = (ai > ai.min() + 0.5) & (ai < ai.max() - 0.5) & (bi > bi.min() + 0.5) & (bi < bi.max() - 0.5)

    def fit(sel):
        x, y = ai[sel], bi[sel]
        mx, my = x.mean(), y.mean()
        vxx, vyy, vxy = x.var(), y.var(), ((x - mx) * (y - my)).mean()
        gain = (vyy - vxx + np.sqrt((vyy - vxx) ** 2 + 4 * vxy * vxy)) / (2 * vxy) if vxy else 1.0
        return gain, my - gain * mx
    g, o = fit(unsat)
    res = np.abs(bi - (g * ai + o))
    cut = np.sort(res[unsat])[int(unsat.sum() * 0.9)]
    return fit(unsat & (res <= cut))


def change():
    # As delivered (pre 4137², post 3551²: chg.detect reads both whole, and the pre image is over
    # its 16 M-sample limit) and as a co-located crop of both (gdal_translate -projWin, the pre
    # crop 2048²) that the app can run, so the method itself is measured on real imagery.
    iid = 'eo-maxar-libya-floods-wv3-prepost'
    pre = path(iid, '1040010087AB7E00-ms.tif')
    post = path(iid, '104001008B282A00-ms.tif')
    change_pair(iid, pre, post, 'change')
    d = gdal.Open(str(pre))
    gt = d.GetGeoTransform()
    n = 2048
    x0 = (d.RasterXSize - n) // 2
    y0 = (d.RasterYSize - n) // 2
    win = [gt[0] + x0 * gt[1], gt[3] + y0 * gt[5], gt[0] + (x0 + n) * gt[1], gt[3] + (y0 + n) * gt[5]]
    ACC.mkdir(parents=True, exist_ok=True)
    crops = []
    for src in (pre, post):
        out = ACC / f'{iid}.crop.{src.name}'
        gdal.Translate(str(out), str(src), projWin=win, creationOptions=['COMPRESS=DEFLATE', 'TILED=YES'])
        crops.append(out)
    change_pair(iid, crops[0], crops[1], 'change_crop', {'cropOf': [pre.name, post.name], 'projWin': win,
                                                          'files': [str(c.relative_to(common.TRUTH)).replace('\\', '/') for c in crops],
                                                          'command': f'gdal_translate -projWin {" ".join(f"{v:.3f}" for v in win)} -co COMPRESS=DEFLATE -co TILED=YES'})


def change_pair(iid, pre, post, check, extra=None):
    from scipy import ndimage
    band = int(sys.argv[sys.argv.index('--band') + 1]) if '--band' in sys.argv else 0  # 0-based: the app's chain.bands[0]
    d1 = gdal.Open(str(pre))
    W, H = d1.RasterXSize, d1.RasterYSize
    gt = d1.GetGeoTransform()
    a = d1.GetRasterBand(band + 1).ReadAsArray().astype(np.float64)
    nd1 = d1.GetRasterBand(band + 1).GetNoDataValue()
    warped = gdal.Warp('', str(post), format='MEM', outputBounds=(gt[0], gt[3] + H * gt[5], gt[0] + W * gt[1], gt[3]), width=W, height=H,
                       resampleAlg='bilinear', dstNodata=float('nan'), outputType=gdal.GDT_Float32, srcBands=[band + 1], dstBands=[1])
    b = warped.GetRasterBand(1).ReadAsArray().astype(np.float64)
    valid = np.isfinite(a) & np.isfinite(b)
    if nd1 is not None:
        valid &= (a != nd1) & (b != nd1)
    # Date 1's own mask (GDAL internal PER_DATASET mask); date 2's is honoured by gdal.Warp (TE-053).
    valid &= d1.GetRasterBand(band + 1).GetMaskBand().ReadAsArray() > 0
    gain, offset = deming(a, b, valid)
    d = np.where(valid, np.abs(b - (gain * np.nan_to_num(a) + offset)), 0.0)
    ones = np.ones_like(d)
    s = ndimage.uniform_filter(d, 3, mode='constant') / ndimage.uniform_filter(ones, 3, mode='constant')
    sample = s.ravel()[::13][valid.ravel()[::13]]
    med = np.sort(sample)[len(sample) >> 1]
    mad = np.sort(np.abs(sample - med))[len(sample) >> 1] * 1.4826
    k = 4.0
    thr = med + k * max(mad, 1e-3) + 3
    mask = valid & (s > thr)
    st = np.ones((3, 3), bool)
    mask = ndimage.binary_dilation(ndimage.binary_erosion(mask, st, border_value=0), st)
    lab, n = ndimage.label(mask, st)
    boxes = []
    areas = ndimage.sum_labels(np.ones_like(d), lab, index=np.arange(1, n + 1)) if n else []
    for i, sl in enumerate(ndimage.find_objects(lab)):
        if sl is None or areas[i] < 30:
            continue
        boxes.append([sl[1].start, sl[0].start, sl[1].stop, sl[0].stop, int(areas[i])])
    cover = np.zeros((H, W), bool)
    for x0, y0, x1, y1, _ in boxes:
        cover[y0:y1, x0:x1] = True
    save(iid, check, {'pre': pre.name, 'post': post.name, 'band': band, 'width': W, 'height': H, 'k': k, 'minArea': 30,
                         'gain': gain, 'offset': offset, 'threshold': thr, 'candidates': len(boxes), 'boxes': boxes,
                         **(extra or {}), 'boxCoverPx': int(cover.sum()), 'changedPx': int(mask.sum()), 'validPx': int(valid.sum()),
                         'method': 'gdal.Warp bilinear (post → pre grid), Deming fit step 7 (unsaturated, refit without top 10 % residuals), |Δ|, 3×3 mean, median + 4·1.4826·MAD + 3, 3×3 opening, 8-connected ≥ 30 px'})


# ---- 1. CCD coherence on the Umbra Bingham pair ----

def ncc(a, b):
    """Shift (dy, dx) with b(y + d) ≈ a(y): Hann-windowed normalised cross-correlation of detected
    amplitude, parabolic sub-pixel peak; returns (dy, dx, peak correlation)."""
    n = a.shape[0]
    w = np.hanning(n)[:, None] * np.hanning(n)[None, :]
    a = (a - a.mean()) / (a.std() + 1e-9) * w
    b = (b - b.mean()) / (b.std() + 1e-9) * w
    c = np.fft.ifft2(np.fft.fft2(b) * np.conj(np.fft.fft2(a))).real / (w * w).sum()
    py, px = np.unravel_index(np.argmax(c), c.shape)
    pk = c[py, px]

    def par(m1, z, p1):
        d = m1 - 2 * z + p1
        return 0.5 * (m1 - p1) / d if d else 0.0
    sy = par(c[py - 1, px], pk, c[(py + 1) % n, px])
    sx = par(c[py, px - 1], pk, c[py, (px + 1) % n])
    return (py if py <= n // 2 else py - n) + sy, (px if px <= n // 2 else px - n) + sx, float(pk)


def ccd():
    from scipy import ndimage
    from sarpy.io.complex.converter import open_complex
    from sarpy.geometry.point_projection import image_to_ground, ground_to_image
    ia, ib = 'umbra-bingham-20230925-full', 'umbra-bingham-20230821-repeat'
    pa, pb = path(ia, 'umbra_20230925_SICD.nitf'), path(ib, 'umbra_20230821_SICD.nitf')
    ra, rb = open_complex(str(pa)), open_complex(str(pb))
    ma, mb = ra.sicd_meta, rb.sicd_meta
    rows, cols = ma.ImageData.NumRows, ma.ImageData.NumCols
    N, win = 2048, 5
    hae = ma.GeoData.SCP.LLH.HAE
    P = lambda y, x: np.c_[np.ones_like(y), y, x, y * y, x * y, x * x]  # noqa: E731
    # Chip centres as fractions of image a: a 3×3 scan (--scan), one (--at fy,fx) or the centre.
    if '--scan' in sys.argv:
        centres = [(fy, fx) for fy in (0.25, 0.5, 0.75) for fx in (0.25, 0.5, 0.75)]
    elif '--at' in sys.argv:
        centres = [tuple(float(v) for v in sys.argv[sys.argv.index('--at') + 1].split(','))]
    else:
        centres = [(0.5, 0.5)]
    results = []
    for fy, fx in centres:
        r0, c0 = int(fy * rows) - N // 2, int(fx * cols) - N // 2
        # Geometric mapping a → b (both projected on the SCP height plane), quadratic in (row, col).
        gr = np.linspace(0, N, 9)
        pts = np.array([[r0 + y, c0 + x] for y in gr for x in gr])
        q = ground_to_image(image_to_ground(pts, ma, projection_type='HAE', hae0=hae), mb)[0]
        cgy, *_ = np.linalg.lstsq(P(pts[:, 0] - r0, pts[:, 1] - c0), q[:, 0], rcond=None)
        cgx, *_ = np.linalg.lstsq(P(pts[:, 0] - r0, pts[:, 1] - c0), q[:, 1], rcond=None)
        M = 160
        rb0, rb1 = int(q[:, 0].min()) - M, int(q[:, 0].max()) + M
        cb0, cb1 = int(q[:, 1].min()) - M, int(q[:, 1].max()) + M
        if rb0 < 0 or cb0 < 0 or rb1 > mb.ImageData.NumRows or cb1 > mb.ImageData.NumCols or r0 < 0 or c0 < 0 or r0 + N > rows or c0 + N > cols:
            continue
        za = ra[r0:r0 + N, c0:c0 + N].astype(np.complex64)
        zbig = rb[rb0:rb1, cb0:cb1].astype(np.complex64)
        yy, xx = np.mgrid[0:N, 0:N].astype(np.float64)
        by = P(yy.ravel(), xx.ravel()) @ cgy - rb0
        bx = P(yy.ravel(), xx.ravel()) @ cgx - cb0
        # Dense residual offsets: detected-amplitude tiles (256², step 64) of a vs b resampled on a's grid.
        ab = ndimage.map_coordinates(np.abs(zbig).astype(np.float64), [by, bx], order=1, mode='nearest').reshape(N, N)
        aa = np.abs(za).astype(np.float64)
        T, S = 256, 64
        ties = []
        for ty in range(0, N - T + 1, S):
            for tx in range(0, N - T + 1, S):
                ddy, ddx, pk = ncc(aa[ty:ty + T, tx:tx + T], ab[ty:ty + T, tx:tx + T])
                ties.append([ddy, ddx, pk])
        ties = np.array(ties)
        n = (N - T) // S + 1
        oy, ox, pk = (ties[:, k].reshape(n, n) for k in (0, 1, 2))
        # Outliers (weak peaks or > 1.5 px from the 5×5 median) → the median; then a 3×3 mean.
        my, mx = ndimage.median_filter(oy, 5, mode='nearest'), ndimage.median_filter(ox, 5, mode='nearest')
        bad = (pk < 0.15) | (np.hypot(oy - my, ox - mx) > 1.5)
        oy, ox = np.where(bad, my, oy), np.where(bad, mx, ox)
        oy, ox = ndimage.uniform_filter(oy, 3, mode='nearest'), ndimage.uniform_filter(ox, 3, mode='nearest')
        # Offset field at every pixel (bilinear between tie centres). b-resampled matches a at y + d.
        ty_ = (yy - T / 2) / S
        tx_ = (xx - T / 2) / S
        fy_ = ndimage.map_coordinates(oy, [ty_.ravel(), tx_.ravel()], order=1, mode='nearest')
        fx_ = ndimage.map_coordinates(ox, [ty_.ravel(), tx_.ravel()], order=1, mode='nearest')
        # Map the residual through the local Jacobian of the geometric map (a pixels → b pixels).
        jy = (cgy[1] + 2 * cgy[3] * yy.ravel() + cgy[4] * xx.ravel(), cgy[2] + cgy[4] * yy.ravel() + 2 * cgy[5] * xx.ravel())
        jx = (cgx[1] + 2 * cgx[3] * yy.ravel() + cgx[4] * xx.ravel(), cgx[2] + cgx[4] * yy.ravel() + 2 * cgx[5] * xx.ravel())
        cy_ = by + jy[0] * fy_ + jy[1] * fx_
        cx_ = bx + jx[0] * fy_ + jx[1] * fx_
        # Complex resampling: cubic B-spline on I and Q (centred spectra: DeltaKCOAPoly = 0, ~1.26× oversampled).
        zb = (ndimage.map_coordinates(zbig.real, [cy_, cx_], order=3, mode='nearest') + 1j * ndimage.map_coordinates(zbig.imag, [cy_, cx_], order=3, mode='nearest')).reshape(N, N)
        ifg = za.astype(np.complex128) * np.conj(zb)
        # Flat earth: the interferogram's strongest fringe frequency (zero-padded FFT peak).
        F = np.abs(np.fft.fft2(ifg, s=(2 * N, 2 * N)))
        py, px = np.unravel_index(np.argmax(F), F.shape)
        fry, frx = np.fft.fftfreq(2 * N)[py], np.fft.fftfreq(2 * N)[px]
        ifg0 = ifg * np.exp(-2j * np.pi * (fry * yy + frx * xx))
        box = lambda v: ndimage.uniform_filter(v, win, mode='nearest')  # noqa: E731
        num = np.hypot(box(ifg0.real), box(ifg0.imag))
        den = np.sqrt(box(np.abs(za.astype(np.float64)) ** 2) * box(np.abs(zb) ** 2))
        gamma = num / np.maximum(den, 1e-30)
        t = 32
        tiles = gamma.reshape(N // t, t, N // t, t).mean(axis=(1, 3))
        stable = float((tiles >= 0.85).mean())
        disturbed = float((tiles <= 0.35).mean())
        common.log(f'chip r0={r0} c0={c0}: field dy {np.ptp(oy):.2f} dx {np.ptp(ox):.2f} px, weak {int(bad.sum())}/{bad.size}, '
                   f'fringe ({fry:.5f},{frx:.5f}) mean γ {gamma.mean():.3f} p90 {np.percentile(gamma, 90):.3f} stable {stable:.3f} disturbed {disturbed:.3f}')
        results.append({'chip': {'x0': c0, 'y0': r0, 'w': N, 'h': N}, 'chipB': {'x0': cb0, 'y0': rb0, 'w': cb1 - cb0, 'h': rb1 - rb0},
                        'geomJacobian': [float(cgy[1]), float(cgy[2]), float(cgx[1]), float(cgx[2])],
                        'offsetFieldRangePx': [float(np.ptp(oy)), float(np.ptp(ox))], 'weakTies': int(bad.sum()), 'ties': int(bad.size),
                        'fringe': [fry, frx], 'win': win, 'meanGamma': float(gamma.mean()), 'p90Gamma': float(np.percentile(gamma, 90)),
                        'stableTileFrac': stable, 'disturbedTileFrac': disturbed, 'tile': t, 'tiles': tiles.round(4).tolist(),
                        'hist': np.histogram(gamma, bins=10, range=(0, 1))[0].tolist(), 'scpHae': hae, '_gamma': gamma})
    best = max(results, key=lambda r: (min(r['stableTileFrac'], r['disturbedTileFrac']), r['p90Gamma']))
    # Interferometric geometry of the pair (why coherence can or cannot be high): height-sensitive
    # baseline B⊥ ≈ R·Δgraze, height of ambiguity λR·sinθᵢ/(2B⊥), range spectral shift f₀B⊥/(R·tanθᵢ).
    R = float(np.linalg.norm(ma.SCPCOA.ARPPos.get_array() - ma.GeoData.SCP.ECF.get_array()))
    lam = 299792458.0 / (ma.RadarCollection.TxFrequency.Min + ma.RadarCollection.TxFrequency.Max) * 2
    inc = np.radians(90 - ma.SCPCOA.GrazeAng)
    dg = np.radians(abs(ma.SCPCOA.GrazeAng - mb.SCPCOA.GrazeAng))
    bperp = R * dg
    bw = (ma.RadarCollection.TxFrequency.Max - ma.RadarCollection.TxFrequency.Min)
    shift = (299792458.0 / lam) * bperp / (R * np.tan(inc))
    geometry = {'slantRangeM': R, 'wavelengthM': lam, 'grazeDeg': [ma.SCPCOA.GrazeAng, mb.SCPCOA.GrazeAng], 'azimDeg': [ma.SCPCOA.AzimAng, mb.SCPCOA.AzimAng],
                'bPerpM': bperp, 'heightOfAmbiguityM': lam * R * np.sin(inc) / (2 * bperp) if bperp else None, 'txBandwidthHz': bw,
                'rangeSpectralShiftHz': shift, 'spectralOverlap': max(0.0, 1 - shift / bw), 'dates': [str(ma.Timeline.CollectStart), str(mb.Timeline.CollectStart)]}
    common.log('geometry', geometry)
    best['geometry'] = geometry
    best['raster'] = write_f32(f'{ia}.ccd_gamma.tif', best.pop('_gamma'))
    for r in results:
        r.pop('_gamma', None)
    save(ia, 'ccd', {'a': pa.name, 'b': pb.name, 'axes': 'chip x = SICD column, y = SICD row (app image x/y)', **best,
                     'method': 'sarpy chips; a→b quadratic map through sarpy image_to_ground/ground_to_image (SCP HAE); dense amplitude offsets (256² tiles, step 64, Hann-windowed NCC, parabolic peak, 5×5 median outlier test, 3×3 mean); cubic B-spline I/Q resampling; linear phase removed at the interferogram FFT peak; |Σ a b*| / √(Σ|a|² Σ|b|²) over 5×5; no common-band filtering',
                     'scanned': [{k: r[k] for k in ('chip', 'meanGamma', 'p90Gamma', 'stableTileFrac', 'disturbedTileFrac', 'offsetFieldRangePx')} for r in results]})


CHECKS = {'terrain': terrain, 'toa': toa, 'thermal': thermal, 'classify': classify, 'change': change, 'ccd': ccd}

if __name__ == '__main__':
    want = [a for a in sys.argv[1:] if a in CHECKS] or list(CHECKS)
    for k in want:
        common.log(f'== {k}')
        CHECKS[k]()
