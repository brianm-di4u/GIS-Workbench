// Content-based routing (REQ-ING-03): a file whose name says nothing is identified by its first
// bytes and given the extension its route expects; a dropped folder is walked.

/** Names the routes know; anything else is identified by content. */
const KNOWN_EXT = /\.(gwb|gwpack|pmtiles|geojson|json|kml|kmz|shp|shx|dbf|prj|cpg|zip|gpkg|csv|gpx|gml|xml|las|laz|copc|glb|gltf|ts|mpg|mpeg|m2ts|4607|ntf|nitf|nsf|r0|tif|tiff|jp2|j2k|jpg|jpeg|png|gif|bmp|webp|dt0|dt1|dt2|hgt|img|hdr|h5|he5|nc|pdf|sid|aux|tfw|jgw|pgw|wld|rpb|til|imd|txt|parquet)$/i;

/** The extension a file's content calls for, or null when it is unknown or already right. */
export function sniffExt(name, head) {
  if (KNOWN_EXT.test(name) || head.length < 4) return null;
  const b = head;
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head).replace(/^﻿/, '').trimStart();
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return '.zip';
  if (text.startsWith('SQLite format 3')) return '.gpkg';
  if (text.startsWith('PAR1')) return '.parquet';
  if (b[0] === 0 && b[1] === 0 && b[2] === 0x27 && b[3] === 0x0a) return '.shp';
  if (text.startsWith('LASF')) return '.las';
  if (/^[{[]/.test(text) && /"type"\s*:\s*"(FeatureCollection|Feature|Polygon|Point|LineString|Multi)/.test(text)) return '.geojson';
  if (/<kml[\s>]/i.test(text)) return '.kml';
  if (/<gpx[\s>]/i.test(text)) return '.gpx';
  if (/<(gml:)?FeatureCollection|xmlns:gml=/i.test(text)) return '.gml';
  return null;
}

/** A renamed copy of a file whose extension is missing or unknown, from its first 4 KiB. */
export async function sniffName(f) {
  if (KNOWN_EXT.test(f.name) || f.size < 4) return f;
  const ext = sniffExt(f.name, new Uint8Array(await f.slice(0, 4096).arrayBuffer()));
  if (!ext) return f;
  const g = new File([f], `${f.name}${ext}`, { type: f.type, lastModified: f.lastModified });
  if (f.__handle) g.__handle = f.__handle;
  return g;
}

/** Every file in a dropped folder (4 levels, 2000 files at most). */
export async function walkFolder(dir, out = [], depth = 0) {
  for await (const [, hnd] of dir.entries()) {
    if (out.length >= 2000) break;
    if (hnd.kind === 'directory') {
      if (depth < 4) await walkFolder(hnd, out, depth + 1);
    } else {
      const f = await hnd.getFile();
      f.__handle = hnd;
      out.push(f);
    }
  }
  return out;
}
