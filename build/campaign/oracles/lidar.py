"""Point-cloud truth from laspy: version, point format, counts, bounds, scales, class and return
histograms, CRS VLRs. Feeds c10-lidar (pc.header, pc.export round trip, budgets)."""
import numpy as np


def describe(path):
    import laspy
    with laspy.open(str(path)) as f:
        h = f.header
        out = {
            'version': f'{h.version.major}.{h.version.minor}', 'pdrf': h.point_format.id,
            'points': int(h.point_count), 'scales': list(h.scales), 'offsets': list(h.offsets),
            'mins': list(h.mins), 'maxs': list(h.maxs),
            'byReturn': [int(x) for x in h.number_of_points_by_return],
            'vlrs': [f'{v.user_id}/{v.record_id}' for v in h.vlrs],
            'evlrs': [f'{v.user_id}/{v.record_id}' for v in (h.evlrs or [])],
            'extraDims': [d.name for d in h.point_format.extra_dimensions],
            'copc': any(v.user_id == 'copc' for v in h.vlrs),
        }
        try:
            crs = h.parse_crs()
            out['crs'] = crs.to_wkt() if crs else None
            out['epsg'] = crs.to_epsg() if crs else None
        except Exception as e:  # noqa: BLE001
            out['crs'] = f'error: {e}'
        if h.point_count <= 50_000_000:
            pts = f.read()
            cls, n = np.unique(np.asarray(pts.classification), return_counts=True)
            out['classes'] = {int(a): int(b) for a, b in zip(cls, n)}
            out['zRange'] = [float(np.min(pts.z)), float(np.max(pts.z))]
    return out
