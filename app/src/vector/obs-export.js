// Observations out of the app (OD-2.23 field tools, REQ-HOST-05): GeoJSON and KML/KMZ, each with
// the observation's photos. Pure functions over observation records
// ({id, text, category, confidence, time, created, lat, lon, h, analyst, image, photos:
// [{name, type, data (data: URL)}]}); tests/unit/obs-export.test.js checks them and reads the KML
// back with the app's own KML reader. `scene` adds the AOIs, GRG cells and annotations, as items
// {id, kind ('aoi', 'graphic'), name, shape, coords [[lon, lat, h?], …]} in ground positions.

import { zipSync, strToU8 } from 'fflate';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** Observations that have a position. */
export const placed = (obs) => obs.filter((o) => Number.isFinite(o.lat) && Number.isFinite(o.lon));

/** The bytes of a data: URL (base64). */
export function dataUrlBytes(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(String(url ?? ''));
  if (!m) throw new Error('not a data: URL');
  if (!m[2]) return strToU8(decodeURIComponent(m[3]));
  const bin = atob(m[3]);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

/** A safe file name for a photo inside an archive: files/<obs>-<n>.<ext>. */
export function photoPath(o, i, p) {
  const ext = /png/i.test(p?.type ?? '') ? 'png' : 'jpg';
  return `files/${String(o.id ?? 'obs').replace(/[^\w.-]+/g, '_')}-${i + 1}.${ext}`;
}

const when = (o) => o.time ?? o.created ?? null;

/** 'polygon', 'line' or 'point' of a scene item. */
const sceneType = (s) => (s.coords.length === 1 ? 'point' : s.coords.length >= 3 && (s.shape === 'polygon' || s.shape === 'rect' || s.kind === 'aoi') ? 'polygon' : 'line');

function sceneFeature(s) {
  const c = s.coords.map(([lon, lat]) => [lon, lat]);
  const type = sceneType(s);
  const geometry = type === 'point' ? { type: 'Point', coordinates: c[0] } : type === 'polygon' ? { type: 'Polygon', coordinates: [[...c, c[0]]] } : { type: 'LineString', coordinates: c };
  return { type: 'Feature', id: s.id, geometry, properties: { kind: s.kind, shape: s.shape ?? null, name: s.name ?? '' } };
}

function scenePlacemark(s) {
  const pos = s.coords.map(([lon, lat]) => `${lon.toFixed(9)},${lat.toFixed(9)}`);
  const type = sceneType(s);
  const geom = type === 'point' ? `<Point><coordinates>${pos[0]}</coordinates></Point>` : type === 'polygon' ? `<Polygon><outerBoundaryIs><LinearRing><coordinates>${[...pos, pos[0]].join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>` : `<LineString><coordinates>${pos.join(' ')}</coordinates></LineString>`;
  return `<Placemark id="${esc(s.id)}"><name>${esc(s.name || s.shape || s.kind)}</name><ExtendedData><Data name="kind"><value>${esc(s.kind)}</value></Data></ExtendedData>${geom}</Placemark>`;
}

/** GeoJSON FeatureCollection (RFC 7946: lon, lat[, height]); photos as data: URLs in the properties. */
export function observationsGeoJSON(obs, { photos = true, scene = [] } = {}) {
  return {
    type: 'FeatureCollection',
    features: placed(obs).map((o) => ({
      type: 'Feature',
      id: o.id,
      geometry: { type: 'Point', coordinates: Number.isFinite(o.h) ? [o.lon, o.lat, o.h] : [o.lon, o.lat] },
      properties: {
        text: o.text ?? '',
        category: o.category ?? 'other',
        confidence: o.confidence ?? 'moderate',
        time: when(o),
        analyst: o.analyst ?? '',
        image: o.image ?? null,
        photos: (o.photos ?? []).map((p, i) => ({ name: p.name ?? photoPath(o, i, p).slice(6), type: p.type ?? 'image/jpeg', ...(photos ? { href: p.data } : {}) })),
      },
    })).concat(scene.map(sceneFeature)),
  };
}

/**
 * KML 2.2: one Placemark per observation. With `photoHref(o, i, p)` the description shows the
 * photos (a KMZ passes the archive paths). Heights are left to the ground (clampToGround): a
 * phone's or an image's height is not a KML absolute altitude.
 */
export function observationsKml(obs, { name = 'GIS Workbench observations', photoHref = null, scene = [] } = {}) {
  const marks = placed(obs).map((o) => {
    const t = when(o);
    const pics = photoHref ? (o.photos ?? []).map((p, i) => `<p><img src="${esc(photoHref(o, i, p))}" width="320"/></p>`).join('') : '';
    const desc = `<p>${esc(o.text ?? '')}</p><p>${esc(o.category ?? '')} · ${esc(o.confidence ?? '')}${t ? ` · ${esc(t)}` : ''}</p>${pics}`;
    const data = [['category', o.category], ['confidence', o.confidence], ['time', t], ['analyst', o.analyst], ['image', o.image], ['photos', (o.photos ?? []).length]].filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<Data name="${k}"><value>${esc(v)}</value></Data>`).join('');
    return `<Placemark id="${esc(o.id)}"><name>${esc((o.text ?? '').slice(0, 60) || o.category || 'observation')}</name>${t ? `<TimeStamp><when>${esc(t)}</when></TimeStamp>` : ''}<description><![CDATA[${desc.replace(/]]>/g, ']]]]><![CDATA[>')}]]></description><ExtendedData>${data}</ExtendedData><Point><coordinates>${(+o.lon).toFixed(8)},${(+o.lat).toFixed(8)}</coordinates></Point></Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${marks.join('')}${scene.map(scenePlacemark).join('')}</Document></kml>\n`;
}

/** KMZ: doc.kml and the photos under files/. Returns zip bytes. */
export function observationsKmz(obs, opts = {}) {
  const entries = { 'doc.kml': strToU8(observationsKml(obs, { ...opts, photoHref: photoPath })) };
  for (const o of placed(obs)) (o.photos ?? []).forEach((p, i) => (entries[photoPath(o, i, p)] = [dataUrlBytes(p.data), { level: 0 }]));
  return zipSync(entries);
}
