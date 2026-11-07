// Vendor metadata helpers for the lazy js-vendor block (REQ-GAP-20; lazy/vendor.lazy.js): the words for
// the Rust readers' notes, the band of a Landsat or Sentinel-2 band file from its name, and the
// tile offsets of a DigitalGlobe .TIL.

import { t } from '../i18n/index.js';
import { fmtNum } from '../shell/dom.js';

/** Words for the reader's notes: flags (gw_sensor::vendor::dg NOTE_*) and the a priori σ. */
export function vendorNotes({ flags = 0, sigma = null } = {}) {
  const out = [];
  if (flags & 1) out.push(t('line timing from avgLineRate: the IMD has no TLCList'));
  if (flags & 2) out.push(t('the GEO camera attitude is not the identity; it is applied after the ATT attitude, an order not checked on a sample'));
  if (flags & 8) out.push(t('the EPH and ATT files state no covariance, so the model has no a priori error'));
  if (sigma) out.push(t('a priori σ from the EPH and ATT covariances: position {inTrack} m in track, {crossTrack} m across, {radial} m radial; attitude {att} µrad per axis', { inTrack: fmtNum(sigma[0], 3), crossTrack: fmtNum(sigma[1], 3), radial: fmtNum(sigma[2], 3), att: fmtNum(sigma[3], 2) }));
  return out;
}

/** The band of a Landsat band file name (…_B4.TIF → 4). */
export const landsatBand = (name) => Number(/_B(\d{1,2})\.TIF$/i.exec(name ?? '')?.[1] ?? NaN);
/** The band index (0–12) of a Sentinel-2 band file name (…_B04.jp2, …_B8A_10m.jp2). */
export function s2Band(name) {
  const m = /_(B\d{2}|B8A)(_\d+m)?\.(jp2|tif)$/i.exec(name ?? '');
  if (!m) return NaN;
  const order = ['B01', 'B02', 'B03', 'B04', 'B05', 'B06', 'B07', 'B08', 'B8A', 'B09', 'B10', 'B11', 'B12'];
  return order.indexOf(m[1].toUpperCase());
}

/** DG .TIL → {file name (lower case): [ULColOffset, ULRowOffset]}. */
export function parseTilOffsets(text) {
  const out = {};
  for (const m of text.matchAll(/BEGIN_GROUP\s*=\s*TILE_\d+([\s\S]*?)END_GROUP/gi)) {
    const f = /filename\s*=\s*"([^"]+)"/i.exec(m[1])?.[1];
    const c = Number(/ULColOffset\s*=\s*(-?\d+)/i.exec(m[1])?.[1] ?? 0);
    const r = Number(/ULRowOffset\s*=\s*(-?\d+)/i.exec(m[1])?.[1] ?? 0);
    if (f) out[f.toLowerCase()] = [c, r];
  }
  return out;
}
