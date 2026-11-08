"""Independent reference for automatic endmembers (REQ-GAP-82 oracle).

Vertex Component Analysis as published by Nascimento and Bioucas-Dias (IEEE TGRS 43(4), 2005,
pp. 898-910, and their MATLAB release), written from the paper and not from crates/gw-spectral:

  * the signal subspace comes from a singular value decomposition of the data (not from MNF);
  * the SNR is estimated as in the paper (eq. 13) and chooses the projection: above the paper's
    threshold 15 + 10 log10(p) dB a projective projection onto the d = p dimensional subspace,
    below it a projection onto p - 1 principal components plus a constant coordinate;
  * random directions come from numpy's PCG64, so the pixel choices differ from the kernel's.

The kernel and this reference are therefore compared by the spectra they find (spectral angle),
never by pixel index.

Usage: python -I endmember_ref.py IN.json OUT.json
IN = {"cube": path to BIP float32 (little-endian), "w": int, "h": int, "nb": int, "m": int, "seed": int}
OUT = {"pixels": [int] * m, "spectra": [[float] * nb] * m, "snr_db": float, "branch": "projective"|"pca"}
"""
import json
import sys

import numpy as np


def vca(y, p, seed):
    """y: nb x n reflectance, p endmembers. Returns (pixel indices, snr dB, branch)."""
    nb, n = y.shape
    rng = np.random.default_rng(seed)
    mean = y.mean(axis=1, keepdims=True)
    y0 = y - mean
    u_pca = np.linalg.svd(y0 @ y0.T / n)[0][:, :p]
    x_p = u_pca.T @ y0
    # eq. 13: SNR from the projected and total power.
    p_y = np.sum(y ** 2) / n
    p_x = np.sum(x_p ** 2) / n + np.sum(mean ** 2)
    snr = 10 * np.log10(max((p_x - p / nb * p_y) / max(p_y - p_x, 1e-30), 1e-30))
    if snr > 15 + 10 * np.log10(p):
        branch = "projective"
        ud = np.linalg.svd(y @ y.T / n)[0][:, :p]
        x = ud.T @ y
        u = x.mean(axis=1, keepdims=True)
        proj = x / np.maximum(np.sum(x * u, axis=0, keepdims=True), 1e-30)
    else:
        branch = "pca"
        d = p - 1
        x = u_pca[:, :d].T @ y0
        c = np.sqrt(np.max(np.sum(x ** 2, axis=0)))
        proj = np.vstack([x, c * np.ones((1, n))])
    a = np.zeros((p, p))
    a[-1, 0] = 1.0
    idx = np.zeros(p, dtype=int)
    for i in range(p):
        w = rng.standard_normal((p, 1))
        f = w - a @ np.linalg.pinv(a) @ w
        f = f / np.linalg.norm(f)
        v = f.T @ proj
        idx[i] = int(np.argmax(np.abs(v)))
        a[:, i] = proj[:, idx[i]]
    return idx, float(snr), branch


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    w, h, nb = spec["w"], spec["h"], spec["nb"]
    cube = np.fromfile(spec["cube"], dtype="<f4").reshape(w * h, nb).astype(np.float64)
    ok = np.all(np.isfinite(cube), axis=1)
    pix = np.nonzero(ok)[0]
    idx, snr, branch = vca(cube[ok].T, int(spec["m"]), int(spec.get("seed", 0)))
    pixels = [int(pix[i]) for i in idx]
    out = {"pixels": pixels, "spectra": [cube[p].tolist() for p in pixels], "snr_db": snr, "branch": branch}
    json.dump(out, open(sys.argv[2], "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
