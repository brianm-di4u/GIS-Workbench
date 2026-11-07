"""A synthetic UAV block with exact truth (REQ-GAP-29): the only place heights can be measured.

    python -I sfm26_synth.py make  <dir>                 photographs in <dir>/images, truth in <dir>/truth.json
    python -I sfm26_synth.py check <dir> <out.dsm.tif> <out.ortho.tif> <frames.geojson> <report.json>

The ODM data sets have no surveyed surface, so the fit to their GPS shows only that the block is
consistent. Here terrain, two flat-roofed buildings, texture and camera positions are all known. The
camera model is the ideal pinhole, and GPS is exact, so what is measured is the route's own error:
the best it can do, not what a real flight will get.

Rendered by ray marching a height function; the texture is sampled at the surface. Truth for any
(east, north) comes from the same functions.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from PIL.TiffImagePlugin import IFDRational
from pyproj import Transformer
from scipy.ndimage import gaussian_filter, map_coordinates

W, H = 1600, 1200
SENSOR_35MM_FOCAL = 35  # EXIF FocalLengthIn35mmFilm
# COLMAP reads that tag by the CIPA rule, on the diagonal: this makes its prior exactly the truth, so
# GWB_SYNTH_F_ERROR can set how wrong the prior is (the height error should follow it).
FX = SENSOR_35MM_FOCAL / 43.27 * np.hypot(W, H) * (1.0 + float(os.environ.get("GWB_SYNTH_F_ERROR", "0")))
AGL = 100.0
E0, N0 = 437000.0, 4572000.0
GROUND = 250.0
TEX_M = 0.04  # texture cell, metres
TEX_SPAN = 400.0
TO_LL = Transformer.from_crs(32617, 4326, always_xy=True)
BUILDINGS = [(150.0, 170.0, 190.0, 195.0, 6.0), (230.0, 120.0, 255.0, 150.0, 9.0)]  # x0, y0, x1, y1, height


def surface(x, y):
    z = GROUND + 4.0 * np.sin(x / 37.0) * np.cos(y / 53.0) + 2.0 * np.sin(x / 11.0 + y / 17.0)
    for x0, y0, x1, y1, b in BUILDINGS:
        z = np.where((x >= x0) & (x <= x1) & (y >= y0) & (y <= y1), GROUND + b, z)
    return z


def texture():
    rng = np.random.default_rng(26)
    n = int(TEX_SPAN / TEX_M)
    t = np.zeros((n, n), np.float32)
    for s, a in [(1.5, 0.30), (4, 0.30), (12, 0.25), (40, 0.20), (160, 0.20)]:
        layer = gaussian_filter(rng.standard_normal((n // 2, n // 2)).astype(np.float32), s / 2.0)
        layer = np.kron(layer, np.ones((2, 2), np.float32))[:n, :n]
        t += a * layer / layer.std()
    return np.clip(0.45 + 0.18 * t, 0.0, 1.0)


def rational(v):
    return IFDRational(int(round(v * 1_000_000)), 1_000_000)


def exif_of(lat, lon, alt):
    def dms(a):
        a = abs(a)
        d = int(a)
        m = int((a - d) * 60)
        return (IFDRational(d, 1), IFDRational(m, 1), rational((a - d - m / 60) * 3600))

    ex = Image.Exif()
    ex[0x010F] = "GWB"
    ex[0x0110] = "SYNTH1"
    sub = ex.get_ifd(0x8769)
    sub[0xA405] = SENSOR_35MM_FOCAL
    gps = ex.get_ifd(0x8825)
    gps[1] = "N" if lat >= 0 else "S"
    gps[2] = dms(lat)
    gps[3] = "E" if lon >= 0 else "W"
    gps[4] = dms(lon)
    gps[5] = 0
    gps[6] = rational(alt)
    return ex


def make(root):
    root = Path(root)
    (root / "images").mkdir(parents=True, exist_ok=True)
    tex = texture()
    rng = np.random.default_rng(1)
    cams = []
    # Six strips of eleven. The footprint is 99 by 74 m, so about 60 % overlap across strips and 69 %
    # along them, as a survey would fly.
    for s, x in enumerate(np.linspace(100.0, 300.0, 6)):
        for i, y in enumerate(np.linspace(80.0, 320.0, 11)):
            cams.append((f"S{s}_{i:02d}.jpg", float(x), float(y), GROUND + AGL))
    u = (np.arange(W) + 0.5 - W / 2) / FX
    v = (np.arange(H) + 0.5 - H / 2) / FX
    uu, vv = np.meshgrid(u, v)
    truth = []
    for name, cx, cy, cz in cams:
        # Nadir, north up: image x is east, image y is south, the ray goes down.
        h = np.full_like(uu, GROUND)
        for _ in range(40):
            d = cz - h
            h = surface(cx + uu * d, cy - vv * d)
        d = cz - h
        ex, ny = cx + uu * d, cy - vv * d
        col = np.clip(ex / TEX_M, 0, tex.shape[1] - 1)
        row = np.clip(ny / TEX_M, 0, tex.shape[0] - 1)
        g = map_coordinates(tex, [row, col], order=1)
        rgb = np.stack([g * 0.95, g, g * 0.85], axis=2) * 255 + rng.normal(0, 1.0, (H, W, 3))
        lon, lat = TO_LL.transform(E0 + cx, N0 + cy)
        Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(root / "images" / name, quality=92, exif=exif_of(lat, lon, cz))
        truth.append({"name": name, "east": E0 + cx, "north": N0 + cy, "height": cz})
    (root / "truth.json").write_text(json.dumps({"cameras": truth, "gsd_m": AGL / FX}, indent=1))
    print(f"{len(cams)} photographs, ground sample distance {AGL / FX:.4f} m")


def stats(d):
    d = d[np.isfinite(d)]
    med = float(np.median(d))
    return {"n": int(d.size), "bias_m": med, "nmad_m": float(1.4826 * np.median(np.abs(d - med))), "rmse_m": float(np.sqrt(np.mean(d * d))), "abs_p95_m": float(np.percentile(np.abs(d), 95))}


def lateral(ours, truth):
    """Sub-pixel shift between two images by phase correlation, in pixels (x, y)."""
    a = (ours - ours.mean()) * np.hanning(ours.shape[0])[:, None] * np.hanning(ours.shape[1])[None, :]
    b = (truth - truth.mean()) * np.hanning(ours.shape[0])[:, None] * np.hanning(ours.shape[1])[None, :]
    (dx, dy), resp = __import__("cv2").phaseCorrelate(b.astype(np.float64), a.astype(np.float64))
    return float(dx), float(dy), float(resp)


def check(root, dsm_path, ortho_path, frames_path, report_path):
    import rasterio

    root = Path(root)
    tr = json.loads((root / "truth.json").read_text())
    with rasterio.open(dsm_path) as ds:
        z = ds.read(1).astype(np.float64)
        z[z == ds.nodata] = np.nan
        t = ds.transform
        cols, rows = np.meshgrid(np.arange(ds.width) + 0.5, np.arange(ds.height) + 0.5)
        x, y = rasterio.transform.xy(t, rows.ravel() - 0.5, cols.ravel() - 0.5, offset="center")
        x = np.asarray(x).reshape(z.shape) - E0
        y = np.asarray(y).reshape(z.shape) - N0
        res = abs(t.a)
    true_z = surface(x, y)
    # Cells near a building's wall are mixed: the wall itself is a step no raster can hold.
    near = np.zeros_like(z, bool)
    for x0, y0, x1, y1, _ in BUILDINGS:
        m = 2.0
        near |= (x > x0 - m) & (x < x1 + m) & (y > y0 - m) & (y < y1 + m) & ~((x > x0 + m) & (x < x1 - m) & (y > y0 + m) & (y < y1 - m))
    roof = np.zeros_like(z, bool)
    for x0, y0, x1, y1, _ in BUILDINGS:
        roof |= (x > x0 + 2) & (x < x1 - 2) & (y > y0 + 2) & (y < y1 - 2)
    out = {
        "dsm_cell_m": res,
        "terrain": stats((z - true_z)[~near & ~roof]),
        "roofs": stats((z - true_z)[roof]),
        "coverage_of_camera_block": float(np.isfinite(z[(x > 100) & (x < 300) & (y > 80) & (y < 320)]).mean()),
    }
    with rasterio.open(ortho_path) as ds:
        g = ds.read(2).astype(np.float64)
        alpha = ds.read(4) > 0
        t = ds.transform
        px = abs(t.a)
        c0 = int((E0 + 150 - t.c) / px)
        r0 = int((t.f - (N0 + 300)) / px)
        n = int(100 / px)
        chip = g[r0:r0 + n, c0:c0 + n]
        keep = alpha[r0:r0 + n, c0:c0 + n]
    # The truth at the same pixels, from the texture.
    tex = texture()
    cc, rr = np.meshgrid(c0 + 0.5 + np.arange(chip.shape[1]), r0 + 0.5 + np.arange(chip.shape[0]))
    ex = t.c + cc * px - E0
    ny = t.f - rr * px - N0
    want = map_coordinates(tex, [np.clip(ny / TEX_M, 0, tex.shape[0] - 1), np.clip(ex / TEX_M, 0, tex.shape[1] - 1)], order=1)
    dx, dy, resp = lateral(np.where(keep, chip, chip[keep].mean()), want)
    out["ortho"] = {"pixel_m": px, "valid_share_of_chip": float(keep.mean()), "correlation": float(np.corrcoef(chip[keep], want[keep])[0, 1]), "shift_m": {"east": dx * px, "south": dy * px}, "phase_response": resp}
    # Camera positions.
    fr = json.loads(Path(frames_path).read_text())
    by = {c["name"]: c for c in tr["cameras"]}
    d = np.array([[f["properties"]["easting"] - by[f["properties"]["name"]]["east"], f["properties"]["northing"] - by[f["properties"]["name"]]["north"], f["properties"]["height_m"] - by[f["properties"]["name"]]["height"]] for f in fr["features"]])
    out["cameras"] = {"registered": len(d), "of": len(tr["cameras"]), "rms_m": {"east": float(np.sqrt((d[:, 0] ** 2).mean())), "north": float(np.sqrt((d[:, 1] ** 2).mean())), "up": float(np.sqrt((d[:, 2] ** 2).mean()))}}
    out["report"] = {k: v for k, v in json.loads(Path(report_path).read_text()).items() if k in ("dense_points", "gsd_m")}
    print(json.dumps(out, indent=1))
    return out


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(sys.argv[2])
    else:
        r = check(*sys.argv[2:7])
        Path(sys.argv[2], "measured.json").write_text(json.dumps(r, indent=1))
