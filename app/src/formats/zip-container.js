// Imagery delivered in ZIP packages (IMP-21, TE-060): DigitalGlobe/Maxar tile sets, Pléiades DIMAP
// volumes and ZIPs of ZIPs open without unpacking. Only the central directory is read; a stored
// entry is a zero-copy Blob slice, so a multi-gigabyte archive is never loaded whole, and a deflated
// entry is inflated as a stream into a Blob the browser can page to disk.

const MAX_DEPTH = 3;
const MAX_ENTRIES = 100000;
// Rasters that make a ZIP an imagery package (a ZIP of only vectors keeps the vector route).
export const RASTER_IN_ZIP = /\.(tif|tiff|gtiff|ntf|nitf|nsf|jp2|j2k|jpx|img|dt[0-2]|hgt|sid|ecw)$/i;
// Quick looks and logos travel in packages but are not what the user came for.
const QUICKLOOK = /(^|\/)(icon|preview|logo|thumb)[^/]*$|_browse\.[^/]+$/i;
// Product masks (DIMAP MASKS/*.GML) are offered, not opened by default.
const MASK = /(^|\/)masks\//i;
const VECTOR_IN_ZIP = /\.(shp|geojson|kml|kmz|gpkg|gml|zip)$/i;

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);
const u64 = (v, o) => v.getUint32(o, true) + v.getUint32(o + 4, true) * 2 ** 32;

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Central-directory entries of a ZIP held in `blob` (ZIP64 aware). Throws a named error otherwise. */
export async function listZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = await view(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP archive (no end-of-central-directory record)');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOff = u32(tail, eocd + 16);
  if (cdOff === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    if (eocd < 20 || u32(tail, eocd - 20) !== 0x07064b50) throw new Error('ZIP64 archive without its locator');
    const at = u64(tail, eocd - 20 + 8);
    const z = await view(blob, at, at + 56);
    if (u32(z, 0) !== 0x06064b50) throw new Error('ZIP64 end record not found');
    count = u64(z, 32);
    cdSize = u64(z, 40);
    cdOff = u64(z, 48);
  }
  if (count > MAX_ENTRIES) throw new Error(`the ZIP lists ${count} entries (this release reads up to ${MAX_ENTRIES})`);
  if (cdOff + cdSize > blob.size) throw new Error('the ZIP is truncated (its directory lies past the end of the file)');
  const cd = await view(blob, cdOff, cdOff + cdSize);
  const utf8 = new TextDecoder('utf-8');
  const latin = new TextDecoder('windows-1252');
  const out = [];
  for (let p = 0, k = 0; k < count; k++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014b50) throw new Error('the ZIP central directory is damaged');
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let csize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nlen = u16(cd, p + 28);
    const xlen = u16(cd, p + 30);
    const clen = u16(cd, p + 32);
    let local = u32(cd, p + 42);
    const raw = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nlen);
    const path = (flags & 0x800 ? utf8 : latin).decode(raw).replace(/\\/g, '/');
    for (let x = p + 46 + nlen, end = x + xlen; x + 4 <= end; ) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (csize === 0xffffffff) (csize = u64(cd, q)), (q += 8);
        if (local === 0xffffffff) local = u64(cd, q);
      }
      x += 4 + len;
    }
    p += 46 + nlen + xlen + clen;
    if (path.endsWith('/')) continue;
    out.push({ path, name: path.split('/').pop(), size, csize, method, local, encrypted: !!(flags & 1) });
  }
  return out;
}

/** The bytes of one entry as a File (a slice when stored, a streamed inflate when deflated). */
export async function entryFile(blob, e) {
  if (e.encrypted) throw new Error(`${e.path}: encrypted ZIP entries cannot be read`);
  const h = await view(blob, e.local, e.local + 30);
  if (u32(h, 0) !== 0x04034b50) throw new Error(`${e.path}: damaged local header in the ZIP`);
  const start = e.local + 30 + u16(h, 26) + u16(h, 28);
  if (start + e.csize > blob.size) throw new Error(`${e.path}: the ZIP is truncated`);
  const part = blob.slice(start, start + e.csize);
  let data;
  if (e.method === 0) data = part;
  else if (e.method === 8) {
    data = await new Response(part.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    if (data.size !== e.size) throw new Error(`${e.path}: inflated to ${data.size} bytes, the ZIP says ${e.size}`);
  } else throw new Error(`${e.path}: ZIP compression method ${e.method} is not supported (stored and deflate are)`);
  const f = new File([data], e.name, { lastModified: Date.now() });
  f.__zipPath = e.zipPath;
  return f;
}

/**
 * Every entry of a ZIP, with ZIPs inside it expanded (to MAX_DEPTH). Each entry gets `zipPath`
 * (outer.zip/inner.zip/name), `group` (the innermost ZIP it came from) and `open()` → File.
 * Stored inner ZIPs are slices and always expanded; deflated ones are inflated while `budget`
 * bytes last (a delivery of many deflated ZIPs is not inflated whole just to list it). The rest stay
 * as `nested` entries: picked, they open as packages of their own.
 */
export async function expandZip(file, depth = 0, prefix = file.name, budget = { bytes: 256 << 20 }) {
  const out = [];
  for (const e of await listZip(file)) {
    e.zipPath = `${prefix}/${e.path}`;
    e.group = prefix;
    if (/\.zip$/i.test(e.name) && depth + 1 < MAX_DEPTH) {
      if (e.method === 0 || e.size <= budget.bytes) {
        if (e.method !== 0) budget.bytes -= e.size;
        const inner = await entryFile(file, e);
        const kids = await expandZip(inner, depth + 1, e.zipPath, budget).catch(() => null);
        // A ZIP of vectors (shapefile set) stays one entry for the vector reader.
        if (kids?.some((k) => RASTER_IN_ZIP.test(k.name) || k.nested)) {
          out.push(...kids);
          continue;
        }
        e.blob = inner;
      } else e.nested = true;
    }
    e.open = () => (e.blob ? Object.assign(new File([e.blob], e.name), { __zipPath: e.zipPath }) : entryFile(file, e));
    out.push(e);
  }
  return out;
}

/** True when a ZIP holds imagery (directly or in ZIPs inside it): it opens as a package. */
export async function isImageryZip(file) {
  try {
    const es = await listZip(file);
    if (es.some((e) => RASTER_IN_ZIP.test(e.name))) return true;
    // ZIPs inside: the stored ones are slices; of the deflated ones, only the smallest is inflated.
    const zips = es.filter((x) => /\.zip$/i.test(x.name));
    const look = [...zips.filter((x) => x.method === 0).slice(0, 4), ...zips.filter((x) => x.method !== 0 && x.size <= 256 << 20).sort((p, q) => p.size - q.size).slice(0, 1)];
    for (const e of look) {
      const inner = await entryFile(file, e);
      if ((await listZip(inner)).some((k) => RASTER_IN_ZIP.test(k.name))) return true;
    }
  } catch {
    return false; // the vector route reports a damaged ZIP by name
  }
  return false;
}

/** Entries a user would open by default: the imagery with its sidecars, and the vector overlays. */
export function defaultPick(entries, maxRasters = 24) {
  const main = entries.filter((e) => RASTER_IN_ZIP.test(e.name) && !QUICKLOOK.test(e.path));
  // Packages not expanded (see expandZip) are offered, not opened by default.
  entries = entries.filter((e) => !e.nested);
  const groups = [...new Set(main.map((e) => e.group))];
  // A big delivery (a ZIP of many packages) starts with its first package selected.
  const keep = main.length > maxRasters ? new Set([groups[0]]) : new Set(groups);
  return entries.filter((e) => keep.has(e.group) && (main.includes(e) || (!RASTER_IN_ZIP.test(e.name) && !QUICKLOOK.test(e.path) && ((VECTOR_IN_ZIP.test(e.name) && !MASK.test(e.path)) || isSidecarOf(e, main)))));
}

const stem = (n) => n.toLowerCase().replace(/\.aux\.xml$/, '').replace(/\.[^.]+$/, '');
function isSidecarOf(e, rasters) {
  const s = stem(e.name);
  return rasters.some((r) => r.group === e.group && (stem(r.name) === s || r.name.toLowerCase() === s)) || /^dim_.*\.xml$/i.test(e.name);
}
