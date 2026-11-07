// Frame coverage of an RPF table of contents (REQ-FMT-40: coverage shown before the frames load):
// one polygon per frame cell of each equal-arc boundary rectangle, from the TOC alone. Shared by the
// decode worker and the main thread (no imports).

const FRAME = 1536;

/** GeoJSON of a TOC's frame cells (equal-arc boundaries) for the coverage layer. */
export function frameCoverage(toc, present = () => true) {
  const features = [];
  for (const b of toc.boundaries) {
    if (b.overview || b.zone === '9' || b.zone === 'J') continue;
    const dLon = b.horizInterval * FRAME;
    const dLat = b.vertInterval * FRAME;
    for (const fr of b.frames) {
      const w = b.nw[1] + fr.col * dLon;
      const n = b.nw[0] - fr.row * dLat;
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, n], [w + dLon, n], [w + dLon, n - dLat], [w, n - dLat], [w, n]]] },
        properties: { file: fr.file, dir: fr.dir, row: fr.row, col: fr.col, product: b.product, scale: b.scale, zone: b.zone, georef: fr.georef, present: present(fr) ? 'yes' : 'no' },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}
