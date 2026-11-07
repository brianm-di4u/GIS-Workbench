// FX-21 raster group (SDP-2.1 §4 P9; FC-03/FC-04): synthetic NetCDF-3 and ERDAS Imagine inputs.
//
// NetCDF-3 files are written here, by an encoder independent of the app's (crates/gw-parse
// netcdf3.rs): CDF-1, CDF-2 and CDF-5 headers, record (unlimited) variables, every classic type and
// the CDF-5 unsigned/64-bit ones, _FillValue/_Unsigned/scale_factor, south-up and north-up rows and
// the CF grid mappings the reader maps (transverse Mercator, LCC 2SP, polar stereographic,
// latitude/longitude, rotated pole). Pixel values follow `value()` so a test can check them exactly.
// HFA files are written by GDAL's HFA driver (raster_hfa.py, gw-te env) with RLE, an .ige spill
// file, internal and .rrd overviews and every pixel type. Every output is then read back by GDAL
// (gdalinfo -json) and the result stored in fx21-raster.json.
//
//   node build/fixtures/fxformats21.mjs --only=raster

import { writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = process.env.GW_TE_ENV ?? join(HERE, '..', '..', '..', '..', 'TE-tools', 'mamba', 'envs', 'gw-te');
const PY = join(ENV, 'python.exe');
const BIN = join(ENV, 'Library', 'bin');
const GENV = { ...process.env, PATH: `${BIN};${process.env.PATH}`, GDAL_DATA: join(ENV, 'Library', 'share', 'gdal'), PROJ_DATA: join(ENV, 'Library', 'share', 'proj'), GDAL_DRIVER_PATH: join(ENV, 'Library', 'lib', 'gdalplugins'), GDAL_PAM_ENABLED: 'NO' };

const TYPES = { byte: [1, 1], char: [2, 1], short: [3, 2], int: [4, 4], float: [5, 4], double: [6, 8], ubyte: [7, 1], ushort: [8, 2], uint: [9, 4], int64: [10, 8], uint64: [11, 8] };

/** The value of a grid variable at (band b, row r, col c): row 0 is the file's first row. */
export function value(type, b, r, c) {
  const v = ((c * 7 + r * 3 + b * 13) % 101) + ((c >> 3) + (r >> 2)) % 5;
  switch (type) {
    case 'byte':
      return v - 50;
    case 'ubyte':
      return v * 2;
    case 'short':
      return v * 300 - 15000;
    case 'ushort':
      return v * 600;
    case 'int':
      return v * 100000 - 5000000;
    case 'uint':
      return v * 40000000;
    case 'int64':
      return v * 1000 - 9;
    case 'uint64':
      return v * 1000;
    case 'float':
      return Math.fround(v / 4 - 7.5);
    default:
      return v / 8 + 0.0625;
  }
}

/** A minimal CDF encoder: {version, numrecs, dims:[[name,len]], gatts, vars:[{name,type,dims,atts,data(i)→value}]}. */
function encodeCdf(f) {
  const v = f.version;
  const out = [];
  let len = 0;
  const push = (u8) => {
    out.push(u8);
    len += u8.length;
  };
  const u32 = (x) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, x);
    push(b);
  };
  const u64 = (x) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(x));
    push(b);
  };
  const count = (x) => (v === 5 ? u64(x) : u32(x));
  const pad = () => {
    if (len % 4) push(new Uint8Array(4 - (len % 4)));
  };
  const name = (s) => {
    const b = new TextEncoder().encode(s);
    count(b.length);
    push(b);
    pad();
  };
  const val = (t, x) => {
    const [, sz] = TYPES[t];
    const b = new Uint8Array(sz);
    const dv = new DataView(b.buffer);
    ({ byte: () => dv.setInt8(0, x), char: () => dv.setUint8(0, x), ubyte: () => dv.setUint8(0, x), short: () => dv.setInt16(0, x), ushort: () => dv.setUint16(0, x), int: () => dv.setInt32(0, x), uint: () => dv.setUint32(0, x), float: () => dv.setFloat32(0, x), double: () => dv.setFloat64(0, x), int64: () => dv.setBigInt64(0, BigInt(x)), uint64: () => dv.setBigUint64(0, BigInt(x)) })[t]();
    return b;
  };
  const atts = (list) => {
    if (!list?.length) {
      u32(0);
      count(0);
      return;
    }
    u32(0x0c);
    count(list.length);
    for (const [n, t, x] of list) {
      name(n);
      u32(TYPES[t][0]);
      if (t === 'char') {
        const b = new TextEncoder().encode(x);
        count(b.length);
        push(b);
      } else {
        const a = Array.isArray(x) ? x : [x];
        count(a.length);
        for (const y of a) push(val(t, y));
      }
      pad();
    }
  };
  const dimLen = (d) => (f.dims[d][1] === 0 ? f.numrecs : f.dims[d][1]);
  const isRec = (x) => x.dims.length && f.dims[x.dims[0]][1] === 0;
  const per = (x) => x.dims.slice(isRec(x) ? 1 : 0).reduce((a, d) => a * dimLen(d), 1) * TYPES[x.type][1];
  const header = (begins) => {
    out.length = 0;
    len = 0;
    push(new Uint8Array([0x43, 0x44, 0x46, v]));
    count(f.numrecs);
    u32(0x0a);
    count(f.dims.length);
    for (const [n, l] of f.dims) {
      name(n);
      count(l);
    }
    atts(f.gatts);
    u32(0x0b);
    count(f.vars.length);
    f.vars.forEach((x, i) => {
      name(x.name);
      count(x.dims.length);
      for (const d of x.dims) count(d);
      atts(x.atts);
      u32(TYPES[x.type][0]);
      count((per(x) + 3) & ~3);
      if (v === 1) u32(begins[i]);
      else u64(begins[i]);
    });
    return len;
  };
  const hl = header(f.vars.map(() => 0));
  const begins = [];
  let off = hl;
  f.vars.forEach((x, i) => {
    if (!isRec(x)) {
      begins[i] = off;
      off += (per(x) + 3) & ~3;
    }
  });
  const recs = f.vars.filter(isRec);
  let rs = 0;
  f.vars.forEach((x, i) => {
    if (isRec(x)) {
      begins[i] = off + rs;
      rs += recs.length === 1 ? per(x) : (per(x) + 3) & ~3;
    }
  });
  header(begins);
  const body = (x, from, n) => {
    for (let i = 0; i < n; i++) push(val(x.type, x.data(from + i)));
  };
  for (const x of f.vars.filter((y) => !isRec(y))) {
    body(x, 0, per(x) / TYPES[x.type][1]);
    pad();
  }
  for (let r = 0; r < f.numrecs; r++) {
    for (const x of recs) {
      const n = per(x) / TYPES[x.type][1];
      body(x, r * n, n);
      if (recs.length > 1) pad();
    }
  }
  const all = new Uint8Array(len);
  let p = 0;
  for (const u of out) {
    all.set(u, p);
    p += u.length;
  }
  return all;
}

const lin = (n, a, d) => (i) => a + i * d;
/** A grid variable over dims [lead…, y, x] filled from value(). */
const grid = (name, type, dims, shape, atts, map = (x) => x) => {
  const [H, W] = shape.slice(-2);
  return { name, type, dims, atts, data: (i) => map(value(type, Math.floor(i / (W * H)), Math.floor(i / W) % H, i % W)) };
};

function netcdfFixtures() {
  const wgs = [['semi_major_axis', 'double', 6378137], ['inverse_flattening', 'double', 298.257223563]];
  return [
    {
      file: 'nc_cdf1_utm_byte.nc',
      version: 1,
      numrecs: 0,
      dims: [['y', 40], ['x', 60]],
      gatts: [['Conventions', 'char', 'CF-1.8']],
      vars: [
        { name: 'transverse_mercator', type: 'char', dims: [], atts: [['grid_mapping_name', 'char', 'transverse_mercator'], ['longitude_of_central_meridian', 'double', -117], ['latitude_of_projection_origin', 'double', 0], ['scale_factor_at_central_meridian', 'double', 0.9996], ['false_easting', 'double', 500000], ['false_northing', 'double', 0], ...wgs], data: () => 0 },
        { name: 'x', type: 'double', dims: [1], atts: [['standard_name', 'char', 'projection_x_coordinate'], ['units', 'char', 'm']], data: lin(60, 440735, 30) },
        // South-up rows (y increasing), as GDAL writes NetCDF.
        { name: 'y', type: 'double', dims: [0], atts: [['standard_name', 'char', 'projection_y_coordinate'], ['units', 'char', 'm']], data: lin(40, 3750135, 30) },
        grid('Band1', 'byte', [0, 1], [40, 60], [['_Unsigned', 'char', 'true'], ['grid_mapping', 'char', 'transverse_mercator'], ['_FillValue', 'byte', -1]], (v) => v),
      ],
      expect: { w: 60, h: 40, bands: 1, epsg: 32611 },
    },
    {
      file: 'nc_cdf2_lcc_records.nc',
      version: 2,
      numrecs: 3,
      dims: [['time', 0], ['y', 25], ['x', 33]],
      gatts: [['Conventions', 'char', 'CF-1.8'], ['title', 'char', 'FX-21 LCC 2SP record variables']],
      vars: [
        { name: 'lcc', type: 'int', dims: [], atts: [['grid_mapping_name', 'char', 'lambert_conformal_conic'], ['standard_parallel', 'double', [33, 45]], ['longitude_of_central_meridian', 'double', -97], ['latitude_of_projection_origin', 'double', 40], ['false_easting', 'double', 0], ['false_northing', 'double', 0], ...wgs], data: () => 0 },
        { name: 'x', type: 'double', dims: [2], atts: [['standard_name', 'char', 'projection_x_coordinate'], ['units', 'char', 'km']], data: lin(33, -500, 12) },
        { name: 'y', type: 'double', dims: [1], atts: [['standard_name', 'char', 'projection_y_coordinate'], ['units', 'char', 'km']], data: lin(25, 300, -12) },
        { name: 'time', type: 'double', dims: [0], atts: [['units', 'char', 'hours since 2020-01-01 00:00:00'], ['standard_name', 'char', 'time']], data: lin(3, 0, 6) },
        grid('temp', 'float', [0, 1, 2], [25, 33], [['grid_mapping', 'char', 'lcc'], ['units', 'char', 'K'], ['_FillValue', 'float', -9999]]),
        grid('pres', 'short', [0, 1, 2], [25, 33], [['grid_mapping', 'char', 'lcc'], ['scale_factor', 'float', 0.01], ['add_offset', 'float', 1000]]),
      ],
      expect: { w: 33, h: 25, bands: 3, epsg: null },
    },
    {
      file: 'nc_cdf5_polar_types.nc',
      version: 5,
      numrecs: 2,
      dims: [['t', 0], ['yc', 20], ['xc', 30]],
      gatts: [['Conventions', 'char', 'CF-1.8']],
      vars: [
        { name: 'ps', type: 'int', dims: [], atts: [['grid_mapping_name', 'char', 'polar_stereographic'], ['straight_vertical_longitude_from_pole', 'double', -45], ['latitude_of_projection_origin', 'double', 90], ['standard_parallel', 'double', 70], ['false_easting', 'double', 0], ['false_northing', 'double', 0], ...wgs], data: () => 0 },
        { name: 'xc', type: 'double', dims: [2], atts: [['standard_name', 'char', 'projection_x_coordinate'], ['units', 'char', 'm']], data: lin(30, -1000000, 25000) },
        { name: 'yc', type: 'double', dims: [1], atts: [['standard_name', 'char', 'projection_y_coordinate'], ['units', 'char', 'm']], data: lin(20, -500000, 25000) },
        grid('u16', 'ushort', [0, 1, 2], [20, 30], [['grid_mapping', 'char', 'ps']]),
        grid('u32', 'uint', [0, 1, 2], [20, 30], [['grid_mapping', 'char', 'ps']]),
        grid('i64', 'int64', [1, 2], [20, 30], [['grid_mapping', 'char', 'ps']]),
        grid('u8', 'ubyte', [1, 2], [20, 30], [['grid_mapping', 'char', 'ps'], ['_FillValue', 'ubyte', 255]]),
      ],
      expect: { w: 30, h: 20, bands: 2, epsg: null },
    },
    {
      file: 'nc_cdf1_latlon_double.nc',
      version: 1,
      numrecs: 0,
      dims: [['lat', 18], ['lon', 36], ['level', 2]],
      gatts: [['Conventions', 'char', 'CF-1.8']],
      vars: [
        { name: 'lat', type: 'float', dims: [0], atts: [['units', 'char', 'degrees_north'], ['standard_name', 'char', 'latitude']], data: lin(18, 85, -10) },
        { name: 'lon', type: 'float', dims: [1], atts: [['units', 'char', 'degrees_east'], ['standard_name', 'char', 'longitude']], data: lin(36, -175, 10) },
        { name: 'level', type: 'int', dims: [2], atts: [['units', 'char', 'hPa']], data: (i) => [850, 500][i] },
        // Not CF order on purpose (lat, lon, level): only the last two dimensions are the grid, as GDAL
        // reads it; this variable is a 18-band 36 × 2 raster.
        grid('odd', 'short', [0, 1, 2], [36, 2], []),
        { name: 'z', type: 'double', dims: [0, 1], atts: [['_FillValue', 'double', NaN], ['units', 'char', 'm']], data: (i) => (i % 37 === 0 ? NaN : value('double', 0, Math.floor(i / 36), i % 36)) },
      ],
      expect: { w: 36, h: 18, bands: 1, epsg: 4326 },
    },
    {
      file: 'nc_cdf2_rotated.nc',
      version: 2,
      numrecs: 0,
      dims: [['rlat', 16], ['rlon', 24]],
      gatts: [['Conventions', 'char', 'CF-1.8']],
      vars: [
        { name: 'rotated_pole', type: 'char', dims: [], atts: [['grid_mapping_name', 'char', 'rotated_latitude_longitude'], ['grid_north_pole_latitude', 'double', 39.25], ['grid_north_pole_longitude', 'double', -162]], data: () => 0 },
        { name: 'rlon', type: 'double', dims: [1], atts: [['standard_name', 'char', 'grid_longitude'], ['units', 'char', 'degrees']], data: lin(24, -10, 0.5) },
        { name: 'rlat', type: 'double', dims: [0], atts: [['standard_name', 'char', 'grid_latitude'], ['units', 'char', 'degrees']], data: lin(16, -4, 0.5) },
        grid('tas', 'float', [0, 1], [16, 24], [['grid_mapping', 'char', 'rotated_pole'], ['units', 'char', 'K']]),
      ],
      expect: { w: 24, h: 16, bands: 1, epsg: null },
    },
  ];
}

function gdalinfo(p) {
  try {
    return JSON.parse(execFileSync(join(BIN, 'gdalinfo.exe'), ['-json', '-checksum', p], { env: GENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (e) {
    return { error: String(e.stderr ?? e.message).slice(0, 300) };
  }
}

export async function generate(outDir) {
  const made = [];
  const report = { generated: 'build/fixtures/fx21/raster.mjs', netcdf: [], hfa: [] };
  for (const f of netcdfFixtures()) {
    const p = join(outDir, f.file);
    writeFileSync(p, encodeCdf(f));
    made.push(p);
    report.netcdf.push({ file: f.file, version: f.version, expect: f.expect, vars: f.vars.filter((v) => v.dims.length >= 2).map((v) => ({ name: v.name, type: v.type })) });
  }
  const gdal = existsSync(PY);
  if (gdal) {
    const out = execFileSync(PY, ['-I', join(HERE, 'raster_hfa.py'), outDir], { env: GENV, encoding: 'utf8', maxBuffer: 1 << 26 });
    report.hfa = JSON.parse(out.slice(out.indexOf('[')));
    for (const h of report.hfa) made.push(join(outDir, h.file), ...h.sidecars.map((s) => join(outDir, s)));
    // GDAL's view of each NetCDF fixture (the independent check of the JS encoder).
    for (const n of report.netcdf) {
      const g = gdalinfo(join(outDir, n.file));
      n.gdal = g.error ? { error: g.error } : { w: g.size?.[0], h: g.size?.[1], bands: g.bands?.length ?? 0, subdatasets: Object.keys(g.metadata?.SUBDATASETS ?? {}).length / 2, epsg: g.stac?.['proj:epsg'] ?? null, checksum: (g.bands ?? []).map((b) => b.checksum) };
    }
  } else report.note = `gw-te environment not found at ${ENV}: HFA fixtures and the GDAL check were skipped`;
  writeFileSync(join(outDir, 'fx21-raster.json'), `${JSON.stringify(report, null, 1)}\n`);
  made.push(join(outDir, 'fx21-raster.json'));
  return made;
}
