"""FX-25 sarstereo: a synthetic SAR stereo pair with exact terrain truth (REQ-GAP-42 e2e).

Run with a Python that has SARkit 1.12 (MIT), numpy, lxml and GDAL (the gw-te environment):
    python -I build/fixtures/fx25-sarstereo.py [outdir]

The geometry is that of two real Umbra spotlight collects of Hetch Hetchy Reservoir (the SICD XML
in fixtures/fx25/sarstereo, CC BY 4.0, Umbra Open Data Program): 2023-09-28 (incidence 35.3°) and
2023-07-27 (44.9°), a 10° same-side pair. Their image grids are coarsened 4× (Row/Col SS and
impulse response) so that a chip of the scene stays small, and each file is a chip of that
coarsened full image (ImageData/FirstRow, FirstCol). The pixels are synthetic: a terrain of
hills and one steep ridge about the SCP of the first collect, a log-normal reflectivity texture
on 0.5 m ground cells, every cell put into both images at its SARkit scene-to-image position
(so layover and foreshortening are those of the real geometry), and independent circular
Gaussian speckle per image. SARkit writes the NITF files.

Outputs:
  fx25_sarstereo_a.nitf, fx25_sarstereo_b.nitf   RE16I_IM16I chips
  fx25_sarstereo_prior.tif    a GLO-30-like prior: the truth block-averaged over 30 m, +3 m, HAE
  fx25_sarstereo_truth.tif    the truth at 2 m posts, HAE
  fx25_sarstereo_truth.json   area, ridge, offsets, sizes
"""

import json
import os
import sys

import lxml.etree as ET
import numpy as np
import sarkit.sicd as sksicd
import sarkit.sicd.projection as proj
import sarkit.wgs84 as wgs84
from osgeo import gdal, osr

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
FX = os.path.join(ROOT, "fixtures", "fx25", "sarstereo")
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else FX
os.makedirs(OUT, exist_ok=True)
A = "umbra_2023-09-28-05-16-39_UMBRA-04.sicd.xml"
B = "umbra_2023-07-27-05-21-14_UMBRA-05.sicd.xml"
K = 4.0  # grid coarsening
HALF = 210.0  # scene half size (m) about the centre
CELL = 0.5  # ground cell (m)
PRIOR_BIAS = 3.0


def q(root, path):
    ns = ET.QName(root).namespace
    return root.find("/".join(f"{{{ns}}}{x}" for x in path.split("/")))


def coarsen(tree):
    """Row/Col SS and impulse response × K, bandwidths / K, full image and SCP pixel / K."""
    root = tree.getroot()
    for ax in ("Row", "Col"):
        for tag, f in (("SS", K), ("ImpRespWid", K), ("ImpRespBW", 1.0 / K)):
            e = q(root, f"Grid/{ax}/{tag}")
            e.text = repr(float(e.text) * f)
    for tag in ("ImageData/FullImage/NumRows", "ImageData/FullImage/NumCols"):
        e = q(root, tag)
        e.text = str(int(int(e.text) / K))
    for tag in ("ImageData/SCPPixel/Row", "ImageData/SCPPixel/Col"):
        e = q(root, tag)
        e.text = str(int(round(float(e.text) / K)))
    return tree


def terrain(e, n):
    """Heights above the centre (m): two hills, a hollow, a ripple and a steep north-south ridge."""
    h = 35.0 * np.exp(-((e - 30.0) ** 2 + (n + 25.0) ** 2) / (2 * 60.0**2))
    h -= 20.0 * np.exp(-((e + 70.0) ** 2 + (n - 50.0) ** 2) / (2 * 45.0**2))
    h += 6.0 * np.sin(e / 33.0) * np.cos(n / 47.0)
    ridge = np.clip(1.0 - np.abs(e + 120.0) / 18.0, 0.0, None) * np.clip(1.0 - np.abs(n + 110.0) / 70.0, 0.0, 1.0) * 30.0
    return h + ridge


def main():
    rng = np.random.default_rng(25)
    ta = coarsen(ET.parse(os.path.join(FX, A)))
    tb = coarsen(ET.parse(os.path.join(FX, B)))
    scp = np.array([float(q(ta.getroot(), f"GeoData/SCP/LLH/{k}").text) for k in ("Lat", "Lon", "HAE")])
    lat0, lon0, h0 = scp
    kn = np.pi / 180 * 6_367_000.0
    ke = kn * np.cos(np.radians(lat0))
    # Reflectivity: smoothed white noise on 1 m, log-normal σ_ln 0.9, sampled on 0.5 m cells.
    m = int(2 * HALF) + 1
    t = rng.standard_normal((m, m))
    for _ in range(2):
        p = np.pad(t, 1, mode="edge")
        t = sum(p[1 + dy : 1 + dy + m, 1 + dx : 1 + dx + m] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9.0
    t = np.exp(0.9 * t / t.std())
    nc = int(2 * HALF / CELL)
    e = -HALF + (np.arange(nc) + 0.5) * CELL
    n = HALF - (np.arange(nc) + 0.5) * CELL
    E, N = np.meshgrid(e, n)
    H = h0 + terrain(E, N)
    fi = np.clip(E + HALF, 0, m - 1.001)
    fj = np.clip(HALF - N, 0, m - 1.001)
    i0, j0 = fi.astype(int), fj.astype(int)
    tx, ty = fi - i0, fj - j0
    R = (t[j0, i0] * (1 - tx) + t[j0, i0 + 1] * tx) * (1 - ty) + (t[j0 + 1, i0] * (1 - tx) + t[j0 + 1, i0 + 1] * tx) * ty
    llh = np.stack([lat0 + N.ravel() / kn, lon0 + E.ravel() / ke, H.ravel()], axis=1)
    ecf = wgs84.geodetic_to_cartesian(llh)
    out = {}
    for name, tree, seed in (("a", ta, 11), ("b", tb, 23)):
        root = tree.getroot()
        prm = proj.MetadataParams.from_xml(tree)
        xy, _, _ = proj.scene_to_image(prm, ecf)
        rss, css = float(q(root, "Grid/Row/SS").text), float(q(root, "Grid/Col/SS").text)
        sr, sc = float(q(root, "ImageData/SCPPixel/Row").text), float(q(root, "ImageData/SCPPixel/Col").text)
        row = xy[:, 0] / rss + sr
        col = xy[:, 1] / css + sc
        r0, c0 = int(np.floor(row.min())) + 2, int(np.floor(col.min())) + 2
        nr, ncol = int(np.floor(row.max())) - r0 - 2, int(np.floor(col.max())) - c0 - 2
        acc = np.zeros((nr, ncol))
        fr, fc = row - r0, col - c0
        ir, ic = np.floor(fr).astype(int), np.floor(fc).astype(int)
        wr, wc = fr - ir, fc - ic
        v = R.ravel() * CELL * CELL
        for dr, dc, w in ((0, 0, (1 - wr) * (1 - wc)), (1, 0, wr * (1 - wc)), (0, 1, (1 - wr) * wc), (1, 1, wr * wc)):
            rr, cc = ir + dr, ic + dc
            ok = (rr >= 0) & (cc >= 0) & (rr < nr) & (cc < ncol)
            np.add.at(acc, (rr[ok], cc[ok]), v[ok] * w[ok])
        g = np.random.default_rng(seed)
        z = np.sqrt(acc / 2.0) * (g.standard_normal(acc.shape) + 1j * g.standard_normal(acc.shape))
        k16 = 12000.0 / np.abs(z).max()
        arr = np.zeros(z.shape, dtype=sksicd.PIXEL_TYPES["RE16I_IM16I"]["dtype"])
        arr["real"] = np.round(z.real * k16).astype(np.int16)
        arr["imag"] = np.round(z.imag * k16).astype(np.int16)
        q(root, "ImageData/PixelType").text = "RE16I_IM16I"
        q(root, "ImageData/FirstRow").text = str(r0)
        q(root, "ImageData/FirstCol").text = str(c0)
        q(root, "ImageData/NumRows").text = str(nr)
        q(root, "ImageData/NumCols").text = str(ncol)
        vd = q(root, "ImageData/ValidData")
        if vd is not None:
            vd.getparent().remove(vd)
        core = q(root, "CollectionInfo/CoreName")
        core.text = f"FX25-SARSTEREO-{name.upper()}-{core.text}"
        sec = sksicd.NitfSecurityFields(clas="U")
        meta = sksicd.NitfMetadata(
            xmltree=tree,
            file_header_part=sksicd.NitfFileHeaderPart(ostaid="GISWB", ftitle=f"FX-25 synthetic SAR stereo {name}", security=sec),
            im_subheader_part=sksicd.NitfImSubheaderPart(isorce="GWB-SYNTH-25", security=sec),
            de_subheader_part=sksicd.NitfDeSubheaderPart(security=sec),
        )
        path = os.path.join(OUT, f"fx25_sarstereo_{name}.nitf")
        with open(path, "wb") as f, sksicd.NitfWriter(f, meta) as w:
            w.write_image(arr)
        out[name] = {"file": os.path.basename(path), "firstRow": r0, "firstCol": c0, "rows": nr, "cols": ncol, "bytes": os.path.getsize(path)}

    def geotiff(path, z, half, d):
        nn = z.shape[0]
        ds = gdal.GetDriverByName("GTiff").Create(path, nn, nn, 1, gdal.GDT_Float32, ["COMPRESS=DEFLATE", "PREDICTOR=3"])
        ds.SetGeoTransform([lon0 - half / ke - 0.5 * d / ke, d / ke, 0.0, lat0 + half / kn + 0.5 * d / kn, 0.0, -d / kn])
        sr = osr.SpatialReference()
        sr.ImportFromEPSG(4326)
        ds.SetProjection(sr.ExportToWkt())
        b = ds.GetRasterBand(1)
        b.WriteArray(z.astype(np.float32))
        b.SetNoDataValue(-32768.0)
        ds.SetMetadataItem("VERTICAL", "WGS 84 ellipsoid (HAE)")
        ds = None

    # Truth at 2 m posts over the scene; prior block-averaged over 30 m (+bias) at 10 m, wider.
    d = 2.0
    nt = int(2 * HALF / d) + 1
    g = -HALF + np.arange(nt) * d
    TE, TN = np.meshgrid(g, -g)
    geotiff(os.path.join(OUT, "fx25_sarstereo_truth.tif"), h0 + terrain(TE, TN), HALF, d)
    hp = 600.0
    dp = 10.0
    npr = int(2 * hp / dp) + 1
    gp = -hp + np.arange(npr) * dp
    PE, PN = np.meshgrid(gp, -gp)
    acc = np.zeros_like(PE)
    for a in np.arange(-12.5, 13, 5.0):
        for b in np.arange(-12.5, 13, 5.0):
            acc += terrain(PE + a, PN + b)
    geotiff(os.path.join(OUT, "fx25_sarstereo_prior.tif"), h0 + acc / 36.0 + PRIOR_BIAS, hp, dp)
    truth = {
        "description": "FX-25 synthetic SAR stereo pair on the geometry of two Umbra Hetch Hetchy collects (SARkit 1.12 writer and projections)",
        "centre": {"lat": lat0, "lon": lon0, "hae": h0},
        "halfSizeM": HALF,
        "coarsening": K,
        "priorBiasM": PRIOR_BIAS,
        "ridge": {"eastM": -120.0, "northM": -110.0, "heightM": 30.0, "halfWidthM": 18.0, "halfLengthM": 70.0},
        "images": out,
    }
    with open(os.path.join(OUT, "fx25_sarstereo_truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print(json.dumps(truth, indent=1))


if __name__ == "__main__":
    main()
