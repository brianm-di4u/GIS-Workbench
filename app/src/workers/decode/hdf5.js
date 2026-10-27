// HDF5 hyperspectral products through h5wasm from the HDF5 data pack (REQ-MSI-02; `Research/10`
// §5): PRISMA L1/L2 HDF5-EOS (VNIR/SWIR cubes in BIL order, wavelengths and scale factors as
// root attributes, Latitude/Longitude geolocation fields), EMIT L1B/L2A NetCDF-4 (reflectance or
// radiance in BIP order, sensor_band_parameters, location/lat, lon), and a generic reader for
// any 3-D numeric dataset with a wavelength list. The file is read into h5wasm's in-memory file
// system (wasm32 limits files to a few GB).

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

/** Geolocation grid → GCPs (pixel-centre lat/lon sampled on an n × n grid). */
function gcpsFrom(latDs, lonDs, W, H, n = 12) {
  if (!latDs || !lonDs) return null;
  const sh = latDs.shape;
  if (sh?.length !== 2) return null;
  const [lh, lw] = sh;
  const out = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const r = Math.min(lh - 1, Math.round((j * (lh - 1)) / (n - 1)));
      const c = Math.min(lw - 1, Math.round((i * (lw - 1)) / (n - 1)));
      const la = Number(latDs.slice([[r, r + 1], [c, c + 1]])[0]);
      const lo = Number(lonDs.slice([[r, r + 1], [c, c + 1]])[0]);
      if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) out.push({ x: ((c + 0.5) * W) / lw, y: ((r + 0.5) * H) / lh, lat: la, lon: lo });
    }
  }
  return out.length >= 6 ? out : null;
}

/**
 * Open an HDF5 file → {meta, source}. `lib` is self.h5wasm (the pack library, already run).
 * Wavelengths are reported in µm, like every other band source.
 */
export async function openHdf5(file, lib) {
  const M = await lib.ready;
  const path = `/gw-${nextFile++}.h5`;
  M.FS.writeFile(path, new Uint8Array(await file.arrayBuffer()));
  const f = new lib.File(path, 'r');
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
    throw new Error('no image cube found in this HDF5 file');
  }
  const sh = cube.shape;
  const [H, W, NB] = layout === 'BIP' ? [sh[0], sh[1], sh[2]] : layout === 'BIL' ? [sh[0], sh[2], sh[1]] : [sh[1], sh[2], sh[0]];
  const { t, C, wide } = DT(cube);
  const fill = Number(attr(cube, '_FillValue') ?? attr(cube, 'missing_value'));
  // Present bands in ascending wavelength order (PRISMA stores VNIR descending); flagged bands
  // without a wavelength go last. `order[k]` is the file band of presented band k.
  const order = [...Array(NB).keys()];
  if (bands?.length === NB) order.sort((a, b) => (Number.isFinite(bands[a].cw) ? bands[a].cw : Infinity) - (Number.isFinite(bands[b].cw) ? bands[b].cw : Infinity) || a - b);
  const reordered = order.some((v, k) => v !== k);
  if (bands?.length === NB) bands = order.map((b) => bands[b]);
  if (gain) gain = order.map((b) => gain[b] ?? gain[0]);
  if (offset) offset = order.map((b) => offset[b] ?? offset[0]);
  const source = {
    kind: 'hdf5',
    imageIndex: 0,
    width: W,
    height: H,
    bands: NB,
    sampleType: t,
    nodata: Number.isFinite(fill) ? fill : null,
    async readWindow(x0, y0, w, h, sel) {
      return sel.map((k) => {
        const b = order[k];
        const ranges = layout === 'BIP' ? [[y0, y0 + h], [x0, x0 + w], [b, b + 1]] : layout === 'BIL' ? [[y0, y0 + h], [b, b + 1], [x0, x0 + w]] : [[b, b + 1], [y0, y0 + h], [x0, x0 + w]];
        const v = cube.slice(ranges);
        return wide || !(v instanceof C) ? C.from(v, Number) : v;
      });
    },
    close() {
      try {
        f.close();
        M.FS.unlink(path);
      } catch {}
    },
  };
  const meta = { format: `${product} (HDF5, ${layout}, ${t}${reordered ? ', bands reordered by wavelength' : ''})`, product, bandOrder: order, bandsMeta: bands?.length === NB ? bands : null, radiometry: { state, gain, offset, unit: state === 'reflectance' ? 'reflectance' : state === 'radiance' ? 'radiance' : 'DN', source: product }, gcps, layout };
  return { meta, source };
}
