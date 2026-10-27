"""SCN-14 reference: PDAL SMRF (default parameters) on a 3DEP tile, scored against the delivered
USGS ground like the app's SMRF, plus 1 m DTM RMSEz at delivered ground points. Writes
_truth/<item>.smrf.json. Usage: python -I smrf.py <laz> <out.json>"""
import os, sys, json, numpy as np, pdal
p = sys.argv[1]
pipe = pdal.Pipeline(json.dumps([
    {"type": "readers.las", "filename": p},
    {"type": "filters.ferry", "dimensions": "Classification=>OrigClass"},
    {"type": "filters.assign", "value": ["Classification = 1", "Classification = 7 WHERE OrigClass == 7", "Classification = 18 WHERE OrigClass == 18"]},
    {"type": "filters.smrf", "ignore": "Classification[7:7],Classification[18:18]"},
]))
pipe.execute()
a = pipe.arrays[0]
o, c = a['OrigClass'], a['Classification']
keep = (o != 7) & (o != 18)
o, c = o[keep], c[keep]
g1, g0 = c == 2, o == 2
res = ({'n': int(keep.sum()), 'agree': float((g1 == g0).mean()), 'fp': float((g1 & ~g0).mean()), 'fn': float((~g1 & g0).mean()),
                  'orig_hist': {int(k): int(v) for k, v in zip(*np.unique(o, return_counts=True))},
                  'fp_by_orig': {int(k): int(v) for k, v in zip(*np.unique(o[g1 & ~g0], return_counts=True))}})
# DTM at 1 m from the SMRF ground (cell mean and cell min) sampled at delivered ground points.
x, y, z = a['X'][keep], a['Y'][keep], a['Z'][keep]
x0, y0 = x.min(), y.max()
ix, iy = np.floor(x - x0).astype(np.int64), np.floor(y0 - y).astype(np.int64)
nx, ny = ix.max() + 1, iy.max() + 1
cell = iy * nx + ix
out = {}
for stat in ('mean', 'min'):
    gsel = g1
    if stat == 'mean':
        s = np.bincount(cell[gsel], weights=z[gsel], minlength=nx * ny); n = np.bincount(cell[gsel], minlength=nx * ny)
        d = np.where(n > 0, s / np.maximum(n, 1), np.nan)
    else:
        d = np.full(nx * ny, np.inf); np.minimum.at(d, cell[gsel], z[gsel]); d[np.isinf(d)] = np.nan
    gi = np.flatnonzero(g0)[:: max(1, int(g0.sum() // 20000))]
    v = d[cell[gi]] - z[gi]
    v = v[np.isfinite(v)]
    out[stat] = {'rmse': float(np.sqrt((v ** 2).mean())), 'n': int(v.size)}
# Same, from the delivered USGS ground (the best case for a 1 m cell DTM).
s = np.bincount(cell[g0], weights=z[g0], minlength=nx * ny); n = np.bincount(cell[g0], minlength=nx * ny)
d = np.where(n > 0, s / np.maximum(n, 1), np.nan); gi = np.flatnonzero(g0)[:: max(1, int(g0.sum() // 20000))]; v = d[cell[gi]] - z[gi]; v = v[np.isfinite(v)]
out['usgs_mean'] = {'rmse': float(np.sqrt((v ** 2).mean())), 'n': int(v.size)}
res['dtm'] = out
res['file'] = os.path.basename(p)
open(sys.argv[2], 'w').write(json.dumps(res, indent=1))
print(json.dumps(res))
# The app's DTM method on PDAL's ground: 1 m posts (nearest post, mean), bilinear between posts,
# sampled at the same delivered ground points (posts without ground are skipped, not filled).
px0, py0 = np.ceil(x.min()), np.floor(y.max())
pi, pj = np.rint(x - px0).astype(np.int64), np.rint(py0 - y).astype(np.int64)
ok = (pi >= 0) & (pj >= 0)
pw, ph = pi[ok].max() + 1, pj[ok].max() + 1
def posts(sel):
    sel = sel & ok
    q = pj[sel] * pw + pi[sel]
    s = np.bincount(q, weights=z[sel], minlength=pw * ph); n = np.bincount(q, minlength=pw * ph)
    return np.where(n > 0, s / np.maximum(n, 1), np.nan).reshape(ph, pw)
def bilinear(P, k):
    fi, fj = x[k] - px0, py0 - y[k]
    i, j = np.floor(fi).astype(np.int64), np.floor(fj).astype(np.int64)
    m = (i >= 0) & (j >= 0) & (i + 1 < pw) & (j + 1 < ph)
    i, j, u, v, k = i[m], j[m], (fi - i[m] if False else fi[m] - i[m]), fj[m] - j[m], k[m]
    zz = (1 - v) * ((1 - u) * P[j, i] + u * P[j, i + 1]) + v * ((1 - u) * P[j + 1, i] + u * P[j + 1, i + 1])
    d = zz - z[k]
    d = d[np.isfinite(d)]
    return {'rmse': float(np.sqrt((d ** 2).mean())), 'n': int(d.size)}
gi = np.flatnonzero(g0)[:: max(1, int(g0.sum() // 20000))]
res['dtm']['posts_bilinear'] = bilinear(posts(g1), gi)
res['dtm']['usgs_posts_bilinear'] = bilinear(posts(g0), gi)
open(sys.argv[2], 'w').write(json.dumps(res, indent=1))
print(json.dumps(res['dtm']))
