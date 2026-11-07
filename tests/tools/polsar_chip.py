"""Read a polarimetric chip straight from the source files, independently of the app, as the input
of polsar_ref.py (REQ-GAP-40 campaign c59):

* sicd: HH HV [VH] VV SICD files through sarpy (rows = image y, columns = image x);
* uavsar: HHHH HVHV VVVV HHVV GRD files (little-endian REAL*4 / COMPLEX*8, `cols` samples per
  line from the .ann) by numpy memmap, as C3 planes (C22 = 2 HVHV; HHHV and HVVV absent -> 0;
  zero power marks no data -> NaN);
* s1: Sentinel-1 SLC measurement TIFFs (co-pol first) through GDAL.

Usage: python -I polsar_chip.py <kind> <out.bin> <x0> <y0> <w> <h> [--cols N] files...
"""
import sys

import numpy as np


def main():
    kind, out = sys.argv[1], sys.argv[2]
    x0, y0, w, h = (int(v) for v in sys.argv[3:7])
    rest = sys.argv[7:]
    cols = None
    if rest and rest[0] == "--cols":
        cols = int(rest[1])
        rest = rest[2:]
    parts = []
    if kind == "sicd":
        from sarpy.io.complex.converter import open_complex

        for f in rest:
            r = open_complex(f)
            z = np.asarray(r[y0:y0 + h, x0:x0 + w], dtype=np.complex64)
            parts.append(z.ravel().view(np.float32))
    elif kind == "uavsar":
        hhhh, hvhv, vvvv, hhvv = rest
        def real(p):
            m = np.memmap(p, dtype="<f4", mode="r")
            return np.array(m.reshape(-1, cols)[y0:y0 + h, x0:x0 + w], dtype=np.float64)
        c11, c22, c33 = real(hhhh), 2 * real(hvhv), real(vvvv)
        m = np.memmap(hhvv, dtype="<c8", mode="r")
        c13 = np.array(m.reshape(-1, cols)[y0:y0 + h, x0:x0 + w], dtype=np.complex128)
        ok = (c11 > 0) & (c33 > 0)
        planes = [c11, c22, c33, 0 * c11, 0 * c11, c13.real, c13.imag, 0 * c11, 0 * c11]
        for p in planes:
            parts.append(np.where(ok, p, np.nan).astype(np.float32).ravel())
    elif kind == "s1":
        from osgeo import gdal

        for f in rest:
            ds = gdal.Open(f)
            z = ds.GetRasterBand(1).ReadAsArray(x0, y0, w, h).astype(np.complex64)
            parts.append(z.ravel().view(np.float32))
    else:
        raise SystemExit(f"unknown kind {kind}")
    np.concatenate(parts).astype("<f4").tofile(out)


if __name__ == "__main__":
    main()
