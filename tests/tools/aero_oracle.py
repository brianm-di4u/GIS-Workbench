"""OpenCV oracle for the REQ-GAP-22 aerial triangulation (gw-te environment, OpenCV 5).

Part 1, synthetic (independent of the GIS Workbench solver): a 3-D target field and a planar
board seen in several views, projected with cv2.projectPoints (Brown) and cv2.fisheye.projectPoints
(equidistant), with Gaussian noise; then cv2.calibrateCamera, cv2.fisheye.calibrate and
cv2.solvePnP on the same measurements. The scenes and OpenCV's solutions go to
D:/gwb25/data-aero/oracle/*.json, which crates/gw-aero/tests/aero_oracle.rs reads and solves
with the solver, comparing the two.

Part 2, real data: for each <block>-selfcal-solution.json the corpus test wrote (our camera, EO
and adjusted points per image, the measurements Huber left at full weight), OpenCV re-solves the camera with the points held
(calibrateCamera with the intrinsic guess, CALIB_FIX_ASPECT_RATIO, no k3 → k1 k2 k3 p1 p2 as ours)
and every image's pose (solvePnP, our camera held); the differences go to
D:/gwb25/data-aero/oracle/<block>-real.json.

Conventions: OpenCV pixel centres are integers (ours are corner-origin, + 0.5); OpenCV's camera
looks along +z with y down, ours along −z with y up: R_ours = diag(1, −1, −1)·R_cv, C = −R_cvᵀ t.

  python -I tests/tools/aero_oracle.py synthetic
  python -I tests/tools/aero_oracle.py real
"""
import glob
import json
import math
import os
import sys

import cv2
import numpy as np

OUT = "D:/gwb25/data-aero/oracle"
RES = "D:/gwb25/data-aero/results"


def rodrigues(r):
    return cv2.Rodrigues(np.asarray(r, dtype=np.float64))[0]


def look_at(c, target, up=(0, 0, 1)):
    """OpenCV rotation (world → camera, z forward, y down) for a camera at c looking at target."""
    z = np.asarray(target, float) - c
    z /= np.linalg.norm(z)
    x = np.cross(z, up)
    if np.linalg.norm(x) < 1e-6:
        x = np.array([1.0, 0, 0])
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    return np.vstack([x, y, z])


def synthetic():
    rng = np.random.default_rng(42)
    os.makedirs(OUT, exist_ok=True)
    # --- Brown: a 3-D field (2 m × 1.5 m × 0.6 m) seen from 12 convergent views ---
    W, H = 3000, 2000
    K = np.array([[2400.0, 0, 1512.3], [0, 2398.0, 994.6], [0, 0, 1]])
    dist = np.array([-0.12, 0.09, 4e-4, -6e-4, -0.02])
    pts = np.array([[x, y, 0.6 * math.sin(x * 2.1) * math.cos(y * 1.7)] for x in np.linspace(-1, 1, 15) for y in np.linspace(-0.75, 0.75, 11)])
    views = []
    for k in range(12):
        az = 2 * math.pi * k / 12
        c = np.array([3.2 * math.cos(az), 3.2 * math.sin(az), 2.4 + 0.4 * math.sin(3 * az)])
        R = look_at(c, rng.normal(0, 0.1, 3))
        # Roll every other view by 90° (breaks the aspect/principal-point correlations).
        if k % 2:
            R = np.array([[0, 1, 0], [-1, 0, 0], [0, 0, 1.0]]) @ R
        t = -R @ c
        uv, _ = cv2.projectPoints(pts, cv2.Rodrigues(R)[0], t, K, dist)
        uv = uv.reshape(-1, 2) + rng.normal(0, 0.3, (len(pts), 2))
        keep = (uv[:, 0] > 2) & (uv[:, 1] > 2) & (uv[:, 0] < W - 2) & (uv[:, 1] < H - 2)
        views.append({"R": R, "t": t, "uv": uv, "keep": keep})
    obj = [pts[v["keep"]].astype(np.float32) for v in views]
    img = [v["uv"][v["keep"]].astype(np.float32) for v in views]
    K0 = np.array([[2300.0, 0, W / 2], [0, 2300.0, H / 2], [0, 0, 1]])
    crit = (cv2.TERM_CRITERIA_COUNT + cv2.TERM_CRITERIA_EPS, 200, 1e-12)
    rms, Kc, dc, rv, tv = cv2.calibrateCamera(obj, img, (W, H), K0.copy(), np.zeros(5), flags=cv2.CALIB_USE_INTRINSIC_GUESS, criteria=crit)
    # solvePnP on view 3 with the true intrinsics.
    ok, r3, t3 = cv2.solvePnP(obj[3], img[3], K, dist, flags=cv2.SOLVEPNP_ITERATIVE)
    out = {
        "kind": "brown",
        "width": W,
        "height": H,
        "truth": {"K": K.tolist(), "dist": dist.tolist(), "views": [{"R": v["R"].tolist(), "t": v["t"].tolist()} for v in views]},
        "views": [{"obj": o.astype(float).tolist(), "uv": i.astype(float).tolist()} for o, i in zip(obj, img)],
        "opencv": {"rms": rms, "K": Kc.tolist(), "dist": dc.ravel().tolist(), "views": [{"R": rodrigues(r).tolist(), "t": np.ravel(t).tolist()} for r, t in zip(rv, tv)]},
        "pnp": {"view": 3, "R": rodrigues(r3).tolist(), "t": np.ravel(t3).tolist()},
    }
    json.dump(out, open(f"{OUT}/synthetic-brown.json", "w"))
    print(f"brown: calibrateCamera RMS {rms:.4f} px, fx {Kc[0,0]:.3f} fy {Kc[1,1]:.3f} cx {Kc[0,2]:.3f} cy {Kc[1,2]:.3f} dist {dc.ravel()}")

    # --- Fisheye: a planar board (equidistant, θ up to ~70°), 14 views ---
    W, H = 2000, 1500
    Kf = np.array([[620.0, 0, 1003.4], [0, 619.0, 748.2], [0, 0, 1]])
    D = np.array([0.04, -0.012, 0.003, -0.0007])
    board = np.array([[x, y, 0.0] for x in np.linspace(-1.2, 1.2, 25) for y in np.linspace(-0.9, 0.9, 19)])
    fviews = []
    for k in range(14):
        az = 2 * math.pi * k / 14
        c = np.array([0.6 * math.cos(az), 0.6 * math.sin(az), 0.55 + 0.1 * (k % 3)])
        R = look_at(c, np.array([0.3 * math.cos(az + 1), 0.3 * math.sin(az + 1), 0.0]), up=(1, 0, 0) if k % 2 else (0, 1, 0))
        t = -R @ c
        uv, _ = cv2.fisheye.projectPoints(board.reshape(-1, 1, 3), cv2.Rodrigues(R)[0], t, Kf, D)
        uv = uv.reshape(-1, 2) + rng.normal(0, 0.3, (len(board), 2))
        cam = (R @ board.T).T + t
        theta = np.degrees(np.arctan2(np.hypot(cam[:, 0], cam[:, 1]), cam[:, 2]))
        keep = (uv[:, 0] > 2) & (uv[:, 1] > 2) & (uv[:, 0] < W - 2) & (uv[:, 1] < H - 2) & (theta < 75) & (cam[:, 2] > 0)
        fviews.append({"R": R, "t": t, "uv": uv, "keep": keep})
    fobj = [board[v["keep"]].reshape(1, -1, 3).astype(np.float64) for v in fviews]
    fimg = [v["uv"][v["keep"]].reshape(1, -1, 2).astype(np.float64) for v in fviews]
    K0 = np.array([[600.0, 0, W / 2], [0, 600.0, H / 2], [0, 0, 1]])
    flags = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_RECOMPUTE_EXTRINSIC | cv2.CALIB_FIX_SKEW  # OpenCV 5: one flag namespace
    frms, Kfc, Dfc, frv, ftv = cv2.fisheye.calibrate(fobj, fimg, (W, H), K0.copy(), np.zeros((4, 1)), flags=flags, criteria=crit)
    fout = {
        "kind": "fisheye",
        "width": W,
        "height": H,
        "truth": {"K": Kf.tolist(), "dist": D.tolist(), "views": [{"R": v["R"].tolist(), "t": v["t"].tolist()} for v in fviews]},
        "views": [{"obj": o.reshape(-1, 3).tolist(), "uv": i.reshape(-1, 2).tolist()} for o, i in zip(fobj, fimg)],
        "opencv": {"rms": frms, "K": Kfc.tolist(), "dist": np.ravel(Dfc).tolist(), "views": [{"R": rodrigues(r).tolist(), "t": np.ravel(t).tolist()} for r, t in zip(frv, ftv)]},
    }
    json.dump(fout, open(f"{OUT}/synthetic-fisheye.json", "w"))
    print(f"fisheye: fisheye.calibrate RMS {frms:.4f} px, fx {Kfc[0,0]:.3f} fy {Kfc[1,1]:.3f} cx {Kfc[0,2]:.3f} cy {Kfc[1,2]:.3f} D {np.ravel(Dfc)}")


def to_cv(sol):
    """Our camera (mm, y up, corner origin) → OpenCV K and (k1, k2, p1, p2, k3)."""
    pix, W, H = sol["pixelMm"], sol["width"], sol["height"]
    f, x0, y0, k1, k2, k3, k4, p1, p2, b1, b2 = sol["io"]
    fy = f / pix
    fx = fy * (1 + b1)
    cx = W / 2 + x0 / pix - 0.5
    cy = H / 2 - y0 / pix - 0.5
    K = np.array([[fx, 0, cx], [0, fy, cy], [0, 0, 1.0]])
    # k_mm = k_cv / f^2n; P1_ours = p2_cv / f, P2_ours = −p1_cv / f.
    d = np.array([k1 * f**2, k2 * f**4, -p2 * f, p1 * f, k3 * f**6])
    return K, d


def from_cv(K, d, sol):
    pix, W, H = sol["pixelMm"], sol["width"], sol["height"]
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    f = fy * pix
    k1, k2, p1, p2, k3 = list(np.ravel(d)) + [0] * (5 - len(np.ravel(d)))
    return [f, (cx + 0.5 - W / 2) * pix, -(cy + 0.5 - H / 2) * pix, k1 / f**2, k2 / f**4, k3 / f**6, 0, p2 / f, -p1 / f, fx / fy - 1, 0]


FLIP = np.diag([1.0, -1.0, -1.0])


def real():
    os.makedirs(OUT, exist_ok=True)
    for path in sorted(glob.glob(f"{RES}/*-selfcal-solution.json")):
        sol = json.load(open(path))
        K, d = to_cv(sol)
        W, H = int(sol["width"]), int(sol["height"])
        obj, img, eo = [], [], []
        for im in sol["images"]:
            o = np.array(im["obs"], dtype=np.float64)
            # Full-weight measurements only: OpenCV solves unweighted least squares, ours down-weights
            # the rest (Huber), so the two problems match on these.
            if o.ndim == 2 and o.shape[1] > 5:
                o = o[o[:, 5] > 0.999]
            if len(o) < 12:
                continue
            obj.append(o[:, 2:5].astype(np.float32))
            img.append((o[:, 0:2] - 0.5).astype(np.float32))
            eo.append(im)
        # 1. Every pose with our camera held.
        dc, da = [], []
        for o, i, im in zip(obj, img, eo):
            R = FLIP @ np.array(im["r"])  # ours → OpenCV
            c = np.array(im["c"])
            rv0, tv0 = cv2.Rodrigues(R)[0], -R @ c
            ok, rv, tv = cv2.solvePnP(o.astype(np.float64), i.astype(np.float64), K, d, rv0.copy(), tv0.copy(), useExtrinsicGuess=True, flags=cv2.SOLVEPNP_ITERATIVE)
            Rc = rodrigues(rv)
            cc = -Rc.T @ np.ravel(tv)
            dc.append(float(np.linalg.norm(cc - c)))
            da.append(float(np.degrees(np.linalg.norm(cv2.Rodrigues(Rc @ R.T)[0]))))
        # 2. The camera with every point held (our solution as the guess).
        crit = (cv2.TERM_CRITERIA_COUNT + cv2.TERM_CRITERIA_EPS, 100, 1e-12)
        flags = cv2.CALIB_USE_INTRINSIC_GUESS | cv2.CALIB_FIX_ASPECT_RATIO
        rms, Kc, dcv, _, _ = cv2.calibrateCamera(obj, img, (W, H), K.copy(), d.copy(), flags=flags, criteria=crit)
        io_cv = from_cv(Kc, dcv, sol)
        # The two lenses as image displacement over the format (px): corners and edges.
        grid = [(x, y) for x in np.linspace(0, W, 9) for y in np.linspace(0, H, 7)]
        und_ours = cv2.undistortPoints(np.array(grid, dtype=np.float64).reshape(-1, 1, 2), K, d, P=K).reshape(-1, 2)
        und_cv = cv2.undistortPoints(np.array(grid, dtype=np.float64).reshape(-1, 1, 2), Kc, dcv, P=K).reshape(-1, 2)
        field = float(np.max(np.hypot(*(und_ours - und_cv).T)))
        out = {"block": sol["block"], "images": len(eo), "points": int(sum(len(o) for o in obj)), "pnp": {"centreMax": max(dc), "centreRms": float(np.sqrt(np.mean(np.square(dc)))), "angleMaxDeg": max(da)},
               "calibrate": {"rms": rms, "ours": sol["io"], "opencv": io_cv, "fieldMaxPx": field}}
        json.dump(out, open(f"{OUT}/{sol['block']}-real.json", "w"), indent=1)
        print(f"{sol['block']}: {len(eo)} images; solvePnP vs ours: centre max {max(dc):.4f} m (RMS {out['pnp']['centreRms']:.4f}), attitude max {max(da):.5f} deg; calibrateCamera RMS {rms:.3f} px, f {io_cv[0]:.5f} vs {sol['io'][0]:.5f} mm, lens field differs by <= {field:.3f} px")


if __name__ == "__main__":
    {"synthetic": synthetic, "real": real}[sys.argv[1]]()
