// In-memory sources: DTED/SRTM HGT elevation grids (Rust parser) and plain JPEG/PNG images
// (browser decoder). Both hold the whole raster; these files are small by nature.

async function bytesOf(file) {
  return new Uint8Array(await file.arrayBuffer());
}

export function memorySource(kind, width, height, bands, sampleType, nodata, planes) {
  const C = planes[0].constructor;
  return {
    kind,
    width,
    height,
    bands,
    sampleType,
    nodata,
    async readWindow(x0, y0, w, h, sel) {
      return sel.map((b) => {
        const src = planes[b];
        const out = new C(w * h);
        for (let y = 0; y < h; y++) {
          const sy = y0 + y;
          if (sy >= height) break;
          const ww = Math.min(w, width - x0);
          if (ww > 0) out.set(src.subarray(sy * width + x0, sy * width + x0 + ww), y * w);
        }
        return out;
      });
    },
  };
}

export async function openDem(file, parse, name) {
  let b = await bytesOf(file);
  const lower = name.toLowerCase();
  if (lower.endsWith('.gz')) {
    const ds = new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'));
    b = new Uint8Array(await new Response(ds).arrayBuffer());
    if (b.length > 64 << 20) throw new Error('decompressed elevation file is larger than 64 MB');
  }
  const [p, n] = parse.put(b);
  let st;
  try {
    if (/\.hgt(\.gz)?$/.test(lower)) {
      const m = /([ns])(\d{2})([ew])(\d{3})/i.exec(name);
      if (!m) throw new Error('an SRTM .hgt file name must give its south-west corner, e.g. S35W059.hgt');
      const lat = Number(m[2]) * (m[1].toLowerCase() === 's' ? -1 : 1);
      const lon = Number(m[4]) * (m[3].toLowerCase() === 'w' ? -1 : 1);
      st = parse.x.gw_hgt_parse(p, n, lat, lon);
    } else st = parse.x.gw_dted_parse(p, n);
  } finally {
    parse.free(p, n);
  }
  if (st !== 0) throw new Error(parse.lastError());
  const out = parse.outBytes();
  const jl = new DataView(out.buffer).getUint32(0, true);
  const meta = JSON.parse(new TextDecoder().decode(out.subarray(4, 4 + jl)));
  let off = 4 + jl;
  while (off % 4) off++;
  const heights = new Float32Array(out.buffer.slice(off, off + meta.width * meta.height * 4));
  return {
    meta: { ...meta, sampleType: 'f32', bands: 1 },
    grid: { lat0: meta.nwLat, lon0: meta.swLon, dlat: meta.dlat, dlon: meta.dlon, width: meta.width, height: meta.height, heights },
    source: memorySource('dem', meta.width, meta.height, 1, 'f32', NaN, [heights]),
  };
}

export async function openPicture(file, type) {
  const bmp = await createImageBitmap(file);
  const w = bmp.width;
  const h = bmp.height;
  if (w * h > 64e6) throw new Error('plain images above 64 Mpx are not supported; use GeoTIFF/COG');
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const px = g.getImageData(0, 0, w, h).data;
  const planes = [0, 1, 2, 3].map(() => new Uint8Array(w * h));
  let hasAlpha = false;
  for (let i = 0; i < w * h; i++) {
    planes[0][i] = px[4 * i];
    planes[1][i] = px[4 * i + 1];
    planes[2][i] = px[4 * i + 2];
    planes[3][i] = px[4 * i + 3];
    if (px[4 * i + 3] !== 255) hasAlpha = true;
  }
  const grey = planes[0].every((v, i) => v === planes[1][i] && v === planes[2][i]);
  const bands = grey ? 1 : 3;
  return {
    meta: { format: type, width: w, height: h, bands, sampleType: 'u8', hasAlpha, grey },
    source: memorySource('picture', w, h, bands, 'u8', null, grey ? [planes[0]] : planes.slice(0, 3)),
  };
}
