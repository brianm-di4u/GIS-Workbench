"""Independent reference for the airfield obstruction surfaces (REQ-GAP-73 oracle).

Written from the texts, not from crates/gw-aviation:
  * 14 CFR Part 77 §77.19 (a)-(e), civil airport imaginary surfaces;
  * ICAO Annex 14 Volume I as amended by Amendment 18 (State letter AN 4/1.2.31-25/23), Chapter 4 as
    applicable until 20 November 2030: Table 4-1 and the strip rule §3.4.5 as printed there, with
    Table 4-2 and §3.4.2-3.4.4, which the amendment leaves unchanged.

Different methods from the Rust kernel on purpose: positions relative to a runway are taken in
geodesic polar coordinates about each runway end (pyproj Geod: distance and azimuth), and the
horizontal / inner horizontal perimeter is a shapely union of buffered circles (convex hull) in an
azimuthal equidistant projection, with distances measured by shapely.

The inner approach, inner transitional and balked landing surfaces are evaluated by a third method:
each surface is an explicit triangle mesh, its vertices the corners and edges the text describes, and
a position's height comes from the barycentric coordinates in the triangle holding it. The kernel
uses closed-form station and offset expressions and shares none of this. Their tables here are typed
from the printed Table 4-1, columns (9) to (11), not from the kernel. These surfaces are reported on
their own (ofzLimit, ofzKind) as well as in the lowest limit: they mostly lie above the strip,
transitional and approach surfaces, so the lowest limit alone would never show them.

Amendment 18's Chapter 4 as applicable from 21 November 2030 (regime "icao-a18") is a fourth
method: every runway-attached surface is a triangle mesh in station and offset (geodesic polar
coordinates as above), each triangle planar because the surfaces are linear between their breaks, and
a position takes the lowest triangle holding it; the horizontal surfaces are shapely hulls. Its
tables are typed from the amendment's printed Tables 4-1 to 4-15. The obstacle free surfaces' own
lowest limit is reported as ofzLimit.

Usage: python -I obstruction_ref.py IN.json OUT.json
IN = {"regime": "part77"|"icao"|"icao-a18", "airport": {elev, ihsDatum?, codeF?, runways: [{paved, code,
      tocsWidth?, adg? (1 I .. 7 V), width?, mtom?,
      ends: [{lat, lon, elev, p77, icao, disp, thrElev, approach, takeoff, clearway}]×2}]},
      "points": [[lat, lon], ...]}
OUT = {"limit": [m or null], "kind": [str or null], "ofzLimit": [m or null], "ofzKind": [str or null]}
"""
import json
import math
import sys

import numpy as np
from pyproj import Geod, Transformer
from shapely.geometry import Point
from shapely.ops import unary_union

FT = 0.3048
G = Geod(ellps="WGS84")
P77 = ["A(V)", "A(NP)", "B(V)", "C", "D", "PIR"]


def p77_dims(cat):
    """§77.19(d): (outer width ft, [(length ft, slope)])."""
    if cat in ("A(V)", "A(NP)", "B(V)"):
        w = {"A(V)": 1250, "A(NP)": 2000, "B(V)": 1500}[cat]
        return w, [(5000, 1 / 20)]
    if cat in ("C", "D"):
        return (3500 if cat == "C" else 4000), [(10000, 1 / 34)]
    return 16000, [(10000, 1 / 50), (40000, 1 / 40)]


def rise(sections, x):
    z, x0 = 0.0, 0.0
    for length, slope in sections:
        if x <= x0 + length:
            return z + (x - x0) * slope
        z += length * slope
        x0 += length
    return z


def icao_tables(typ, code):
    c = code - 1
    if typ == 0:
        appr = ([60, 80, 110, 150][c], [30, 60, 60, 60][c], 0.10, [([1600, 2500, 3000, 3000][c], [0.05, 0.04, 0.0333, 0.025][c])])
        trans, rad, con = [0.20, 0.20, 0.143, 0.143][c], [2000, 2500, 4000, 4000][c], [35, 55, 75, 100][c]
        strip = ([30, 40, 55, 75][c], 30 if c == 0 else 60)
    elif typ == 1:
        secs = [([2500, 2500, 3000, 3000][c], [0.0333, 0.0333, 0.02, 0.02][c])]
        if c >= 2:
            secs += [(3600, 0.025), (8400, 0.0)]
        appr = ([140, 140, 280, 280][c], 60, 0.15, secs)
        trans, rad, con = [0.20, 0.20, 0.143, 0.143][c], [3500, 3500, 4000, 4000][c], [60, 60, 75, 100][c]
        strip = ([70, 70, 140, 140][c], 60)
    elif typ == 2:
        secs = [(3000, 0.025), (12000, 0.03)] if c < 2 else [(3000, 0.02), (3600, 0.025), (8400, 0.0)]
        appr = ([140, 140, 280, 280][c], 60, 0.15, secs)
        trans, rad, con = 0.143, [3500, 3500, 4000, 4000][c], [60, 60, 100, 100][c]
        strip = ([70, 70, 140, 140][c], 60)
    else:
        appr = (280, 60, 0.15, [(3000, 0.02), (3600, 0.025), (8400, 0.0)])
        trans, rad, con = 0.143, 4000, 100
        strip = ([70, 70, 140, 140][c], 60)
    return appr, trans, rad, con, strip


def takeoff_table(code):
    return {1: (60, 30, 0.10, 380, 1600, 0.05), 2: (80, 60, 0.10, 580, 2500, 0.04)}.get(code, (180, 60, 0.125, 1200, 15000, 0.02))


def ofz_table(typ, code, code_f):
    """Table 4-1 columns (9) to (11): widths, slopes, and the balked landing inner edge distance."""
    if typ == 2 and code <= 2:
        return {"w": 90.0, "ia": 0.025, "it": 0.40, "bl": 0.04, "dist": "strip"}
    return {"w": 140.0 if code_f else 120.0, "ia": 0.02, "it": 0.333, "bl": 0.0333, "dist": 1800.0}


def tris_of_strip(lower, upper):
    """Triangles between two polylines of (u, t, z) with the same stations."""
    out = []
    for a, b, c, d in zip(lower, lower[1:], upper, upper[1:]):
        out.append((a, b, d))
        out.append((a, d, c))
    return out


def ofz_mesh(E, O, L, strip_ext, h_elev, code, code_f):
    """Half (t >= 0) of the zone of the precision approach to end E, the far end being O.

    u is metres after the threshold along the landing direction, t the offset from the centre line.
    Returns [(kind, triangle)], each triangle three (u, t, z) vertices.
    """
    tb = ofz_table(E["icao"], code, code_f)
    disp = E.get("disp", 0.0)
    zthr = E["thrElev"] if E.get("thrElev") is not None else E["elev"]
    w0 = tb["w"] / 2

    def centre(u):
        f = min(1.0, max(0.0, (u + disp) / L))
        return E["elev"] + (O["elev"] - E["elev"]) * f

    ub = L - disp + strip_ext if tb["dist"] == "strip" else min(tb["dist"], L - disp)
    zb = centre(ub)
    bl_len = max(0.0, (h_elev - zb) / tb["bl"])

    # Inner approach: a rectangle from 60 m to 960 m before the threshold, rising outwards.
    far = -960.0
    near = -60.0
    zfar = zthr + 900.0 * tb["ia"]
    ia = [(near, 0.0, zthr), (near, w0, zthr), (far, w0, zfar), (far, 0.0, zfar)]
    mesh = [("innerApproach", (ia[0], ia[1], ia[2])), ("innerApproach", (ia[0], ia[2], ia[3]))]
    # The strip between the inner edges, at the height of the nearest centre line point.
    cuts = sorted({near, ub, *[u for u in (-disp, L - disp) if near < u < ub]})
    for a, b in zip(cuts, cuts[1:]):
        p = [(a, 0.0, centre(a)), (b, 0.0, centre(b)), (b, w0, centre(b)), (a, w0, centre(a))]
        mesh += [("ofzStrip", (p[0], p[1], p[2])), ("ofzStrip", (p[0], p[2], p[3]))]
    # Balked landing: a trapezoid from its inner edge up to the plane of the inner horizontal.
    wout = w0 + 0.10 * bl_len
    if bl_len > 0:
        b = [(ub, 0.0, zb), (ub, w0, zb), (ub + bl_len, wout, h_elev), (ub + bl_len, 0.0, h_elev)]
        mesh += [("balkedLanding", (b[0], b[1], b[2])), ("balkedLanding", (b[0], b[2], b[3]))]
    # Inner transitional: its lower edge is the side of the three parts above, in order; each station
    # reaches out at the table's slope to the plane of the inner horizontal.
    # At the inner edge it steps from the threshold's stated elevation to the nearest centre line
    # point, where a stated threshold elevation is off the straight profile between the runway ends.
    edge = [(far, w0, zfar), (near, w0, zthr)] + [(u, w0, centre(u)) for u in cuts]
    if bl_len > 0:
        edge.append((ub + bl_len, wout, h_elev))
    # Where the lower edge itself passes the plane there is no surface: cut the edge there.
    cut = []
    for a, b in zip(edge, edge[1:]):
        cut.append(a)
        if (a[2] - h_elev) * (b[2] - h_elev) < 0:
            f = (h_elev - a[2]) / (b[2] - a[2])
            cut.append(tuple(p + (q - p) * f for p, q in zip(a, b)))
    cut.append(edge[-1])
    runs, run = [], []
    for p in cut:
        if p[2] <= h_elev + 1e-9:
            run.append(p)
        else:
            if len(run) > 1:
                runs.append(run)
            run = []
    if len(run) > 1:
        runs.append(run)
    for run in runs:
        upper = [(u, t + (h_elev - z) / tb["it"], h_elev) for u, t, z in run]
        mesh += [("innerTransitional", q) for q in tris_of_strip(run, upper)]
    return mesh


def ofz_eval(rws, lats, lons, h_elev, code_f):
    """Lowest zone surface at each position: (heights, kinds)."""
    n = len(lats)
    best = np.full(n, np.inf)
    kind = np.full(n, None, dtype=object)
    for rw in rws:
        A, B, L = rw["A"], rw["B"], rw["L"]
        ends = [e for e in (A, B) if e.get("approach", True) and e["icao"] >= 2]
        if not ends:
            continue
        fa, _, da = G.inv(np.full(n, A["lon"]), np.full(n, A["lat"]), lons, lats)
        fb, _, db = G.inv(np.full(n, B["lon"]), np.full(n, B["lat"]), lons, lats)
        sa = da * np.cos(np.radians(fa - rw["azAB"]))
        ta = np.abs(da * np.sin(np.radians(fa - rw["azAB"])))
        sb = db * np.cos(np.radians(fb - rw["azBA"]))
        tb = np.abs(db * np.sin(np.radians(fb - rw["azBA"])))
        near_a = sa <= L / 2
        s_from_a = np.where(near_a, sa, L - sb)
        t = np.where(near_a, ta, tb)
        for E in ends:
            O = B if E is A else A
            s = s_from_a if E is A else L - s_from_a
            u = s - E.get("disp", 0.0)
            for k, (p, q, r) in ofz_mesh(E, O, L, rw["ext"], h_elev, rw["code"], code_f):
                d = (q[1] - r[1]) * (p[0] - r[0]) + (r[0] - q[0]) * (p[1] - r[1])
                if abs(d) < 1e-12:
                    continue
                l1 = ((q[1] - r[1]) * (u - r[0]) + (r[0] - q[0]) * (t - r[1])) / d
                l2 = ((r[1] - p[1]) * (u - r[0]) + (p[0] - r[0]) * (t - r[1])) / d
                l3 = 1 - l1 - l2
                z = l1 * p[2] + l2 * q[2] + l3 * r[2]
                hit = (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9) & (z < best)
                best[hit] = z[hit]
                kind[hit] = k
    return best, kind


# ---- Annex 14 Amendment 18, Chapter 4 as applicable from 21 November 2030 (regime "icao-a18") ----
# Typed from the amendment's printed Tables 4-1 to 4-15 (PDF pp.38-60), not from the kernel. Columns
# are the tables' ADG columns: I | IIA-IIB | IIC | III | IV | V; Table 4-10's are I-IIA | IIB | IIC |
# III | IV | V. The readings taken where the document is silent or ambiguous are the kernel's
# assumptions (crates/gw-aviation/src/a18.rs A_*), restated here in words where they are used.
ADG = ["I", "IIA", "IIB", "IIC", "III", "IV", "V"]
A18_T41 = {"dist": [30, 60, 60, 60, 60, 60], "edge": [60, 80, 100, 125, 135, 150], "len": [1600, 2500, 2500, 2500, 2500, 2500], "slope": [0.05, 0.04, 0.0333, 0.0333, 0.0333, 0.0333]}
A18_T42 = {"dist": [60] * 6, "edge": [110, 125, 155, 175, 185, 200], "len": [4500] * 6, "slope": [0.0333] * 6}
A18_INNER = {0: ([60, 80, 100, 110, 120, 120], [900, 1125, 1350, 1350, 1350, 1350]), 1: ([80, 80, 120, 120, 120, 120], [1350] * 6), 2: ([90, 90, 120, 120, 120, 120], [1350] * 6)}
A18_VERT = {0: [6, 6, 8.4, 10, 5, 5], 1: [6, 6, 5, 5, 5, 5]}
A18_IT_SLOPE = [0.40, 0.40, 0.333, 0.333, 0.333, 0.333]
A18_BALKED_SLOPE = [0.05, 0.04, 0.0333, 0.0333, 0.0333, 0.0333]
A18_HORIZ = ([3350, 5350, 10750, 10750, 10750, 10750], [45, 60, 90, 90, 90, 90])
A18_T414 = [(30, 60, 0.10, 380, 1600, 0.05), (60, 80, 0.10, 580, 2500, 0.04)]
A18_T415_EDGE = [144, 156, 156, 172, 180, 180]
A18_T415_SLOPE = [0.05, 0.04, 0.02, 0.02, 0.02, 0.02]


def a18_col(adg):
    return [0, 1, 1, 2, 3, 4, 5][adg - 1]


def a18_col10(adg):
    return [0, 0, 1, 2, 3, 4, 5][adg - 1]


def a18_edge(instrument, c, width):
    """Tables 4-1 and 4-2 inner edge with the runway-width notes (none when the width is unknown)."""
    tb = A18_T42 if instrument else A18_T41
    if width is None:
        return tb["edge"][c]
    if not instrument:
        if c == 0:
            return 100 if width > 30 else 80 if width > 23 else 60
        if c in (1, 2) and width > 45:
            return 110
        if c == 1 and width > 30:
            return 100
        return tb["edge"][c]
    if c == 0 and width > 30:
        return 125
    if c == 1 and width > 30:
        return 140
    if c == 2 and width <= 30:
        return 140
    return tb["edge"][c]


class Mesh:
    """Triangles in (s, t, z) about one runway: s along it from end A, t >= 0 off its centre line."""

    def __init__(self):
        self.tris = []

    def quad(self, kind, ofs, a, b, c, d):
        self.tris.append((kind, ofs, (a, b, c)))
        self.tris.append((kind, ofs, (a, c, d)))


def lin(p, q, f):
    return tuple(a + (b - a) * f for a, b in zip(p, q))


def fan_mesh(mesh, kind, ofs, s0, d, hw0, sections, base, hwmax=math.inf, side=None):
    """A fan from station s0 running in direction d: its top (t >= 0 half) as planar quads between
    its breaks, and its lateral surface (slope, kind, top) as planar bands up to the top."""
    xs = [0.0]
    for length, _, _ in sections:
        xs.append(xs[-1] + length)
    total = xs[-1]

    def at(x):
        z, hw, x0 = base, hw0, 0.0
        for length, slope, div in sections:
            dx = min(max(x - x0, 0.0), length)
            z += dx * slope
            hw += dx * div
            x0 += length
        return z, min(hw, hwmax)

    # Breaks: section ends, where the half-width reaches its final value, where the fan passes its
    # lateral surface's top.
    brk = set(xs)
    x0 = 0.0
    hw = hw0
    for length, slope, div in sections:
        if div > 0 and hw < hwmax < hw + length * div:
            brk.add(x0 + (hwmax - hw) / div)
        hw += length * div
        x0 += length
    if side:
        x0, z = 0.0, base
        for length, slope, _ in sections:
            if slope > 0 and z < side[2] < z + length * slope:
                brk.add(x0 + (side[2] - z) / slope)
            x0 += length
            z += length * slope
    xs = sorted(x for x in brk if 0 <= x <= total)
    for xa, xb in zip(xs, xs[1:]):
        (za, ha), (zb, hb) = at(xa), at(xb)
        sa, sb = s0 + d * xa, s0 + d * xb
        mesh.quad(kind, ofs, (sa, 0.0, za), (sb, 0.0, zb), (sb, hb, zb), (sa, ha, za))
        if side and za < side[2] - 1e-9:
            slope, skind, top = side
            mesh.quad(skind, ofs, (sa, ha, za), (sb, hb, zb), (sb, hb + (top - zb) / slope, top), (sa, ha + (top - za) / slope, top))


def a18_runway(rw, r, ap, mesh, horiz_discs, rects):
    """Every runway-attached Amendment 18 surface of one runway as triangles, and its horizontal discs."""
    A, B, L = rw["A"], rw["B"], rw["L"]
    adg = r["adg"]
    c = a18_col(adg)
    width = r.get("width")
    mtom = r.get("mtom")
    typ = max(A["icao"], B["icao"])
    # Chapter 3 strip (the current edition's values): the transitional's lower edge.
    hw = ([30, 40, 55, 75][r["code"] - 1] if typ == 0 else [70, 70, 140, 140][r["code"] - 1])
    ext = (30 if r["code"] == 1 else 60) if typ == 0 else 60
    rw["hw"], rw["ext"] = hw, ext
    thr = [E["thrElev"] if E.get("thrElev") is not None else E["elev"] for E in (A, B)]
    top = max(thr) + 60.0
    elevA, elevB = A["elev"], B["elev"]

    def centre(s):
        return elevA + (elevB - elevA) * min(1.0, max(0.0, s / L))

    # The strip (not an OFS) and the 20 % transitional off its edge, up to 60 m above the highest threshold.
    cuts = [-ext, 0.0, L, L + ext]
    for sa, sb in zip(cuts, cuts[1:]):
        za, zb = centre(sa), centre(sb)
        mesh.quad("strip", False, (sa, 0.0, za), (sb, 0.0, zb), (sb, hw, zb), (sa, hw, za))
        mesh.quad("transitional", True, (sa, hw, za), (sb, hw, zb), (sb, hw + (top - zb) / 0.20, top), (sa, hw + (top - za) / 0.20, top))
    s_thr = [A.get("disp", 0.0), L - B.get("disp", 0.0)]
    appr = [E["icao"] for E in (A, B) if E.get("approach", True)]
    best = max(appr) if appr else None
    if best == 1:
        # The straight-in surface instead of the horizontal: lower = ADG I horizontal; upper = a 7 410 m
        # wide rectangle reaching 5 350 m beyond the thresholds, 60 m up.
        for s in s_thr:
            horiz_discs.setdefault("straight", []).append((rw, s, 3350.0))
        rects.append((rw, s_thr[0] - 5350.0, s_thr[1] + 5350.0, 3705.0, ap["elev"] + 60.0))
    else:
        k = a18_col10(adg)
        for s in s_thr:
            horiz_discs.setdefault(k, []).append((rw, s, A18_HORIZ[0][k]))
    for k, E in enumerate((A, B)):
        out = -1.0 if k == 0 else 1.0
        end_s = 0.0 if k == 0 else L
        if E.get("approach", True):
            inst = E["icao"] >= 1
            tb = A18_T42 if inst else A18_T41
            fan_mesh(mesh, "approach", True, s_thr[k] + out * tb["dist"][c], out, a18_edge(inst, c, width) / 2, [(tb["len"][c], tb["slope"][c], 0.10)], thr[k], side=(0.20, "transitional", top))
            if E["icao"] >= 2:
                side = (0.143, "precisionTransitional", thr[k] + 300.0)
                fan_mesh(mesh, "precisionApproach", False, s_thr[k] + out * 60, out, 150, [(3000, 0.02, 0.15), (9600, 0.025, 0.15)], thr[k], side=side)
                fan_mesh(mesh, "precisionMissedApproach", False, s_thr[k] - out * 900, -out, 150, [(1800, 0.025, 0.1748), (10200, 0.025, 0.25)], thr[k], side=side)
                fan_mesh(mesh, "precisionLower", False, s_thr[k] + out * 60, -out, 150, [(960, 0.0, 0.0)], thr[k], side=side)
        if E.get("takeoff", True):
            cw = E.get("clearway", 0.0)
            if mtom <= 5700 and c <= 1:
                d0, edge, div, wf, length, slope = A18_T414[c]
                start = max(d0, cw)
            else:
                edge, div, wf, length, slope = A18_T415_EDGE[c], 0.125, 1800, 10000, A18_T415_SLOPE[c]
                start = cw
            if r.get("tocsWidth") is not None:
                wf = r["tocsWidth"]
            fan_mesh(mesh, "takeoff", False, end_s + out * start, out, edge / 2, [(length, slope, div)], E["elev"], hwmax=wf / 2)
            if (best or 0) >= 1:
                fan_mesh(mesh, "departure", False, end_s + out * cw, out, 150, [(3500, 0.025, 0.268), (8300, 0.025, 0.578)], E["elev"] + 5.0)
    # Inner approach, inner transitional, balked landing: in (u after the threshold, t) of the landing
    # direction, then mapped to s.
    for k, E in enumerate((A, B)):
        if not E.get("approach", True):
            continue
        ty = min(E["icao"], 2)
        tb = A18_T42 if E["icao"] >= 1 else A18_T41
        w = A18_INNER[ty][0][c]
        if c == 5 and ap.get("codeF"):
            w = 140
        w0 = w / 2
        dist, ia_len, ia_slope = tb["dist"][c], A18_INNER[ty][1][c], tb["slope"][c]
        run = L - E.get("disp", 0.0)
        ub = run + ext if c <= 1 else min(1800.0, run)
        vert = 0.0 if ty == 2 else A18_VERT[ty][c]
        its = A18_IT_SLOPE[c]
        sgn = 1.0 if k == 0 else -1.0

        def to_s(u, sgn=sgn, k=k):
            return s_thr[k] + sgn * u

        def cen(u, to_s=to_s):
            return centre(to_s(u))

        far, near = -(dist + ia_len), -dist
        zfar = thr[k] + ia_len * ia_slope
        S = lambda p, to_s=to_s: (to_s(p[0]), p[1], p[2])
        mesh.quad("innerApproach", True, *[S(p) for p in [(near, 0.0, thr[k]), (near, w0, thr[k]), (far, w0, zfar), (far, 0.0, zfar)]])
        ucuts = sorted({near, ub, *[u for u in (-E.get("disp", 0.0), run) if near < u < ub]})
        for a, b in zip(ucuts, ucuts[1:]):
            mesh.quad("ofzStrip", True, *[S(p) for p in [(a, 0.0, cen(a)), (b, 0.0, cen(b)), (b, w0, cen(b)), (a, w0, cen(a))]])
        edge = [(far, w0, zfar), (near, w0, thr[k])] + [(u, w0, cen(u)) for u in ucuts]
        if ty == 2:
            zb = cen(ub)
            bl_len = max(0.0, (top - zb) / A18_BALKED_SLOPE[c])
            if bl_len > 0:
                wout = w0 + 0.10 * bl_len
                mesh.quad("balkedLanding", True, *[S(p) for p in [(ub, 0.0, zb), (ub, w0, zb), (ub + bl_len, wout, top), (ub + bl_len, 0.0, top)]])
                edge.append((ub + bl_len, wout, top))
        # The inner transitional off that edge: a vertical section of `vert`, then `its` up to the top.
        raised = [(u, t, z + vert) for u, t, z in edge]
        cut = []
        for a, b in zip(raised, raised[1:]):
            cut.append(a)
            if (a[2] - top) * (b[2] - top) < 0:
                cut.append(lin(a, b, (top - a[2]) / (b[2] - a[2])))
        cut.append(raised[-1])
        runs, cur = [], []
        for p in cut:
            if p[2] <= top + 1e-9:
                cur.append(p)
            else:
                if len(cur) > 1:
                    runs.append(cur)
                cur = []
        if len(cur) > 1:
            runs.append(cur)
        for run_ in runs:
            upper = [(u, t + (top - z) / its, top) for u, t, z in run_]
            for (a, b), (cc, dd) in zip(zip(run_, run_[1:]), zip(upper, upper[1:])):
                if abs(a[0] - b[0]) < 1e-9:
                    continue
                mesh.quad("innerTransitional", True, S(a), S(b), S(dd), S(cc))


def a18_main(spec):
    ap = spec["airport"]
    pts = np.array(spec["points"], dtype=float).reshape(-1, 2)
    lats, lons = pts[:, 0], pts[:, 1]
    n = len(lats)
    lat0 = sum(e["lat"] for r in ap["runways"] for e in r["ends"]) / (2 * len(ap["runways"]))
    lon0 = sum(e["lon"] for r in ap["runways"] for e in r["ends"]) / (2 * len(ap["runways"]))
    aeqd = Transformer.from_crs("EPSG:4326", f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +ellps=WGS84 +units=m", always_xy=True)
    best = np.full(n, np.inf)
    kind = np.full(n, None, dtype=object)
    zbest = np.full(n, np.inf)
    zkind = np.full(n, None, dtype=object)

    def take(z, k, ofs, hit):
        m = hit & (z < best)
        best[m] = z[m]
        kind[m] = k
        if ofs:
            m = hit & (z < zbest)
            zbest[m] = z[m]
            zkind[m] = k

    horiz_discs, rects = {}, []
    for r in ap["runways"]:
        A, B = r["ends"]
        azAB, azBA, L = G.inv(A["lon"], A["lat"], B["lon"], B["lat"])
        rw = {"A": A, "B": B, "azAB": azAB, "azBA": azBA, "L": L}
        mesh = Mesh()
        a18_runway(rw, r, ap, mesh, horiz_discs, rects)
        fa, _, da = G.inv(np.full(n, A["lon"]), np.full(n, A["lat"]), lons, lats)
        fb, _, db = G.inv(np.full(n, B["lon"]), np.full(n, B["lat"]), lons, lats)
        sa = da * np.cos(np.radians(fa - azAB))
        ta = np.abs(da * np.sin(np.radians(fa - azAB)))
        sb = db * np.cos(np.radians(fb - azBA))
        tb = np.abs(db * np.sin(np.radians(fb - azBA)))
        near_a = sa <= L / 2
        s = np.where(near_a, sa, L - sb)
        t = np.where(near_a, ta, tb)
        rw["s"], rw["t"] = s, t
        for k, ofs, (p, q, rr) in mesh.tris:
            d = (q[1] - rr[1]) * (p[0] - rr[0]) + (rr[0] - q[0]) * (p[1] - rr[1])
            if abs(d) < 1e-12:
                continue
            l1 = ((q[1] - rr[1]) * (s - rr[0]) + (rr[0] - q[0]) * (t - rr[1])) / d
            l2 = ((rr[1] - p[1]) * (s - rr[0]) + (p[0] - rr[0]) * (t - rr[1])) / d
            l3 = 1 - l1 - l2
            z = l1 * p[2] + l2 * q[2] + l3 * rr[2]
            take(z, k, ofs, (l1 >= -1e-9) & (l2 >= -1e-9) & (l3 >= -1e-9))
    for rw, s0, s1, hw, z in rects:
        take(np.full(n, z), "straightIn", False, (rw["t"] <= hw) & (rw["s"] >= s0) & (rw["s"] <= s1))
    # Horizontal surfaces (and the straight-in lower section): the convex hull of circles about the
    # thresholds, by shapely in an azimuthal equidistant projection.
    px, py = aeqd.transform(lons, lats)
    for key, discs in horiz_discs.items():
        polys = []
        for rw, s, rad in discs:
            A = rw["A"]
            lon, lat, _ = G.fwd(A["lon"], A["lat"], rw["azAB"], s) if s >= 0 else G.fwd(A["lon"], A["lat"], rw["azAB"] + 180.0, -s)
            x, y = aeqd.transform(lon, lat)
            polys.append(Point(x, y).buffer(rad, quad_segs=512))
        hull = unary_union(polys).convex_hull
        inside = np.array([hull.contains(Point(a, b)) for a, b in zip(px, py)])
        z = ap["elev"] + (A18_HORIZ[1][key] if key != "straight" else 45.0)
        take(np.full(n, z), "horizontal" if key != "straight" else "straightIn", False, inside)
    fin = lambda v: [float(x) if math.isfinite(x) else None for x in v]
    return {"limit": fin(best), "kind": [k for k in kind], "ofzLimit": fin(zbest), "ofzKind": [k for k in zkind]}


def main(inp, outp):
    spec = json.load(open(inp, encoding="utf8"))
    regime = spec["regime"]
    ap = spec["airport"]
    if regime == "icao-a18":
        json.dump(a18_main(spec), open(outp, "w", encoding="utf8"))
        return
    icao = regime == "icao"
    lats = [e["lat"] for r in ap["runways"] for e in r["ends"]]
    lons = [e["lon"] for r in ap["runways"] for e in r["ends"]]
    lat0, lon0 = sum(lats) / len(lats), sum(lons) / len(lons)
    aeqd = Transformer.from_crs("EPSG:4326", f"+proj=aeqd +lat_0={lat0} +lon_0={lon0} +ellps=WGS84 +units=m", always_xy=True)

    rws = []
    circles = []
    ihs_rad, con_h = 0.0, 0.0
    for r in ap["runways"]:
        A, B = r["ends"]
        azAB, azBA, L = G.inv(A["lon"], A["lat"], B["lon"], B["lat"])
        rw = {"A": A, "B": B, "azAB": azAB, "azBA": azBA, "L": L, "code": r.get("code", 4)}
        if not icao:
            cats = [A["p77"], B["p77"]]
            utility = all(c in ("A(V)", "A(NP)") for c in cats)
            if utility:
                pw = 250 if all(c == "A(V)" for c in cats) else 500
            else:
                pw = 1000 if any(c in ("D", "PIR") for c in cats) else 500
            rw["hw"] = pw * FT / 2
            rw["ext"] = 200 * FT if r["paved"] else 0.0
            rw["trans"] = 1 / 7
            rad = (5000 if all(c in ("A(V)", "A(NP)", "B(V)") for c in cats) else 10000) * FT
            fans = []
            for k, (E, az_out) in enumerate([(A, azBA + 0.0), (B, azAB)]):
                w, secs = p77_dims(E["p77"])
                secs = [(l * FT, s) for l, s in secs]
                total = sum(l for l, _ in secs)
                fans.append({"kind": "approach", "k": k, "x0": rw["ext"], "hw0": rw["hw"], "div": (w * FT / 2 - rw["hw"]) / total, "hwmax": math.inf, "secs": secs, "len": total, "base": E["elev"], "pir": E["p77"] == "PIR"})
            rw["fans"] = fans
            ext_rad = rad
        else:
            typ = max(A["icao"], B["icao"])
            appr, trans, rad, con, strip = icao_tables(typ, rw["code"])
            rw["hw"], rw["ext"] = strip
            rw["trans"] = trans
            ihs_rad, con_h = max(ihs_rad, rad), max(con_h, con)
            fans = []
            for k, E in enumerate([A, B]):
                if E.get("approach", True):
                    l0, d0, div, secs = icao_tables(E["icao"], rw["code"])[0]
                    total = sum(l for l, _ in secs)
                    thr = E.get("thrElev")
                    fans.append({"kind": "approach", "k": k, "x0": d0 - E.get("disp", 0.0), "hw0": l0 / 2, "div": div, "hwmax": math.inf, "secs": secs, "len": total, "base": thr if thr is not None else E["elev"], "pir": False})
                if E.get("takeoff", True):
                    l0, d0, div, wf, length, slope = takeoff_table(rw["code"])
                    if r.get("tocsWidth") is not None:
                        wf = r["tocsWidth"]
                    fans.append({"kind": "takeoff", "k": k, "x0": max(d0, E.get("clearway", 0.0)), "hw0": l0 / 2, "div": div, "hwmax": wf / 2, "secs": [(length, slope)], "len": length, "base": E["elev"], "pir": False})
            rw["fans"] = fans
            ext_rad = None
        # Circle centres: the primary-surface ends (Part 77) or strip ends (Annex 14), on the extended centreline.
        for E, az in ((A, azBA), (B, azAB)):
            # Outward from A is the azimuth from A away from B: azAB + 180.
            pass
        cA = G.fwd(A["lon"], A["lat"], azAB + 180.0, rw["ext"])
        cB = G.fwd(B["lon"], B["lat"], azBA + 180.0, rw["ext"])
        rw["cA"], rw["cB"] = cA, cB
        circles.append((cA, ext_rad))
        circles.append((cB, ext_rad))
        rws.append(rw)

    if icao:
        circles = [(c, ihs_rad) for c, _ in circles]
        h_elev = (ap.get("ihsDatum") if ap.get("ihsDatum") is not None else ap["elev"]) + 45.0
        reach, cslope, hkind = con_h / 0.05, 0.05, "innerHorizontal"
    else:
        h_elev = ap["elev"] + 150 * FT
        reach, cslope, hkind = 4000 * FT, 1 / 20, "horizontal"
    discs = []
    for (lon, lat, _), rad in circles:
        x, y = aeqd.transform(lon, lat)
        discs.append(Point(x, y).buffer(rad, quad_segs=512))
    hull = unary_union(discs).convex_hull

    out_l, out_k = [], []
    for lat, lon in spec["points"]:
        px, py = aeqd.transform(lon, lat)
        P = Point(px, py)
        inside = hull.contains(P)
        dout = 0.0 if inside else hull.exterior.distance(P)
        in_fp = dout <= reach
        cands = []
        if inside:
            cands.append((h_elev, hkind))
        elif in_fp:
            cands.append((h_elev + dout * cslope, "conical"))
        for rw in rws:
            A, B, L = rw["A"], rw["B"], rw["L"]
            fa, aza, da = G.inv(A["lon"], A["lat"], lon, lat)
            fb, azb, db = G.inv(B["lon"], B["lat"], lon, lat)
            # Station from A along A→B and offset; for the far half, from B (more accurate there).
            sa = da * math.cos(math.radians(fa - rw["azAB"]))
            ta = abs(da * math.sin(math.radians(fa - rw["azAB"])))
            sb = db * math.cos(math.radians(fb - rw["azBA"]))
            tb = abs(db * math.sin(math.radians(fb - rw["azBA"])))
            s, t = (sa, ta) if sa <= L / 2 else (L - sb, tb)
            ext, hw = rw["ext"], rw["hw"]
            if -ext <= s <= L + ext:
                base = A["elev"] + (B["elev"] - A["elev"]) * min(1.0, max(0.0, s / L))
                if t <= hw:
                    cands.append((base, "strip" if icao else "primary"))
                else:
                    z = base + (t - hw) * rw["trans"]
                    if (icao and z <= h_elev) or (not icao and in_fp):
                        cands.append((z, "transitional"))
            for f in rw["fans"]:
                # Outward distance beyond the end and offset, about that end.
                if f["k"] == 0:
                    xo, tt = -sa - f["x0"], ta
                else:
                    xo, tt = -sb - f["x0"], tb
                if f["kind"] == "approach" and not (0 < xo <= f["len"]):
                    continue
                if f["kind"] == "takeoff" and not (0 <= xo <= f["len"]):
                    continue
                half = min(f["hw0"] + f["div"] * xo, f["hwmax"])
                za = f["base"] + rise(f["secs"], xo)
                if tt <= half:
                    cands.append((za, f["kind"]))
                elif f["kind"] == "approach":
                    z = za + (tt - half) * rw["trans"]
                    ok = (z <= h_elev) if icao else (in_fp or (f["pir"] and tt - half <= 5000 * FT))
                    if ok:
                        cands.append((z, "transitional"))
        if cands:
            z, k = min(cands, key=lambda c: c[0])
            out_l.append(z)
            out_k.append(k)
        else:
            out_l.append(None)
            out_k.append(None)
    ofz_l, ofz_k = [None] * len(out_l), [None] * len(out_l)
    if icao:
        pts = np.array(spec["points"], dtype=float).reshape(-1, 2)
        best, kind = ofz_eval(rws, pts[:, 0], pts[:, 1], h_elev, bool(ap.get("codeF")))
        for i in range(len(out_l)):
            if not math.isfinite(best[i]):
                continue
            ofz_l[i], ofz_k[i] = float(best[i]), kind[i]
            # The zone can be the lowest limit where nothing lower lies, as beyond the far end of a
            # runway with no approach or take-off climb there.
            if out_l[i] is None or best[i] < out_l[i]:
                out_l[i], out_k[i] = float(best[i]), kind[i]
    json.dump({"limit": out_l, "kind": out_k, "ofzLimit": ofz_l, "ofzKind": ofz_k}, open(outp, "w", encoding="utf8"))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
