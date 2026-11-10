"""GEOS through GDAL reference for vector geoprocessing (REQ-GAP-79 oracle, SDP-2.7 §4.1).

Every operation is OGR's (osgeo.ogr Geometry: Buffer/BufferEx, Intersection, Union, Difference,
UnionCascaded, Intersects, Within, Contains, Distance), which GDAL implements on GEOS, run in a
PROJ azimuthal equidistant projection (+proj=aeqd on the WGS 84 ellipsoid) about each feature
(buffers) or about the layers' centre (overlay, dissolve, join). Nothing here is shared with
app/src/analysis/geoproc.js or crates/gw-geoproc.

The app's own results come in as GeoJSON and are measured in the same projection: area of each,
area of their symmetric difference, and the Hausdorff distance between their boundaries (shapely,
GEOS too). Usage: python -I geoproc_ref.py IN.json OUT.json
"""
import json
import sys

from osgeo import ogr, osr
import shapely.wkb

osr.UseExceptions()
ogr.UseExceptions()

WGS84 = osr.SpatialReference()
WGS84.ImportFromEPSG(4326)
WGS84.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)


def aeqd(lat, lon):
    s = osr.SpatialReference()
    s.ImportFromProj4(f"+proj=aeqd +lat_0={lat} +lon_0={lon} +ellps=WGS84 +units=m +no_defs")
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return osr.CoordinateTransformation(WGS84, s)


def geom(gj, ct):
    if gj is None:
        return None
    g = ogr.CreateGeometryFromJson(json.dumps(gj))
    g.Transform(ct)
    return g


def shp(g):
    return shapely.wkb.loads(bytes(g.ExportToWkb()))


def compare(ours, ref):
    """Area of each, of their symmetric difference, and the boundary Hausdorff distance (m)."""
    a = ours.GetArea() if ours is not None else 0.0
    b = ref.GetArea() if ref is not None and not ref.IsEmpty() else 0.0
    if ours is None or ref is None or ref.IsEmpty():
        return {"ours": a, "ref": b, "symdiff": abs(a - b), "hausdorff": None}
    sd = ours.SymDifference(ref).GetArea()
    hd = shp(ours).boundary.hausdorff_distance(shp(ref).boundary)
    return {"ours": a, "ref": b, "symdiff": sd, "hausdorff": hd}


def union_all(gs):
    m = ogr.Geometry(ogr.wkbMultiPolygon)
    for g in gs:
        if g is None:
            continue
        g = g.MakeValid()
        if g.GetGeometryType() in (ogr.wkbPolygon, ogr.wkbPolygon25D):
            m.AddGeometry(g)
        elif g.GetGeometryCount():
            for k in range(g.GetGeometryCount()):
                p = g.GetGeometryRef(k)
                if p.GetGeometryType() in (ogr.wkbPolygon, ogr.wkbPolygon25D):
                    m.AddGeometry(p)
    return m.UnionCascaded() if m.GetGeometryCount() else ogr.Geometry(ogr.wkbMultiPolygon)


def op_buffer(spec):
    out = []
    caps = {"round": "ROUND", "flat": "FLAT", "square": "SQUARE"}
    for f, c, mine in zip(spec["features"], spec["centres"], spec["ours"]):
        ct = aeqd(c[0], c[1])
        g = geom(f, ct)
        opts = [f"QUADRANT_SEGMENTS={spec['quadSegs']}", f"ENDCAP_STYLE={caps[spec['cap']]}", "JOIN_STYLE=ROUND"]
        ref = g.Buffer(spec["distance"], opts)
        out.append(compare(geom(mine, ct), ref))
    return {"features": out}


def op_overlay(spec):
    ct = aeqd(*spec["centre"])
    a = [geom(g, ct).MakeValid() for g in spec["a"]]
    b = [geom(g, ct).MakeValid() for g in spec["b"]]
    op = spec["kind"]
    ua, ub = union_all(a), union_all(b)
    if op == "intersect":
        ref = ua.Intersection(ub)
    elif op == "union":
        ref = ua.Union(ub)
    elif op == "erase":
        ref = ua.Difference(ub)
    else:
        ref = ua.SymDifference(ub)
    # Pairwise pieces, for the intersection: the area of each A ∩ B that meets.
    pairs = 0
    pair_area = 0.0
    if op in ("intersect", "union"):
        for ga in a:
            for gb in b:
                if ga.Intersects(gb):
                    i = ga.Intersection(gb)
                    if i.GetArea() > 0:
                        pairs += 1
                        pair_area += i.GetArea()
    ours = union_all([geom(g, ct) for g in spec["ours"]])
    total_ours = sum(geom(g, ct).GetArea() for g in spec["ours"])
    return {"compare": compare(ours, ref), "pairs": pairs, "pairArea": pair_area, "oursPieceArea": total_ours}


def op_dissolve(spec):
    ct = aeqd(*spec["centre"])
    groups = {}
    for g, k in zip(spec["features"], spec["groups"]):
        groups.setdefault(k, []).append(geom(g, ct))
    out = {}
    for k, mine in spec["ours"].items():
        out[k] = compare(geom(mine, ct), union_all(groups[int(k)]))
    return {"groups": out}


def op_join(spec):
    ct = aeqd(*spec["centre"])
    t = [geom(g, ct) for g in spec["targets"]]
    j = [geom(g, ct) for g in spec["joins"]]
    pred = spec["predicate"]
    field = spec.get("field")
    vals = spec.get("values", [])
    out = []
    for g in t:
        if pred == "nearest":
            d = [g.Distance(h) for h in j]
            k = min(range(len(d)), key=d.__getitem__)
            out.append({"nearest": k, "distance": d[k]})
            continue
        test = {"intersects": g.Intersects, "within": g.Within, "contains": g.Contains}[pred]
        hit = [k for k, h in enumerate(j) if test(h)]
        s = [vals[k] for k in hit if field is not None and vals[k] is not None]
        out.append({"count": len(hit), "sum": sum(s) if s else None})
    return {"targets": out}


def op_tiger(spec):
    """A county's block groups and roads from the TIGER/Line 2024 zips, as GeoJSON (test input)."""
    out = {}
    for key, path, where in (("polygons", spec["bg"], f"COUNTYFP = '{spec['county']}'"), ("lines", spec["roads"], None)):
        ds = ogr.Open(f"/vsizip/{path}")
        lyr = ds.GetLayer(0)
        if where:
            lyr.SetAttributeFilter(where)
        ct = osr.CoordinateTransformation(lyr.GetSpatialRef(), WGS84)
        feats = []
        for f in lyr:
            g = f.GetGeometryRef().Clone()
            g.Transform(ct)
            props = {k: f.GetField(k) for k in spec.get(key + "Fields", [])}
            feats.append({"geometry": json.loads(g.ExportToJson()), "properties": props})
            if len(feats) >= spec.get("limit", 10 ** 9):
                break
        out[key] = feats
    return out


def main():
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    op = {"buffer": op_buffer, "overlay": op_overlay, "dissolve": op_dissolve, "join": op_join, "tiger": op_tiger}[spec["op"]]
    json.dump(op(spec), open(sys.argv[2], "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
