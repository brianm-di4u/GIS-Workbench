"""Vector truth from GDAL/OGR: layers, feature counts, geometry types, extents, fields, CRS and a
validity count (GEOS). Feeds c12-vector (open, ext.saveas round trip, ext.validate)."""
from osgeo import ogr, osr

ogr.UseExceptions()


def describe(path):
    p = str(path)
    if p.lower().endswith('.zip'):
        p = '/vsizip/' + p
    ds = ogr.Open(p)
    layers = []
    for i in range(ds.GetLayerCount()):
        lyr = ds.GetLayerByIndex(i)
        srs = lyr.GetSpatialRef()
        defn = lyr.GetLayerDefn()
        invalid = 0
        n = 0
        for feat in lyr:
            n += 1
            g = feat.GetGeometryRef()
            if g is not None and not g.IsValid():
                invalid += 1
            if n >= 200_000:
                break
        lyr.ResetReading()
        layers.append({
            'name': lyr.GetName(), 'features': lyr.GetFeatureCount(), 'geomType': ogr.GeometryTypeToName(lyr.GetGeomType()),
            'extent': lyr.GetExtent(can_return_null=True), 'epsg': srs.GetAuthorityCode(None) if srs else None,
            'fields': [defn.GetFieldDefn(j).GetName() for j in range(defn.GetFieldCount())],
            'invalidGeometries': invalid, 'checked': n,
        })
    return {'driver': ds.GetDriver().GetName(), 'layers': layers}
