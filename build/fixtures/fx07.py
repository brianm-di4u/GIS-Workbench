"""FX-07: a synthetic two-pass SICD pair with exact truth for SCN-12 (Appendix E, AT-12.1..12.5).

Run with a Python that has SARkit 1.12 (MIT) and numpy:  python -I build/fixtures/fx07.py [outdir]
SARkit writes the SICD NITF files and computes the SCPCOA block and every reference projection
(the oracle the Rust port is checked against, Appendix D §5). Nothing here ships in the HTML.

Outputs (fixtures/fx07):
  fx07_a.nitf          pass 1, RE32F_IM32F, PLANE grid in the slant plane, Radiometric block (σ⁰ only)
  fx07_b.nitf          pass 2, RE32F_IM32F: same speckle where the scene is stable, new speckle in the
                       disturbed area, a flat-earth phase ramp, a sub-pixel shift, a vehicle moved,
                       APOs in ErrorStatistics, no Radiometric block
  fx07_c.nitf          pass 1 as RE16I_IM16I
  fx07_d.nitf          pass 1 as AMP8I_PHS8I with an AmpTable
  fx07_truth.json      regions, coherence, shift, ramp, targets, SCPCOA, corners
  oracle_<name>.json   SARkit reference projections for fx07_a, fx07_b, the Umbra chip, the ICEYE XML
                       and XML-only variants of the FX-07 geometry for the other grid types
"""

import copy
import json
import os
import sys

import lxml.etree as ET
import numpy as np
import numpy.polynomial.polynomial as npp
import sarkit.sicd as sksicd
import sarkit.sicd.projection as proj
import sarkit.wgs84 as wgs84

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(ROOT, "fixtures", "fx07")
SAMPLES = os.path.join(os.path.dirname(ROOT), "Research", "samples")
os.makedirs(OUT, exist_ok=True)

NS = "urn:SICD:1.4.0"
N = 1024
SCP_LLH = np.array([-34.55, -58.55, 20.0])
T_SCP = 1.5
DUR = 3.0
FC = 9.6e9
C = 299792458.0
ROW_SS, COL_SS = 0.6, 0.9
ROW_IRW, COL_IRW = 0.75, 1.1


def fs(v):
    return repr(float(v))


def unit(v):
    return v / np.linalg.norm(v)


def geometry(graze_deg=50.0, look_az_deg=280.0, alt=525e3, speed=7600.0):
    """ARP polynomial for a straight, gravity-curved pass; right-looking, zero squint at the SCP."""
    scp = wgs84.geodetic_to_cartesian(SCP_LLH)
    up = wgs84.up(SCP_LLH)
    north = wgs84.north(SCP_LLH)
    east = wgs84.east(SCP_LLH)
    g = np.deg2rad(graze_deg)
    az = np.deg2rad(look_az_deg)
    rng = alt / np.sin(g)
    horiz = np.sin(az) * east + np.cos(az) * north
    arp = scp + rng * (np.cos(g) * horiz + np.sin(g) * up)
    # Heading 90° clockwise from the direction from the sensor to the scene → right-looking.
    head = az + np.pi - np.pi / 2
    vel = speed * (np.sin(head) * east + np.cos(head) * north)
    acc = -9.81 * (6371e3 / (6371e3 + alt)) ** 2 * unit(arp)
    # ARP(t) = arp + vel (t − T) + ½ acc (t − T)²  as a power series in t.
    c0 = arp - vel * T_SCP + 0.5 * acc * T_SCP**2
    c1 = vel - acc * T_SCP
    c2 = 0.5 * acc
    return scp, np.stack([c0, c1, c2]), arp, vel


def poly1d(tag, coefs):
    s = f'<{tag} order1="{len(coefs) - 1}">'
    for i, c in enumerate(coefs):
        s += f'<Coef exponent1="{i}">{fs(c)}</Coef>'
    return s + f"</{tag}>"


def poly2d(tag, m):
    m = np.atleast_2d(m)
    s = f'<{tag} order1="{m.shape[0] - 1}" order2="{m.shape[1] - 1}">'
    for i in range(m.shape[0]):
        for j in range(m.shape[1]):
            s += f'<Coef exponent1="{i}" exponent2="{j}">{fs(m[i, j])}</Coef>'
    return s + f"</{tag}>"


def xyzpoly(tag, c):
    s = f"<{tag}>"
    for k, ax in enumerate("XYZ"):
        s += poly1d(ax, list(c[:, k]))
    return s + f"</{tag}>"


def xyz(tag, v):
    return f"<{tag}><X>{fs(v[0])}</X><Y>{fs(v[1])}</Y><Z>{fs(v[2])}</Z></{tag}>"


def build_xml(*, core, pixel_type, arp_poly, scp, urow, ucol, radiometric, apos, amp_table=None, match=None, collect_start="2026-03-14T10:20:30.000000Z"):
    llh = SCP_LLH
    bw_r, bw_c = 0.886 / ROW_IRW, 0.886 / COL_IRW
    rad = ""
    if radiometric:
        rad = (
            "<Radiometric><NoiseLevel><NoiseLevelType>ABSOLUTE</NoiseLevelType>"
            + poly2d("NoisePoly", [[-25.0]])
            + "</NoiseLevel>"
            + poly2d("SigmaZeroSFPoly", [[radiometric, 1e-6], [2e-6, 0.0]])
            + "</Radiometric>"
        )
    err = "<ErrorStatistics><CompositeSCP><Rg>2.0</Rg><Az>3.0</Az><RgAz>0.1</RgAz></CompositeSCP>"
    if apos:
        err += (
            "<AdjustableParameterOffsets>"
            + xyz("ARPPosSCPCOA", apos["pos"])
            + xyz("ARPVel", apos["vel"])
            + f"<TxTimeSCPCOA>{fs(apos['tx'])}</TxTimeSCPCOA><RcvTimeSCPCOA>{fs(apos['rcv'])}</RcvTimeSCPCOA>"
            + "</AdjustableParameterOffsets>"
        )
    err += "</ErrorStatistics>"
    amp = ""
    if amp_table is not None:
        amp = '<AmpTable size="256">' + "".join(f'<Amplitude index="{i}">{fs(a)}</Amplitude>' for i, a in enumerate(amp_table)) + "</AmpTable>"
    mi = ""
    if match:
        mi = (
            '<MatchInfo><NumMatchTypes>1</NumMatchTypes><MatchType index="1"><TypeID>COHERENT</TypeID>'
            f'<NumMatchCollections>1</NumMatchCollections><MatchCollection index="1"><CoreName>{match}</CoreName></MatchCollection></MatchType></MatchInfo>'
        )
    vd = '<ValidData size="4"><Vertex index="1"><Row>0</Row><Col>0</Col></Vertex><Vertex index="2"><Row>0</Row><Col>1023</Col></Vertex><Vertex index="3"><Row>1023</Row><Col>1023</Col></Vertex><Vertex index="4"><Row>1023</Row><Col>0</Col></Vertex></ValidData>'
    corners = "".join(f'<ICP index="{k}"><Lat>{fs(llh[0])}</Lat><Lon>{fs(llh[1])}</Lon></ICP>' for k in ("1:FRFC", "2:FRLC", "3:LRLC", "4:LRFC"))
    s = f"""<SICD xmlns="{NS}">
<CollectionInfo><CollectorName>GWB-SYNTH-1</CollectorName><CoreName>{core}</CoreName><CollectType>MONOSTATIC</CollectType>
<RadarMode><ModeType>SPOTLIGHT</ModeType><ModeID>SPOT-FX07</ModeID></RadarMode><Classification>UNCLASSIFIED//SYNTHETIC TEST DATA</Classification></CollectionInfo>
<ImageCreation><Application>GIS Workbench fx07.py (SARkit 1.12)</Application><DateTime>2026-10-26T00:00:00Z</DateTime><Site>GISWB</Site><Profile>FX-07</Profile></ImageCreation>
<ImageData><PixelType>{pixel_type}</PixelType>{amp}<NumRows>{N}</NumRows><NumCols>{N}</NumCols><FirstRow>0</FirstRow><FirstCol>0</FirstCol>
<FullImage><NumRows>{N}</NumRows><NumCols>{N}</NumCols></FullImage><SCPPixel><Row>{N // 2}</Row><Col>{N // 2}</Col></SCPPixel>{vd}</ImageData>
<GeoData><EarthModel>WGS_84</EarthModel><SCP>{xyz("ECF", scp)}<LLH><Lat>{fs(llh[0])}</Lat><Lon>{fs(llh[1])}</Lon><HAE>{fs(llh[2])}</HAE></LLH></SCP>
<ImageCorners>{corners}</ImageCorners></GeoData>
<Grid><ImagePlane>SLANT</ImagePlane><Type>PLANE</Type>{poly2d("TimeCOAPoly", [[T_SCP]])}
<Row>{xyz("UVectECF", urow)}<SS>{fs(ROW_SS)}</SS><ImpRespWid>{fs(ROW_IRW)}</ImpRespWid><Sgn>-1</Sgn><ImpRespBW>{fs(bw_r)}</ImpRespBW><KCtr>{fs(2 * FC / C)}</KCtr>
<DeltaK1>{fs(-bw_r / 2)}</DeltaK1><DeltaK2>{fs(bw_r / 2)}</DeltaK2>{poly2d("DeltaKCOAPoly", [[0.0]])}<WgtType><WindowName>UNIFORM</WindowName></WgtType></Row>
<Col>{xyz("UVectECF", ucol)}<SS>{fs(COL_SS)}</SS><ImpRespWid>{fs(COL_IRW)}</ImpRespWid><Sgn>-1</Sgn><ImpRespBW>{fs(bw_c)}</ImpRespBW><KCtr>0.0</KCtr>
<DeltaK1>{fs(-bw_c / 2)}</DeltaK1><DeltaK2>{fs(bw_c / 2)}</DeltaK2>{poly2d("DeltaKCOAPoly", [[0.0]])}<WgtType><WindowName>UNIFORM</WindowName></WgtType></Col></Grid>
<Timeline><CollectStart>{collect_start}</CollectStart><CollectDuration>{fs(DUR)}</CollectDuration><IPP size="1"><Set index="1"><TStart>0.0</TStart><TEnd>{fs(DUR)}</TEnd>
<IPPStart>0</IPPStart><IPPEnd>8999</IPPEnd>{poly1d("IPPPoly", [0.0, 3000.0])}</Set></IPP></Timeline>
<Position>{xyzpoly("ARPPoly", arp_poly)}</Position>
<RadarCollection><TxFrequency><Min>{fs(FC - 3e8)}</Min><Max>{fs(FC + 3e8)}</Max></TxFrequency><TxPolarization>V</TxPolarization>
<RcvChannels size="1"><ChanParameters index="1"><TxRcvPolarization>V:V</TxRcvPolarization></ChanParameters></RcvChannels></RadarCollection>
<ImageFormation><RcvChanProc><NumChanProc>1</NumChanProc><ChanIndex>1</ChanIndex></RcvChanProc><TxRcvPolarizationProc>V:V</TxRcvPolarizationProc>
<TStartProc>0.0</TStartProc><TEndProc>{fs(DUR)}</TEndProc><TxFrequencyProc><MinProc>{fs(FC - 3e8)}</MinProc><MaxProc>{fs(FC + 3e8)}</MaxProc></TxFrequencyProc>
<ImageFormAlgo>OTHER</ImageFormAlgo><STBeamComp>NO</STBeamComp><ImageBeamComp>NO</ImageBeamComp><AzAutofocus>NO</AzAutofocus><RgAutofocus>NO</RgAutofocus></ImageFormation>
<SCPCOA><SCPTime>0</SCPTime></SCPCOA>{rad}{err}{mi}</SICD>"""
    tree = ET.ElementTree(ET.fromstring(s.encode()))
    # SCPCOA from the geometry (SICD Vol. 1 formulas, SARkit's implementation).
    old = tree.getroot().find(f"{{{NS}}}SCPCOA")
    new = sksicd.compute_scp_coa(tree)
    old.getparent().replace(old, new)
    # Image corners: the corner pixels projected to the SCP HAE (SARkit) — exact by construction.
    pts = np.array([[0, 0], [0, N - 1], [N - 1, N - 1], [N - 1, 0]], float)
    xr = (pts - [N // 2, N // 2]) * [ROW_SS, COL_SS]
    ecf, _, ok = sksicd.image_to_constant_hae_surface(tree, xr, SCP_LLH[2])
    assert ok
    llh_c = wgs84.cartesian_to_geodetic(ecf)
    icp = tree.getroot().find(f"{{{NS}}}GeoData/{{{NS}}}ImageCorners")
    for k, e in enumerate(icp):
        e.find(f"{{{NS}}}Lat").text = repr(float(llh_c[k, 0]))
        e.find(f"{{{NS}}}Lon").text = repr(float(llh_c[k, 1]))
    schema = ET.XMLSchema(file=sksicd.VERSION_INFO[NS]["schema"])
    if not schema.validate(tree):
        raise SystemExit("FX-07 XML is not schema-valid: " + str(schema.error_log))
    return tree


def fft_shift(z, dr, dc):
    """Exact sub-pixel shift of a complex image by the Fourier shift theorem (periodic)."""
    fr = np.fft.fftfreq(z.shape[0])[:, None]
    fc = np.fft.fftfreq(z.shape[1])[None, :]
    return np.fft.ifft2(np.fft.fft2(z) * np.exp(-2j * np.pi * (fr * dr + fc * dc)))


def scene(rng):
    """Reflectivity (power) map and region masks, image space (row, col)."""
    r, c = np.mgrid[0:N, 0:N]
    base = 0.04 + 0.03 * (np.sin(r / 37.0) * np.cos(c / 53.0) + 1)
    fields = ((r // 128 + c // 160) % 3) * 0.05
    p = base + fields
    road = np.abs((r - 0.35 * c) - 300) < 6
    p[road] = 0.01
    water = (r > 820) & (c > 700)
    p[water] = 2e-4  # near the noise floor (CNR mask, no decision)
    blds = []
    for k, (r0, c0) in enumerate([(150, 200), (180, 640), (520, 300), (610, 760), (300, 880)]):
        p[r0:r0 + 18, c0:c0 + 26] = 1.5
        p[r0 + 3, c0 + 5] = 400.0  # corner reflector
        blds.append({"row": r0, "col": c0, "h": 18, "w": 26})
    stable = np.ones((N, N), bool)
    dist = {"row0": 400, "row1": 520, "col0": 520, "col1": 680}
    stable[dist["row0"]:dist["row1"], dist["col0"]:dist["col1"]] = False
    return p, road, water, stable, dist, blds


def projection_oracle(tree, name, rng, dem_block=True):
    """Reference projections by SARkit for one SICD XML."""
    root = tree.getroot()
    ns = ET.QName(root).namespace
    q = lambda p: root.find("/".join(f"{{{ns}}}{x}" for x in p.split("/")))
    nr = int(q("ImageData/NumRows").text)
    nc = int(q("ImageData/NumCols").text)
    fr = int(q("ImageData/FirstRow").text)
    fc = int(q("ImageData/FirstCol").text)
    sr = float(q("ImageData/SCPPixel/Row").text)
    sc = float(q("ImageData/SCPPixel/Col").text)
    rss = float(q("Grid/Row/SS").text)
    css = float(q("Grid/Col/SS").text)
    scp_hae = float(q("GeoData/SCP/LLH/HAE").text)
    rowcol = np.column_stack([rng.uniform(fr, fr + nr - 1, 40), rng.uniform(fc, fc + nc - 1, 40)])
    rowcol = np.vstack([rowcol, [[sr, sc], [fr, fc], [fr, fc + nc - 1], [fr + nr - 1, fc + nc - 1], [fr + nr - 1, fc]]])
    xr = (rowcol - [sr, sc]) * [rss, css]
    out = {"name": name, "sarkit": "1.12.0", "xml": ET.tostring(tree).decode(), "rows": nr, "cols": nc, "firstRow": fr, "firstCol": fc, "i2hae": [], "s2i": [], "gp": [], "dem": []}
    for hae in (scp_hae - 50.0, scp_hae, scp_hae + 150.0):
        ecf, dh, ok = sksicd.image_to_constant_hae_surface(tree, xr, hae)
        llh = wgs84.cartesian_to_geodetic(ecf)
        for k in range(len(rowcol)):
            out["i2hae"].append({"row": rowcol[k, 0], "col": rowcol[k, 1], "hae": hae, "ecf": list(ecf[k]), "lat": llh[k, 0], "lon": llh[k, 1]})
    # Scene → image for points near the scene centre and its corners.
    params = proj.MetadataParams.from_xml(tree)
    pts = []
    for k in range(30):
        rc = [rng.uniform(fr, fr + nr - 1), rng.uniform(fc, fc + nc - 1)]
        x = (np.array(rc) - [sr, sc]) * [rss, css]
        e, _, _ = sksicd.image_to_constant_hae_surface(tree, x[None, :], scp_hae + rng.uniform(-40, 200))
        pts.append(e[0])
    pts = np.array(pts)
    il, dgp, ok = sksicd.scene_to_image(tree, pts)
    rcs = il / [rss, css] + [sr, sc]
    llh = wgs84.cartesian_to_geodetic(pts)
    for k in range(len(pts)):
        out["s2i"].append({"ecf": list(pts[k]), "lat": llh[k, 0], "lon": llh[k, 1], "hae": llh[k, 2], "row": rcs[k, 0], "col": rcs[k, 1]})
    # Ground plane through the SCP with the local up normal.
    scp = params.SCP
    ugpn = wgs84.up(wgs84.cartesian_to_geodetic(scp))
    gpp, _, _ = sksicd.image_to_ground_plane(tree, xr, scp, ugpn)
    for k in range(len(rowcol)):
        out["gp"].append({"row": rowcol[k, 0], "col": rowcol[k, 1], "ecf": list(gpp[k])})
    if dem_block:
        # A 120 m block centred on the SCP: every R/Rdot crossing, ordered by HAE (Vol. 3 1.5).
        scp_llh = wgs84.cartesian_to_geodetic(scp)
        en = lambda llh: ((llh[..., 1] - scp_llh[1]) * 111320 * np.cos(np.deg2rad(scp_llh[0])), (llh[..., 0] - scp_llh[0]) * 110940)

        def dem_h(llh):
            e, n = en(llh)
            return np.where((np.abs(e) < 60) & (np.abs(n) < 60), scp_llh[2] + 120.0, scp_llh[2])

        def ecef2dem(p):
            llh = wgs84.cartesian_to_geodetic(np.asarray(p))
            return llh[..., 2] - dem_h(llh)

        for rc in [[sr, sc], [sr - 40, sc + 10], [sr + 25, sc - 30], [sr - 120, sc + 90]]:
            x = (np.array(rc) - [sr, sc]) * [rss, css]
            s = sksicd.image_to_dem_surface(tree, x, ecef2dem, scp_llh[2] - 10, scp_llh[2] + 200, 5.0)
            sl = wgs84.cartesian_to_geodetic(s) if len(s) else np.zeros((0, 3))
            out["dem"].append({"row": rc[0], "col": rc[1], "block": {"size": 120, "height": 120, "base": scp_llh[2]}, "crossings": [{"lat": a[0], "lon": a[1], "hae": a[2]} for a in sl]})
    # Layover check: a point 100 m above the SCP, projected to the image and back to the SCP HAE.
    up = wgs84.up(wgs84.cartesian_to_geodetic(scp))
    top = scp + 100.0 * up
    il2, _, _ = sksicd.scene_to_image(tree, top[None, :])
    back, _, _ = sksicd.image_to_constant_hae_surface(tree, il2, float(wgs84.cartesian_to_geodetic(scp)[2]))
    d = back[0] - scp
    north = wgs84.north(wgs84.cartesian_to_geodetic(scp))
    east = wgs84.east(wgs84.cartesian_to_geodetic(scp))
    out["layover"] = {"topRow": float(il2[0, 0] / rss + sr), "topCol": float(il2[0, 1] / css + sc), "groundShift": float(np.linalg.norm(d)), "azimuth": float(np.rad2deg(np.arctan2(d @ east, d @ north)) % 360)}
    sc_ = root.find(f"{{{ns}}}SCPCOA")
    out["scpcoa"] = {ET.QName(e).localname: float(e.text) for e in sc_ if e.text and ET.QName(e).localname not in ("SideOfTrack", "ARPPos", "ARPVel", "ARPAcc")}
    out["scpcoa"]["SideOfTrack"] = sc_.find(f"{{{ns}}}SideOfTrack").text
    with open(os.path.join(OUT, f"oracle_{name}.json"), "w") as f:
        json.dump(out, f)
    return out


def variant(tree, grid_type, ifa, extra):
    """An XML-only copy of a geometry with another grid type (differential test of the port)."""
    t = copy.deepcopy(tree)
    root = t.getroot()
    ns = ET.QName(root).namespace
    root.find(f"{{{ns}}}Grid/{{{ns}}}Type").text = grid_type
    root.find(f"{{{ns}}}ImageFormation/{{{ns}}}ImageFormAlgo").text = ifa
    if extra is not None:
        idx = list(root).index(root.find(f"{{{ns}}}SCPCOA"))
        el = ET.fromstring(extra.replace("<X", f'<X xmlns="{ns}"', 1) if False else f'<wrap xmlns="{ns}">{extra}</wrap>')
        for k, e in enumerate(el):
            root.insert(idx + 1 + k, e)
    return t


def main():
    rng = np.random.default_rng(7)
    scp, arp_poly, arp, vel = geometry()
    urow = unit(scp - arp)
    ucol = unit(vel - (vel @ urow) * urow)
    p, road, water, stable, dist, blds = scene(rng)
    # Speckle: one complex Gaussian field shared by both passes where the scene is stable.
    g1 = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) / np.sqrt(2)
    g2i = (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N))) / np.sqrt(2)
    # Band-limit the speckle to the Grid's spectral support (ImpRespBW·SS ≈ 0.71 rows, 0.72
    # columns), so the data are oversampled like a real SICD and the support matches the XML.
    def bandlimit(z):
        fr_ = np.fft.fftfreq(N)[:, None]
        fc_ = np.fft.fftfreq(N)[None, :]
        keep = (np.abs(fr_) <= 0.886 / ROW_IRW * ROW_SS / 2) & (np.abs(fc_) <= 0.886 / COL_IRW * COL_SS / 2)
        out = np.fft.ifft2(np.fft.fft2(z) * keep)
        return out / np.sqrt(np.mean(np.abs(out) ** 2))
    g1 = bandlimit(g1)
    g2i = bandlimit(g2i)
    rho = np.where(stable, 0.98, 0.0)
    g2 = rho * g1 + np.sqrt(1 - rho**2) * g2i
    noise = 10 ** (-25 / 10)  # noise power (dB −25 = NoisePoly)
    sf = 2.0  # σ⁰ scale factor at the SCP; pixel power × SF = σ⁰
    amp = np.sqrt(p / sf)
    # Thermal noise in pixel-power units: NoisePoly (dB, ABSOLUTE) = 10·log10(noise power).
    n1 = np.sqrt(noise / 2) * (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N)))
    n2 = np.sqrt(noise / 2) * (rng.standard_normal((N, N)) + 1j * rng.standard_normal((N, N)))
    z1 = amp * g1 + n1
    z2 = amp * g2 + n2
    # Amplitude change: a vehicle present in pass 1 only, another in pass 2 only.
    veh1 = {"row": 700, "col": 150, "h": 4, "w": 9}
    veh2 = {"row": 260, "col": 420, "h": 4, "w": 9}
    z1[veh1["row"]:veh1["row"] + veh1["h"], veh1["col"]:veh1["col"] + veh1["w"]] *= 12.0
    z2[veh2["row"]:veh2["row"] + veh2["h"], veh2["col"]:veh2["col"] + veh2["w"]] = 12.0 * amp[veh2["row"]:veh2["row"] + veh2["h"], veh2["col"]:veh2["col"] + veh2["w"]] * g2[veh2["row"]:veh2["row"] + veh2["h"], veh2["col"]:veh2["col"] + veh2["w"]]
    # Pass 2: flat-earth ramp (cycles per pixel) and a sub-pixel misregistration.
    ramp = {"row": 0.011, "col": -0.004}
    rr, cc = np.mgrid[0:N, 0:N]
    shift = {"row": 0.3, "col": -0.2}
    z2 = fft_shift(z2 * np.exp(2j * np.pi * (ramp["row"] * rr + ramp["col"] * cc)), shift["row"], shift["col"])

    sec = sksicd.NitfSecurityFields(clas="U")

    def write(path, tree, arr):
        meta = sksicd.NitfMetadata(
            xmltree=tree,
            file_header_part=sksicd.NitfFileHeaderPart(ostaid="GISWB", ftitle="FX-07 synthetic SICD", security=sec),
            im_subheader_part=sksicd.NitfImSubheaderPart(isorce="GWB-SYNTH-1", security=sec),
            de_subheader_part=sksicd.NitfDeSubheaderPart(security=sec),
        )
        with open(path, "wb") as f, sksicd.NitfWriter(f, meta) as w:
            w.write_image(arr)

    apos = {"pos": [1.5, -2.0, 0.5], "vel": [0.01, -0.02, 0.005], "tx": 2e-9, "rcv": 5e-9}
    ta = build_xml(core="FX07A", pixel_type="RE32F_IM32F", arp_poly=arp_poly, scp=scp, urow=urow, ucol=ucol, radiometric=sf, apos=None, match="FX07B")
    tb = build_xml(core="FX07B", pixel_type="RE32F_IM32F", arp_poly=arp_poly, scp=scp, urow=urow, ucol=ucol, radiometric=None, apos=apos, match="FX07A", collect_start="2026-03-25T10:20:31.000000Z")
    write(os.path.join(OUT, "fx07_a.nitf"), ta, z1.astype(np.complex64))
    write(os.path.join(OUT, "fx07_b.nitf"), tb, z2.astype(np.complex64))
    tc = build_xml(core="FX07A", pixel_type="RE16I_IM16I", arp_poly=arp_poly, scp=scp, urow=urow, ucol=ucol, radiometric=sf, apos=None)
    k16 = 8000.0 / np.abs(z1).max()
    a16 = np.zeros((N, N), dtype=sksicd.PIXEL_TYPES["RE16I_IM16I"]["dtype"])
    a16["real"] = np.round(z1.real * k16).astype(np.int16)
    a16["imag"] = np.round(z1.imag * k16).astype(np.int16)
    write(os.path.join(OUT, "fx07_c.nitf"), tc, a16)
    amax = float(np.abs(z1).max())
    table = [amax * (i / 255.0) ** 2 for i in range(256)]
    td = build_xml(core="FX07A", pixel_type="AMP8I_PHS8I", arp_poly=arp_poly, scp=scp, urow=urow, ucol=ucol, radiometric=sf, apos=None, amp_table=table)
    a8 = np.zeros((N, N), dtype=sksicd.PIXEL_TYPES["AMP8I_PHS8I"]["dtype"])
    names = a8.dtype.names
    a8[names[0]] = np.clip(np.round(255 * np.sqrt(np.abs(z1) / amax)), 0, 255).astype(np.uint8)
    a8[names[1]] = np.round((np.angle(z1) % (2 * np.pi)) / (2 * np.pi) * 256).astype(np.int64) % 256
    write(os.path.join(OUT, "fx07_d.nitf"), td, a8)

    # Quad-pol trio (REQ-SAR-13): 512² chips of pass 1 geometry as HH, HV, VV. A dihedral-like
    # block (HH − VV strong) and a volume block (HV strong) give distinct Pauli colours.
    M = 512
    base = g1[:M, :M] * amp[:M, :M]
    hh = base.copy()
    vv = base.copy()
    hv = 0.3 * (rng.standard_normal((M, M)) + 1j * rng.standard_normal((M, M))) / np.sqrt(2) * amp[:M, :M]
    hh[100:160, 100:160] *= 4.0
    vv[100:160, 100:160] *= -4.0  # double bounce: HH and VV in antiphase → |HH − VV| (red)
    hv[300:360, 300:360] *= 8.0  # volume scattering → |HV| (green)
    quad = {}
    for pol, arr in (("H:H", hh), ("H:V", hv), ("V:V", vv)):
        t = build_xml(core=f"FX07Q{pol.replace(':', '')}", pixel_type="RE32F_IM32F", arp_poly=arp_poly, scp=scp, urow=urow, ucol=ucol, radiometric=None, apos=None)
        root = t.getroot()
        for path, val in (("ImageData/NumRows", M), ("ImageData/NumCols", M), ("ImageData/FullImage/NumRows", N), ("ImageData/FullImage/NumCols", N)):
            root.find("/".join(f"{{{NS}}}{x}" for x in path.split("/"))).text = str(val)
        vdx = root.find(f"{{{NS}}}ImageData/{{{NS}}}ValidData")
        for k, (rr_, cc_) in enumerate([(0, 0), (0, M - 1), (M - 1, M - 1), (M - 1, 0)]):
            vdx[k].find(f"{{{NS}}}Row").text = str(rr_)
            vdx[k].find(f"{{{NS}}}Col").text = str(cc_)
        root.find(f"{{{NS}}}ImageFormation/{{{NS}}}TxRcvPolarizationProc").text = pol
        root.find(f"{{{NS}}}RadarCollection/{{{NS}}}TxPolarization").text = pol[0]
        root.find(f"{{{NS}}}RadarCollection/{{{NS}}}RcvChannels/{{{NS}}}ChanParameters/{{{NS}}}TxRcvPolarization").text = pol
        name = f"fx07_q{pol.replace(':', '').lower()}.nitf"
        write(os.path.join(OUT, name), t, arr.astype(np.complex64))
        quad[pol] = name

    # True 5×5 sample coherence where stable (with noise) and where disturbed.
    snr = (p / sf) / noise
    gamma_stable = 0.98 * np.mean(1 / (1 + 1 / snr[stable & ~water]))
    oa = projection_oracle(ta, "fx07_a", rng)
    projection_oracle(tb, "fx07_b", rng)
    # Other grid types on the FX-07 geometry (XML only).
    vmag = np.linalg.norm(vel)
    r_ca = float(np.linalg.norm(arp - scp))
    projection_oracle(variant(ta, "XRGYCR", "OTHER", None), "fx07_xrgycr", rng, dem_block=False)
    projection_oracle(variant(ta, "XCTYAT", "OTHER", None), "fx07_xctyat", rng, dem_block=False)
    rgaz = variant(ta, "RGAZIM", "RGAZCOMP", f"<RgAzComp><AzSF>{fs(1.0 / r_ca)}</AzSF>{poly1d('KazPoly', [0.0, 1.0])}</RgAzComp>")
    projection_oracle(rgaz, "fx07_rgazcomp", rng, dem_block=False)
    inca = (
        "<RMA><RMAlgoType>OMEGA_K</RMAlgoType><ImageType>INCA</ImageType><INCA>"
        + poly1d("TimeCAPoly", [T_SCP, 1.0 / vmag])
        + f"<R_CA_SCP>{fs(r_ca)}</R_CA_SCP><FreqZero>{fs(FC)}</FreqZero>"
        + poly2d("DRateSFPoly", [[1.0, 1e-7], [2e-7, 0.0]])
        + "</INCA></RMA>"
    )
    rgz = variant(ta, "RGZERO", "RMA", inca)
    projection_oracle(rgz, "fx07_rgzero", rng, dem_block=False)
    pfa_c = [0.0, vmag / r_ca]
    pfa = (
        "<PFA>" + xyz("FPN", wgs84.up(SCP_LLH)) + xyz("IPN", unit(np.cross(urow, ucol)))
        + f"<PolarAngRefTime>{fs(T_SCP)}</PolarAngRefTime>" + poly1d("PolarAngPoly", [pfa_c[1] * T_SCP, -pfa_c[1], 1e-6]) + poly1d("SpatialFreqSFPoly", [1.0, 0.0, -0.01])
        + f"<Krg1>{fs(2 * (FC - 3e8) / C)}</Krg1><Krg2>{fs(2 * (FC + 3e8) / C)}</Krg2><Kaz1>-0.5</Kaz1><Kaz2>0.5</Kaz2></PFA>"
    )
    projection_oracle(variant(ta, "RGAZIM", "PFA", pfa), "fx07_pfa", rng, dem_block=False)
    for f, name in [(os.path.join(SAMPLES, "sicd-umbra-chip", "umbra_sicd_chip_1024.nitf"), "umbra"), (os.path.join(SAMPLES, "sicd-sidd-xml-iceye", "ICEYE_X56_SICD_SLF_6785560_20251028T000519.xml"), "iceye")]:
        if not os.path.exists(f):
            continue
        if f.endswith(".xml"):
            tree = ET.parse(f)
        else:
            with open(f, "rb") as fh, sksicd.NitfReader(fh) as r:
                tree = r.metadata.xmltree
        projection_oracle(tree, name, rng)

    truth = {
        "description": "FX-07 synthetic two-pass SICD pair (SARkit 1.12 writer and oracle)",
        "files": {"a": "fx07_a.nitf", "b": "fx07_b.nitf", "c": "fx07_c.nitf", "d": "fx07_d.nitf"},
        "size": N,
        "pixelTypes": {"a": "RE32F_IM32F", "b": "RE32F_IM32F", "c": "RE16I_IM16I", "d": "AMP8I_PHS8I"},
        "quadPol": {"files": quad, "size": M, "dihedral": {"row0": 100, "row1": 160, "col0": 100, "col1": 160}, "volume": {"row0": 300, "row1": 360, "col0": 300, "col1": 360}},
        "grid": {"type": "PLANE", "plane": "SLANT", "rowSS": ROW_SS, "colSS": COL_SS, "anamorphic": COL_SS / ROW_SS},
        "regions": {"disturbed": dist, "water": {"row0": 820, "col0": 700}, "roadLine": "row - 0.35·col = 300 ± 6"},
        "coherence": {"stableTrue": float(gamma_stable), "disturbedTrue": 0.0, "window": 5},
        "shiftB": shift,
        "rampB": ramp,
        "vehicles": {"onlyA": veh1, "onlyB": veh2},
        "buildings": blds,
        "radiometric": {"a": {"sigmaZeroSF": sf, "noiseDb": -25.0}, "b": None},
        "apos": {"b": apos},
        "scpcoa": oa["scpcoa"],
        "layover": oa["layover"],
        "corners": [[e["lat"], e["lon"]] for e in oa["i2hae"][-4:]],
    }
    with open(os.path.join(OUT, "fx07_truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print("FX-07 written to", OUT, "stable gamma", round(gamma_stable, 3))


if __name__ == "__main__":
    main()
