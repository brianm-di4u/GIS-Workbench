// MrSID container header (TE-061, FC-01, REQ-FMT-22): recognise LizardTech/Extensis MrSID files by
// their "msid" magic. The wavelet codestream is proprietary and undocumented (OD-10 closed by OD-2.9:
// footprint natively, pixels through the sidecar), so the file opens as a footprint layer: the
// container's size, bands, generation and georeferencing (the image-information records GeoExpress
// writes, parsed by the Rust `legacy` bundle) over a hatched placeholder raster whose every level is
// generated, never decoded. ECW shares the footprint source (ecw-header.js).

import { gwError } from '../../i18n/index.js';
import { wasmError, nested } from '../errors.js';

export const isMrSid = (h) => h.length >= 4 && h[0] === 0x6d && h[1] === 0x73 && h[2] === 0x69 && h[3] === 0x64;

/** Header fields from the first 41 bytes, or null when they are not plausible. */
export function mrsidHeader(b) {
  if (b.length < 41 || !isMrSid(b)) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = b[4];
  const width = v.getUint32(26);
  const height = v.getUint32(30);
  const bands = b[36];
  const bits = b[40];
  const ok = width > 0 && height > 0 && width < 2 ** 31 && height < 2 ** 31 && bands >= 1 && bands <= 255 && [8, 16, 32].includes(bits);
  return { version, generation: version === 3 ? 'MG3' : version === 4 ? 'MG4' : version <= 2 ? 'MG2' : `v${version}`, ...(ok ? { width, height, bands, bits } : {}) };
}

/** The refusal shown for a MrSID file whose container cannot be read (REQ-FMT-56: names the route). */
export function mrsidRefusal(b, why = '') {
  return mrsidRefusalError(b, why).message;
}

/** The same as an Error with its message key; `why` is the reason (text or a caught Error). */
export function mrsidRefusalError(b, why = '') {
  const m = mrsidHeader(b);
  const what = nested(m?.width ? gwError('{w} × {h} px, {bands, plural, one {# band} other {# bands}}, {bits}-bit', { w: m.width.toLocaleString('en-US'), h: m.height.toLocaleString('en-US'), bands: m.bands, bits: String(m.bits) }) : gwError('header not readable'));
  const gen = m?.generation ?? '?';
  const reason = why instanceof Error ? nested(why) : String(why ?? '');
  return String(reason)
    ? gwError('MrSID ({gen}; {what}): {why}. Its pixels are a proprietary wavelet codestream with no open decoder: convert it with the GIS Workbench sidecar (Convert with Sidecar, profile raster-cog) or gdal_translate -of COG with a MrSID-enabled GDAL', { gen, what, why: reason })
    : gwError('MrSID ({gen}; {what}). Its pixels are a proprietary wavelet codestream with no open decoder: convert it with the GIS Workbench sidecar (Convert with Sidecar, profile raster-cog) or gdal_translate -of COG with a MrSID-enabled GDAL', { gen, what });
}

/** Bytes read for a container header: GeoExpress keeps its records in the first few tens of KB. */
export const FOOTPRINT_HEAD = 1 << 18;

/** Footprint JSON from the first bytes of a MrSID (kind 1) or ECW (kind 2) file, via the legacy bundle. */
export function readFootprint(head, kind, legacy) {
  const [p, n] = legacy.put(head);
  try {
    if (legacy.x.gw_footprint_header(kind, p, n) !== 0) throw wasmError(legacy);
    return legacy.outJson();
  } finally {
    legacy.free(p, n);
  }
}

/**
 * Placeholder raster of a footprint: 0 (nodata, transparent) inside, 1 on a two-pixel border and 2 on
 * a diagonal hatch, generated for every pyramid level so a 340 000 × 220 000 mosaic draws at once.
 */
export function footprintSource(fp) {
  const width = Math.max(1, Math.round(fp.width));
  const height = Math.max(1, Math.round(fp.height));
  const draw = (lw, lh, x0, y0, w, h) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const Y = y0 + y;
      if (Y < 0 || Y >= lh) continue;
      for (let x = 0; x < w; x++) {
        const X = x0 + x;
        if (X < 0 || X >= lw) continue;
        out[y * w + x] = X < 2 || Y < 2 || X >= lw - 2 || Y >= lh - 2 ? 1 : (X + Y) % 24 < 2 ? 2 : 0;
      }
    }
    return out;
  };
  return {
    kind: 'footprint',
    width,
    height,
    bands: 1,
    sampleType: 'u8',
    nodata: 0,
    footprint: fp,
    hasLevel: () => true,
    async readLevel(L, x0, y0, w, h, bands) {
      const lw = Math.max(1, Math.ceil(width / 2 ** L));
      const lh = Math.max(1, Math.ceil(height / 2 ** L));
      return bands.map(() => draw(lw, lh, x0, y0, w, h));
    },
    async readWindow(x0, y0, w, h, bands) {
      if (w * h > 64e6) throw new Error('a footprint has no pixels: convert the file with the sidecar to read them');
      return bands.map(() => draw(width, height, x0, y0, w, h));
    },
  };
}
