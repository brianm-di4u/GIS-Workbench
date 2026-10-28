"""Vector truth from GDAL/OGR: layers, feature counts, geometry types, extents, fields, CRS and a
validity count (GEOS). Feeds c12-vector (open, ext.saveas round trip, ext.validate)."""
from osgeo import gdal, ogr, osr

ogr.UseExceptions()
gdal.UseExceptions()


def describe(path):
    p = str(path)
    if p.lower().endswith('.zip'):
        p = '/vsizip/' + p
    # H-15: the GML driver writes a .gfs schema file next to its input by default; the corpus is
    # read-only to the oracles.
    ds = gdal.OpenEx(p, gdal.OF_VECTOR, open_options=['WRITE_GFS=NO'] if p.lower().endswith('.gml') else [])
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
