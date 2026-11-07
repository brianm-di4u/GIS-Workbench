"""Oracle on the ODM data set (REQ-GAP-29): our orthomosaic against ODM's own of the same block.

    python -I sfm26_odm_ortho.py <ours.ortho.tif> <aukerman.png> <out.json>

aukerman.png is the preview ODM published with the data set (ODM commit da22dd2): 1053 x 810 pixels,
no georeferencing. So this measures shape, not position: SIFT tie points between the two, a
similarity fit, and what is left over. The residual is the distortion between the two mosaics.
It says nothing about absolute accuracy, and it cannot see below the preview's pixel.
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import rasterio
from rasterio.enums import Resampling


def main(ours, odm, out):
    bgr = cv2.imread(odm, cv2.IMREAD_UNCHANGED)
    alpha = bgr[:, :, 3] > 0 if bgr.shape[2] == 4 else None
    a = cv2.cvtColor(bgr[:, :, :3], cv2.COLOR_BGR2GRAY)
    with rasterio.open(ours) as ds:
        # Our mosaic at about twice the preview's size: enough for SIFT, and it sets no scale.
        f = max(ds.width / (a.shape[1] * 2), 1.0)
        w, h = int(ds.width / f), int(ds.height / f)
        rgb = ds.read([1, 2, 3], out_shape=(3, h, w), resampling=Resampling.average)
        mask = ds.read(4, out_shape=(h, w), resampling=Resampling.nearest) > 0
        metres_per_pixel = ds.res[0] * f
    b = cv2.cvtColor(np.moveaxis(rgb, 0, 2), cv2.COLOR_RGB2GRAY)
    sift = cv2.SIFT_create(nfeatures=40000, contrastThreshold=0.02)
    ka, da = sift.detectAndCompute(a, None if alpha is None else alpha.astype(np.uint8) * 255)
    kb, db = sift.detectAndCompute(b, mask.astype(np.uint8) * 255)
    pairs = cv2.BFMatcher().knnMatch(da, db, k=2)
    good = [m for m, n in pairs if m.distance < 0.8 * n.distance]
    pa = np.float32([ka[m.queryIdx].pt for m in good])
    pb = np.float32([kb[m.trainIdx].pt for m in good])
    sim, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=6.0, maxIters=20000, confidence=0.9999)
    inl = inl.ravel().astype(bool)
    pa, pb = pa[inl], pb[inl]

    def residuals(m):
        q = pa @ m[:, :2].T + m[:, 2]
        return np.hypot(*(q - pb).T) * metres_per_pixel

    r_sim = residuals(sim)
    affine = cv2.estimateAffine2D(pa, pb, method=cv2.LMEDS)[0]
    r_aff = residuals(affine)
    scale = float(np.hypot(sim[0, 0], sim[1, 0]))
    cells = {(int(x * 6 / b.shape[1]), int(y * 6 / b.shape[0])) for x, y in pb}
    res = {
        "tie_points": int(inl.sum()),
        "candidates": len(good),
        "grid_cells_with_points_of_36": len(cells),
        "preview_pixel_m": metres_per_pixel * scale,
        "rotation_deg": float(np.degrees(np.arctan2(sim[1, 0], sim[0, 0]))),
        "similarity_residual_m": {"rms": float(np.sqrt(np.mean(r_sim**2))), "median": float(np.median(r_sim)), "p90": float(np.percentile(r_sim, 90))},
        "affine_residual_m": {"rms": float(np.sqrt(np.mean(r_aff**2))), "median": float(np.median(r_aff)), "p90": float(np.percentile(r_aff, 90))},
    }
    Path(out).write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:4])
