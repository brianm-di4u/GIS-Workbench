// Decode worker (REQ-ARC-05/07, REQ-SEC-02): opens files by format, serves pyramid tiles
// and statistics. Every parser of untrusted bytes here is either Rust (`parse` bundle) or a
// vetted library (geotiff.js) or the browser's own image decoder.

import { Pyramid, LRU, TILE } from '../decode/pyramid.js';
import { openNitf, ioStats } from '../decode/nitf.js';
import { mosaicPlan, mosaicSource } from '../decode/mosaic.js';
import { isMieImage, openMie, describeSequence, writeChip } from '../decode/mie.js';
import { clearStore as clearMieStore } from '../decode/mie-cache.js';
import { openGeoTiff } from '../decode/geotiff.js';
import { openDem, openPicture } from '../decode/simple.js';
import { sicdSource } from '../decode/sicd.js';
import { enviSource, enviBands, gdalBands } from '../decode/envi.js';
import { openHdf5 } from '../decode/hdf5.js';
import { openGeoPdf } from '../decode/geopdf.js';
import { openJp2 } from '../decode/jp2.js';
import { deflate, predict2, predict3 } from '../../formats/geotiff-writer.js';
import { isMrSid, mrsidRefusalError, readFootprint, footprintSource, FOOTPRINT_HEAD } from '../decode/mrsid-header.js';
import { psIndex, MpvSession } from '../decode/mpv.js';
import { transmuxSegment } from '../../media/ts2mp4.js';
import { isEcw, ecwRefusalError } from '../decode/ecw-header.js';
import { openRpfToc, readToc } from '../decode/rpftoc.js';
import { aridpcmEncode } from '../decode/nitf-writers.js';
import { openCphd, cphdSubset } from '../decode/cphd.js';
import { openUavsar, uavsarAnn } from '../decode/uavsar.js';
import { safeXml, s1Luts, s1Radiometry } from '../decode/safe.js';
import { openHfa } from '../decode/hfa.js';
import { openNetcdf3 } from '../decode/netcdf3.js';
import { openTileset, tilesetSource, basemapTile, queryAt, extractFeatures, decompress as tsDecompress } from '../decode/tileset.js';
import { warpTile, tileVectors, exportTileset, writeTiles } from '../decode/tile-writers.js';
import { gwError } from '../../i18n/index.js';
import { decodeMvt, drawTile as drawMvtTile, backgroundFor as mvtBackground } from '../../tiles/mvt.js';
import { wasmError, nested } from '../errors.js';

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
  // An RPF table of contents is a NITF file (RPFHDR TRE) or a bare RPF header (REQ-FMT-40).
  if (/(^|[\\/])a\.toc$/.test(lower)) return 'rpftoc';
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
  // MBTiles (FC-05) and PMTiles (FC-06/07) tile sets.
  if (s.startsWith('SQLite') && lower.endsWith('.mbtiles')) return 'tileset';
  if (s.startsWith('PMTiles')) return 'tileset';
  if (s.startsWith('SQLite')) return 'gpkg';
  if (s.startsWith('LASF')) return 'las';
  if (h[0] === 0x50 && h[1] === 0x4b) return 'zip';
  if (h[0] === 0x47 && (lower.endsWith('.ts') || lower.endsWith('.mpg'))) return 'mpegts';
  // MPEG program stream (pack header) or a bare MPEG video elementary stream (sequence header).
  if (h[0] === 0 && h[1] === 0 && h[2] === 1 && (h[3] === 0xba || h[3] === 0xb3)) return 'mpegps';
  if (h[0] === 0x89 && s.slice(1, 4) === 'HDF') return 'hdf5';
  if (s.startsWith('%PDF-')) return 'pdf';
  if (s.startsWith('CPHD/')) return 'cphd';
  if (s.startsWith('ASTM-E57')) return 'e57';
  if (isMrSid(h)) return 'mrsid';
  if (h[0] === 0x1f && h[1] === 0x8b) return 'gzip';
  // ERDAS Imagine HFA and NetCDF-3 classic (2.1, FC-03/FC-04): read natively from the legacy bundle.
  if (String.fromCharCode(...h.slice(0, 15)) === 'EHFA_HEADER_TAG') return 'hfa';
  if (s.startsWith('CDF') && [1, 2, 5].includes(h[3])) return 'netcdf3';
  if (isEcw(h, lower)) return 'ecw';
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

/** An A.TOC's boundary rectangles and frame index (REQ-FMT-40), before any frame is opened. */
GW.register('rpfToc', async ({ file }) => readToc(file, await GW.ensure('legacy')));

/** 2.1 writer (REQ-FMT-45): ARIDPCM blocks. */
GW.register('aridpcmEncode', async (args) => {
  const r = aridpcmEncode(await GW.ensure('legacy'), args);
  return GW.transfer(r, r.blocks.map((b) => b.buffer));
});

GW.register('open', async ({ file, name, merge = false, hdr = null, frames = null, ann = null, s1 = null, sidecars = [] }) => {
  if (file?.remoteId) file = GW.remoteFile(file); // a remote file reads its bytes through the pool
  const kind = detect(await head(file, 16), name || file.name || '');
  // UAVSAR (FC-24, REQ-FMT-53): a headerless product opened with the .ann annotation that names it.
  if (ann && !['nitf', 'tiff', 'jp2', 'j2c', 'hdf5', 'pdf', 'png', 'jpeg'].includes(kind)) {
    const { meta, source, complex } = await openUavsar(file, ann, await GW.ensure('legacy'));
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    return { kind: 'uavsar', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels, sar: complex ? { kind: 'UAVSAR', complex: true, version: meta.uavsar.entries?.version ?? '', pixelType: 'CF8 (COMPLEX REAL*4)', radiometry: source.radiometry ?? null } : null }] };
  }
  // ENVI (REQ-MSI-01): a raw file (no recognised container) opened with its .hdr sidecar.
  if (hdr && kind === 'unknown') {
    const parse = GW.bundle('parse');
    const [p, n] = parse.put(new Uint8Array(await hdr.arrayBuffer()));
    let hd;
    try {
      if (parse.x.gw_envi_header(p, n, file.size) !== 0) throw gwError('ENVI header {file}: {msg}', { file: hdr.name, msg: nested(wasmError(parse)) });
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
    // MIE4NITF frames (REQ-GAP-47) are not opened as images: each camera set opens as one sequence.
    const r = await openNitf(file, parse(), { defer: isMieImage });
    const mie = await openMie(file, r, parse(), { tileCache });
    const images = r.images.map((im) => ({ index: im.index, error: im.error ?? null, warning: im.warning ?? null, subheader: im.ish ?? null, segment: im.seg }));
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
    } else if (forceMerge) throw gwError("the SICD's image segments cannot be joined: {reason}", { reason: String(plan.reason) });
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
    result = { kind, header: r.header, images, others: r.others, rasters: pyr, mergeable: !plan.reason, mergeNote, merged: (merge || forceMerge) && !plan.reason ? sources[0]?.parts ?? null : null };
    for (const p of pyr) if (sources[0]?.parts && p.handle) p.mosaic = sources[0].parts;
    for (const sq of mie?.sequences ?? []) {
      const h = nextHandle++;
      const entry = { seq: sq, pyr: await sq.pyramid(0) };
      entry.src = entry.pyr.src;
      handles.set(h, entry);
      pyr.push({ handle: h, imageIndex: entry.src.imageIndex, width: sq.width, height: sq.height, bands: sq.bands, sampleType: sq.sampleType, nodata: sq.nodata, abpp: sq.abpp, levels: entry.pyr.levels, mie: describeSequence(sq) });
    }
    if (mie) result.mie = { warnings: mie.collection.warnings, layers: mie.collection.layers, cameraSets: mie.collection.cameraSets.map((c) => ({ index: c.index, cameras: c.cameras.length })), intervals: mie.collection.intervals.map((i) => ({ index: i.index, start: i.start ? String(i.start.ns) : null, end: i.end ? String(i.end.ns) : null })), mappings: mie.collection.mappings.length, blocks: mie.collection.blocks };
  } else if (kind === 'rpftoc') {
    // RPF A.TOC (REQ-FMT-40): one mosaic per boundary rectangle of the frames given beside it.
    const r = await openRpfToc(file, frames ?? [], { legacy: await GW.ensure('legacy'), parse: parse() });
    if (!r.sources.length) {
      const n = String(r.toc.boundaries.reduce((a, b) => a + b.frames.length, 0));
      const e = r.notes.length
        ? gwError('RPF table of contents: no frame of its {n} frames can be opened ({notes}); open the A.TOC together with its RPF folder', { n, notes: r.notes.join('; ') })
        : gwError('RPF table of contents: no frame of its {n} frames can be opened; open the A.TOC together with its RPF folder', { n });
      e.code = 4;
      throw e;
    }
    const rasters = r.sources.map((src) => {
      const h = nextHandle++;
      handles.set(h, { pyr: new Pyramid(src, tileCache), src });
      return { handle: h, imageIndex: src.imageIndex, width: src.width, height: src.height, bands: src.bands, sampleType: src.sampleType, nodata: src.nodata, levels: handles.get(h).pyr.levels, georef: src.georef, boundary: src.boundary };
    });
    const nframes = r.toc.boundaries.reduce((a, b) => a + b.frames.length, 0);
    result = { kind, meta: { format: 'RPF A.TOC', frames: nframes, missing: r.missing, used: r.used }, header: { warnings: [...r.notes, ...(r.missing ? [`${r.missing} of ${nframes} frame files listed in the A.TOC were not given; their area reads as nodata`] : [])] }, toc: r.toc, rasters };
  } else if (kind === 'tiff') {
    const opened = await openGeoTiff(file);
    const { meta } = opened;
    // A Sentinel-1 SAFE measurement (FC-26, REQ-FMT-55): its annotation (bursts, geolocation grid) and
    // calibration/noise vectors (β⁰, σ⁰, γ⁰ with thermal noise removed). A detected (GRD) measurement is
    // served as DN + 0i so the same calibrated bands apply.
    let s1lut = null;
    if (s1?.annotation) {
      const B = await GW.ensure('legacy');
      const read = async (f) => new Uint8Array(await f.arrayBuffer());
      meta.s1 = { annotation: safeXml(B, 'annotation', await read(s1.annotation)), manifest: s1.manifest ? safeXml(B, 'manifest', await read(s1.manifest)) : null, files: { annotation: s1.annotation.name, calibration: s1.calibration?.name ?? null, noise: s1.noise?.name ?? null } };
      if (s1.calibration) s1lut = s1Luts(safeXml(B, 'calibration', await read(s1.calibration)), s1.noise ? safeXml(B, 'noise', await read(s1.noise)) : null);
    }
    const detected = s1lut && !meta.complex && opened.source.bands === 1;
    const base = detected ? { ...opened.source, bands: 2, async readWindow(x, y, w, h, b, job) {
      const [dn] = await opened.source.readWindow(x, y, w, h, [0], job);
      return [Float32Array.from(dn), new Float32Array(w * h)];
    }, hasLevel: () => false, readLevel: undefined } : opened.source;
    // A complex SLC GeoTIFF (IMP-16) gets the derived SAR bands of a SICD (no calibration block).
    const source = meta.complex || detected ? sicdSource(base, s1lut ? { pixelType: 'RE32F_IM32F', lut: s1lut, lutRadiometry: s1Radiometry(s1lut) } : { pixelType: 'RE32F_IM32F' }) : opened.source;
    if (detected) meta.complex = true;
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
    const sar = meta.complex ? { kind: meta.s1 ? 'Sentinel-1' : 'Complex GeoTIFF', complex: true, version: meta.s1?.annotation?.productType ?? '', pixelType: detected ? 'DN (detected)' : meta.sampleType, radiometry: source.radiometry ?? null } : null;
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
  } else if (kind === 'hfa') {
    // ERDAS Imagine (FC-03, REQ-FMT-24): .ige spill and .rrd overview files come as sidecars.
    const { meta, source: raw } = await openHfa(file, await GW.ensure('legacy'), sidecars ?? []);
    // One complex layer (an SLC saved as .img) gets the SAR views of a complex GeoTIFF.
    const slc = meta.complex && raw.bands === 2;
    const source = slc ? sicdSource(raw, { pixelType: 'RE32F_IM32F' }) : raw;
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    const sar = slc ? { kind: 'Complex HFA', complex: true, version: '', pixelType: meta.bandsMeta[0]?.pixelType ?? 'c64', radiometry: source.radiometry ?? null } : null;
    result = { kind: 'hfa', meta, header: { warnings: [meta.overviewNote, meta.skippedLayers ? `${meta.skippedLayers} layer(s) of another size are not shown` : null].filter(Boolean) }, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels, sar }] };
  } else if (kind === 'netcdf3') {
    // NetCDF-3 (FC-04, REQ-FMT-26): one raster per gridded variable, the largest shown first.
    const { meta, sources } = await openNetcdf3(file, await GW.ensure('legacy'));
    const rasters = sources.map(({ source, meta: m }, i) => {
      const h = nextHandle++;
      const pyr = new Pyramid(source, tileCache);
      handles.set(h, { pyr, src: source });
      return { handle: h, imageIndex: source.imageIndex, width: source.width, height: source.height, bands: source.bands, sampleType: source.sampleType, nodata: source.nodata, levels: pyr.levels, meta: m, label: sources.length > 1 ? `[${m.variable}]` : null, hidden: i > 0 };
    });
    result = { kind: 'netcdf3', meta: { ...meta, ...sources[0].meta, format: sources[0].meta.format }, rasters, header: { warnings: meta.skipped ? [`${meta.skipped} more gridded variables are not opened (32 at most)`] : [] } };
  } else if (kind === 'pdf') {
    // GeoPDF raster pages (REQ-FMT-14); a page of vectors only opens with no raster (REQ-GAP-66:
    // its layers come from 'pdfVectors').
    const { meta, source } = await openGeoPdf(file, parse());
    if (!source) result = { kind: 'pdf', meta, rasters: [] };
    else {
      const h = nextHandle++;
      const pyr = new Pyramid(source, tileCache);
      handles.set(h, { pyr, src: source });
      result = { kind: 'pdf', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: 3, sampleType: 'u8', nodata: null, levels: pyr.levels }] };
    }
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
  } else if (kind === 'cphd') {
    // CPHD phase history (FC-21, REQ-FMT-49): one complex raster per channel (vectors × samples), the
    // metadata, PVP series, ARP track and support-array summaries for the phase-history panel.
    const { meta, channels, ctx } = await openCphd(file, await GW.ensure('legacy'));
    if (meta.compression) {
      const e = gwError('CPHD {version} with a compressed signal array (SignalCompressionID {compression}) cannot be read', { version: String(meta.version), compression: String(meta.compression) });
      e.code = 4;
      throw e;
    }
    const rasters = [];
    for (const c of channels) {
      const src = sicdSource(c.source, { pixelType: 'RE32F_IM32F' });
      const h = nextHandle++;
      const pyr = new Pyramid(src, tileCache);
      handles.set(h, { pyr, src, cphd: ctx });
      rasters.push({ handle: h, imageIndex: c.info.index, width: src.width, height: src.height, bands: src.bands, sampleType: src.sampleType, nodata: src.nodata, levels: pyr.levels, sar: { kind: 'CPHD', complex: true, version: meta.version, pixelType: meta.signalFormat, radiometry: src.radiometry ?? null, channel: c.info } });
    }
    result = { kind: 'cphd', meta: { format: `CPHD ${meta.version} phase history (${meta.signalFormat}, ${channels.length} channel${channels.length > 1 ? 's' : ''})`, cphd: meta, dateTime: meta.collectStart }, rasters };
  } else if (kind === 'mrsid' || kind === 'ecw') {
    // MrSID and ECW (FC-01/02, REQ-FMT-22): a footprint layer from the container header; pixels
    // come through the sidecar (Convert with Sidecar). An unreadable header is refused by name.
    const bytes = await head(file, Math.min(file.size, FOOTPRINT_HEAD));
    let fp;
    try {
      fp = readFootprint(bytes, kind === 'mrsid' ? 1 : 2, await GW.ensure('legacy'));
    } catch (err) {
      const e = kind === 'mrsid' ? mrsidRefusalError(bytes, err) : ecwRefusalError(err);
      e.code = 4;
      throw e;
    }
    const source = footprintSource(fp);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source });
    const format = `${fp.version} footprint (pixels through the sidecar)`;
    result = { kind: 'footprint', meta: { format, container: kind === 'mrsid' ? 'MrSID' : 'ECW', footprint: fp }, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: 1, sampleType: 'u8', nodata: 0, levels: pyr.levels, footprint: fp }] };
  } else if (kind === 'tileset') {
    // MBTiles / PMTiles (REQ-FMT-28, 30, 32): raster tiles as a 3857 image with native overviews,
    // vector tiles drawn with the default style.
    const ts = await openTileset(file, name || file.name);
    const { meta, source } = await tilesetSource(ts);
    const h = nextHandle++;
    const pyr = new Pyramid(source, tileCache);
    handles.set(h, { pyr, src: source, ts });
    result = { kind: 'tileset', meta, rasters: [{ handle: h, imageIndex: 0, width: source.width, height: source.height, bands: 3, sampleType: 'u8', nodata: null, levels: pyr.levels }] };
  } else {
    const names = { gpkg: 'GeoPackage (R2)', las: 'LAS/LAZ point cloud (R2)', mpegts: 'MPEG-TS motion imagery (R3)', mpegps: 'An MPEG program stream (motion imagery): open it with Open Video… (fmv.open), which plays MPEG-1 and MPEG-2 (the sidecar transcode for MPEG-2 the app cannot decode); it', zip: 'ZIP container', gzip: 'gzip file', unknown: 'unrecognised data' };
    // With the conversion that makes them readable.
    const named = {
      e57: 'an ASTM E57 point cloud, which the browser does not read: convert it with the optional GIS Workbench Sidecar (E57 → COPC), which then opens here',
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
// Tile sets without an image layer (a basemap), and the tile operations of either kind of handle.
GW.register('tsOpen', async ({ file, name }) => {
  if (file?.remoteId) file = GW.remoteFile(file);
  const ts = await openTileset(file, name || file.name);
  const h = nextHandle++;
  handles.set(h, { ts });
  const { meta } = ts.tileType === 'mvt' ? await tilesetSource(ts) : { meta: { tileType: ts.tileType, format: ts.format, minZoom: ts.minZoom, maxZoom: ts.maxZoom, bounds: ts.bounds, attribution: ts.attribution, name: ts.name, container: ts.kind === 'mbtiles' ? 'MBTiles' : 'PMTiles', vector: false, tileCompression: ts.tileCompression } };
  return { handle: h, meta };
});
const tsEntry = (handle) => {
  const e = handles.get(handle);
  if (!e?.ts) throw new Error('unknown tile set handle');
  return e;
};
GW.register('tsTile', async ({ handle, z, x, y, size = 512 }) => {
  const bmp = await basemapTile(tsEntry(handle), z, x, y, size);
  return bmp ? GW.transfer({ bmp }, [bmp]) : { bmp: null };
});
// Remote vector tiles (REQ-GAP-05, REQ-GAP-06: ArcGIS VectorTileServer, OGC API Tiles): the main
// thread fetches each tile through the logged fetch; here it is decoded and drawn with the default
// vector style. A tile served still gzip-compressed (no Content-Encoding) is inflated first.
GW.register('mvtRender', async ({ bytes, z = 0, size = 512 }) => {
  let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  const vt = decodeMvt(u8);
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const bg = mvtBackground(vt);
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);
  }
  drawMvtTile(g, vt, { size, zoom: z, dpr: size / 256 });
  const bmp = c.transferToImageBitmap();
  return GW.transfer({ bmp }, [bmp]);
});
// Brotli and Zstandard for the main thread's PMTiles reader (its basemaps), so zstddec and the
// brotli bundle stay out of the eager code.
GW.register('tsDecompress', async ({ bytes, compression }) => {
  const out = new Uint8Array(await tsDecompress(bytes, compression));
  return GW.transfer({ bytes: out }, [out.buffer]);
});
GW.register('tsQuery', async ({ handle, lat, lon, zoom, tol = 4 }) => queryAt(tsEntry(handle), lat, lon, zoom, tol));
// Writers (P14): an image warped to Web Mercator tiles, a vector layer tiled to MVT, a tile set copied.
GW.register('warpTile', async ({ handle, ...o }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  const bytes = await warpTile(e, o, job);
  return bytes ? GW.transfer({ bytes }, [bytes.buffer]) : { bytes: null };
});
GW.register('mvtTiler', async (o) => {
  const r = await tileVectors(o);
  return GW.transfer(r, [r.bytes.buffer]);
});
GW.register('tsWrite', async ({ tiles, to, type, bounds, name }) => {
  const bytes = await writeTiles(tiles, { to, type, bounds, name });
  return GW.transfer({ bytes }, [bytes.buffer]);
});
GW.register('tsExport', async ({ handle, ...o }, job) => {
  const r = await exportTileset(tsEntry(handle), o, job);
  return GW.transfer(r, [r.bytes.buffer]);
});
GW.register('tsExtract', async ({ handle, bbox = null, zoom = null, layers = null, clip = true, maxTiles, maxFeatures }, job) => extractFeatures(tsEntry(handle), { bbox, zoom, layers, clip, maxTiles, maxFeatures }, job));

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

// Sentinel-1 SAFE XML on its own (REQ-FMT-55): a manifest's summary for pairing and the footprint.
GW.register('safeXml', async ({ kind, bytes }) => safeXml(await GW.ensure('legacy'), kind, bytes));

// A UAVSAR annotation on its own (REQ-FMT-53): its summary for the footprint layer.
GW.register('uavsarAnn', async ({ bytes }) => uavsarAnn(bytes, await GW.ensure('legacy')));

// A CPHD subset (REQ-FMT-51) of an open phase history, as a Blob of the new file.
GW.register('cphdSubset', async ({ handle, subs }) => {
  const e = handles.get(handle);
  if (!e?.cphd) throw new Error('the layer is not an open CPHD phase history');
  return { blob: await cphdSubset(e.cphd, subs) };
});

GW.register('tile', async ({ handle, level, tx, ty, bands, frame = null }, job) => {
  const h = handles.get(handle);
  if (!h) throw new Error('unknown image handle (the file was closed)');
  // A MIE4NITF sequence (REQ-GAP-47): the tile of the frame the request names.
  const t = h.seq ? await h.seq.tile(frame ?? h.seq.current, level, tx, ty, bands, job) : await h.pyr.tile(level, tx, ty, bands, job);
  return GW.transfer(t, t.bands.map((b) => b.buffer));
});

// MIE4NITF sequences (REQ-GAP-47): the frame the other reads (pixels, windows, statistics) use.
const seqOf = (handle) => {
  const h = handles.get(handle);
  if (!h?.seq) throw gwError('the layer is not a MIE4NITF frame sequence', null, 'E_NO_MIE_FRAMES');
  return h;
};
GW.register('mieFrame', async ({ handle, frame }) => {
  const h = seqOf(handle);
  h.pyr = await h.seq.pyramid(frame);
  h.src = h.pyr.src;
  h.seq.current = frame;
  return h.seq.info();
});
GW.register('mieInfo', async ({ handle, flush = false }) => {
  const h = seqOf(handle);
  if (flush) await h.seq.store?.flush();
  return h.seq.info();
});
GW.register('mieChip', async ({ handle, ...o }, job) => {
  const b = await writeChip(seqOf(handle).seq, { ...o, job });
  return GW.transfer({ bytes: b }, [b.buffer]);
});
GW.register('mieClearStore', async () => clearMieStore());

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
GW.register('patch', async ({ handle, x, y, w, h, band = 0, bands = null }, job) => {
  const e = handles.get(handle);
  if (!e) throw new Error('unknown image handle');
  w = Math.min(w, e.src.width);
  h = Math.min(h, e.src.height);
  const x0 = Math.max(0, Math.min(e.src.width - w, Math.floor(x)));
  const y0 = Math.max(0, Math.min(e.src.height - h, Math.floor(y)));
  if (bands) {
    // Every band in one read (orthorectify): a J2K multispectral tile decodes all its components once.
    const got = await e.src.readWindow(x0, y0, w, h, bands, job);
    const pxs = got.map((a) => (a instanceof Float32Array ? a : Float32Array.from(a)));
    return GW.transfer({ x0, y0, w, h, pxs }, pxs.map((p) => p.buffer));
  }
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
  if (W * H > maxSamples) throw gwError('{w}×{h} samples are more than {what} takes ({max} M)', { w: String(W), h: String(H), what: String(what), max: (maxSamples / 1e6).toFixed(0) });
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
  if (ow * oh * bands.length > maxSamples) throw gwError('{w}×{h}×{n} samples are more than a product takes ({max} M): draw a smaller AOI, zoom out (a coarser chip) or choose fewer bands', { w: String(ow), h: String(oh), n: String(bands.length), max: (maxSamples / 1e6).toFixed(0) });
  const planes = [];
  // A decimated window comes from the source's own coarser level when it has one (J2K resolution
  // levels, strided raw NITF/ENVI, GeoTIFF overviews): read at full resolution and thinned, the 3D
  // globe's drape of a whole WorldView strip decoded all of it and timed out (TE 2.0.4 cross).
  let L = 0;
  while (e.src.readLevel && 2 ** (L + 1) <= step && e.src.hasLevel?.(L + 1)) L++;
  if (L > 0) {
    const f = 2 ** L;
    const lx0 = Math.floor(x0 / f);
    const lw = Math.min(Math.ceil(e.src.width / f) - lx0, Math.ceil(sw / f) + 1);
    const lyOf = (oy) => Math.min(Math.ceil(e.src.height / f) - 1, Math.floor((y0 + oy * step) / f));
    const perL = Math.max(1, Math.floor(16e6 / Math.max(1, lw * bands.length)));
    for (let oy0 = 0; oy0 < oh; ) {
      const ly0 = lyOf(oy0);
      let oy1 = oy0;
      while (oy1 < oh && lyOf(oy1) - ly0 < perL) oy1++;
      const lh = lyOf(oy1 - 1) - ly0 + 1;
      const got = await e.src.readLevel(L, lx0, ly0, lw, lh, bands, job);
      got.forEach((a, k) => {
        const out = (planes[k] ??= new a.constructor(ow * oh));
        for (let oy = oy0; oy < oy1; oy++) {
          const ry = lyOf(oy) - ly0;
          for (let ox = 0; ox < ow; ox++) out[oy * ow + ox] = a[ry * lw + Math.min(lw - 1, Math.floor((x0 + ox * step) / f) - lx0)];
        }
      });
      oy0 = oy1;
    }
    return GW.transfer({ x0, y0, w: ow, h: oh, step, planes, level: L }, planes.map((p) => p.buffer));
  }
  // Read in row bands so a decimated chip of a large image never holds the full window.
  // Every band of a row band in one read: pixel-interleaved JPEG blocks were decoded once per band.
  const per = Math.floor(16e6 / Math.max(1, sw * bands.length));
  const rows = Math.max(step, per - (per % step));
  for (let r0 = 0; r0 < sh; r0 += rows) {
    const rh = Math.min(rows, sh - r0);
    const got = await e.src.readWindow(x0, y0 + r0, sw, rh, bands, job);
    got.forEach((a, k) => {
      const out = (planes[k] ??= new a.constructor(ow * oh));
      for (let y = 0; y < rh; y += step) {
        const oy = (r0 + y) / step;
        for (let x = 0, ox = 0; x < sw; x += step, ox++) out[oy * ow + ox] = a[y * sw + x];
      }
    });
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
  if (w * h > maxSamples) throw gwError('{w}×{h} is more than an AOI chip takes ({max} M pixels)', { w: String(w), h: String(h), max: (maxSamples / 1e6).toFixed(0) });
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
  if (ow * oh * nb > maxSamples) throw gwError('{w}×{h}×{n} samples are more than a cube takes ({max} M); use an AOI or a coarser step', { w: String(ow), h: String(oh), n: String(nb), max: (maxSamples / 1e6).toFixed(0) });
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
  // A decimated cube comes from the source's own coarser level where it has one, as windows do
  // (CX-063): spectral tools on a CORE3D 8-band MSI J2K strip read it all at full resolution and timed out.
  let L = 0;
  while (e.src.readLevel && 2 ** (L + 1) <= step && e.src.hasLevel?.(L + 1)) L++;
  if (L > 0) {
    const f = 2 ** L;
    const lx0 = Math.floor(x0 / f);
    const lw = Math.min(Math.ceil(e.src.width / f) - lx0, Math.ceil(w / f) + 1);
    const lyOf = (oy) => Math.min(Math.ceil(e.src.height / f) - 1, Math.floor((y0 + oy * step) / f));
    const perL = Math.max(1, Math.floor(8e6 / Math.max(1, lw * nb)));
    for (let oy0 = 0; oy0 < oh; ) {
      const ly0 = lyOf(oy0);
      let oy1 = oy0;
      while (oy1 < oh && lyOf(oy1) - ly0 < perL) oy1++;
      const planes = await e.src.readLevel(L, lx0, ly0, lw, lyOf(oy1 - 1) - ly0 + 1, bands, job);
      for (let oy = oy0; oy < oy1; oy++) {
        const ry = lyOf(oy) - ly0;
        for (let ox = 0; ox < ow; ox++) {
          const rx = Math.min(lw - 1, Math.floor((x0 + ox * step) / f) - lx0);
          const o = (oy * ow + ox) * nb;
          for (let k = 0; k < nb; k++) {
            const v = planes[k][ry * lw + rx];
            out[o + k] = isNd(v) ? NaN : (gain ? gain[k] : 1) * v + (offset ? offset[k] : 0);
          }
        }
      }
      oy0 = oy1;
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
    if (parse.x.gw_envi_header(p, n, dataLen) !== 0) throw wasmError(parse);
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
    if (parse.x.gw_msi_meta(kind, p, n) !== 0) throw wasmError(parse);
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
        if (parse.x.gw_ts_push(id, p, n, off) !== 0) throw wasmError(parse);
      } finally {
        parse.free(p, n);
      }
      job.progress(Math.min(1, (off + block) / file.size));
    }
  } catch (e) {
    parse.x.gw_ts_finish(id);
    throw e;
  }
  if (parse.x.gw_ts_finish(id) !== 0) throw wasmError(parse);
  return parse.outJson();
});

/**
 * One HLS transport-stream segment (REQ-GAP-49): its KLV and video index from the same Rust
 * demuxer as a file (tsindex), and its H.264 access units as length-prefixed samples for an fMP4
 * fragment (media/ts2mp4.js). The bytes are transferred in and the samples out.
 */
GW.register('hlsseg', async ({ bytes }) => {
  const b = new Uint8Array(bytes);
  const parse = GW.bundle('parse');
  const id = parse.x.gw_ts_open();
  const [p, n] = parse.put(b);
  try {
    if (parse.x.gw_ts_push(id, p, n, 0) !== 0) {
      parse.x.gw_ts_finish(id);
      throw wasmError(parse);
    }
  } finally {
    parse.free(p, n);
  }
  if (parse.x.gw_ts_finish(id) !== 0) throw wasmError(parse);
  const idx = parse.outJson();
  const tm = transmuxSegment(b);
  return GW.transfer({ idx, codec: tm.codec, mime: tm.mime ?? null, info: tm.info, samples: tm.samples, data: tm.data, sps: tm.sps, pps: tm.pps, streams: tm.streams, errors: tm.errors }, [tm.data.buffer]);
});

/** Complete PES of one PID in a byte range → {pes: [[pts, off, len]…], data}. */
GW.register('tspes', async ({ file, start, end, pid }) => {
  const parse = GW.bundle('parse');
  const b = new Uint8Array(await file.slice(start, end).arrayBuffer());
  const [p, n] = parse.put(b);
  try {
    if (parse.x.gw_ts_pes(p, n, start, pid, end >= file.size ? 1 : 0) !== 0) throw wasmError(parse);
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

// ---- MPEG program streams, MPEG-1 and MPEG-2 video (FC-22, REQ-FMT-52, REQ-GAP-48; workers/decode/mpv.js) ----

/** Program stream (or bare MPEG video ES) index: packs, streams, video access units, KLV. */
GW.register('psindex', async ({ file, block = 4 << 20 }, job) => psIndex(await GW.ensure('mpeg'), file, { block, job }));

const mpvSessions = new Map(); // session id → MpvSession (one per playing clip)
let mpvNext = 1;

/**
 * Decoded RGBA frames → ImageBitmaps (transferred), or the RGBA buffers where bitmaps are missing.
 * The RGB conversion is the decoder's own (BT.601), so the canvas shows exactly what a frame
 * capture saves (a WebCodecs VideoFrame from I420 was tried for MPEG-2 and differed by up to 43
 * levels at colour edges: Chrome interpolates the chroma).
 */
async function mpvOut(r, info) {
  const transfer = [];
  for (const f of r.frames) {
    if (globalThis.createImageBitmap && globalThis.ImageData) {
      f.bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(f.rgba.buffer, f.rgba.byteOffset, info.width * info.height * 4), info.width, info.height));
      delete f.rgba;
      transfer.push(f.bitmap);
    } else transfer.push(f.rgba.buffer);
  }
  return GW.transfer({ ...r, width: info.width, height: info.height }, transfer);
}

GW.register('mpvopen', async ({ file, container, sid, seqOff = 0, auPts = [], codec = 'mp1v' }) => {
  const s = new MpvSession(await GW.ensure('mpeg'), GW.bundle('parse'), { file, container, sid, auPts, codec });
  try {
    const info = await s.open(seqOff);
    const session = mpvNext++;
    mpvSessions.set(session, s);
    return { session, info };
  } catch (e) {
    s.close();
    throw e;
  }
});

/** Next pictures of a session (after an optional seek {off, baseAu, minPts}) → {frames: [{au, type, pts, bitmap}], eof}. */
GW.register('mpvrun', async ({ session, seek = null, count = 8, wantAu = null }, job) => {
  const s = mpvSessions.get(session);
  if (!s) throw new Error('the MPEG video decoder session is no longer open');
  if (seek) s.seek(seek);
  return mpvOut(await s.run({ count, wantAu, job }), s.info);
});

GW.register('mpvclose', async ({ session }) => {
  mpvSessions.get(session)?.close();
  mpvSessions.delete(session);
  return { closed: true };
});

/** One exact picture (frame step, capture) with its own decoder → {frames: [{au, bitmap}]}. */
GW.register('mpvframe', async ({ file, container, sid, seqOff = 0, seek, au, auPts = [], codec = 'mp1v' }, job) => {
  const s = new MpvSession(await GW.ensure('mpeg'), GW.bundle('parse'), { file, container, sid, auPts, codec });
  try {
    await s.open(seqOff);
    s.seek({ ...seek, minPts: -Infinity });
    return await mpvOut(await s.run({ wantAu: au, job }), s.info);
  } finally {
    s.close();
  }
});

/** Standalone KLV bytes → packets. */
GW.register('klv', async ({ bytes }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(bytes);
  try {
    if (parse.x.gw_klv_decode(p, n) !== 0) throw wasmError(parse);
    return parse.outJson();
  } finally {
    parse.free(p, n);
  }
});

/**
 * GeoPDF vector content (REQ-GAP-66) → {scan, vec}: the page scan (viewports, LGIDict) and the
 * features of each georeferenced page in PDF user space (crates/gw-parse/src/pdfvec.rs).
 */
GW.register('pdfVectors', async ({ file, maxFeatures = 0, maxVertices = 0 }) => {
  const parse = GW.bundle('parse');
  const [p, n] = parse.put(new Uint8Array(await file.arrayBuffer()));
  try {
    if (parse.x.gw_pdf_scan(p, n) !== 0) throw wasmError(parse);
    const scan = parse.outJson();
    if (parse.x.gw_pdf_vectors(p, n, maxFeatures, maxVertices) !== 0) throw wasmError(parse);
    return { scan, vec: parse.outJson() };
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

/** One COG tile: predictor and deflate off the main thread (streamed COG writer, TE 2.0.4 cross). */
GW.register('tileenc', async ({ bytes, type, tile, n, predictor }) => {
  let b = new Uint8Array(bytes);
  if (predictor === 2) predict2(b, type, tile, tile, n);
  else if (predictor === 3) b = predict3(b, tile, tile, n);
  const c = await deflate(b);
  return GW.transfer({ c }, [c.buffer]);
});

// Views sharing one open (Xport panes) each hold a reference; the handle goes with the last one.
const refs = new Map();
GW.register('retain', async ({ handle }) => {
  if (!handles.has(handle)) throw new Error('unknown image handle (the file was closed)');
  refs.set(handle, (refs.get(handle) ?? 1) + 1);
  return true;
});

GW.register('close', async ({ handle }) => {
  const n = (refs.get(handle) ?? 1) - 1;
  if (n > 0) {
    refs.set(handle, n);
    return true;
  }
  refs.delete(handle);
  handles.get(handle)?.ts?.close?.(); // an MBTiles database frees its SQLite memory
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

/**
 * Writer metadata from the legacy bundle (REQ-FMT-25/27): an HFA metadata block or a NetCDF-3
 * header from a line spec (crates/gw-parse/src/{hfa,netcdf3}.rs), with the layout that places the data.
 */
GW.register('rasterSpec', async ({ kind, spec }) => {
  const lx = await GW.ensure('legacy');
  const [p, n] = lx.put(new TextEncoder().encode(spec));
  try {
    if (lx.x[kind === 'hfa' ? 'gw_hfa_write' : 'gw_nc3_write_header'](p, n) !== 0) throw wasmError(lx);
  } finally {
    lx.free(p, n);
  }
  const o = lx.outBytes();
  const jl = new DataView(o.buffer, o.byteOffset).getUint32(0, true);
  const layout = JSON.parse(new TextDecoder().decode(o.subarray(4, 4 + jl)));
  const bytes = o.slice(4 + jl);
  return GW.transfer({ layout, bytes }, [bytes.buffer]);
});
