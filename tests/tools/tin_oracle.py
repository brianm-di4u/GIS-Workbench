"""Independent oracles for the TIN bundle (crates/gw-tin, REQ-GAP-39), run in the gw-te environment.

* delaunay: scipy.spatial.Delaunay (Qhull) of the given points; the triangles as sorted vertex
  triples, so a test can compare sets.
* interp: linear interpolation on *given* triangles with matplotlib.tri (Triangulation +
  LinearTriInterpolator, its own point location and barycentric weights), at given points; NaN
  outside. The TIN-to-grid test feeds it the bundle's own triangles: it checks the rasteriser's
  location and interpolation, not the triangulation.
* qhull_interp: linear interpolation on Qhull's own Delaunay triangles (scipy.spatial.Delaunay)
  located and weighted by matplotlib.tri, at given points: for unconstrained point sets in general
  position the bundle must agree with it. Not LinearNDInterpolator: anything using
  Delaunay.find_simplex or .transform dies in gw-te (exit 0xC06D007F, a LAPACK delay-load failure).
* ground: the class-2 (ground) points of a LAS/LAZ file with laspy (lazrs), as f64 x, y, z in the
  file's CRS, optionally inside a box and thinned to every k-th point.

Triangle-level constraint and Delaunay checks live in the JS test (exact BigInt predicates), not
here: the triangle and CGAL bindings are not in gw-te.

Usage: python -I tin_oracle.py job.json
job.json: {mode, ...}; binary inputs and outputs are little-endian files named in the job.
"""
import json
import sys

import numpy as np


def main():
    job = json.load(open(sys.argv[1]))
    mode = job["mode"]
    if mode == "delaunay":
        from scipy.spatial import Delaunay

        p = np.fromfile(job["points"], dtype="<f8").reshape(-1, 2)
        tri = Delaunay(p)
        s = np.sort(tri.simplices.astype(np.int64), axis=1)
        s = s[np.lexsort((s[:, 2], s[:, 1], s[:, 0]))]
        s.astype("<u4").tofile(job["out"])
        json.dump({"triangles": int(s.shape[0]), "coplanar": int(len(tri.coplanar))}, open(job["out"] + ".json", "w"))
    elif mode == "interp":
        import matplotlib.tri as mtri

        v = np.fromfile(job["vertices"], dtype="<f8").reshape(-1, 3)
        t = np.fromfile(job["triangles"], dtype="<u4").reshape(-1, 3).astype(np.int64)
        q = np.fromfile(job["queries"], dtype="<f8").reshape(-1, 2)
        # Offset to the vertices' centre for numerical comfort (matplotlib works in doubles too).
        c = v[:, :2].mean(axis=0)
        tr = mtri.Triangulation(v[:, 0] - c[0], v[:, 1] - c[1], t)
        f = mtri.LinearTriInterpolator(tr, v[:, 2])
        z = f(q[:, 0] - c[0], q[:, 1] - c[1])
        out = np.where(np.ma.getmaskarray(z), np.nan, np.ma.getdata(z)).astype("<f8")
        out.tofile(job["out"])
    elif mode == "qhull_interp":
        import matplotlib.tri as mtri
        from scipy.spatial import Delaunay

        v = np.fromfile(job["vertices"], dtype="<f8").reshape(-1, 3)
        q = np.fromfile(job["queries"], dtype="<f8").reshape(-1, 2)
        c = v[:, :2].mean(axis=0)
        p = v[:, :2] - c
        tr = mtri.Triangulation(p[:, 0], p[:, 1], Delaunay(p).simplices.astype(np.int64))
        z = mtri.LinearTriInterpolator(tr, v[:, 2])(q[:, 0] - c[0], q[:, 1] - c[1])
        np.where(np.ma.getmaskarray(z), np.nan, np.ma.getdata(z)).astype("<f8").tofile(job["out"])
    elif mode == "ground":
        import laspy

        las = laspy.read(job["las"])
        cls = np.asarray(las.classification)
        x, y, z = np.asarray(las.x), np.asarray(las.y), np.asarray(las.z)
        k = cls == 2
        if job.get("box"):
            x0, y0, x1, y1 = job["box"]
            k &= (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
        idx = np.nonzero(k)[0][:: int(job.get("every", 1))]
        np.stack([x[idx], y[idx], z[idx]], axis=1).astype("<f8").tofile(job["out"])
        wkt = None
        try:
            crs = las.header.parse_crs()
            wkt = crs.to_wkt() if crs is not None else None
            epsg = crs.to_epsg() if crs is not None else None
        except Exception:
            epsg = None
        json.dump({"points": int(idx.size), "all": int(cls.size), "ground": int(k.sum()), "epsg": epsg, "wkt": wkt}, open(job["out"] + ".json", "w"))
    else:
        raise SystemExit("unknown mode " + mode)


if __name__ == "__main__":
    main()
