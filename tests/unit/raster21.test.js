// 2.1 raster group (FC-03/FC-04; REQ-FMT-24..27): HFA and NetCDF-3 sources through the real legacy
// WASM bundle, checked exactly —
//   * FX-21 NetCDF-3 fixtures (CDF-1/2/5, record variables, CF grid mappings) against the values
//     the generator wrote (build/fixtures/fx21/raster.mjs value());
//   * the writers: app → file → the app's reader (exact);
//   * the CRS mappings both ways (reader ↔ writer) and WKT1 through proj4js.
// Skipped when the bundle or the fixtures are absent.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import proj4 from 'proj4';
import { Bundle } from '../../app/src/wasm/abi.js';
import { openHfa, hfaCrs } from '../../app/src/workers/decode/hfa.js';
import { openNetcdf3 } from '../../app/src/workers/decode/netcdf3.js';
import { gridMapping, unrotate } from '../../app/src/workers/decode/cf.js';
import { layerCrs, wkt1, cfAttrs, hfaProjection } from '../../app/src/formats/raster-crs.js';
import { encodeHfa, encodeNetcdf3 } from '../../app/src/formats/raster-writers.js';
import { value } from '../../build/fixtures/fx21/raster.mjs';

const FX = resolve('fixtures/fx21/raster');
const wasm = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_legacy.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasm && existsSync(wasm);
const lx = haveWasm ? new Bundle(new WebAssembly.Module(readFileSync(wasm)), 'legacy') : null;
const file = (p) => new File([readFileSync(p)], p.split(/[\\/]/).pop());
const TMP = mkdtempSync(join(tmpdir(), 'gw-raster21-'));

const sideOf = (dir, img) => ['.ige', '.rrd'].map((e) => join(dir, img.replace(/\.img$/i, e))).filter(existsSync).map(file);

describe.skipIf(!haveWasm || !existsSync(FX))('FX-21 NetCDF-3 against the generator', () => {
  const report = existsSync(join(FX, 'fx21-raster.json')) ? JSON.parse(readFileSync(join(FX, 'fx21-raster.json'), 'utf8')) : { netcdf: [] };
  for (const n of report.netcdf) {
    it(`${n.file} (CDF-${n.version})`, async () => {
      const { meta, sources } = await openNetcdf3(file(join(FX, n.file)), lx);
      expect(meta.version).toBe(n.version);
      const s0 = sources[0];
      expect([s0.source.width, s0.source.height, s0.source.bands]).toEqual([n.expect.w, n.expect.h, n.expect.bands]);
      if (n.expect.epsg) expect(s0.meta.epsg).toBe(n.expect.epsg);
      expect(s0.meta.geotransform || s0.meta.gcps, 'georeferenced').toBeTruthy();
      for (const { source, meta: m } of sources) {
        const type = n.vars.find((v) => v.name === m.variable).type;
        const W = source.width;
        const H = source.height;
        for (let b = 0; b < source.bands; b++) {
          const [a] = await source.readWindow(0, 0, W, H, [b]);
          for (let r = 0; r < H; r++)
            for (let c = 0; c < W; c++) {
              const fr = m.flipped ? H - 1 - r : r;
              let want = value(type, b, fr, c);
              if (m.variable === 'z' && (fr * W + c) % 37 === 0) want = NaN;
              if (type === 'byte' && source.sampleType === 'u8') want = (want + 256) % 256; // _Unsigned
              if (source.sampleType === 'f32') want = Math.fround(want);
              const got = a[r * W + c];
              if (!(got === want || (Number.isNaN(got) && Number.isNaN(want)))) throw new Error(`${n.file} ${m.variable} band ${b} (${c},${r}): ${got} vs ${want}`);
            }
        }
      }
    });
  }
  it('strided coarse levels: every level sample is the full-resolution pixel at the centre of its cell', async () => {
    for (const f of ['nc_cdf2_lcc_records.nc', 'nc_cdf1_utm_byte.nc', 'nc_cdf1_latlon_double.nc']) {
      const { sources } = await openNetcdf3(file(join(FX, f)), lx);
      const src = sources[0].source;
      const full = await src.readWindow(0, 0, src.width, src.height, [src.bands - 1]);
      for (const L of [1, 2, 3]) {
        const sc = 2 ** L;
        const lw = Math.ceil(src.width / sc);
        const lh = Math.ceil(src.height / sc);
        const [lv] = await src.readLevel(L, 1, 1, lw, lh, [src.bands - 1]);
        for (let j = 0; j < lh - 1; j++)
          for (let i = 0; i < lw - 1; i++) {
            const X = Math.min(src.width - 1, (1 + i) * sc + (sc >> 1));
            const Y = Math.min(src.height - 1, (1 + j) * sc + (sc >> 1));
            const want = full[0][Y * src.width + X];
            const got = lv[j * lw + i];
            if (!(got === want || (Number.isNaN(got) && Number.isNaN(want)))) throw new Error(`${f} L${L} (${i},${j}): ${got} vs ${want}`);
          }
      }
    }
  });
  it('the rotated-pole grid gets GCPs at the right place', async () => {
    const { sources } = await openNetcdf3(file(join(FX, 'nc_cdf2_rotated.nc')), lx);
    const g = sources[0].meta.gcps;
    expect(g.length).toBeGreaterThan(100);
    // Rotated (0, 0) is 90° from the rotated pole along its meridian: (50.75 N, 18 E).
    const c = unrotate(0, 0, { poleLat: 39.25, poleLon: -162 });
    expect(c.lat).toBeCloseTo(50.75, 6);
    expect(c.lon).toBeCloseTo(18, 6);
  });
});

describe('CRS mappings, both ways', () => {
  const layer = (meta) => ({ info: { meta } });
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const cases = [
    { epsg: 32611 },
    { epsg: 32733 },
    { epsg: 26910 },
    { epsg: 26711 },
    { epsg: 4326 },
    { epsg: 3035 },
    { epsg: 5070 },
    { epsg: 2229 },
    { epsg: 3413 },
    { proj4: '+proj=lcc +lat_1=33 +lat_2=45 +lat_0=40 +lon_0=-97 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs' },
    { proj4: '+proj=merc +lon_0=10 +lat_ts=20 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs' },
  ];
  for (const m of cases) {
    it(`${m.epsg ? `EPSG:${m.epsg}` : m.proj4}: HFA and CF parameters read back to the same projection`, () => {
      const c = layerCrs(layer(m));
      expect(c?.P, 'parsed').toBeTruthy();
      const ref = proj4(c.P, 'WGS84');
      // A point inside the projection's area: near its origin (polar ones at 80°).
      const D = 180 / Math.PI;
      const lat0 = c.kind === 'longlat' ? 41.9 : Math.max(-80, Math.min(80, (c.P.lat0 ?? 0) * D + 0.3));
      const lon0 = c.kind === 'longlat' ? 12.5 : (c.P.long0 ?? 0) * D + 0.3;
      const xy = ref.forward([lon0, lat0]);
      const ll = ref.inverse(xy);
      expect(xy.every(Number.isFinite), 'test point').toBe(true);
      // HFA: writer → reader.
      const h = hfaProjection(c);
      if (!h.error) {
        const pro = { proType: 'EPRJ_INTERNAL', proNumber: h.pro.number, proName: h.pro.proName, proZone: h.pro.zone, proParams: h.pro.params, proSpheroid: { sphereName: h.pro.sphereName, a: h.pro.a, b: h.pro.b } };
        const back = hfaCrs(pro, { datumname: h.datum.name, type: 'EPRJ_DATUM_PARAMETRIC', params: h.datum.params }, { proName: h.mapProName, units: h.units });
        if (m.epsg && [32611, 32733, 26910, 26711, 4326].includes(m.epsg)) expect(back.epsg).toBe(m.epsg);
        const r2 = proj4(back.proj4, 'WGS84');
        expect(near(r2.inverse(xy), ll, 1e-6), `HFA ${back.proj4}`).toBe(true);
      }
      // CF: writer → reader.
      const attrs = cfAttrs(c).map((a) => ({ name: a.name, value: a.type === 'char' ? a.value : a.value }));
      const g = gridMapping(attrs, { toMeters: c.P.to_meter && c.P.to_meter !== 1 ? c.P.to_meter : c.P.units === 'us-ft' ? 0.304800609601219 : 1 });
      expect(g.error, JSON.stringify(attrs)).toBeUndefined();
      const r3 = proj4(g.proj4, 'WGS84');
      expect(near(r3.inverse(xy), ll, 1e-6), `CF ${g.proj4}`).toBe(true);
      // WKT1 parses (proj4js) to the same projection.
      // WKT1 parses (proj4js) to the same projection; proj4js has no Mercator_2SP (GDAL has, c53 checks it).
      const w = wkt1(c);
      if (!/Mercator_2SP/.test(w)) {
        const r4 = proj4(w, 'WGS84');
        expect(near(r4.inverse(xy), ll, 2e-6), `WKT ${w}`).toBe(true);
      }
    });
  }
});

/** A test double of the app: the decode worker's 'window' (nearest decimation) and 'rasterSpec' ops. */
function fakeApp(source) {
  return {
    pool: {
      async run(op, a) {
        if (op === 'rasterSpec') {
          const [p, n] = lx.put(new TextEncoder().encode(a.spec));
          try {
            if (lx.x[a.kind === 'hfa' ? 'gw_hfa_write' : 'gw_nc3_write_header'](p, n) !== 0) throw new Error(lx.lastError());
          } finally {
            lx.free(p, n);
          }
          const o = lx.outBytes();
          const jl = new DataView(o.buffer, o.byteOffset).getUint32(0, true);
          return { layout: JSON.parse(new TextDecoder().decode(o.subarray(4, 4 + jl))), bytes: o.slice(4 + jl) };
        }
        if (op === 'window') {
          const { x0, y0, w, h, step, bands } = a;
          const sw = Math.min(source.width - x0, w * step);
          const sh = Math.min(source.height - y0, h * step);
          const ow = Math.ceil(sw / step);
          const oh = Math.ceil(sh / step);
          const got = await source.readWindow(x0, y0, sw, sh, bands);
          const planes = got.map((g) => {
            const o = new g.constructor(ow * oh);
            for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) o[oy * ow + ox] = g[oy * step * sw + ox * step];
            return o;
          });
          return { x0, y0, w: ow, h: oh, step, planes };
        }
        throw new Error(`fake pool: no op ${op}`);
      },
    },
  };
}

describe.skipIf(!haveWasm || !existsSync(FX))('writers: app → file → app (exact)', () => {
  const inputs = [
    ['hfa_f32_rle.img', 'hfa'],
    ['hfa_rgb.img', 'hfa'],
    ['hfa_s16.img', 'hfa'],
    ['nc_cdf1_utm_byte.nc', 'nc'],
    ['nc_cdf2_lcc_records.nc', 'nc'],
    ['hfa_u16_rle.img', 'hfa'],
  ];
  for (const [f0, kind] of inputs) {
    const at = (q) => (/[\\/]/.test(q) ? q : join(FX, q));
    const f = f0.split(/[\\/]/).pop();
    const fp = at(f0);
    for (const fmt of ['hfa', 'nc3']) {
      it(`${f} → ${fmt}`, async () => {
        const src = kind === 'hfa' ? await openHfa(file(fp), lx, sideOf(FX, f)) : await openNetcdf3(file(fp), lx).then((r) => r.sources[0]);
        const { source, meta } = src;
        const l = { width: source.width, height: source.height, bands: source.bands, handle: 1, affinity: 0, nodata: source.nodata, rec: { name: f }, info: { meta, bandsMeta: meta.bandsMeta } };
        const app = fakeApp(source);
        const r = fmt === 'hfa' ? await encodeHfa(app, l) : await encodeNetcdf3(app, l);
        const out = join(TMP, `${f}.${fmt === 'hfa' ? 'img' : 'nc'}`);
        writeFileSync(out, new Uint8Array(await r.blob.arrayBuffer()));
        // The app reads its own file back: same pixels, same georeferencing.
        const back = fmt === 'hfa' ? await openHfa(file(out), lx) : (await openNetcdf3(file(out), lx)).sources[0];
        expect([back.source.width, back.source.height, back.source.bands]).toEqual([source.width, source.height, source.bands]);
        for (let b = 0; b < source.bands; b++) {
          const [a] = await source.readWindow(0, 0, source.width, source.height, [b]);
          const [c] = await back.source.readWindow(0, 0, source.width, source.height, [b]);
          expect(Array.from(c), `${f} → ${fmt} band ${b}`).toEqual(Array.from(a));
        }
        if (meta.geotransform) expect(near6(back.meta.geotransform, meta.geotransform), `${JSON.stringify(back.meta.geotransform)} vs ${JSON.stringify(meta.geotransform)}`).toBe(true);
        if (meta.epsg) expect(back.meta.epsg ?? back.meta.wkt).toBeTruthy();
        if (Number.isFinite(source.nodata)) expect(back.source.nodata).toBe(source.nodata);
        if (fmt === 'hfa' && Math.max(source.width, source.height) >= 64) expect(back.meta.overviews).toBeGreaterThanOrEqual(1);
      }, 60000); // corpus files are read from the archive disk
    }
  }
});

function near(a, b, tol) {
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function near6(a, b) {
  return a.length === 6 && a.every((v, i) => Math.abs(v - b[i]) <= 1e-6 * Math.max(1, Math.abs(b[i])));
}
