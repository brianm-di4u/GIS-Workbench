#!/usr/bin/env python3
"""Oracles for the 2.6 gdalroutes group (SCN-60). Each subcommand prints one JSON object.

Run with the gw-te environment (numpy, GDAL bindings). The bindings only read the tool's output;
what it is compared with comes from elsewhere:

  fits      a FITS image parsed here, by the standard (FITS 4.0), not by GDAL
  kea       the HDF5 arrays of a KEA file read with h5py
  brovey    weighted Brovey computed here with numpy from the inputs
  points    a coordinates file from PROJ's cs2cs (run by the caller, with the grids)
  raster    a second GDAL build (OSGeo4W), through a raw dump, or a raw array
  fbx       the binary FBX node tree parsed here
  glb       the glTF binary container parsed here, with node transforms
  ifc       the STEP file's point lists and index lists parsed here, and IfcOpenShell's validator
"""

import json
import re
import struct
import sys
import zlib

import numpy as np


def out(d):
    print(json.dumps(d))


def gdal_array(path):
    from osgeo import gdal

    gdal.UseExceptions()
    ds = gdal.Open(path)
    return np.stack([ds.GetRasterBand(i + 1).ReadAsArray() for i in range(ds.RasterCount)]), ds.GetGeoTransform()


def read_fits(path):
    """The primary image HDU of a FITS file: header cards of 80 bytes, big-endian data, BSCALE/BZERO."""
    b = open(path, "rb").read()
    h = {}
    pos = 0
    done = False
    while not done:
        block = b[pos : pos + 2880]
        pos += 2880
        for i in range(0, 2880, 80):
            card = block[i : i + 80].decode("ascii")
            key = card[:8].strip()
            if key == "END":
                done = True
                break
            if card[8:10] == "= ":
                h[key] = card[10:].split("/")[0].strip()
    bp = int(h["BITPIX"])
    dims = [int(h[f"NAXIS{i + 1}"]) for i in range(int(h["NAXIS"]))]
    t = {8: ">u1", 16: ">i2", 32: ">i4", 64: ">i8", -32: ">f4", -64: ">f8"}[bp]
    a = np.frombuffer(b, dtype=t, count=int(np.prod(dims)), offset=pos).reshape(dims[::-1]).astype("f8")
    return a * float(h.get("BSCALE", 1)) + float(h.get("BZERO", 0))


def cmd_fits(a):
    want = read_fits(a[0])
    got, _ = gdal_array(a[1])
    got = got.astype("f8")
    # GDAL shows a FITS image with its rows top down: FITS keeps them bottom up.
    if got.ndim == 3 and got.shape[0] == 1:
        got = got[0]
    same_flip = bool(np.array_equal(got, want[::-1]))
    same = bool(np.array_equal(got, want))
    out({"shape": list(got.shape), "equal": same or same_flip, "flipped": same_flip and not same, "max_abs": float(np.abs(got - (want[::-1] if same_flip else want)).max())})


def cmd_kea(a):
    """A KEA file is HDF5: BAND1/DATA read with h5py, against the converted raster."""
    import h5py

    with h5py.File(a[0], "r") as f:
        want = f["BAND1/DATA"][()].astype("f8")
    got = gdal_array(a[1])[0][0].astype("f8")
    out({"shape": list(got.shape), "equal": bool(np.array_equal(got, want)), "max_abs": float(np.abs(got - want).max())})


def cmd_brovey(a):
    """pan ms out weights: GDAL's weighted Brovey, nearest resampling, 8 or 16 bits."""
    pan = gdal_array(a[0])[0][0].astype("f8")
    ms, _ = gdal_array(a[1])
    res, _ = gdal_array(a[2])
    w = np.array([float(x) for x in a[3].split(",")])
    ry = pan.shape[0] / ms.shape[1]
    rx = pan.shape[1] / ms.shape[2]
    iy = np.minimum((np.arange(pan.shape[0]) + 0.5) / ry, ms.shape[1] - 1e-9).astype(int)
    ix = np.minimum((np.arange(pan.shape[1]) + 0.5) / rx, ms.shape[2] - 1e-9).astype(int)
    up = ms[:, iy][:, :, ix].astype("f8")
    pseudo = np.einsum("i,ijk->jk", w, up)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(pseudo != 0, pan / pseudo, 0)
    expect = up * ratio
    mx = {"uint8": 255, "uint16": 65535}[res.dtype.name]
    expect = np.clip(np.floor(expect + 0.5), 0, mx)
    d = np.abs(expect - res.astype("f8"))
    out({"shape": list(res.shape), "max_abs": float(d.max()), "mean_abs": float(d.mean()), "share_differing": float((d > 0).mean())})


def cmd_gridcheck(a):
    """warped points.txt: band 1 and 2 of the warped raster hold the source X and Y; points.txt has
    lon lat srcX srcY per line, from cs2cs with the grids. Residuals are in source units."""
    from osgeo import gdal

    gdal.UseExceptions()
    ds = gdal.Open(a[0])
    gt = ds.GetGeoTransform()
    bx = ds.GetRasterBand(1)
    by = ds.GetRasterBand(2)
    rows = [[float(x) for x in ln.split()[:4]] for ln in open(a[1]) if ln.strip()]
    res = []
    for lon, lat, sx, sy in rows:
        c = (lon - gt[0]) / gt[1] - 0.5
        r = (lat - gt[3]) / gt[5] - 0.5
        i, j = int(round(c)), int(round(r))
        if not (0 <= i < ds.RasterXSize and 0 <= j < ds.RasterYSize):
            continue
        vx = float(bx.ReadAsArray(i, j, 1, 1)[0, 0])
        vy = float(by.ReadAsArray(i, j, 1, 1)[0, 0])
        res.append(float(np.hypot(vx - sx, vy - sy)))
    a_ = np.array(res)
    out({"points": len(res), "rms": float(np.sqrt((a_**2).mean())), "max": float(a_.max()), "p95": float(np.percentile(a_, 95))})


def cmd_raw(a):
    """a.tif b.raw w h bands dtype: the file against a raw dump from another GDAL build."""
    got, _ = gdal_array(a[0])
    w, h, n = int(a[2]), int(a[3]), int(a[4])
    want = np.fromfile(a[1], dtype=a[5]).reshape(n, h, w)
    g = got.astype("f8")
    if g.shape[0] == n + 1:
        # PDFium's page has alpha, poppler's is on white: compare what a viewer shows.
        al = g[n] / 255
        g = g[:n] * al + 255 * (1 - al)
    d = np.abs(g - want.astype("f8"))
    out({"shape": list(got.shape), "equal": bool((d == 0).all()), "max_abs": float(d.max()), "mean_abs": float(d.mean()), "rmse": float(np.sqrt((d**2).mean()))})


def cmd_psnr(a):
    """a.tif b.tif: peak signal to noise of 8-bit images on the same grid, over b's valid pixels."""
    x = gdal_array(a[0])[0].astype("f8")[:3]
    y = gdal_array(a[1])[0].astype("f8")[:3]
    ok = y.sum(0) > 0
    mse = float(((x - y) ** 2)[:, ok].mean())
    out({"shape": list(y.shape), "share_valid": float(ok.mean()), "psnr": 10 * float(np.log10(255**2 / mse)) if mse else 99.0})


def cmd_ink(a):
    """a.tif b.raw w h bands: two renderers of a page. Hairlines and anti-aliasing differ, so the
    measure is the ink: the share of dark pixels of each with a dark pixel of the other within 2."""
    got, _ = gdal_array(a[0])
    w, h, n = int(a[2]), int(a[3]), int(a[4])
    want = np.fromfile(a[1], dtype="u1").reshape(n, h, w).astype("f8")
    g = got.astype("f8")
    if g.shape[0] == n + 1:
        al = g[n] / 255
        g = g[:n] * al + 255 * (1 - al)

    def near(m):
        r = m.copy()
        for dy in range(-2, 3):
            for dx in range(-2, 3):
                r |= np.roll(np.roll(m, dy, 0), dx, 1)
        return r

    x = g.mean(0) < 200
    y = want.mean(0) < 200
    out({"dark_a": int(x.sum()), "dark_b": int(y.sum()), "a_in_b": float((x & near(y)).sum() / max(1, x.sum())), "b_in_a": float((y & near(x)).sum() / max(1, y.sum()))})


def fbx_nodes(b, pos, end, ver):
    nodes = []
    while pos < end:
        if ver >= 7500:
            eo, np_, plen = struct.unpack_from("<QQQ", b, pos)
            pos += 24
        else:
            eo, np_, plen = struct.unpack_from("<III", b, pos)
            pos += 12
        nl = b[pos]
        pos += 1
        if eo == 0:
            break
        name = b[pos : pos + nl].decode("ascii", "replace")
        pos += nl
        props = []
        q = pos
        for _ in range(np_):
            t = chr(b[q])
            q += 1
            if t in "fdlib":
                c = {"f": "f", "d": "d", "l": "q", "i": "i", "b": "b"}[t]
                ln, enc, cl = struct.unpack_from("<III", b, q)
                q += 12
                raw = b[q : q + cl]
                q += cl
                if enc == 1:
                    raw = zlib.decompress(raw)
                props.append(np.frombuffer(raw, dtype="<" + c, count=ln))
            elif t in "SR":
                ln = struct.unpack_from("<I", b, q)[0]
                q += 4
                props.append(b[q : q + ln])
                q += ln
            else:
                sz, c = {"Y": (2, "h"), "C": (1, "b"), "I": (4, "i"), "F": (4, "f"), "D": (8, "d"), "L": (8, "q")}[t]
                props.append(struct.unpack_from("<" + c, b, q)[0])
                q += sz
        pos += plen
        kids = fbx_nodes(b, pos, eo, ver) if pos < eo else []
        nodes.append((name, props, kids))
        pos = eo
    return nodes


def fbx_geometry(path):
    b = open(path, "rb").read()
    if b[:20] != b"Kaydara FBX Binary  ":
        raise SystemExit("not a binary FBX")
    ver = struct.unpack_from("<I", b, 23)[0]
    top = fbx_nodes(b, 27, len(b), ver)
    verts = 0
    polys = 0
    pts = []
    for name, _, kids in top:
        if name != "Objects":
            continue
        for k, props, sub in kids:
            if k != "Geometry":
                continue
            for s, pr, _ in sub:
                if s == "Vertices":
                    v = pr[0].reshape(-1, 3)
                    verts += len(v)
                    pts.append(v)
                if s == "PolygonVertexIndex":
                    polys += int((pr[0] < 0).sum())
    return ver, verts, polys, np.concatenate(pts) if pts else np.zeros((0, 3))


def cmd_fbx(a):
    ver, verts, polys, pts = fbx_geometry(a[0])
    out({"version": ver, "vertices": verts, "polygons": polys, "bbox": [pts.min(0).tolist(), pts.max(0).tolist()] if len(pts) else None})


def glb_triangles(path):
    """Triangles and world-space bounding box of an uncompressed GLB, node transforms applied."""
    b = open(path, "rb").read()
    jl = struct.unpack_from("<I", b, 12)[0]
    g = json.loads(b[20 : 20 + jl])
    bin_ = b[20 + jl + 8 :]

    def acc(i):
        ac = g["accessors"][i]
        bv = g["bufferViews"][ac["bufferView"]]
        off = bv.get("byteOffset", 0) + ac.get("byteOffset", 0)
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[ac["type"]]
        t = {5121: "u1", 5123: "<u2", 5125: "<u4", 5126: "<f4"}[ac["componentType"]]
        s = np.dtype(t).itemsize * n
        st = bv.get("byteStride", s)
        return np.ndarray((ac["count"], n), dtype=t, buffer=bin_, offset=off, strides=(st, np.dtype(t).itemsize)).copy()

    def local(nd):
        if "matrix" in nd:
            return np.array(nd["matrix"]).reshape(4, 4).T
        m = np.eye(4)
        t = nd.get("translation", [0, 0, 0])
        x, y, z, w = nd.get("rotation", [0, 0, 0, 1])
        s = nd.get("scale", [1, 1, 1])
        r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        m[:3, :3] = r * np.array(s)
        m[:3, 3] = t
        return m

    pts = []
    tris = 0

    def walk(i, parent):
        nonlocal tris
        nd = g["nodes"][i]
        m = np.einsum("ij,jk->ik", parent, local(nd))
        if "mesh" in nd:
            for p in g["meshes"][nd["mesh"]]["primitives"]:
                v = acc(p["attributes"]["POSITION"]).astype("f8")
                v = np.einsum("ij,kj->ki", m[:3, :3], v) + m[:3, 3]
                pts.append(v)
                tris += (g["accessors"][p["indices"]]["count"] if "indices" in p else len(v)) // 3
        for c in nd.get("children", []):
            walk(c, m)

    for n in g["scenes"][g.get("scene", 0)]["nodes"]:
        walk(n, np.eye(4))
    return tris, np.concatenate(pts)


def cmd_glb(a):
    tris, p = glb_triangles(a[0])
    out({"triangles": tris, "bbox": [p.min(0).tolist(), p.max(0).tolist()]})


def cmd_ifc(a):
    """The STEP text read here, then IfcOpenShell's validator when its path is given."""
    t = open(a[0], encoding="ascii").read()
    tris = 0
    pts = []
    lists = dict(re.findall(r"#(\d+)=IFCCARTESIANPOINTLIST3D\(\((.*?)\)(?:,\$)?\);", t, re.S))
    for pl, idx in re.findall(r"=IFCTRIANGULATEDFACESET\(#(\d+),\$,\$?\.?[TFU]?\.?,?\(\((.*?)\)\)", t, re.S):
        tris += idx.count("),(") + 1
        for m in re.finditer(r"\(([-0-9.E+]+),([-0-9.E+]+),([-0-9.E+]+)\)", "(" + lists[pl] + ")"):
            pts.append((float(m[1]), float(m[2]), float(m[3])))
    p = np.array(pts)
    r = {"schema": re.search(r"FILE_SCHEMA\(\('(\w+)'\)\)", t)[1], "triangles": tris, "points": len(p), "bbox": [p.min(0).tolist(), p.max(0).tolist()] if len(p) else None, "map_conversion": "IFCMAPCONVERSION" in t}
    if len(a) > 1:
        sys.path.insert(0, a[1])
        import logging

        import ifcopenshell
        import ifcopenshell.validate

        logger = ifcopenshell.validate.json_logger()
        ifcopenshell.validate.validate(ifcopenshell.open(a[0]), logger)
        r["validator_issues"] = len(logger.statements)
        r["validator_sample"] = [str(s.get("message"))[:200] for s in logger.statements[:5]]
    out(r)


if __name__ == "__main__":
    globals()["cmd_" + sys.argv[1]](sys.argv[2:])
