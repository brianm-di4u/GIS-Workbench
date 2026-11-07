// HDF5 hyperspectral products through h5wasm from the HDF5 data pack (REQ-MSI-02; `Research/10`
// §5): PRISMA L1/L2 HDF5-EOS (VNIR/SWIR cubes in BIL order, wavelengths and scale factors as
// root attributes, Latitude/Longitude geolocation fields), EMIT L1B/L2A NetCDF-4 (reflectance or
// radiance in BIP order, sensor_band_parameters, location/lat, lon), and a generic reader for
// any 3-D numeric dataset with a wavelength list. The file is read into h5wasm's in-memory file
// system (wasm32 limits files to a few GB).

import { gcpGrid } from './cf.js';
import { gwError } from '../../i18n/index.js';

let nextFile = 1;

/** Sample type from h5wasm's metadata (class 0 integer, 1 float; size in bytes). */
const DT = (ds) => {
  const m = ds.metadata ?? {};
  if (m.type === 1) return m.size === 4 ? { t: 'f32', C: Float32Array } : { t: 'f32', C: Float32Array, wide: true };
  if (m.type === 0) {
    if (m.size === 1 && !m.signed) return { t: 'u8', C: Uint8Array };
    if (m.size === 2) return m.signed ? { t: 'i16', C: Int16Array } : { t: 'u16', C: Uint16Array };
  }
  return { t: 'f32', C: Float32Array, wide: true };
};

const attr = (o, k) => {
  try {
    const a = o?.attrs?.[k];
    return a ? a.value : undefined;
  } catch {
    return undefined;
  }
};
const arr = (v) => (v === undefined || v === null ? null : ArrayBuffer.isView(v) || Array.isArray(v) ? Array.from(v, Number) : [Number(v)]);
const tryGet = (f, p) => {
  try {
    return f.get(p) ?? null;
  } catch {
    return null;
  }
};

/** All datasets below a group: [{path, ds}] (bounded walk). */
function datasets(g, base = '', out = [], depth = 0) {
  if (depth > 8 || out.length > 2000) return out;
  for (const k of g.keys()) {
    const o = tryGet(g, k);
    const p = `${base}/${k}`;
    if (!o) continue;
    if (o.type === 'Dataset' || o.shape !== undefined) out.push({ path: p, ds: o });
    else if (o.keys) datasets(o, p, out, depth + 1);
  }
  return out;
}

/** Geolocation grid → GCPs (pixel-centre lat/lon sampled on an n × n grid; shared CF logic in cf.js). */
function gcpsFrom(latDs, lonDs, W, H, n = 12) {
  if (!latDs || !lonDs) return null;
  const sh = latDs.shape;
  if (sh?.length !== 2) return null;
  const [lh, lw] = sh;
  const at = (c, r) => ({ lat: Number(latDs.slice([[r, r + 1], [c, c + 1]])[0]), lon: Number(lonDs.slice([[r, r + 1], [c, c + 1]])[0]) });
  return gcpGrid(at, lw, lh, W, H, n);
}

/**
 * Per-pixel (or subsampled) latitude/longitude arrays → the nodes of a geolocation-array sensor model
 * (FC-25, REQ-FMT-54): {xs, ys, lat, lon, nx, ny, step, shape}. Node (r, c) of an lh × lw array sits at
 * image position ((c + 0.5)·W/lw, (r + 0.5)·H/lh); every `step`-th node is kept (and the last row and
 * column), at most `max` per axis. Fill values and out-of-range positions become NaN.
 */
export function geolocFrom(latDs, lonDs, W, H, max = 2048) {
  const sh = latDs?.shape;
  if (sh?.length !== 2 || lonDs?.shape?.length !== 2 || lonDs.shape[0] !== sh[0] || lonDs.shape[1] !== sh[1]) return null;
  const [lh, lw] = sh;
  if (lh < 2 || lw < 2) return null;
  // Arrays the same size as the image, or an integer subsample of it (MODIS-style 1 km / 5 km).
  const rx = W / lw;
  const ry = H / lh;
  if (!(Math.abs(rx - Math.round(rx)) < 1e-6 && Math.abs(ry - Math.round(ry)) < 1e-6 && rx >= 1 && ry >= 1)) return null;
  const la = latDs.value;
  const lo = lonDs.value;
  if (!la || !lo || la.length !== lh * lw) return null;
  const fill = (ds) => Number(attr(ds, '_FillValue') ?? attr(ds, 'missing_value') ?? NaN);
  const [fa, fo] = [fill(latDs), fill(lonDs)];
  const step = Math.max(1, Math.ceil(Math.max(lh, lw) / max));
  const pick = (n) => {
    const out = [];
    for (let i = 0; i < n; i += step) out.push(i);
    if (out.at(-1) !== n - 1) out.push(n - 1);
    return out;
  };
  const ci = pick(lw);
  const rj = pick(lh);
  const nx = ci.length;
  const ny = rj.length;
  const lat = new Float32Array(nx * ny);
  const lon = new Float32Array(nx * ny);
  let valid = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const k = rj[j] * lw + ci[i];
      const a = Number(la[k]);
      const o = Number(lo[k]);
      const ok = Number.isFinite(a) && Number.isFinite(o) && a !== fa && o !== fo && Math.abs(a) <= 90 && Math.abs(o) <= 360;
      lat[j * nx + i] = ok ? a : NaN;
      lon[j * nx + i] = ok ? o : NaN;
      if (ok) valid++;
    }
  if (valid < 4) return null;
  return { xs: ci.map((c) => (c + 0.5) * rx), ys: rj.map((r) => (r + 0.5) * ry), lat, lon, nx, ny, step, shape: [lh, lw] };
}

/**
 * Open an HDF5 file → {meta, source}. `lib` is self.h5wasm (the pack library, already run).
 * Wavelengths are reported in µm, like every other band source.
 */
export async function openHdf5(file, lib) {
  const M = await lib.ready;
  // The file is copied into wasm memory (fast for interleaved cubes, which read every band from all over
  // the file). When that copy cannot be allocated it is mounted where it is instead (WORKERFS, read on
  // demand with FileReaderSync): slower, but the file opens (CX-092).
  const WFS = M.FS.filesystems?.WORKERFS;
  const id = nextFile++;
  let dir = null;
  let path = `/gw-${id}.h5`;
  let bytes = null;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    M.FS.writeFile(path, bytes);
  } catch (e) {
    bytes = null;
    try {
      M.FS.unlink(path);
    } catch {}
    if (!(WFS && typeof FileReaderSync !== 'undefined' && file instanceof Blob)) throw e;
    dir = `/gw-w${id}`;
    M.FS.mkdir(dir);
    M.FS.mount(WFS, { blobs: [{ name: 'f.h5', data: file }] }, dir);
    path = `${dir}/f.h5`;
  }
  bytes = null;
  const unlink = () => {
    if (!dir) return M.FS.unlink(path);
    M.FS.unmount(dir);
    M.FS.rmdir(dir);
  };
  // The HDF5 library prints its error stack (HDF5-DIAG …) to stderr before a damaged file is refused
  // (CX-091): kept out of the console; the refusal names the first line instead. The module bound its
  // stderr printer when it loaded, so the stderr device's characters are taken over while the file opens.
  const diag = [];
  const { error, warn } = console;
  console.error = console.warn = (...a) => diag.push(a.join(' '));
  const tty = (M.FS.streams?.[2] ?? null)?.tty;
  const ttyOps = tty?.ops;
  if (ttyOps) {
    let line = [];
    tty.ops = {
      ...ttyOps,
      put_char(t, v) {
        if (v === 10 || v === null) {
          diag.push(new TextDecoder().decode(new Uint8Array(line)));
          line = [];
        } else if (v !== 0) line.push(v);
      },
      fsync() {
        if (line.length) diag.push(new TextDecoder().decode(new Uint8Array(line)));
        line = [];
      },
    };
  }
  let f;
  try {
    f = new lib.File(path, 'r');
  } catch (e) {
    unlink();
    const why = diag.find((l) => /minor:/.test(l))?.replace(/^\s*minor:\s*/, '') ?? e.message;
    throw gwError('the HDF5/NetCDF-4 file cannot be read ({why}); it may be truncated or damaged', { why: String(why) });
  } finally {
    console.error = error;
    console.warn = warn;
    if (ttyOps) tty.ops = ttyOps;
  }
  if (!f || f.file_id < 0) {
    unlink();
    const why = diag.find((l) => /minor:/.test(l))?.replace(/^\s*minor:\s*/, '') ?? 'not an HDF5 file';
    throw gwError('the HDF5/NetCDF-4 file cannot be read ({why}); it may be truncated or damaged', { why: String(why) });
  }
  const um = (v) => (v > 100 ? v / 1000 : v); // nm → µm
  let cube = null;
  let layout = 'BIP'; // dataset axes: BIP [rows, cols, bands], BIL [rows, bands, cols], BSQ [bands, rows, cols]
  let product = 'HDF5';
  let bands = null;
  let gain = null;
  let offset = null;
  let state = 'DN';
  let gcps = null;
  const swaths = tryGet(f, 'HDFEOS/SWATHS');
  if (swaths) {
    // PRISMA: HDFEOS/SWATHS/PRS_<level>_<type>/Data Fields/VNIR_Cube (+ SWIR_Cube).
    const sw = swaths.keys().find((k) => /^PRS_/.test(k)) ?? swaths.keys()[0];
    const g = tryGet(swaths, sw);
    const df = tryGet(g, 'Data Fields');
    cube = tryGet(df, 'VNIR_Cube') ?? tryGet(df, 'SWIR_Cube') ?? tryGet(df, 'Cube');
    const isVnir = !!tryGet(df, 'VNIR_Cube');
    layout = 'BIL';
    product = `PRISMA ${sw}${isVnir ? ' VNIR' : ' SWIR'}`;
    const cw = arr(attr(f, isVnir ? 'List_Cw_Vnir' : 'List_Cw_Swir'));
    const fw = arr(attr(f, isVnir ? 'List_Fwhm_Vnir' : 'List_Fwhm_Swir'));
    if (cw) bands = cw.map((c, i) => ({ name: `${isVnir ? 'VNIR' : 'SWIR'} ${i + 1}`, cw: c > 0 ? um(c) : NaN, fwhm: fw?.[i] > 0 ? um(fw[i]) : NaN, bad: !(c > 0) }));
    const lo = Number(attr(f, isVnir ? 'L2ScaleVnirMin' : 'L2ScaleSwirMin'));
    const hi = Number(attr(f, isVnir ? 'L2ScaleVnirMax' : 'L2ScaleSwirMax'));
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi > lo) {
      state = 'reflectance';
      const nb = cw?.length ?? 1;
      gain = Array(nb).fill((hi - lo) / 65535);
      offset = Array(nb).fill(lo);
    }
    const geo = tryGet(g, 'Geolocation Fields');
    const lat = tryGet(geo, isVnir ? 'Latitude_VNIR' : 'Latitude_SWIR') ?? tryGet(geo, 'Latitude');
    const lon = tryGet(geo, isVnir ? 'Longitude_VNIR' : 'Longitude_SWIR') ?? tryGet(geo, 'Longitude');
    if (cube) gcps = gcpsFrom(lat, lon, cube.shape[2], cube.shape[0]);
  } else if (tryGet(f, 'reflectance') || tryGet(f, 'radiance')) {
    // EMIT L2A / L1B NetCDF-4.
    const refl = tryGet(f, 'reflectance');
    cube = refl ?? tryGet(f, 'radiance');
    layout = 'BIP';
    product = `EMIT ${refl ? 'L2A reflectance' : 'L1B radiance'}`;
    state = refl ? 'reflectance' : 'radiance';
    const sbp = tryGet(f, 'sensor_band_parameters');
    const wl = arr(tryGet(sbp, 'wavelengths')?.value);
    const fw = arr(tryGet(sbp, 'fwhm')?.value);
    const good = arr(tryGet(sbp, 'good_wavelengths')?.value);
    if (wl) bands = wl.map((c, i) => ({ name: `Band ${i + 1}`, cw: um(c), fwhm: fw ? um(fw[i]) : NaN, bad: good ? good[i] === 0 : false }));
    gain = bands ? Array(bands.length).fill(1) : null;
    offset = bands ? Array(bands.length).fill(0) : null;
    gcps = gcpsFrom(tryGet(f, 'location/lat'), tryGet(f, 'location/lon'), cube.shape[1], cube.shape[0]);
  } else {
    // Generic: the largest 3-D numeric dataset; bands on its smallest axis.
    const all = datasets(f).filter((d) => d.ds.shape?.length === 3);
    all.sort((a, b) => b.ds.shape.reduce((s, x) => s * x, 1) - a.ds.shape.reduce((s, x) => s * x, 1));
    if (!all.length) {
      f.close();
      unlink();
      throw new Error('no 3-D image dataset in this HDF5 file');
    }
    cube = all[0].ds;
    const sh = cube.shape;
    const bAxis = sh.indexOf(Math.min(...sh));
    layout = bAxis === 2 ? 'BIP' : bAxis === 1 ? 'BIL' : 'BSQ';
    product = `HDF5 ${all[0].path}`;
    const wl = arr(attr(cube, 'wavelength') ?? attr(cube, 'wavelengths')) ?? arr(datasets(f).find((d) => /wavelength/i.test(d.path) && d.ds.shape?.length === 1)?.ds.value);
    if (wl) bands = wl.map((c, i) => ({ name: `Band ${i + 1}`, cw: um(c), fwhm: NaN, bad: false }));
  }
  if (!cube) {
    f.close();
    unlink();
    throw new Error('no image cube found in this HDF5 file');
  }
  const sh = cube.shape;
  const [H, W, NB] = layout === 'BIP' ? [sh[0], sh[1], sh[2]] : layout === 'BIL' ? [sh[0], sh[2], sh[1]] : [sh[1], sh[2], sh[0]];
  const { t, C, wide } = DT(cube);
  const fill = Number(attr(cube, '_FillValue') ?? attr(cube, 'missing_value'));
  // Swath geolocation arrays (REQ-FMT-54): the product's own (PRISMA, EMIT) or any 2-D latitude/longitude
  // pair the size of the image or an integer subsample of it (PACE OCI, HICO, generic CF swaths).
  let geoloc = null;
  try {
    const all = datasets(f).filter((d) => d.ds.shape?.length === 2);
    const by = (re) => all.filter((d) => re.test(d.path.split('/').pop()));
    const lats = by(/^(lat|latitude|latitudes|Latitude(_VNIR|_SWIR)?)$/i);
    const lons = by(/^(lon|long|longitude|longitudes|Longitude(_VNIR|_SWIR)?)$/i);
    const pref = product.startsWith('PRISMA') ? (product.includes('VNIR') ? 'VNIR' : 'SWIR') : null;
    lats.sort((a, b) => (pref && b.path.includes(pref)) - (pref && a.path.includes(pref)));
    for (const l of lats) {
      const o = lons.find((d) => d.path.replace(/[^/]+$/, '') === l.path.replace(/[^/]+$/, '') && (!pref || d.path.includes(pref) === l.path.includes(pref))) ?? lons[0];
      geoloc = o ? geolocFrom(l.ds, o.ds, W, H) : null;
      if (geoloc) {
        geoloc.paths = [l.path, o.path];
        break;
      }
    }
  } catch {
    geoloc = null;
  }
  // Present bands in ascending wavelength order (PRISMA stores VNIR descending); flagged bands
  // without a wavelength go last. `order[k]` is the file band of presented band k.
  const order = [...Array(NB).keys()];
  if (bands?.length === NB) order.sort((a, b) => (Number.isFinite(bands[a].cw) ? bands[a].cw : Infinity) - (Number.isFinite(bands[b].cw) ? bands[b].cw : Infinity) || a - b);
  const reordered = order.some((v, k) => v !== k);
  if (bands?.length === NB) bands = order.map((b) => bands[b]);
  if (gain) gain = order.map((b) => gain[b] ?? gain[0]);
  if (offset) offset = order.map((b) => offset[b] ?? offset[0]);
  // Chunks as wide as the image (PACE OCI: 40 bands × 16 rows × 1272) are inflated whole for any
  // window, and h5wasm's 1 MB chunk cache holds none of them: every tile across a row band inflated
  // the same chunks again (perf 2.1, 6.4 s to a PACE L1B first tile). Such cubes are read in
  // full-width row bands kept in a small cache; the tiles across cut their columns from it.
  const chunks = cube.metadata?.chunks ?? null;
  const fullWidth = Array.isArray(chunks) && chunks.length === 3 && Number(chunks[layout === 'BIP' ? 1 : 2]) >= W && W <= 16384;
  const bandsCache = new Map();
  let bandsBytes = 0;
  function slab(b0, nb, x0, y0, w, h) {
    const ranges = (xa, xb) => (layout === 'BIP' ? [[y0, y0 + h], [xa, xb], [b0, b0 + nb]] : layout === 'BIL' ? [[y0, y0 + h], [b0, b0 + nb], [xa, xb]] : [[b0, b0 + nb], [y0, y0 + h], [xa, xb]]);
    if (!fullWidth || (x0 === 0 && w === W)) return cube.slice(ranges(x0, x0 + w));
    const key = `${b0},${nb},${y0},${h}`;
    let all = bandsCache.get(key);
    if (all) {
      bandsCache.delete(key);
      bandsCache.set(key, all);
    } else {
      all = cube.slice(ranges(0, W));
      if (!ArrayBuffer.isView(all)) return cube.slice(ranges(x0, x0 + w));
      bandsCache.set(key, all);
      bandsBytes += all.byteLength;
      for (const [k, a] of bandsCache) {
        if (bandsBytes <= 96 << 20 || k === key) break;
        bandsCache.delete(k);
        bandsBytes -= a.byteLength;
      }
    }
    // The window's columns, in the order cube.slice would give them.
    const out = new all.constructor(nb * h * w);
    if (layout === 'BIP') for (let r = 0; r < h; r++) out.set(all.subarray((r * W + x0) * nb, (r * W + x0 + w) * nb), r * w * nb);
    else for (let q = 0; q < nb * h; q++) out.set(all.subarray(q * W + x0, q * W + x0 + w), q * w);
    return out;
  }
  const source = {
    kind: 'hdf5',
    imageIndex: 0,
    width: W,
    height: H,
    bands: NB,
    sampleType: t,
    nodata: Number.isFinite(fill) ? fill : null,
    async readWindow(x0, y0, w, h, sel) {
      // Consecutive file bands are read in one slice (CX-092): chunks span many bands (PACE OCI: 40 bands
      // × 16 rows), and a slice per band decompressed every chunk once per band.
      const fileBands = sel.map((k) => order[k]);
      const out = new Array(sel.length);
      const byBand = [...fileBands.keys()].sort((p, q) => fileBands[p] - fileBands[q]);
      for (let i = 0; i < byBand.length; ) {
        let j = i + 1;
        while (j < byBand.length && fileBands[byBand[j]] - fileBands[byBand[j - 1]] <= 1) j++;
        const b0 = fileBands[byBand[i]];
        const nb = fileBands[byBand[j - 1]] - b0 + 1;
        const v = slab(b0, nb, x0, y0, w, h);
        const n = w * h;
        for (let q = i; q < j; q++) {
          const bi = fileBands[byBand[q]] - b0;
          let a;
          if (layout === 'BSQ') a = v.slice(bi * n, (bi + 1) * n);
          else {
            a = new v.constructor(n);
            if (layout === 'BIP') for (let p = 0; p < n; p++) a[p] = v[p * nb + bi];
            else for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) a[r * w + c] = v[(r * nb + bi) * w + c];
          }
          out[byBand[q]] = wide || !(a instanceof C) ? C.from(a, Number) : a;
        }
        i = j;
      }
      return out;
    },
    close() {
      try {
        f.close();
        unlink();
      } catch {}
    },
  };
  const meta = { format: `${product} (HDF5, ${layout}, ${t}${reordered ? ', bands reordered by wavelength' : ''})`, product, bandOrder: order, bandsMeta: bands?.length === NB ? bands : null, radiometry: { state, gain, offset, unit: state === 'reflectance' ? 'reflectance' : state === 'radiance' ? 'radiance' : 'DN', source: product }, gcps, geoloc, layout };
  return { meta, source };
}
