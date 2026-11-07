"""Independent numpy reference for the polarimetric decompositions of crates/gw-sar/src/polsar.rs
(REQ-GAP-40). Neither PolSARpro nor SNAP is in the gw-te environment, so the differential tests
compare the Rust bundle with this file, written from the papers with numpy's own linear algebra
(numpy.linalg.eigh / inv / det, scipy.ndimage.uniform_filter):

* Pauli and lexicographic scattering vectors; T3 = <k k^H>; C3 -> T3 by T = N C N^T.
* Boxcar (truncated at the edges), refined Lee (Lee, Grunes and De Grandi 1999).
* Freeman-Durden 1998, Yamaguchi 2005 (T3 form of Yamaguchi 2011, optional de-orientation).
* Cloude-Pottier H/A/alpha, the H/alpha (H/A/alpha) Wishart classification (Lee et al. 1999).
* Dual-pol and CTLR compact-pol H/A/alpha (Cloude 2007).

The power-constraint choices (what happens to negative powers) follow the documented rules of
polsar.rs; they are conventions, not physics, and PolSARpro's differ in places.

Usage: python -I polsar_ref.py job.json out.bin
job.json: {w, h, input, filter, win, looks, products, rotate, useA, iterations, hasVH, data}
out.bin: float32 planes in the order of out.json {products: [{name, planes}], wishart}.
"""
import json
import sys

import numpy as np
from scipy.ndimage import uniform_filter

R2 = np.sqrt(2.0)


def load(job):
    w, h = job["w"], job["h"]
    n = w * h
    raw = np.fromfile(job["data"], dtype="<f4").astype(np.float64)
    return w, h, n, raw


def cplx(raw, k, n):
    a = raw[k * 2 * n:(k + 1) * 2 * n]
    return a[0::2] + 1j * a[1::2]


def herm_from_vec(k):
    """k: (n, d) complex -> (n, d, d) outer products k k^H."""
    return np.einsum("ni,nj->nij", k, np.conj(k))


def planes9_to_mat(p):
    """(9, n) planar -> (n, 3, 3) Hermitian."""
    n = p.shape[1]
    m = np.zeros((n, 3, 3), dtype=complex)
    m[:, 0, 0], m[:, 1, 1], m[:, 2, 2] = p[0], p[1], p[2]
    m[:, 0, 1] = p[3] + 1j * p[4]
    m[:, 0, 2] = p[5] + 1j * p[6]
    m[:, 1, 2] = p[7] + 1j * p[8]
    m[:, 1, 0] = np.conj(m[:, 0, 1])
    m[:, 2, 0] = np.conj(m[:, 0, 2])
    m[:, 2, 1] = np.conj(m[:, 1, 2])
    return m


def mat_to_planes9(m):
    return np.stack([m[:, 0, 0].real, m[:, 1, 1].real, m[:, 2, 2].real, m[:, 0, 1].real, m[:, 0, 1].imag, m[:, 0, 2].real, m[:, 0, 2].imag, m[:, 1, 2].real, m[:, 1, 2].imag])


def mat2_to_planes(m):
    return np.stack([m[:, 0, 0].real, m[:, 1, 1].real, m[:, 0, 1].real, m[:, 0, 1].imag])


N3 = np.array([[1, 0, 1], [1, 0, -1], [0, R2, 0]]) / R2


def c3_to_t3(m):
    return np.einsum("ij,njk,lk->nil", N3, m, N3)


def t3_to_c3(m):
    return np.einsum("ji,njk,kl->nil", N3, m, N3)


def to_f32(p):
    return p.astype(np.float32).astype(np.float64)


def boxcar(p, w, h, win):
    """Truncated-edge window mean of each plane (NaN pixels left out and kept NaN)."""
    ok = np.isfinite(p.sum(axis=0)).astype(float)
    cnt = uniform_filter(ok.reshape(h, w), size=win, mode="constant", cval=0.0)
    out = np.empty_like(p)
    for c in range(p.shape[0]):
        v = np.where(ok > 0, p[c], 0.0).reshape(h, w)
        s = uniform_filter(v, size=win, mode="constant", cval=0.0)
        out[c] = np.where((cnt.ravel() > 0) & (ok > 0), (s / np.maximum(cnt, 1e-300)).ravel(), np.nan)
    return out


def refined_lee(p, w, h, looks, span):
    cu2 = 1.0 / max(looks, 0.1)
    S = span.reshape(h, w)
    P = p.reshape(p.shape[0], h, w)
    out = np.full_like(P, np.nan)
    # Half-window masks of the 7 x 7 window, by direction index.
    dy, dx = np.mgrid[-3:4, -3:4]
    masks = [dy <= 0, dy >= 0, dx <= 0, dx >= 0, dx + dy <= 0, dx + dy >= 0, dx - dy <= 0, dx - dy >= 0]
    pairs = [(0, 1), (2, 3), (4, 5), (6, 7)]
    ys = np.clip(np.arange(-5, h + 5), 0, h - 1)
    xs = np.clip(np.arange(-5, w + 5), 0, w - 1)
    Sp = S[np.ix_(ys, xs)]  # replicated border, offset 5
    Pp = P[:, ys][:, :, xs]
    for y in range(h):
        for x in range(w):
            if not np.isfinite(S[y, x]):
                continue
            yy, xx = y + 5, x + 5
            bm = np.empty((3, 3))
            for by in range(3):
                for bx in range(3):
                    cy, cx = yy + 2 * (by - 1), xx + 2 * (bx - 1)
                    blk = Sp[cy - 1:cy + 2, cx - 1:cx + 2]
                    f = blk[np.isfinite(blk)]
                    bm[by, bx] = f.mean() if f.size else S[y, x]
            g = [abs(bm[0].sum() - bm[2].sum()), abs(bm[:, 0].sum() - bm[:, 2].sum()), abs((bm[0, 1] + bm[0, 0] + bm[1, 0]) - (bm[1, 2] + bm[2, 2] + bm[2, 1])), abs((bm[0, 1] + bm[0, 2] + bm[1, 2]) - (bm[1, 0] + bm[2, 0] + bm[2, 1]))]
            k = int(np.argmax(g))  # first maximum
            half = [bm[0].mean(), bm[2].mean(), bm[:, 0].mean(), bm[:, 2].mean(), (bm[0, 1] + bm[0, 0] + bm[1, 0]) / 3, (bm[1, 2] + bm[2, 2] + bm[2, 1]) / 3, (bm[1, 0] + bm[2, 0] + bm[2, 1]) / 3, (bm[0, 1] + bm[0, 2] + bm[1, 2]) / 3]
            a, b = pairs[k]
            c = bm[1, 1]
            d = a if abs(half[a] - c) <= abs(half[b] - c) else b
            win = Sp[yy - 3:yy + 4, xx - 3:xx + 4]
            sel = masks[d] & np.isfinite(win)
            v = win[sel]
            m = v.mean()
            var_y = max(np.mean(v * v) - m * m, 0.0)
            var_x = max((var_y - m * m * cu2) / (1 + cu2), 0.0)
            bw = var_x / var_y if var_y > 0 else 0.0
            for ch in range(P.shape[0]):
                mu = Pp[ch, yy - 3:yy + 4, xx - 3:xx + 4][sel].mean()
                out[ch, y, x] = mu + bw * (P[ch, y, x] - mu)
    return out.reshape(p.shape)


def freeman(C):
    c11, c22, c33 = C[:, 0, 0].real, C[:, 1, 1].real, C[:, 2, 2].real
    c13 = C[:, 0, 2]
    span = c11 + c22 + c33
    fv = 1.5 * c22
    a = c11 - fv
    b = c33 - fv
    z = c13 - fv / 3.0
    with np.errstate(divide="ignore", invalid="ignore"):
        cap = np.where(np.abs(z) ** 2 > a * b, np.sqrt(np.abs(a * b) / np.abs(z) ** 2), 1.0)
        z = z * cap
        rho2 = np.abs(z) ** 2
        surf = z.real >= 0
        fd_s = (a * b - rho2) / (a + b + 2 * z.real)
        fs_s = b - fd_s
        ps_s = fs_s + np.abs(z + fd_s) ** 2 / fs_s
        pd_s = 2 * fd_s
        fs_d = (a * b - rho2) / (a + b - 2 * z.real)
        fd_d = b - fs_d
        ps_d = 2 * fs_d
        pd_d = fd_d + np.abs(z - fs_d) ** 2 / fd_d
    ps = np.where(surf, ps_s, ps_d)
    pd = np.where(surf, pd_s, pd_d)
    pv = 8 * fv / 3
    vol_only = (a <= 0) | (b <= 0)
    hi = np.maximum(span, 0)
    ps = np.where(vol_only, 0, np.clip(ps, 0, hi))
    pd = np.where(vol_only, 0, np.clip(pd, 0, hi))
    pv = np.where(vol_only, hi, np.clip(pv, 0, hi))
    return np.stack([ps, pd, pv])


def deorient(T):
    phi = 0.5 * np.arctan2(2 * T[:, 1, 2].real, T[:, 1, 1].real - T[:, 2, 2].real)
    c, s = np.cos(phi), np.sin(phi)
    R = np.zeros((len(phi), 3, 3))
    R[:, 0, 0] = 1
    R[:, 1, 1], R[:, 1, 2], R[:, 2, 1], R[:, 2, 2] = c, s, -s, c
    return np.einsum("nij,njk,nlk->nil", R, T, R)


def yamaguchi(T0, rotate):
    T = deorient(T0) if rotate else T0
    t11, t22, t33 = T[:, 0, 0].real, T[:, 1, 1].real, T[:, 2, 2].real
    t12 = T[:, 0, 1]
    tp = t11 + t22 + t33
    pc = 2 * np.abs(T[:, 1, 2].imag)
    hh = 0.5 * (t11 + t22 + 2 * t12.real)
    vv = 0.5 * (t11 + t22 - 2 * t12.real)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where((hh > 0) & (vv > 0), 10 * np.log10(vv / hh), 0.0)
    kv = np.where((ratio <= -2) | (ratio >= 2), 15 / 4, 4.0)
    t12v = np.where(ratio <= -2, 1 / 6, np.where(ratio >= 2, -1 / 6, 0.0))
    t22v = np.where((ratio <= -2) | (ratio >= 2), 7 / 30, 0.25)
    pv = kv * (t33 - pc / 2)
    neg = pv < 0
    pc = np.where(neg, 0.0, pc)
    pv = np.where(neg, np.maximum(kv * t33, 0), pv)
    over = pv + pc > tp
    S = t11 - pv / 2
    D = t22 - t22v * pv - pc / 2
    C2 = (t12.real - t12v * pv) ** 2 + t12.imag ** 2
    c0 = t11 - t22 - t33 + pc
    rest = tp - pv - pc
    with np.errstate(divide="ignore", invalid="ignore"):
        ps = np.where(c0 > 0, np.where(S > 1e-30, S + C2 / S, 0.0), np.where(D > 1e-30, S - C2 / D, rest))
        pd = np.where(c0 > 0, np.where(S > 1e-30, D - C2 / S, rest), np.where(D > 1e-30, D + C2 / D, 0.0))
    a = (ps > 0) & (pd < 0)
    b = (pd > 0) & (ps < 0) & ~a
    both = (ps < 0) & (pd < 0)
    ps, pd = np.where(a, rest, ps), np.where(a, 0.0, pd)
    ps, pd = np.where(b, 0.0, ps), np.where(b, rest, pd)
    pv = np.where(both, tp - pc, pv)
    ps, pd = np.where(both, 0.0, ps), np.where(both, 0.0, pd)
    ps = np.where(over, 0.0, np.maximum(ps, 0))
    pd = np.where(over, 0.0, np.maximum(pd, 0))
    pv = np.where(over, np.maximum(tp - pc, 0), np.maximum(pv, 0))
    return np.stack([ps, pd, pv, pc])


def haalpha(T):
    lam, U = np.linalg.eigh(T)  # ascending
    lam = np.maximum(lam[:, ::-1], 0)
    U = U[:, :, ::-1]
    s = lam.sum(axis=1)
    p = lam / s[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        H = -np.where(p > 0, p * np.log(p) / np.log(3), 0).sum(axis=1)
        A = np.where(lam[:, 1] + lam[:, 2] > 0, (lam[:, 1] - lam[:, 2]) / (lam[:, 1] + lam[:, 2]), 0.0)
    al = np.degrees((p * np.arccos(np.minimum(np.abs(U[:, 0, :]), 1))).sum(axis=1))
    return np.clip(H, 0, 1), A, al


def halpha2(C):
    lam, U = np.linalg.eigh(C)
    lam = np.maximum(lam[:, ::-1], 0)
    U = U[:, :, ::-1]
    s = lam.sum(axis=1)
    p = lam / s[:, None]
    with np.errstate(divide="ignore", invalid="ignore"):
        H = -np.where(p > 0, p * np.log2(p), 0).sum(axis=1)
    A = (lam[:, 0] - lam[:, 1]) / s
    al = np.degrees((p * np.arccos(np.minimum(np.abs(U[:, 0, :]), 1))).sum(axis=1))
    return np.clip(H, 0, 1), A, al


def zones(H, al):
    z = np.full(H.shape, 9, dtype=np.int32)
    hi, med = H >= 0.9, (H >= 0.5) & (H < 0.9)
    lo = H < 0.5
    z = np.where(hi & (al >= 55), 1, z)
    z = np.where(hi & (al >= 40) & (al < 55), 2, z)
    z = np.where(hi & (al < 40), 3, z)
    z = np.where(med & (al >= 50), 4, z)
    z = np.where(med & (al >= 40) & (al < 50), 5, z)
    z = np.where(med & (al < 40), 6, z)
    z = np.where(lo & (al >= 47.5), 7, z)
    z = np.where(lo & (al >= 42.5) & (al < 47.5), 8, z)
    z = np.where(lo & (al < 42.5), 9, z)
    return z


def wishart(T, H, A, al, use_a, iterations, stop=0.01):
    valid = np.isfinite(H) & np.isfinite(al) & np.all(np.isfinite(T.reshape(len(T), -1).real), axis=1)
    lab = zones(H, al)
    if use_a:
        lab = np.where(A > 0.5, lab + 9, lab)
    lab = np.where(valid, lab, 0)
    it, changed = 0, 0.0
    while True:
        ids = [k for k in range(1, 19) if np.any(lab == k)]
        V = np.stack([T[lab == k].mean(axis=0) for k in ids])
        if it >= iterations or (it > 0 and changed < stop):
            break
        # A singular or non-positive class centre takes no pixels (as in polsar.rs).
        det = np.linalg.det(V)
        good = (det.real > 0) & (np.abs(det) > 1e-300)
        Vi = np.zeros_like(V)
        Vi[good] = np.linalg.inv(V[good])
        ld = np.where(good, np.log(np.where(good, det.real, 1.0)), np.inf)
        d = ld[None, :] + np.einsum("kij,nji->nk", Vi, T).real
        new = np.array(ids)[np.argmin(d, axis=1)]
        new = np.where(valid, new, 0)
        changed = float(np.sum(new != lab)) / max(1, int(valid.sum()))
        lab = new
        it += 1
    return lab, it, changed, ids, [int(np.sum(lab == k)) for k in ids]


def main():
    job = json.load(open(sys.argv[1]))
    w, h, n, raw = load(job)
    inp = job["input"]
    has_vh = job.get("hasVH", False)
    want = set(job["products"])
    three = inp in ("quad", "c3", "t3")
    if inp in ("quad", "compact"):
        hh, hv = cplx(raw, 0, n), cplx(raw, 1, n)
        if has_vh:
            vh, vv = cplx(raw, 2, n), cplx(raw, 3, n)
            x = 0.5 * (hv + vh)
        else:
            vv = cplx(raw, 2, n)
            x = hv
    if inp == "quad":
        k = np.stack([(hh + vv) / R2, (hh - vv) / R2, R2 * x], axis=1)
        M = mat_to_planes9(herm_from_vec(k))
    elif inp == "c3":
        M = mat_to_planes9(c3_to_t3(planes9_to_mat(raw.reshape(9, n))))
    elif inp == "t3":
        M = raw.reshape(9, n)
    elif inp in ("dual", "compact"):
        if inp == "dual":
            a, b = cplx(raw, 0, n), cplx(raw, 1, n)
        else:
            a, b = (hh - 1j * x) / R2, (x - 1j * vv) / R2
        M = mat2_to_planes(herm_from_vec(np.stack([a, b], axis=1)))
    M = to_f32(M)  # the Rust stack stores f32
    flt = job.get("filter", "none")
    if flt == "boxcar":
        M = boxcar(M, w, h, int(job.get("win", 7)) | 1)
    elif flt == "refinedlee":
        span = to_f32(M[:3].sum(axis=0) if three else M[:2].sum(axis=0))
        M = refined_lee(M, w, h, job.get("looks", 1), span)
    M = to_f32(M)
    out, names = [], []

    def emit(name, planes, arrs):
        names.append({"name": name, "planes": planes})
        out.extend(arrs)

    if three:
        T = planes9_to_mat(M)
        if "t3" in want:
            emit("T3", ["T11", "T22", "T33", "T12_real", "T12_imag", "T13_real", "T13_imag", "T23_real", "T23_imag"], list(M))
        if "c3" in want:
            emit("C3", ["C11", "C22", "C33", "C12_real", "C12_imag", "C13_real", "C13_imag", "C23_real", "C23_imag"], list(mat_to_planes9(t3_to_c3(T))))
        if "span" in want:
            emit("Span", ["Span"], [M[:3].sum(axis=0)])
        if "freeman" in want:
            emit("Freeman-Durden", ["Ps", "Pd", "Pv"], list(freeman(t3_to_c3(T))))
        if "yamaguchi" in want:
            rot = bool(job.get("rotate"))
            emit("Yamaguchi Y4R" if rot else "Yamaguchi Y4O", ["Ps", "Pd", "Pv", "Pc"], list(yamaguchi(T, rot)))
        if "haalpha" in want or "wishart" in want:
            H, A, al = haalpha(T)
        if "haalpha" in want:
            emit("H/A/alpha", ["H", "A", "alpha"], [H, A, al])
        wj = None
        if "wishart" in want:
            ua = bool(job.get("useA"))
            lab, it, ch, ids, counts = wishart(T, H, A, al, ua, int(job.get("iterations", 10)))
            emit("H/A/alpha Wishart" if ua else "H/alpha Wishart", ["class"], [lab.astype(float)])
            wj = {"iterations": it, "changed": ch, "classes": [{"label": int(k), "count": c} for k, c in zip(ids, counts)]}
    else:
        C = np.zeros((n, 2, 2), dtype=complex)
        C[:, 0, 0], C[:, 1, 1] = M[0], M[1]
        C[:, 0, 1] = M[2] + 1j * M[3]
        C[:, 1, 0] = np.conj(C[:, 0, 1])
        wj = None
        if "c2" in want:
            emit("C2", ["C11", "C22", "C12_real", "C12_imag"], list(M))
        if "span" in want:
            emit("Span", ["Span"], [M[:2].sum(axis=0)])
        if "halpha2" in want:
            H, A, al = halpha2(C)
            emit("Compact-pol H/A/alpha" if inp == "compact" else "Dual-pol H/A/alpha", ["H", "A", "alpha"], [H, A, al])
    np.concatenate([np.asarray(a, dtype=np.float64).ravel() for a in out]).astype("<f4").tofile(sys.argv[2])
    json.dump({"products": names, "wishart": wj}, open(sys.argv[2] + ".json", "w"))


if __name__ == "__main__":
    main()
