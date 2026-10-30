// Decode worker (REQ-ARC-05/07, REQ-SEC-02): opens files by format, serves pyramid tiles
// and statistics. Every parser of untrusted bytes here is either Rust (`parse` bundle) or a
// vetted library (geotiff.js) or the browser's own image decoder.

import { Pyramid, LRU, TILE } from '../decode/pyramid.js';
import { openNitf, ioStats } from '../decode/nitf.js';
import { mosaicPlan, mosaicSource } from '../decode/mosaic.js';
import { openGeoTiff } from '../decode/geotiff.js';
import { openDem, openPicture } from '../decode/simple.js';
import { sicdSource } from '../decode/sicd.js';
import { enviSource, enviBands, gdalBands } from '../decode/envi.js';
import { openHdf5 } from '../decode/hdf5.js';
import { openGeoPdf } from '../decode/geopdf.js';
import { openJp2 } from '../decode/jp2.js';
import { isMrSid, mrsidRefusal } from '../decode/mrsid-header.js';

const { GW } = self;
const handles = new Map();
const tileCache = new LRU(256 << 20);
let nextHandle = 1;

async function head(file, n = 16) {
  return new Uint8Array(await file.slice(0, n).arrayBuffer());
}

export function detect(h, name) {
  const s = String.fromCharCode(...h.slice(0, 9));
  const lower = name.toLowerCase();
  if (s.startsWith('NITF') || s.startsWith('NSIF')) return 'nitf';
  if ((h[0] === 0x49 && h[1] === 0x49 && (h[2] === 42 || h[2] === 43)) || (h[0] === 0x4d && h[1] === 0x4d && (h[3] === 42 || h[3] === 43))) return 'tiff';
  if (s.startsWith('UHL') || s.startsWith('HDR') || s.startsWith('VOL') || /\.dt[0-2]$/.test(lower)) return 'dted';
  if (/\.hgt(\.gz)?$/.test(lower)) return 'hgt';
  // JP2/JPX signature box, or a bare J2K codestream (SOC + SIZ) — TE-003.
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 12 && h[4] === 0x6a && h[5] === 0x50 && h[6] === 0x20 && h[7] === 0x20) return 'jp2';
  if (h[0] === 0xff && h[1] === 0x4f && h[2] === 0xff && h[3] === 0x51) return 'j2c';
  if (h[0] === 0xff && h[1] === 0xd8) return 'jpeg';
  if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) return 'png';
  if (s.startsWith('GIF8')) return 'gif';
  if (h[0] === 0x42 && h[1] === 0x4d) return 'bmp';
  if (s.startsWith('RIFF') && String.fromCharCode(...h.slice(8, 12)) === 'WEBP') return 'webp';
  if (s.startsWith('SQLite')) return 'gpkg';
  if (s.startsWith('LASF')) return 'las';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  if (h[0] === 0x47 && (lower.endsWith('.ts') || lower.endsWith('.mpg'))) return 'mpegts';
  if (h[0] === 0x89 && s.slice(1, 4) === 'HDF') return 'hdf5';
  if (s.startsWith('%PDF-')) return 'pdf';
  if (s.startsWith('CPHD/')) return 'cphd';
  if (isMrSid(h)) return 'mrsid';
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  // Formats refused by name (TE archive negatives) rather than as "unrecognised data".
  if (String.fromCharCode(...h.slice(0, 15)) === 'EHFA_HEADER_TAG') return 'hfa';
  if (s.startsWith('CDF') && [1, 2, 5].includes(h[3])) return 'netcdf3';
  if (lower.endsWith('.ecw')) return 'ecw';
  return 'unknown';
}

/** XML text → element tree through the hardened Rust reader (no DOMParser in workers). */
function xmlTree(text) {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(new TextEncoder().encode(text));
  try {
    return parse.x.gw_xml_tree(p, n) === 0 ? parse.outJson() : null;
  } finally {
    parse.free(p, n);
  }
}

GW.register('open', async ({ file, name, merge = false, hdr = null }) => {
  if (file?.remoteId) file = GW.remoteFile(file); // a remote file reads its bytes through the pool
  const kind = detect(await head(file, 16), name || file.name || '');
  // ENVI (REQ-MSI-01): a raw file (no recognised container) opened with its .hdr sidecar.
  if (hdr && kind === 'unknown') {
    const parse = GW.bundle('parse');
    const [p, n] = parse.put(new Uint8Array(await hdr.arrayBuffer()));
    let hd;
    try {
      if (parse.x.gw_envi_header(p, n, file.size) !== 0) throw new Error(`ENVI header ${hdr.name}: ${parse.lastError()}`);
      hd = parse.outJson();
    } finally {
      parse.free(p, n);
    }
    const source = enviSource(file, hd);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    const bandsMeta = enviBands(hd);
    return { kind: 'envi', meta: { format: `ENVI ${hd.interleave.toUpperCase()} (data type ${hd.dataType})`, header: hd, bandsMeta }, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels }] };
  }
  const parse = () => GW.bundle('parse');
  let result;
  if (kind === 'nitf') {
    const r = await openNitf(file, parse());
    const images = r.images.map((im) => ({ index: im.index, error: im.error ?? null, subheader: im.ish ?? null, segment: im.seg }));
    const pyr = [];
    // Merged segments (REQ-IMG-20): one mosaic source when the attachment levels allow.
    const plan = mosaicPlan(r.images, r.sources);
    let sources = r.sources;
    let mergeNote = plan.reason ?? null;
    // SICD (REQ-SAR-01): segments of one complex image are always merged (ILOC/IALVL), then
    // wrapped as the derived SAR bands. SIDD products keep their segments and carry the XML.
    const xmls = r.others.filter((o) => o.sar);
    const sicd = xmls.find((o) => o.sar.kind === 'SICD');
    const isSicd = !!sicd && r.images.some((im) => /^SICD/.test(im.ish?.IID1 ?? '') || (im.ish?.ICAT === 'SAR' && im.ish?.IREP === 'NODISPLY'));
    const forceMerge = isSicd && r.sources.length > 1;
    if ((merge || forceMerge) && !plan.reason) {
      sources = [mosaicSource(plan)];
      mergeNote = `${plan.parts.length} segments merged into ${plan.width} × ${plan.height}`;
    } else if (forceMerge) throw new Error(`the SICD's image segments cannot be joined: ${plan.reason}`);
    if (isSicd) sources = [sicdSource(sources[0], sicd.sar)];
    const sidd = xmls.filter((o) => o.sar.kind === 'SIDD');
    for (const src of sources) {
      const h = nextHandle++;
      handles.set(h, { pyr: new Pyramid(src, tileCache), src });
      const im = r.images.find((i) => i.index === src.imageIndex);
      // A SIDD segment IID1 'SIDDppp sss': product ppp uses the ppp-th SIDD XML.
      const prod = /^SIDD(\d{3})/.exec(im?.ish?.IID1 ?? '');
      // A detected product with a SICD XML (filtered amplitude, change, coherence) keeps the
      // SICD geometry but is not complex.
      const sar = sicd ? sicd.sar : sidd.length ? sidd[Math.min(sidd.length - 1, prod ? Number(prod[1]) - 1 : 0)].sar : null;
      pyr.push({ handle: h, imageIndex: src.imageIndex, width: src.width, height: src.height, bands: src.bands, sampleType: src.sampleType, nodata: src.nodata, abpp: src.abpp, levels: handles.get(h).pyr.levels, sar: sar ? { ...sar, complex: isSicd, radiometry: src.radiometry ?? null } : null });
    }
    for (const o of r.others) delete o.sar; // the XML tree goes with the raster only
    result = { kind, header: r.header, images, others: r.others, rasters: pyr, mergeable: !plan.reason, mergeNote, merged: (merge || forceMerge) && !plan.reason ? sources[0].parts ?? null : null };
    for (const p of pyr) if (sources[0].parts && p.handle) p.mosaic = sources[0].parts;
  } else if (kind === 'tiff') {
    const opened = await openGeoTiff(file);
    const { meta } = opened;
    // A complex SLC GeoTIFF (IMP-16) gets the derived SAR bands of a SICD (no calibration block).
    const source = meta.complex ? sicdSource(opened.source, { pixelType: 'RE32F_IM32F' }) : opened.source;
    // Band descriptions and wavelengths from GDAL_METADATA (REQ-MSI-01, AC-13.4).
    if (meta.gdalMetadata) {
      const t = xmlTree(meta.gdalMetadata);
      if (t) {
        const g = gdalBands(t, source.bands);
        meta.bandsMeta = g.bands;
        meta.gdalScale = g.scale;
        meta.gdalOffset = g.offset;
      }
    }
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    const sar = meta.complex ? { kind: 'Complex GeoTIFF', complex: true, version: '', pixelType: meta.sampleType, radiometry: source.radiometry ?? null } : null;
    result = { kind, meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels, sar }] };
  } else if (kind === 'dted' || kind === 'hgt' || (kind === 'gzip' && /\.hgt\.gz$/i.test(name))) {
    const { meta, grid, source } = await openDem(file, parse(), name);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    result = {
      kind: 'dem',
      meta,
      gridInfo: { lat0: grid.lat0, lon0: grid.lon0, dlat: grid.dlat, dlon: grid.dlon, width: grid.width, height: grid.height },
      rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: 1, sampleType: 'f32', nodata: NaN, levels: pyr.levels }],
    };
    // The heights go to the main thread once, for terrain (ray–DEM, cursor height).
    const heights = grid.heights.slice();
    return GW.transfer({ ...result, heights }, [heights.buffer]);
  } else if (kind === 'hdf5') {
    // HDF5 needs the h5wasm data pack (REQ-MSI-02, REQ-ARC-14): the pool sends its verified bytes.
    await GW.lib('h5wasm');
    const { meta, source } = await openHdf5(file, self.h5wasm);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    result = { kind: 'hdf5', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels }] };
  } else if (kind === 'pdf') {
    // GeoPDF raster pages (REQ-FMT-14).
    const { meta, source } = await openGeoPdf(file, parse());
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    result = { kind: 'pdf', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: 3, sampleType: 'u8', nodata: null, levels: pyr.levels }] };
  } else if (kind === 'jp2' || kind === 'j2c') {
    // Standalone JPEG 2000 (TE-003): GeoJP2 / GMLJP2 georeferencing, decoded by the j2k bundle.
    const { meta, source } = await openJp2(file, await self.GW.ensure('j2k'), kind);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    result = { kind: 'jp2', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: null, levels: pyr.levels }] };
  } else if (kind === 'jpeg' || kind === 'png' || kind === 'gif' || kind === 'bmp' || kind === 'webp') {
    const { meta, source } = await openPicture(file, kind);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    result = { kind: 'picture', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: 'u8', nodata: null, levels: pyr.levels }] };
  } else if (kind === 'mrsid') {
    // TE-061: named, with the image's size, instead of "unrecognised data".
    const e = new Error(mrsidRefusal(await head(file, 64)));
    e.code = 4;
    throw e;
  } else {
    const names = { gpkg: 'GeoPackage (R2)', las: 'LAS/LAZ point cloud (R2)', mpegts: 'MPEG-TS motion imagery (R3)', zip: 'ZIP container', gzip: 'gzip file', unknown: 'unrecognised data', cphd: 'CPHD phase history (no image: open the SICD formed from it; CPHD metadata viewing is not in this release)' };
    // With the conversion that makes them readable.
    const named = {
      hfa: 'ERDAS Imagine (HFA .img) is not read in this release; save it as GeoTIFF (e.g. gdal_translate -of COG)',
      netcdf3: 'NetCDF-3 (classic CDF) is not read — NetCDF-4 / HDF5 is; convert it with nccopy -k nc4',
      ecw: 'ECW (Hexagon\'s proprietary wavelet format) has no open decoder and cannot be opened; save it as GeoTIFF or JPEG 2000 with a licensed tool',
    };
    const e = new Error(named[kind] ?? `${names[kind] ?? kind} cannot be opened as imagery in this release`);
    e.code = 4;
    throw e;
  }
  return result;
});

/**
 * Edited DEM posts over a source (REQ-DEM-08): sparse tiles {x0, y0, w, h, data} replace band 0
 * where they cover a window; the source file is never changed. Coarse levels are composed from
 * the edited full-resolution level (native overviews are bypassed while edits exist).
 */
// A small in-memory TIFF (a GeoPackage coverage tile, IMP-11): its first band as f32.
GW.register('tiffBand', async ({ bytes }) => {
  const { source } = await openGeoTiff(new Blob([bytes]));
  const [p] = await source.readWindow(0, 0, source.width, source.height, [0]);
  const data = p instanceof Float32Array ? p : Float32Array.from(p);
  return GW.transfer({ width: source.width, height: source.height, data }, [data.buffer]);
});

GW.register('overlay', async ({ handle, tiles }) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  e.base ??= e.src;
  const base = e.base;
  if (!tiles?.length) {
    e.src = base;
  } else {
    e.src = Object.assign(Object.create(base), {
      hasLevel: () => false,
      readLevel: undefined,
      async readWindow(x, y, w, h, bands, job) {
        const out = await base.readWindow(x, y, w, h, bands, job);
        const bi = bands.indexOf(0);
        if (bi < 0) return out;
        const a = out[bi];
        for (const t of tiles) {
          const ix0 = Math.max(x, t.x0);
          const iy0 = Math.max(y, t.y0);
          const ix1 = Math.min(x + w, t.x0 + t.w);
          const iy1 = Math.min(y + h, t.y0 + t.h);
          for (let yy = iy0; yy < iy1; yy++) for (let xx = ix0; xx < ix1; xx++) a[(yy - y) * w + (xx - x)] = t.data[(yy - t.y0) * t.w + (xx - t.x0)];
        }
        return out;
      },
    });
  }
  e.pyr = new Pyramid(e.src, tileCache); // a new key: cached tiles of the old surface are not reused
  return { tiles: tiles?.length ?? 0 };
});

GW.register('tile', async ({ handle, level, tx, ty, bands }, job) => {
  const h = handles.get(handle);
  if (!h) throw new Error('unknown image handle (the file was closed)');
  const t = await h.pyr.tile(level, tx, ty, bands, job);
  return GW.transfer(t, t.bands.map((b) => b.buffer));
});

GW.register('cellhist', async ({ handle, band, grid = 8, scale = 1, offset = 0 }, job) => {
  const h = handles.get(handle);
  if (!h) throw new Error('unknown image handle');
  const r = await h.pyr.cellHist(band, grid, scale, offset, job);
  return GW.transfer(r, [r.hist.buffer]);
});

GW.register('stats', async ({ handle, bands }, job) => {
  const h = handles.get(handle);
  if (!h) throw new Error('unknown image handle');
  const s = await h.pyr.stats(bands, job);
  return GW.transfer(s, s.bands.map((b) => b.bins.buffer));
});

/** Pixel values around a point at full resolution (Pixel Matrix Viewer, cursor DN read-out). */
GW.register('pixels', async ({ handle, x, y, w = 1, h = 1, bands }) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  const x0 = Math.max(0, Math.min(e.src.width - w, Math.floor(x)));
  const y0 = Math.max(0, Math.min(e.src.height - h, Math.floor(y)));
  const v = await e.src.readWindow(x0, y0, w, h, bands);
  return { x0, y0, w, h, values: v.map((a) => Array.from(a)) };
});

/** One band of a window as Float32, clamped inside the image (matching, REQ-SNS-13). */
GW.register('patch', async ({ handle, x, y, w, h, band = 0 }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  w = Math.min(w, e.src.width);
  h = Math.min(h, e.src.height);
  const x0 = Math.max(0, Math.min(e.src.width - w, Math.floor(x)));
  const y0 = Math.max(0, Math.min(e.src.height - h, Math.floor(y)));
  const [a] = await e.src.readWindow(x0, y0, w, h, [band], job);
  const f = a instanceof Float32Array ? a : Float32Array.from(a);
  return GW.transfer({ x0, y0, w, h, px: f }, [f.buffer]);
});

/**
 * A patch from pyramid level L (2^L full-resolution pixels per sample) covering the full-resolution
 * window [x, x+w) × [y, y+h): {x0, y0, w, h} in level pixels, `scale` = 2^L (orthorectification at
 * coarse output resolutions, TE 2.0.4).
 */
GW.register('patchLevel', async ({ handle, level, x, y, w, h, band = 0 }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  const L = Math.max(0, Math.min(e.pyr.levels - 1, level));
  const s = 2 ** L;
  const { w: lw, h: lh } = e.pyr.dims(L);
  const x0 = Math.max(0, Math.floor(x / s));
  const y0 = Math.max(0, Math.floor(y / s));
  const x1 = Math.min(lw, Math.ceil((x + w) / s));
  const y1 = Math.min(lh, Math.ceil((y + h) / s));
  const pw = Math.max(1, x1 - x0);
  const ph = Math.max(1, y1 - y0);
  const px = new Float32Array(pw * ph);
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + ph - 1) / TILE); ty++)
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + pw - 1) / TILE); tx++) {
      const t = await e.pyr.core(L, tx, ty, band, job);
      const ox = tx * TILE;
      const oy = ty * TILE;
      for (let yy = Math.max(y0, oy); yy < Math.min(y0 + ph, oy + t.h); yy++)
        for (let xx = Math.max(x0, ox); xx < Math.min(x0 + pw, ox + t.w); xx++) px[(yy - y0) * pw + (xx - x0)] = t.data[(yy - oy) * t.w + (xx - ox)];
    }
  return GW.transfer({ x0, y0, w: pw, h: ph, px, scale: s }, [px.buffer]);
});

/** A whole band at full resolution as Float32 (Use as Terrain, REQ-DEM-02). */
GW.register('grid', async ({ handle, band = 0, maxSamples = 25e6, window = null, what = 'the terrain loader' }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  // An optional window [x0, y0, w, h] (change detection scoped to an AOI, TE-052).
  const [x0, y0, w, hh] = window ? [Math.max(0, Math.floor(window[0])), Math.max(0, Math.floor(window[1])), 0, 0] : [0, 0, e.src.width, e.src.height];
  const W = window ? Math.min(e.src.width - x0, Math.ceil(window[2])) : w;
  const H = window ? Math.min(e.src.height - y0, Math.ceil(window[3])) : hh;
  if (W * H > maxSamples) throw new Error(`${W}×${H} samples are more than ${what} takes (${(maxSamples / 1e6).toFixed(0)} M)`);
  const [a] = await e.src.readWindow(x0, y0, W, H, [band], job);
  const f = a instanceof Float32Array ? a : Float32Array.from(a);
  return GW.transfer({ width: W, height: H, x0, y0, heights: f }, [f.buffer]);
});

/** Source samples of a window, every `step`-th pixel (products: GeoTIFF/NITF chips, REQ-PRD-10). */
GW.register('window', async ({ handle, x0, y0, w, h, step = 1, bands, maxSamples = 64e6 }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  const sw = Math.min(e.src.width - x0, w * step);
  const sh = Math.min(e.src.height - y0, h * step);
  const ow = Math.ceil(sw / step);
  const oh = Math.ceil(sh / step);
  if (ow * oh * bands.length > maxSamples) throw new Error(`${ow}×${oh}×${bands.length} samples are more than a product takes (${(maxSamples / 1e6).toFixed(0)} M)`);
  const planes = [];
  // Read in row bands so a decimated chip of a large image never holds the full window.
  const rows = Math.max(step, Math.floor(16e6 / Math.max(1, sw)) - (Math.floor(16e6 / Math.max(1, sw)) % step));
  for (const b of bands) {
    let out = null;
    for (let r0 = 0; r0 < sh; r0 += rows) {
      const rh = Math.min(rows, sh - r0);
      const [a] = await e.src.readWindow(x0, y0 + r0, sw, rh, [b], job);
      out ??= new a.constructor(ow * oh);
      for (let y = 0; y < rh; y += step) {
        const oy = (r0 + y) / step;
        for (let x = 0, ox = 0; x < sw; x += step, ox++) out[oy * ow + ox] = a[y * sw + x];
      }
    }
    planes.push(out);
  }
  return GW.transfer({ x0, y0, w: ow, h: oh, step, planes }, planes.map((p) => p.buffer));
});

/** Complex AOI chip of a SICD as interleaved (re, im) f32 (CCD, sub-apertures; REQ-SAR-09/11). */
GW.register('complex', async ({ handle, x0, y0, w, h, maxSamples = 16e6 }, job) => {
  const e = handles.get(handle);
  if (!e?.src.readComplex) throw new Error('not a SICD complex image');
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  w = Math.min(e.src.width - x0, Math.floor(w));
  h = Math.min(e.src.height - y0, Math.floor(h));
  if (w < 8 || h < 8) throw new Error('the AOI chip is smaller than 8 × 8 pixels inside the image');
  if (w * h > maxSamples) throw new Error(`${w}×${h} is more than an AOI chip takes (${(maxSamples / 1e6).toFixed(0)} M pixels)`);
  const z = await e.src.readComplex(x0, y0, w, h, job);
  return GW.transfer({ x0, y0, w, h, z }, [z.buffer]);
});

/**
 * A BIP Float32 cube of a window (spectral algorithms, REQ-MSI-07..12): every `step`-th pixel of
 * the bands listed, with per-band gain/offset applied (radiometric state); no-data → NaN.
 */
GW.register('cube', async ({ handle, x0 = 0, y0 = 0, w, h, step = 1, bands, gain = null, offset = null, maxSamples = 96e6, pyramid = false }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  w = Math.min(e.src.width - x0, Math.floor(w ?? e.src.width));
  h = Math.min(e.src.height - y0, Math.floor(h ?? e.src.height));
  const ow = Math.ceil(w / step);
  const oh = Math.ceil(h / step);
  const nb = bands.length;
  if (ow * oh * nb > maxSamples) throw new Error(`${ow}×${oh}×${nb} samples are more than a cube takes (${(maxSamples / 1e6).toFixed(0)} M); use an AOI or a coarser step`);
  const out = new Float32Array(ow * oh * nb);
  const nd = e.src.nodata;
  const isNd = nd === null || nd === undefined ? () => false : Number.isNaN(nd) ? (v) => Number.isNaN(v) : (v) => v === nd;
  // pyramid: a statistics cube samples the pyramid level of the step (2^L ≤ step; cached, or the
  // file's own overviews) instead of reading every full-resolution row to keep one in `step`
  // (TE 2.0.4: Band Math statistics of a 4-band NAIP tile ran past 120 s).
  if (pyramid && step >= 2 && e.pyr) {
    const L = Math.min(e.pyr.levels - 1, Math.floor(Math.log2(step)));
    const f = 2 ** L;
    const { w: lw, h: lh } = e.pyr.dims(L);
    const lx = (ox) => Math.min(lw - 1, Math.floor((x0 + ox * step) / f));
    const ly = (oy) => Math.min(lh - 1, Math.floor((y0 + oy * step) / f));
    const [tx0, tx1, ty0, ty1] = [Math.floor(lx(0) / TILE), Math.floor(lx(ow - 1) / TILE), Math.floor(ly(0) / TILE), Math.floor(ly(oh - 1) / TILE)];
    for (let k = 0; k < nb; k++) {
      const tiles = new Map();
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.set(`${tx},${ty}`, await e.pyr.core(L, tx, ty, bands[k], job));
      for (let oy = 0; oy < oh; oy++) {
        const y = ly(oy);
        const ty = Math.floor(y / TILE);
        for (let ox = 0; ox < ow; ox++) {
          const x = lx(ox);
          const t = tiles.get(`${Math.floor(x / TILE)},${ty}`);
          const v = t.data[(y - ty * TILE) * t.w + (x - Math.floor(x / TILE) * TILE)];
          out[(oy * ow + ox) * nb + k] = isNd(v) ? NaN : (gain ? gain[k] : 1) * v + (offset ? offset[k] : 0);
        }
      }
      job?.progress?.((k + 1) / nb);
    }
    return GW.transfer({ x0, y0, w: ow, h: oh, step, nb, v: out, level: L }, [out.buffer]);
  }
  const rows = Math.max(step, Math.floor(8e6 / Math.max(1, w * nb)) - (Math.floor(8e6 / Math.max(1, w * nb)) % step));
  for (let r0 = 0; r0 < h; r0 += rows) {
    const rh = Math.min(rows, h - r0);
    const planes = await e.src.readWindow(x0, y0 + r0, w, rh, bands, job);
    for (let y = 0; y < rh; y += step) {
      const oy = (r0 + y) / step;
      for (let x = 0, ox = 0; x < w; x += step, ox++) {
        const o = (oy * ow + ox) * nb;
        for (let k = 0; k < nb; k++) {
          const v = planes[k][y * w + x];
          out[o + k] = isNd(v) ? NaN : (gain ? gain[k] : 1) * v + (offset ? offset[k] : 0);
        }
      }
    }
  }
  return GW.transfer({ x0, y0, w: ow, h: oh, step, nb, v: out }, [out.buffer]);
});

/** An ENVI header on its own (spectral libraries, REQ-MSI-13). */
GW.register('envihdr', async ({ bytes, dataLen = 0 }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(bytes);
  try {
    if (parse.x.gw_envi_header(p, n, dataLen) !== 0) throw new Error(parse.lastError());
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
});

/** Sensor radiometric metadata (REQ-MSI-05): 1 Landsat MTL, 2 Sentinel-2 MTD, 3 WorldView IMD. */
GW.register('msimeta', async ({ kind, bytes }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(bytes);
  try {
    if (parse.x.gw_msi_meta(kind, p, n) !== 0) throw new Error(parse.lastError());
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
});

// ---- motion imagery (REQ-FMV-01, 02, 11) ----

/** MPEG-TS index: the file is read in blocks and fed to the Rust demuxer. */
GW.register('tsindex', async ({ file, block = 4 << 20 }, job) => {
  const parse = GW.bundle('parse');
  const id = parse.x.gw_ts_open();
  try {
    for (let off = 0; off < file.size; off += block) {
      job.checkCancel();
      const b = new Uint8Array(await file.slice(off, Math.min(file.size, off + block)).arrayBuffer());
      const [p, n] = parse.put(b);
      try {
        if (parse.x.gw_ts_push(id, p, n, off) !== 0) throw new Error(parse.lastError());
      } finally {
        parse.free(p, n);
      }
      job.progress(Math.min(1, (off + block) / file.size));
    }
  } catch (e) {
    parse.x.gw_ts_finish(id);
    throw e;
  }
  if (parse.x.gw_ts_finish(id) !== 0) throw new Error(parse.lastError());
  return parse.outJson();
});

/** Complete PES of one PID in a byte range → {pes: [[pts, off, len]…], data}. */
GW.register('tspes', async ({ file, start, end, pid }) => {
  const parse = GW.bundle('parse');
  const b = new Uint8Array(await file.slice(start, end).arrayBuffer());
  const [p, n] = parse.put(b);
  try {
    if (parse.x.gw_ts_pes(p, n, start, pid, end >= file.size ? 1 : 0) !== 0) throw new Error(parse.lastError());
    const out = parse.outBytes();
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const jl = dv.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + jl)));
    const at = 4 + jl + ((4 - ((4 + jl) % 4)) % 4);
    const data = out.slice(at);
    return GW.transfer({ ...meta, data }, [data.buffer]);
  } finally {
    parse.free(p, n);
  }
});

/** Standalone KLV bytes → packets. */
GW.register('klv', async ({ bytes }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(bytes);
  try {
    if (parse.x.gw_klv_decode(p, n) !== 0) throw new Error(parse.lastError());
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
});

/** STANAG 4607 GMTI file → mission, dwells, targets, jobs, platform locations. */
GW.register('s4607', async ({ file }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(new Uint8Array(await file.arrayBuffer()));
  try {
    if (parse.x.gw_s4607(p, n) !== 0) throw new Error(parse.lastError());
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
});

/** In-memory rasters (classification and detector products with live thresholds). */
GW.register('memopen', async ({ width, height, bands, sampleType, nodata = null, planes }) => {
  const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[sampleType];
  const src = {
    kind: 'memory',
    imageIndex: 0,
    width,
    height,
    bands,
    sampleType,
    nodata,
    planes: planes.map((p) => (p instanceof C ? p : C.from(p))),
    async readWindow(x0, y0, w, h, sel) {
      return sel.map((b) => {
        const s = this.planes[b];
        const o = new C(w * h);
        if (nodata !== null) o.fill(nodata);
        for (let y = 0; y < h; y++) {
          const sy = y0 + y;
          if (sy < 0 || sy >= height) continue;
          const xs = Math.max(0, x0);
          const xe = Math.min(width, x0 + w);
          if (xe > xs) o.set(s.subarray(sy * width + xs, sy * width + xe), y * w + (xs - x0));
        }
        return o;
      });
    },
  };
  const h = nextHandle++;
  const pyr = new Pyramid(src, tileCache);
  handles.set(h, { pyr, src });
  return { handle: h, imageIndex: 0, width, height, bands, sampleType, nodata, levels: pyr.levels };
});

GW.register('memupdate', async ({ handle, planes }) => {
  const e = handles.get(handle);
  if (!e || e.src.kind !== 'memory') throw new Error('not an in-memory raster');
  const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[e.src.sampleType];
  e.src.planes = planes.map((p) => (p instanceof C ? p : C.from(p)));
  e.pyr = new Pyramid(e.src, tileCache); // a new key: cached tiles of the old values are not reused
  return { ok: true };
});

GW.register('close', async ({ handle }) => {
  handles.delete(handle);
  return true;
});

// PT-05 support: deliberately trap the parse bundle, then prove it was re-created.
GW.register('trap', async () => {
  GW.bundle('parse').x.gw_debug_trap(0x74726170);
  return 'unreachable';
});
/** Byte-range read statistics of this worker (REQ-ARC-07 check). */
GW.register('iostats', async () => ({ ...ioStats }));

GW.register('ping', async ({ ms = 0 }, job) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    job.checkCancel();
    await new Promise((r) => setTimeout(r, 20));
    job.progress((Date.now() - t) / ms);
  }
  return { pong: true, abi: GW.bundle('parse').x.gw_abi_version() };
});
GW.register('spin', async () => {
  // Busy loop that ignores cancel, for the time-out test.
  for (;;) {
    /* spin */
  }
});
