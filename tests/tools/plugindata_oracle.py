#!/usr/bin/env python3
"""Oracles for REQ-GAP-72 on real data (26-plugindata.spec.js). No GDAL anywhere in this file.

Inputs are read with the format's own library, outputs with tifffile, so neither side of a comparison
goes through the code under test. Each subcommand prints one JSON object. Run with `python -I` in an
environment holding numpy, pyhdf, astropy, h5py, tiledb and tifffile.

  hdf4-list  f                 SDS, grids and swaths as the HDF4 library and StructMetadata.0 give them
  hdf4-check f sds cog [band]  an SDS against a COG: every pixel, fill, scale, offset, band order
  modis-grid f cog             the grid in StructMetadata.0 and the tile number against the COG's georeferencing
  swath-gcp  f field cog       the COG's tie points against Latitude/Longitude in the swath
  fits-list  f                 HDUs by astropy
  fits-check f hdu cog [plane] a FITS HDU against a COG: every pixel, row order, BSCALE/BZERO, BLANK
  fits-wcs   f hdu cog         astropy's WCS at the corners against the COG's georeferencing, if any
  kea-check  f cog             the KEA file's HDF5 arrays with h5py against a raster
  tiledb-check d cog           a TileDB array against a raster
  tif-info   cog               what the TIFF holds
  unzip      zip dir           a job's ZIP unpacked, through Python's own reader (ZIP64 included)
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET

# A conda environment on Windows that was not activated: its DLLs, before anything else on PATH.
if os.name == "nt":
    os.environ["PATH"] = os.path.join(sys.prefix, "Library", "bin") + os.pathsep + os.environ.get("PATH", "")

import numpy as np


def out(d):
    print(json.dumps(d, default=lambda o: o.item() if hasattr(o, "item") else str(o)))


# ---- the TIFF side, tifffile only ----


def tiff_open(path):
    import tifffile

    return tifffile.TiffFile(path)


def tag(page, code):
    t = page.tags.get(code)
    return None if t is None else t.value


def gdal_meta(page):
    """GDAL_METADATA: band items (scale, offset, unit, description) by sample, dataset items by name."""
    xml = tag(page, 42112)
    bands, ds = {}, {}
    if xml:
        for it in ET.fromstring(xml).findall("Item"):
            s, r, n = it.get("sample"), it.get("role"), it.get("name")
            if s is not None:
                bands.setdefault(int(s), {})[r or n] = it.text
            else:
                ds[n] = it.text
    return bands, ds


def tif_info(path):
    with tiff_open(path) as t:
        p = t.pages[0]
        bands, ds = gdal_meta(p)
        nod = tag(p, 42113)
        tie = tag(p, 33922)
        scale = tag(p, 33550)
        return {
            "width": p.imagewidth,
            "height": p.imagelength,
            "samples": p.samplesperpixel,
            "dtype": str(p.dtype),
            "tile": [p.tilewidth, p.tilelength],
            "compression": str(p.compression).split(".")[-1],
            "overviews": len(t.pages) - 1,
            "nodata": None if nod is None else str(nod).strip("\x00 "),
            "scale_px": None if scale is None else list(scale),
            "tiepoints": None if tie is None else len(tie) // 6,
            "geokeys": t.geotiff_metadata if p.is_geotiff else None,
            "band_meta": {k: v for k, v in list(bands.items())[:32]},
            "ds_keys": len(ds),
        }


def tiff_array(path):
    """(bands, rows, cols), holding the file in memory."""
    with tiff_open(path) as t:
        a = t.pages[0].asarray()
    return a[np.newaxis] if a.ndim == 2 else np.moveaxis(a, -1, 0) if t.pages[0].planarconfig == 1 else a


def tiff_tiles(path):
    """Yield (band or None, row, col, tile), decoded a tile at a time, for files too big for memory."""
    with tiff_open(path) as t:
        p = t.pages[0]
        yield from segs(p)


def segs(page):
    """(sample, row, col, tile as rows x cols x samples) for each decoded tile of a TIFF page."""
    for seg, idx, _shape in page.segments():
        if seg is None:
            continue
        s, r, c = idx[0], idx[-3], idx[-2]
        seg = seg.reshape(seg.shape[-3], seg.shape[-2], -1) if seg.ndim >= 3 else seg[..., np.newaxis]
        yield s, r, c, seg


def same(a, b):
    """Equal, with NaN equal to NaN."""
    if a.dtype.kind == "f" or b.dtype.kind == "f":
        return bool(np.all((a == b) | (np.isnan(a.astype("f8")) & np.isnan(b.astype("f8")))))
    return bool(np.array_equal(a, b))


# ---- HDF4 ----


def struct_metadata(sd):
    """StructMetadata.0, .1 ... joined: the ODL text HDF-EOS keeps its grids and swaths in."""
    a = sd.attributes()
    return "".join(a[k] for k in sorted(k for k in a if k.startswith("StructMetadata")))


def odl_groups(text, kind):
    """Each GROUP=GRID_n or SWATH_n of the ODL, as its text, with the name."""
    res = []
    for m in re.finditer(rf"GROUP=({kind}_\d+)\n(.*?)END_GROUP=\1", text, re.S):
        body = m.group(2)
        name = re.search(rf'{kind.title()}Name="([^"]+)"', body).group(1)
        res.append((name, body))
    return res


def cmd_hdf4_list(a):
    from pyhdf.SD import SD, SDC

    sd = SD(a[0], SDC.READ)
    sds = {}
    for name, (dims, shape, typ, _idx) in sd.datasets().items():
        sds[name] = {"dims": list(dims), "shape": list(shape), "type": typ}
    text = struct_metadata(sd)
    grids = {}
    for name, body in odl_groups(text, "GRID"):
        grids[name] = re.findall(r'DataFieldName="([^"]+)"', body)
    swaths = {}
    for name, body in odl_groups(text, "SWATH"):
        swaths[name] = {"data": re.findall(r'DataFieldName="([^"]+)"', body), "geo": re.findall(r'GeoFieldName="([^"]+)"', body)}
    out({"sds": sds, "grids": grids, "swaths": swaths})


def cmd_hdf4_check(a):
    from pyhdf.SD import SD, SDC

    sd = SD(a[0], SDC.READ)
    v = sd.select(int(a[1][1:]) if a[1].startswith("#") else a[1])
    attrs = v.attributes()
    want = v.get()
    if want.ndim == 2:
        want = want[np.newaxis]
    got = tiff_array(a[2])
    info = tif_info(a[2])
    res = {"sds_shape": list(want.shape), "cog_shape": list(got.shape), "dtype_sds": str(want.dtype), "dtype_cog": str(got.dtype)}
    if want.shape != got.shape:
        # A 3-D SDS may have its band axis last.
        for ax in (want.ndim - 1, 1):
            w2 = np.moveaxis(want, ax, 0)
            if w2.shape == got.shape:
                want = w2
                res["band_axis"] = ax
                break
    if want.shape != got.shape:
        res.update(equal=False, why="shape")
        return out(res)
    res["equal"] = same(got, want)
    res["bands_equal"] = [same(got[i], want[i]) for i in range(want.shape[0])]
    res["bands_distinct"] = len({want[i].tobytes() for i in range(want.shape[0])}) == want.shape[0]
    if not res["equal"]:
        res["share_diff"] = float((got != want).mean())
    fill = attrs.get("_FillValue")
    res["fill_attr"] = fill
    res["fill_pixels"] = None if fill is None or isinstance(fill, str) else int((want == fill).sum())
    res["nodata_tif"] = info["nodata"]
    if isinstance(fill, str):
        # A byte field's fill kept as text ("NA"): no number to compare, and none may appear in the TIFF.
        res["fill_pixels"] = None
        res["nodata_ok"] = info["nodata"] is None
    else:
        res["nodata_ok"] = (fill is None and info["nodata"] is None) or (fill is not None and info["nodata"] is not None and float(info["nodata"]) == float(fill))
    sf, ao = attrs.get("scale_factor"), attrs.get("add_offset")
    bm = info["band_meta"].get(0, {})
    res["scale_attr"], res["offset_attr"] = sf, ao
    res["scale_tif"], res["offset_tif"] = bm.get("scale"), bm.get("offset")
    res["unit_attr"], res["unit_tif"] = attrs.get("units"), bm.get("unittype")
    # Divisor products (MOD13): the band scale must be the reciprocal of the attribute.
    divisor = isinstance(sf, (int, float)) and sf >= 10 and str(attrs.get("units", "")).strip().lower() in ("reflectance", "ndvi", "evi", "degree", "degrees") and bm.get("scale") is not None
    res["divisor"] = bool(divisor)
    if isinstance(sf, (int, float)):
        want_scale = 1.0 / sf if divisor else float(sf)
        res["scale_ok"] = sf == 1 or (bm.get("scale") is not None and abs(float(bm["scale"]) - want_scale) <= 1e-9 * abs(want_scale))
    else:
        res["scale_ok"] = bm.get("scale") is None
    res["min_max"] = [int(want.min()) if want.dtype.kind in "iu" else float(np.nanmin(want)), int(want.max()) if want.dtype.kind in "iu" else float(np.nanmax(want))]
    out(res)


GCTP_RADIUS = 6371007.181  # The MODIS land sphere, also in ProjParams of the file itself.
TILE_M = 1111950.5196666666  # 2 * pi * R / 36


def forward_sinusoidal(lon, lat, r):
    return r * np.radians(lon) * np.cos(np.radians(lat)), r * np.radians(lat)


def cmd_modis_grid(a):
    from pyhdf.SD import SD, SDC

    sd = SD(a[0], SDC.READ)
    text = struct_metadata(sd)
    attrs = sd.attributes()
    info = tif_info(a[1])
    tile_size = (info["width"], info["height"])
    pick = None
    for name, body in odl_groups(text, "GRID"):
        xd, yd = int(re.search(r"XDim=(\d+)", body).group(1)), int(re.search(r"YDim=(\d+)", body).group(1))
        if (xd, yd) == tile_size:
            pick = (name, body, xd, yd)
            break
    if not pick:
        return out({"ok": False, "why": "no grid of this size"})
    name, body, xd, yd = pick
    ul = [float(x) for x in re.search(r"UpperLeftPointMtrs=\(([^)]+)\)", body).group(1).split(",")]
    lr = [float(x) for x in re.search(r"LowerRightMtrs=\(([^)]+)\)", body).group(1).split(",")]
    proj = re.search(r"Projection=(\S+)", body).group(1)
    pp = [float(x) for x in re.search(r"ProjParams=\(([^)]*)\)", body).group(1).split(",")] if "ProjParams" in body else []
    res = {"grid": name, "projection": proj, "ul": ul, "lr": lr, "xdim": xd, "ydim": yd, "projparams": pp[:2]}
    want_px = ((lr[0] - ul[0]) / xd, (lr[1] - ul[1]) / yd)
    with tiff_open(a[1]) as t:
        p = t.pages[0]
        sc = tag(p, 33550)
        tie = tag(p, 33922)
        gk = t.geotiff_metadata
    res["tif_origin"] = [tie[3] - tie[0] * sc[0], tie[4] + tie[1] * sc[1]]
    res["tif_pixel"] = [sc[0], -sc[1]]
    if proj == "GCTP_GEO":
        # UpperLeftPointMtrs in packed DMS for a geographic grid: DDDMMMSSS.SS.
        def dms(v):
            s = -1 if v < 0 else 1
            v = abs(v)
            d = int(v // 1000000)
            m = int((v - d * 1000000) // 1000)
            sec = v - d * 1000000 - m * 1000
            return s * (d + m / 60 + sec / 3600)

        ul = [dms(ul[0]), dms(ul[1])]
        lr = [dms(lr[0]), dms(lr[1])]
        res["ul_deg"], res["lr_deg"] = ul, lr
        want_px = ((lr[0] - ul[0]) / xd, (lr[1] - ul[1]) / yd)
    res["origin_err"] = [abs(res["tif_origin"][0] - ul[0]), abs(res["tif_origin"][1] - ul[1])]
    res["pixel_err"] = [abs(sc[0] - want_px[0]), abs(-sc[1] - want_px[1])]
    res["geokeys"] = {k: gk.get(k) for k in ("GTModelTypeGeoKey", "GeographicTypeGeoKey", "GeogSemiMajorAxisGeoKey", "GeogSemiMinorAxisGeoKey", "GeogInvFlatteningGeoKey", "ProjCoordTransGeoKey", "ProjCenterLongGeoKey", "ProjFalseEastingGeoKey", "ProjFalseNorthingGeoKey", "GTCitationGeoKey", "GeogCitationGeoKey", "PCSCitationGeoKey") if k in gk}
    if proj == "GCTP_SNSOID":
        r = pp[0] if pp and pp[0] else GCTP_RADIUS
        res["radius_file"] = pp[0] if pp else None
        h = round((ul[0] + 18 * TILE_M) / TILE_M)
        v = round((9 * TILE_M - ul[1]) / TILE_M)
        res["tile_from_grid"] = [h, v]
        m = re.search(r"\.h(\d\d)v(\d\d)\.", a[0])
        res["tile_from_name"] = [int(m.group(1)), int(m.group(2))] if m else None
        hv = re.search(r'OBJECT\s*=\s*HORIZONTALTILENUMBER.*?VALUE\s*=\s*"?(\d+)', attrs.get("CoreMetadata.0", ""), re.S)
        res["tile_expected_ul"] = [-18 * TILE_M + h * TILE_M, 9 * TILE_M - v * TILE_M]
        res["tile_ul_err"] = [abs(res["tile_expected_ul"][0] - res["tif_origin"][0]), abs(res["tile_expected_ul"][1] - res["tif_origin"][1])]
        # Bounding coordinates from the product's own ArchiveMetadata, through a sinusoidal written here.
        arch = "".join(attrs[k] for k in sorted(attrs) if k.startswith("ArchiveMetadata"))
        g = {}
        for k in ("NORTHBOUNDINGCOORDINATE", "SOUTHBOUNDINGCOORDINATE", "EASTBOUNDINGCOORDINATE", "WESTBOUNDINGCOORDINATE"):
            m = re.search(rf"OBJECT\s*=\s*{k}.*?VALUE\s*=\s*(-?[\d.]+)", arch, re.S)
            g[k] = float(m.group(1)) if m else None
        if g["NORTHBOUNDINGCOORDINATE"] is not None:
            _, y_n = forward_sinusoidal(0, g["NORTHBOUNDINGCOORDINATE"], r)
            _, y_s = forward_sinusoidal(0, g["SOUTHBOUNDINGCOORDINATE"], r)
            res["bounding_lat_err_m"] = [abs(y_n - res["tif_origin"][1]), abs(y_s - (res["tif_origin"][1] - sc[1] * yd))]
    out(res)


def bilinear(arr, fy, fx):
    gh, gw = arr.shape
    jx, jy = np.clip(np.floor(fx).astype(int), 0, gw - 2), np.clip(np.floor(fy).astype(int), 0, gh - 2)
    tx, ty = fx - jx, fy - jy
    return arr[jy, jx] * (1 - tx) * (1 - ty) + arr[jy, jx + 1] * tx * (1 - ty) + arr[jy + 1, jx] * (1 - tx) * ty + arr[jy + 1, jx + 1] * tx * ty


def cmd_swath_gcp(a):
    """f field cog: the COG's tie points (pixel, line, x, y) against Latitude/Longitude read with pyhdf.

    A geolocation node i stands at image pixel offset + i * increment, the centre of that pixel, from the
    dimension map of the field's own dimensions in StructMetadata.0. ASTER keeps geocentric latitudes,
    and GDAL gives its tie points in UTM: pyproj takes them to geodetic latitude and longitude."""
    from pyhdf.SD import SD, SDC

    sd = SD(a[0], SDC.READ)
    field, cog = a[1], a[2]
    with tiff_open(cog) as t:
        p = t.pages[0]
        tie = np.array(tag(p, 33922), dtype="f8").reshape(-1, 6)
        w, h = p.imagewidth, p.imagelength
        gk = t.geotiff_metadata or {}
    v = sd.select(field)
    dims = [d.split(":")[0] for d in v.dimensions()]
    dims_y, dims_x = dims[-2], dims[-1]
    text = struct_metadata(sd)
    lat_v = sd.select("Latitude")
    geo_y, geo_x = [d.split(":")[0] for d in lat_v.dimensions()]
    # ASTER: one Latitude per swath is named Latitude, Latitude_1...; the first holds for the VNIR field.
    swath = next((m for m in lat_v.dimensions() if ":" in m), ":").split(":")[1]
    if swath:
        dv = v.dimensions()
        sw_f = next((d.split(":")[1] for d in dv if ":" in d), "")
        if sw_f and sw_f != swath:
            for name, (dn, _sh, _t, idx) in sd.datasets().items():
                if name == "Latitude" and any(d.endswith(":" + sw_f) for d in dn):
                    lat_v = sd.select(idx)
                    geo_y, geo_x = [d.split(":")[0] for d in lat_v.dimensions()]
    lat = lat_v.get().astype("f8")
    lon_v = None
    for name, (dn, _sh, _t, idx) in sd.datasets().items():
        if name == "Longitude" and list(dn) == list(lat_v.dimensions()):
            lon_v = sd.select(idx)
    lon = (lon_v if lon_v is not None else sd.select("Longitude")).get().astype("f8")
    gh, gw = lat.shape
    body = next((b for _n, b in odl_groups(text, "SWATH") if f'DataFieldName="{field}"' in b), text)
    maps = {(g, d): (int(o), int(i)) for g, d, o, i in re.findall(r'GeoDimension="([^"]+)"\s+DataDimension="([^"]+)"\s+Offset=(-?\d+)\s+Increment=(\d+)', body)}
    oy, iy = maps.get((geo_y, dims_y), (0, 1))
    ox, ix = maps.get((geo_x, dims_x), (0, 1))
    res = {"gcps": len(tie), "image": [w, h], "geo_shape": [gh, gw], "dims": dims[-2:], "offset_inc_y": [oy, iy], "offset_inc_x": [ox, ix]}
    res["geokeys"] = {k: v_ for k, v_ in gk.items() if k in ("GTModelTypeGeoKey", "GeographicTypeGeoKey", "ProjectedCSTypeGeoKey", "ProjCoordTransGeoKey", "ProjNatOriginLongGeoKey", "ProjScaleAtNatOriginGeoKey", "ProjFalseEastingGeoKey", "ProjFalseNorthingGeoKey", "GeogSemiMajorAxisGeoKey", "GeogInvFlatteningGeoKey")}
    res["gcp_crs_stored"] = bool(gk)
    x, y = tie[:, 3].copy(), tie[:, 4].copy()
    geocentric = "ASTER" in sd.attributes().get("productmetadata.0", "")[:40] or field.startswith("ImageData")
    if geocentric:
        from pyproj import Transformer

        # WGS 84 eccentricity: geocentric to geodetic latitude.
        e2 = 6.69437999014e-3
        lat = np.degrees(np.arctan(np.tan(np.radians(lat)) / (1 - e2)))
        if "ProjNatOriginLongGeoKey" in gk:
            crs = f"+proj=tmerc +lat_0=0 +lon_0={gk['ProjNatOriginLongGeoKey']} +k={gk.get('ProjScaleAtNatOriginGeoKey', 0.9996)} +x_0={gk.get('ProjFalseEastingGeoKey', 500000)} +y_0={gk.get('ProjFalseNorthingGeoKey', 0)} +ellps=GRS80"
        elif abs(x).max() > 400:
            # No CRS in the file: what the product itself states for the zone, UTM 11 or whichever it is.
            zone = int((lon.mean() + 180) // 6) + 1
            crs = f"+proj=utm +zone={zone} +ellps=GRS80"
            res["assumed_zone"] = zone
        else:
            crs = None
        if crs:
            x, y = Transformer.from_crs(crs, "+proj=longlat +ellps=GRS80", always_xy=True).transform(x, y)
        res["geocentric_lat_converted"] = True
    fx = (tie[:, 0] - 0.5 - ox) / ix
    fy = (tie[:, 1] - 0.5 - oy) / iy
    res["outside_image"] = int(((tie[:, 0] > w + 1) | (tie[:, 1] > h + 1)).sum())
    la = bilinear(lat, fy, fx)
    lo = bilinear(lon, fy, fx)
    d = np.hypot(((x - lo + 180) % 360 - 180) * np.cos(np.radians(la)), y - la) * 111195
    res["rms_m"] = float(np.sqrt((d**2).mean()))
    res["max_m"] = float(d.max())
    # How well the tie points alone stand for the geolocation: bilinear on their mesh, at every node.
    ps, ls = sorted(set(tie[:, 0])), sorted(set(tie[:, 1]))
    if len(ps) * len(ls) == len(tie) and len(ps) > 1 and len(ls) > 1:
        mx = np.empty((len(ls), len(ps)))
        my = np.empty((len(ls), len(ps)))
        for k in range(len(tie)):
            mx[ls.index(tie[k, 1]), ps.index(tie[k, 0])] = x[k]
            my[ls.index(tie[k, 1]), ps.index(tie[k, 0])] = y[k]
        ny, nx = np.mgrid[0:gh, 0:gw]
        ip = ox + nx * ix + 0.5
        il = oy + ny * iy + 0.5
        tp = np.interp(ip.ravel(), ps, np.arange(len(ps))).reshape(ip.shape)
        tl = np.interp(il.ravel(), ls, np.arange(len(ls))).reshape(il.shape)
        ix_lo = bilinear(mx, tl, tp)
        ix_la = bilinear(my, tl, tp)
        dm = np.hypot(((ix_lo - lon + 180) % 360 - 180) * np.cos(np.radians(lat)), ix_la - lat) * 111195
        res["mesh_rms_m"] = float(np.sqrt((dm**2).mean()))
        res["mesh_p95_m"] = float(np.percentile(dm, 95))
        res["mesh_max_m"] = float(dm.max())
    out(res)


# ---- FITS ----


def cmd_fits_list(a):
    from astropy.io import fits

    with fits.open(a[0], memmap=True, do_not_scale_image_data=True, disable_image_compression=False) as h:
        res = []
        for i, u in enumerate(h):
            hd = u.header
            res.append({"i": i, "class": type(u).__name__, "name": u.name, "bitpix": hd.get("ZBITPIX", hd.get("BITPIX")), "naxis": hd.get("NAXIS"), "shape": list(u.shape) if u.is_image or hasattr(u, "shape") else None, "bscale": hd.get("BSCALE"), "bzero": hd.get("BZERO"), "blank": hd.get("BLANK"), "ctype1": hd.get("CTYPE1"), "ctype2": hd.get("CTYPE2")})
    out({"hdus": res})


def fits_raw(path, hdu):
    """The HDU's data as stored (raw integers for scaled data), big endian as in the file, memory mapped.

    An empty primary HDU stands for the first image after it. A tile-compressed HDU is decompressed by
    astropy, which applies the quantisation of a floating-point image."""
    from astropy.io import fits

    h = fits.open(path, memmap=True, do_not_scale_image_data=True, disable_image_compression=False)
    if hdu == 0 and h[0].data is None:
        hdu = next(i for i, u in enumerate(h) if u.is_image and u.data is not None or type(u).__name__ == "CompImageHDU")
    if type(h[hdu]).__name__ == "CompImageHDU":
        h.close()
        h = fits.open(path, memmap=True)
    return h, h[hdu]


def cmd_fits_check(a):
    h, u = fits_raw(a[0], int(a[1]))
    hd = u.header
    data = u.data
    plane = int(a[3]) if len(a) > 3 else None
    if data.ndim == 2:
        data = data[np.newaxis]
    info = tif_info(a[2])
    bs, bz = hd.get("BSCALE", 1.0), hd.get("BZERO", 0.0)
    res = {"fits_shape": list(data.shape), "cog": [info["samples"], info["height"], info["width"]], "dtype_cog": info["dtype"], "bitpix": hd.get("ZBITPIX", hd.get("BITPIX")), "bscale": bs, "bzero": bz, "blank": hd.get("BLANK"), "nodata_tif": info["nodata"], "band_meta0": info["band_meta"].get(0)}
    if list(data.shape) != res["cog"]:
        res.update(equal=False, why="shape")
        return out(res)
    n, rows, cols = data.shape
    cog_is_float = info["dtype"].startswith("float")
    file_is_int = data.dtype.kind in "iu"
    res["scaled_to_float"] = bool(cog_is_float and file_is_int)
    # The FITS convention for unsigned integers: BZERO 2^15 or 2^31 with BSCALE 1, an unsigned band in GDAL.
    unsigned = bs == 1.0 and bz in (32768.0, 2147483648.0) and info["dtype"].startswith("uint")
    res["unsigned"] = unsigned
    bad = 0
    flip_seen, noflip_seen = 0, 0
    total = 0
    bm = info["band_meta"].get(0, {})
    tif_scale = float(bm.get("scale", 1))
    tif_off = float(bm.get("offset", 0))

    def expect(tile_rows, band, c0, c1, flip):
        rr = rows - 1 - tile_rows if flip else tile_rows
        return data[band][rr, c0:c1]

    nan_pixels = 0
    with tiff_open(a[2]) as t:
        p = t.pages[0]
        per_band = p.samplesperpixel if p.planarconfig == 2 else 1
        for s, r, c, seg in segs(p):
            tr, tc, ts = seg.shape
            r1, c1 = min(r + tr, rows), min(c + tc, cols)
            seg = seg[: r1 - r, : c1 - c]
            rr = np.arange(r, r1)
            for j in range(ts):
                band = s if p.planarconfig == 2 else j
                v = seg[:, :, j]
                for flip in (True, False):
                    w = expect(rr, band, c, c1, flip).astype(v.dtype if v.dtype.kind == "f" else "f8") if cog_is_float else expect(rr, band, c, c1, flip)
                    if cog_is_float and file_is_int:
                        ok = np.isclose(v.astype("f8"), w.astype("f8") * bs + bz, rtol=1e-6, atol=0)
                        ok = ok | (np.isnan(v))
                    elif v.dtype.kind == "f":
                        vv = v.astype(w.dtype.newbyteorder("="))
                        ok = (vv == w) | (np.isnan(vv) & np.isnan(w.astype(vv.dtype)))
                    elif unsigned:
                        ok = v.astype("f8") == w.astype("f8") + bz
                    else:
                        ok = v.astype("f8") == w.astype("f8")
                    if flip:
                        flip_seen += int(ok.sum())
                    else:
                        noflip_seen += int(ok.sum())
                if v.dtype.kind == "f":
                    nan_pixels += int(np.isnan(v).sum())
                total += v.size
    res["pixels"] = total
    res["match_flipped"] = flip_seen
    res["match_unflipped"] = noflip_seen
    res["equal"] = flip_seen == total or noflip_seen == total
    res["row_order"] = "flipped" if flip_seen == total and noflip_seen != total else "same" if noflip_seen == total and flip_seen != total else "either" if flip_seen == total else "neither"
    res["nan_pixels"] = nan_pixels
    res["physical_ok"] = None
    if file_is_int and (bs != 1.0 or bz != 0.0) and not unsigned:
        res["physical_ok"] = bool(res["scaled_to_float"] or (abs(tif_scale - bs) <= 1e-9 * abs(bs) and abs(tif_off - bz) <= 1e-6 * max(1.0, abs(bz))))
        res["tif_scale"], res["tif_offset"] = tif_scale, tif_off
    h.close()
    out(res)


def cmd_fits_wcs(a):
    from astropy.io import fits
    from astropy.wcs import WCS

    h, u = fits_raw(a[0], int(a[1]))
    hd = u.header
    w = WCS(hd, naxis=2)
    w = w.celestial if w.has_celestial else w
    ny, nx = u.shape[-2:]
    info = tif_info(a[2])
    res = {"ctype": list(w.wcs.ctype), "crval": list(w.wcs.crval), "tif_tiepoints": info["tiepoints"], "tif_pixel": info["scale_px"], "geokeys": info["geokeys"]}
    try:
        sky = w.pixel_to_world_values(np.array([0, nx - 1, 0, nx - 1]), np.array([0, 0, ny - 1, ny - 1]))
        res["corners_astropy"] = [[float(sky[0][i]), float(sky[1][i])] for i in range(4)]
    except Exception as e:  # An old header that wcslib itself cannot use; the keywords are still compared.
        res["wcs_error"] = str(e).splitlines()[0]
    with tiff_open(a[2]) as t:
        bm, ds = gdal_meta(t.pages[0])
    res["wcs_in_tif_metadata"] = {k: ds.get(k) for k in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2", "CDELT1", "CDELT2", "CD1_1", "CD2_2") if k in ds}
    if info["scale_px"] and info["tiepoints"] and "corners_astropy" in res:
        with tiff_open(a[2]) as t:
            p = t.pages[0]
            sc = tag(p, 33550)
            tie = tag(p, 33922)
        # Pixel centres of the same four corners of the file, in the COG's geographic grid.
        got = []
        for row, col in ((ny - 1, 0), (ny - 1, nx - 1), (0, 0), (0, nx - 1)):
            got.append([tie[3] + (col + 0.5) * sc[0], tie[4] - (row + 0.5) * sc[1]])
        res["corners_tif"] = got
        res["corner_err_deg"] = [float(np.hypot(((got[i][0] - res["corners_astropy"][i][0] + 180) % 360 - 180), got[i][1] - res["corners_astropy"][i][1])) for i in range(4)]
    res["wcs_keys_kept"] = all(k in res["wcs_in_tif_metadata"] for k in ("CTYPE1", "CTYPE2", "CRVAL1", "CRVAL2", "CRPIX1", "CRPIX2")) and abs(float(res["wcs_in_tif_metadata"]["CRVAL1"]) - float(hd["CRVAL1"])) < 1e-9 and abs(float(res["wcs_in_tif_metadata"]["CRPIX2"]) - float(hd["CRPIX2"])) < 1e-9
    h.close()
    out(res)


# ---- KEA, TileDB ----


def cmd_kea_check(a):
    """Every band of a KEA file, tile by tile from the other raster, and its geotransform and projection."""
    import h5py

    with h5py.File(a[0], "r") as f:
        n = int(f["HEADER/NUMBANDS"][0])
        hdr = {k: f["HEADER"][k][()] for k in f["HEADER"]}
        res = {"bands": n, "size": [int(x) for x in hdr["SIZE"]], "tl": [float(x) for x in hdr["TL"]], "res": [float(x) for x in hdr["RES"]], "datatype": [f[f"BAND{i + 1}"].attrs.get("BANDTYPE") if False else f[f"BAND{i + 1}/DATATYPE"][()][0] for i in range(n)]}
        ov = [len([k for k in f[f"BAND{i + 1}"].get("OVERVIEWS", {}) ]) for i in range(n)]
        res["overviews"] = ov
        no = []
        for i in range(n):
            g = f[f"BAND{i + 1}"]
            no.append(float(g["NO_DATA_VAL"][()][0]) if "NO_DATA_VAL" in g else None)
        res["nodata"] = no
        res["compression"] = f["BAND1/DATA"].compression
        res["chunks"] = f["BAND1/DATA"].chunks
        bad = 0
        total = 0
        data = [f[f"BAND{i + 1}/DATA"] for i in range(n)]
        with tiff_open(a[1]) as t:
            p = t.pages[0]
            for s, r, c, seg in segs(p):
                r1, c1 = min(r + seg.shape[0], res["size"][1]), min(c + seg.shape[1], res["size"][0])
                seg = seg[: r1 - r, : c1 - c]
                for j in range(seg.shape[2]):
                    b = s if p.planarconfig == 2 else j
                    w = data[b][r:r1, c:c1]
                    total += w.size
                    bad += int(((w != seg[:, :, j]) & ~(np.isnan(w.astype("f8")) & np.isnan(seg[:, :, j].astype("f8")))).sum())
        res["pixels"] = total
        res["different"] = bad
        res["equal"] = bad == 0
        with tiff_open(a[1]) as t:
            sc, tie = tag(t.pages[0], 33550), tag(t.pages[0], 33922)
        if sc is not None:
            res["origin_tif"] = [tie[3], tie[4]]
            res["pixel_tif"] = [sc[0], sc[1]]
    out(res)


def cmd_tiledb_check(a):
    """A TileDB raster as GDAL writes it: dense array, one attribute, BANDS x Y x X, from tiledb-py."""
    import tiledb

    with tiledb.open(a[0], "r") as A:
        s = A.schema
        res = {"dims": [d.name for d in s.domain], "domain": [[int(x) for x in d.domain] for d in s.domain], "nonempty": [[int(x) for x in n] for n in A.nonempty_domain()], "tiles": [int(d.tile) for d in s.domain], "attrs": [s.attr(i).name for i in range(s.nattr)], "dtype": str(s.attr(0).dtype), "sparse": s.sparse, "filters": [type(f).__name__ for f in s.attr(0).filters]}
        total = 0
        bad = 0
        names = res["attrs"]
        with tiff_open(a[1]) as t:
            p = t.pages[0]
            for s_, r, c, seg in segs(p):
                rows = p.imagelength
                cols = p.imagewidth
                r1, c1 = min(r + seg.shape[0], rows), min(c + seg.shape[1], cols)
                seg = seg[: r1 - r, : c1 - c]
                for j in range(seg.shape[2]):
                    b = s_ if p.planarconfig == 2 else j
                    # By the names of the dimensions: GDAL's INTERLEAVE decides their order, and it pads
                    # Y and X to whole tiles, so only the raster's own window is read.
                    if len(names) > 1:
                        w = A[r:r1, c:c1][names[b]]
                    else:
                        lo = res["domain"][res["dims"].index("BANDS")][0] if "BANDS" in res["dims"] else 0
                        sl = {"BANDS": slice(lo + b, lo + b + 1), "Y": slice(r, r1), "X": slice(c, c1)}
                        w = np.squeeze(A[tuple(sl[n] for n in res["dims"])][names[0]])
                    total += w.size
                    bad += int(((w != seg[:, :, j]) & ~(np.isnan(w.astype("f8")) & np.isnan(seg[:, :, j].astype("f8")))).sum())
        res["pixels"] = total
        res["different"] = bad
        res["equal"] = bad == 0
    out(res)


def cmd_unzip(a):
    import zipfile

    with zipfile.ZipFile(a[0]) as z:
        names = z.infolist()
        res = {"files": len(names), "bytes": sum(i.file_size for i in names), "zip_size": 0, "bad": z.testzip() if len(a) > 2 and a[2] == "test" else None}
        z.extractall(a[1])
    res["zip_size"] = os.path.getsize(a[0])
    res["top"] = sorted(os.listdir(a[1]))[:8]
    out(res)


def main():
    c = sys.argv[1].replace("-", "_")
    if c == "tif_info":
        return out(tif_info(sys.argv[2]))
    globals()["cmd_" + c](sys.argv[2:])


if __name__ == "__main__":
    main()
