"""Geodesy truth set (independent of the app's Rust): UTM/UPS from PROJ via pyproj, geodesic
inverse/direct and polygon areas from GeographicLib (Python). A deterministic point set covers
zone edges, the Norway/Svalbard exceptions, UPS caps and the antimeridian, plus every corpus
raster centre. Feeds tests/campaign/golden/geodesy.test.js (AT-03.x, AT-05.x)."""
import json
import random

from geographiclib.geodesic import Geodesic
from pyproj import CRS, Transformer

G = Geodesic.WGS84


def utm_zone(lat, lon):
    if lat >= 84 or lat < -80:
        return 0
    z = int((lon + 180) // 6) + 1
    if 56 <= lat < 64 and 3 <= lon < 12:
        z = 32
    if 72 <= lat < 84 and lon >= 0:
        z = 31 if lon < 9 else 33 if lon < 21 else 35 if lon < 33 else 37 if lon < 42 else z
    return min(z, 60)


_tr = {}


def project(lat, lon):
    z = utm_zone(lat, lon)
    north = lat >= 0
    epsg = (32661 if north else 32761) if z == 0 else (32600 if north else 32700) + z
    if epsg not in _tr:
        _tr[epsg] = Transformer.from_crs(CRS.from_epsg(4326), CRS.from_epsg(epsg), always_xy=True)
    e, n = _tr[epsg].transform(lon, lat)
    return {'zone': z, 'north': north, 'easting': e, 'northing': n, 'epsg': epsg}


def points(extra=()):
    rnd = random.Random(20261026)
    pts = [(rnd.uniform(-79.9, 83.9), rnd.uniform(-179.99, 179.99)) for _ in range(1500)]
    pts += [(rnd.uniform(84.05, 89.9), rnd.uniform(-180, 180)) for _ in range(100)]
    pts += [(rnd.uniform(-89.9, -80.05), rnd.uniform(-180, 180)) for _ in range(100)]
    for z in range(1, 61):  # just inside each zone edge
        lon = -180 + 6 * (z - 1)
        pts += [(rnd.uniform(-70, 50), lon + 1e-7), (rnd.uniform(-70, 50), lon + 6 - 1e-7)]
    pts += [(60.0, 3.0), (63.999999, 2.999999), (63.999999, 3.000001), (72.0, 8.999999), (72.0, 9.000001), (83.999, 20.999), (83.999, 21.001)]
    pts += [(la, (lo + 180) % 360 - 180) for la, lo in extra]  # corpus centres may carry lon > 180
    return pts


def build(extra=()):
    pts = points(extra)
    rnd = random.Random(7)
    geod = []
    for _ in range(600):
        a, b = rnd.choice(pts), rnd.choice(pts)
        g = G.Inverse(a[0], a[1], b[0], b[1])
        geod.append({'p1': a, 'p2': b, 's12': g['s12'], 'azi1': g['azi1'], 'azi2': g['azi2']})
    polys = []
    for _ in range(100):
        lat0, lon0 = rnd.uniform(-70, 70), rnd.uniform(-170, 170)
        size = 10 ** rnd.uniform(-3, 0.5)  # ~100 m to ~300 km
        ring = [(lat0 + size * dy, lon0 + size * dx) for dx, dy in ((0, 0), (1, 0), (1, 1), (0.3, 1.4), (0, 1))]
        p = G.Polygon()
        for la, lo in ring:
            p.AddPoint(la, lo)
        n, perim, area = p.Compute(False, True)
        polys.append({'ring': ring, 'area': abs(area), 'perimeter': perim})
    return {'source': 'pyproj (PROJ) UTM/UPS; GeographicLib Python geodesics', 'utm': [{'lat': la, 'lon': lo, **project(la, lo)} for la, lo in pts],
            'geodesics': geod, 'polygons': polys}


if __name__ == '__main__':
    print(json.dumps(build())[:200])
