"""SAR truth from NGA sarpy: SICD/SIDD version and key fields, image corners (ICP), SCP, and an
image→ground grid for projection checks (AT-12.x: corners ≤ 0.01 m, round trip ≤ 0.05 px)."""
import numpy as np


def describe(path):
    from sarpy.io.complex.converter import open_complex
    from sarpy.io.product.converter import open_product
    try:
        rd = open_complex(str(path))
        kind = 'SICD'
    except Exception:  # noqa: BLE001 - try SIDD next
        rd = open_product(str(path))
        kind = 'SIDD'
    out = {'kind': kind, 'images': []}
    metas = rd.get_sicds_as_tuple() if kind == 'SICD' else rd.get_sidds_as_tuple()
    for m in metas:
        if kind == 'SICD':
            rows, cols = m.ImageData.NumRows, m.ImageData.NumCols
            scp = m.GeoData.SCP.LLH
            img = {
                'version': m.version_required() if hasattr(m, 'version_required') else None,
                'rows': rows, 'cols': cols, 'pixelType': m.ImageData.PixelType,
                'collector': m.CollectionInfo.CollectorName, 'mode': m.CollectionInfo.RadarMode.ModeType,
                'grid': m.Grid.Type, 'imageFormation': m.ImageFormation.ImageFormAlgo,
                'scp': [scp.Lat, scp.Lon, scp.HAE],
                'icp': [[c.Lat, c.Lon] for c in m.GeoData.ImageCorners],
                'rowSS': m.Grid.Row.SS, 'colSS': m.Grid.Col.SS,
                'radiometric': bool(m.Radiometric),
            }
            # Projection grid: 5×5 pixels → ground on the SCP HAE plane (sarpy point_projection).
            from sarpy.geometry.point_projection import image_to_ground_geo, ground_to_image_geo
            r = np.linspace(0, rows - 1, 5)
            c = np.linspace(0, cols - 1, 5)
            pts = np.array([[a, b] for a in r for b in c])
            geo = image_to_ground_geo(pts, m, projection_type='HAE')
            back, _, _ = ground_to_image_geo(geo, m)
            img['grid5'] = {'pixels': pts.tolist(), 'llh': geo.tolist(), 'roundTripPx': float(np.max(np.abs(back - pts)))}
        else:
            img = {'rows': m.Measurement.PixelFootprint.Row, 'cols': m.Measurement.PixelFootprint.Col,
                   'projection': type(m.Measurement.ProjectionType if hasattr(m.Measurement, 'ProjectionType') else m.Measurement).__name__,
                   'pixelType': m.Display.PixelType if m.Display else None}
        out['images'].append(img)
    return out


class Cphd:
    """CPHD metadata via sarpy (the app reads CPHD metadata only, REQ-SAR CPHD row)."""

    @staticmethod
    def describe(path):
        from sarpy.io.phase_history.converter import open_phase_history
        rd = open_phase_history(str(path))
        m = rd.cphd_meta
        ch = m.Data.Channels
        return {
            'version': getattr(rd, 'cphd_version', None),
            'collector': m.CollectionID.CollectorName, 'mode': m.CollectionID.RadarMode.ModeType,
            'channels': len(ch), 'vectors': [c.NumVectors for c in ch], 'samples': [c.NumSamples for c in ch],
            'domain': m.Global.DomainType, 'phaseSgn': m.Global.SGN,
            'refTime': str(m.Global.Timeline.CollectionStart),
        }
