// COLLADA models into the 3D view (REQ-GAP-34): a .dae (with its textures dropped beside it) or a
// KMZ whose KML places a <Model>. The model is read by vector/mesh-formats.js, converted to GLB
// and added like any glTF: placed by the GIS Workbench origin it carries, by the KML Location
// (absolute altitudes are above mean sea level: the EGM96 undulation is added), or at the centre.

import { unzipSync, strFromU8 } from 'fflate';
import { readCollada, colladaToGlb, kmlModel } from '../vector/mesh-formats.js';
import { gwError } from '../i18n/index.js';

const lower = (p) => decodeURIComponent(String(p).split(/[\\/]/).pop()).toLowerCase();

/** True when a KMZ's doc.kml (or first .kml) places a COLLADA <Model>. */
export async function kmzHasModel(file) {
  if (file.size > 256e6) return false; // a large KMZ is an image overlay, not a model
  try {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()), { filter: (f) => /\.kml$/i.test(f.name) });
    const k = z['doc.kml'] ?? Object.values(z)[0];
    return !!k && /<(\w+:)?Model[\s>]/.test(strFromU8(k));
  } catch {
    return false;
  }
}

/**
 * Read a .dae or a model KMZ → {doc, origin, images, kml} (origin from the KML Location or the
 * document's own extra). `resources`: files dropped with a .dae (its textures).
 */
export async function readModelFile(file, { resources = [], undulation = () => 0 } = {}) {
  const images = new Map();
  if (/\.kmz$/i.test(file.name)) {
    const z = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const kmlName = z['doc.kml'] ? 'doc.kml' : Object.keys(z).find((n) => /\.kml$/i.test(n));
    const km = kmlName ? kmlModel(strFromU8(z[kmlName])) : null;
    const daeName = (km?.href && Object.keys(z).find((n) => n.toLowerCase() === km.href.replace(/^\.\//, '').toLowerCase())) ?? Object.keys(z).find((n) => /\.dae$/i.test(n));
    if (!daeName) throw gwError('{file} has no COLLADA model', { file: file.name }, 'E_KMZ_NO_MODEL');
    for (const [n, b] of Object.entries(z)) if (/\.(png|jpe?g|webp)$/i.test(n)) images.set(lower(n), b);
    const doc = readCollada(strFromU8(z[daeName]));
    let origin = doc.origin;
    if (km && Number.isFinite(km.lat) && Number.isFinite(km.lon)) {
      // KML: absolute altitude above mean sea level; relative modes have no terrain here, so they sit on the ellipsoid plus the offset.
      const h = km.altitudeMode === 'absolute' ? km.altitude + undulation(km.lat, km.lon) : km.altitude;
      origin = { lat: km.lat, lon: km.lon, h };
      if (km.heading) doc.warnings.push(`KML heading ${km.heading}° is not applied`);
    }
    return { doc, origin, images, kml: km };
  }
  for (const f of resources) if (/\.(png|jpe?g|webp)$/i.test(f.name)) images.set(lower(f.name), new Uint8Array(await f.arrayBuffer()));
  const doc = readCollada(await file.text());
  return { doc, origin: doc.origin, images, kml: null };
}

/** Open a .dae or model KMZ in the 3D view → the view's model entry plus {textured, warnings}. */
export async function openModelFile(app, file, resources = []) {
  const r = await readModelFile(file, { resources, undulation: (lat, lon) => app.core.undulation?.(lat, lon) ?? 0 });
  const g = colladaToGlb(r.doc, { origin: r.origin, images: r.images });
  const v = await app.scene3d.ensureView();
  const m = await v.addGltf(g.glb, file.name);
  return { ...m, textured: g.textured, warnings: g.warnings, models: r.doc.models.length, unit: r.doc.unit, upAxis: r.doc.upAxis };
}
