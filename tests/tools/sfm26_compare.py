"""Differential test of the dense stage (REQ-GAP-29): gwb-sfm against COLMAP's own CUDA PatchMatch.

    python -I sfm26_compare.py <run> <out.json> [<dense-cuda folder>]

<run> holds two workspaces undistorted from the same oriented model: dense/ (gwb-sfm) and
dense-cuda/ (the official COLMAP binary, test time only, never shipped). Both use the same
fusion settings, so what differs is the depth maps.

Three levels, each both ways, because a method that keeps only easy pixels looks accurate:
  depth    per view, on pixels valid in both: relative difference; and each side's valid share
  cloud    nearest-neighbour distance, each cloud to the other, on a random sample
  surface  a median-height raster of each cloud at one cell size: the height difference
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree


def read_map(path):
    with open(path, "rb") as f:
        head = b""
        amps = 0
        while amps < 3:
            c = f.read(1)
            head += c
            if c == b"&":
                amps += 1
        w, h, c = (int(x) for x in head.decode().split("&")[:3])
        return np.fromfile(f, dtype="<f4").reshape(c, h, w).squeeze()


def read_ply(path):
    with open(path, "rb") as f:
        count = 0
        props = []
        while True:
            line = f.readline().decode().strip()
            if line.startswith("element vertex"):
                count = int(line.split()[-1])
            elif line.startswith("property"):
                _, ty, name = line.split()
                props.append((name, {"float": "<f4", "double": "<f8", "uchar": "u1"}[ty]))
            elif line == "end_header":
                break
        data = np.fromfile(f, dtype=np.dtype(props), count=count)
    return np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float64)


def stats(a):
    a = np.asarray(a)
    return {"n": int(a.size), "median": float(np.median(a)), "p90": float(np.percentile(a, 90)), "p99": float(np.percentile(a, 99))}


def depth_level(run, cuda):
    ours = run / "dense" / "stereo" / "depth_maps"
    theirs = cuda / "stereo" / "depth_maps"
    rel, ours_valid, theirs_valid, overlap, compared = [], [], [], [], 0
    for p in sorted(ours.glob("*.geometric.bin")):
        q = theirs / p.name
        if not q.exists():
            continue
        a, b = read_map(p), read_map(q)
        if a.shape != b.shape:
            raise SystemExit(f"{p.name}: {a.shape} against {b.shape}")
        va, vb = a > 0, b > 0
        ours_valid.append(va.mean())
        theirs_valid.append(vb.mean())
        both = va & vb
        overlap.append(both.sum() / max(vb.sum(), 1))
        rel.append(np.abs(a[both] - b[both]) / b[both])
        compared += 1
    r = np.concatenate(rel)
    return {
        "views": compared,
        "relative_difference": stats(r),
        "within_1pct": float((r < 0.01).mean()),
        "within_0p2pct": float((r < 0.002).mean()),
        "ours_valid_share": float(np.mean(ours_valid)),
        "theirs_valid_share": float(np.mean(theirs_valid)),
        "share_of_theirs_we_also_have": float(np.mean(overlap)),
    }


def cloud_level(a, b, sample=500_000):
    rng = np.random.default_rng(1)
    pick = lambda x: x[rng.choice(len(x), min(sample, len(x)), replace=False)]
    ab = cKDTree(b).query(pick(a), workers=4)[0]
    ba = cKDTree(a).query(pick(b), workers=4)[0]
    return {"points_ours": len(a), "points_theirs": len(b), "ours_to_theirs_m": stats(ab), "theirs_to_ours_m": stats(ba)}


def raster(p, x0, y0, cell, w, h):
    c = ((p[:, 0] - x0) / cell).astype(np.int64)
    r = ((p[:, 1] - y0) / cell).astype(np.int64)
    keep = (c >= 0) & (r >= 0) & (c < w) & (r < h)
    key = r[keep] * w + c[keep]
    z = p[keep, 2]
    order = np.lexsort((z, key))
    key, z = key[order], z[order]
    first = np.flatnonzero(np.r_[True, key[1:] != key[:-1]])
    last = np.r_[first[1:], key.size]
    out = np.full(w * h, np.nan)
    out[key[first]] = z[(first + last) // 2]
    return out.reshape(h, w)


def surface_level(a, b, cell):
    lo = np.minimum(np.percentile(a[:, :2], 0.05, axis=0), np.percentile(b[:, :2], 0.05, axis=0))
    hi = np.maximum(np.percentile(a[:, :2], 99.95, axis=0), np.percentile(b[:, :2], 99.95, axis=0))
    w, h = (int(v) + 1 for v in (hi - lo) / cell)
    ra, rb = raster(a, lo[0], lo[1], cell, w, h), raster(b, lo[0], lo[1], cell, w, h)
    both = np.isfinite(ra) & np.isfinite(rb)
    d = ra[both] - rb[both]
    med = float(np.median(d))
    return {
        "cell_m": cell,
        "cells_ours": int(np.isfinite(ra).sum()),
        "cells_theirs": int(np.isfinite(rb).sum()),
        "cells_both": int(both.sum()),
        "bias_m": med,
        "nmad_m": float(1.4826 * np.median(np.abs(d - med))),
        "rmse_m": float(np.sqrt(np.mean(d * d))),
        "abs_p90_m": float(np.percentile(np.abs(d), 90)),
        "abs_p99_m": float(np.percentile(np.abs(d), 99)),
    }


def main(run, out, cuda=None):
    run = Path(run)
    cuda = Path(cuda) if cuda else run / "dense-cuda"
    a = read_ply(run / "dense" / "fused.ply")
    b = read_ply(cuda / "fused.ply")
    res = {"depth": depth_level(run, cuda), "cloud": cloud_level(a, b), "surface": surface_level(a, b, 0.25)}
    Path(out).write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
