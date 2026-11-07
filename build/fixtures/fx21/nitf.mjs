// FX-21 nitf group (SDP-2.1 §4 P9): synthetic inputs for the 2.1 NITF/RPF/legacy-codec readers.
//   - rpf-cadrg-z2/RPF and rpf-cib-z3/RPF (not generated here): CADRG and CIB frames with their A.TOC,
//     kept as committed files for the readers
//   - poc_lrcp_rpcl.j2k: a JPEG 2000 codestream with a progression order change (opj_compress -POC)
//   - ojpeg_ycbcr.tif: TIFF compression 6 (JPEGInterchangeFormat + SOS strip), YCbCr 2 × 2
//   - aridpcm_075.ntf / aridpcm_450.ntf: NITF IC=M2 ARIDPCM at 0.75 and 4.50 bpp (8-bit)
//   - footprint_mg3.sid + .sdw, footprint_v2.ecw + .eww: header-only MrSID/ECW stand-ins
// Needs the Rust `legacy` WASM build (cargo target dir) and, for POC/OJPEG, the gw-te tools
// (opj_compress, gdal_translate); those fixtures are skipped without them. Returns the files.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOLS = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library';
const tool = (n) => join(TOOLS, 'bin', `${n}.exe`);
const env = { ...process.env, PATH: `${TOOLS}/bin;${process.env.PATH}`, GDAL_DATA: `${TOOLS}/share/gdal`, PROJ_DATA: `${TOOLS}/share/proj` };

function legacyBundle() {
  const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: join(ROOT, 'crates'), encoding: 'utf8' })).target_directory;
  const p = join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_legacy.wasm');
  if (!existsSync(p)) throw new Error(`build the legacy bundle first (${p})`);
  return readFileSync(p);
}

/** Deterministic synthetic scene: gradients, rings and a grid (values 0–255). */
function scene(w, h, k = 0) {
  const r = new Uint8Array(w * h);
  const g = new Uint8Array(w * h);
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.hypot(x - w / 2, y - h / 2);
      r[i] = (x * 255) / w;
      g[i] = 128 + 100 * Math.sin(d / (20 + k * 5));
      b[i] = (x % 128 < 4 || y % 128 < 4 ? 250 : (y * 255) / h) ^ (k * 37);
    }
  return [r, g, b];
}

export async function generate(outDir) {
  const { Bundle } = await import(pathToFileURL(join(ROOT, 'app/src/wasm/abi.js')).href);
  const { writeNitf } = await import(pathToFileURL(join(ROOT, 'app/src/formats/nitf-writer.js')).href);
  const { aridpcmEncode } = await import(pathToFileURL(join(ROOT, 'app/src/workers/decode/nitf-writers.js')).href);
  const legacy = new Bundle(new WebAssembly.Module(legacyBundle()), 'legacy');
  const made = [];
  const put = (rel, bytes) => {
    const p = join(outDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, bytes);
    made.push(rel);
  };
  const N = 1536;

  // 1. ARIDPCM NITF (IC=M2) at the published rate (0.75) and a derived-table rate (4.50).
  const [r] = scene(512, 384, 2);
  for (const comrat of ['0.75', '4.50']) {
    const ar = aridpcmEncode(legacy, { px: r, width: 512, height: 384, nbpp: 8, comrat });
    const corners = [[34.6, 11.2], [34.6, 11.3], [34.5, 11.3], [34.5, 11.2]];
    put(`aridpcm_${comrat.replace('.', '')}.ntf`, writeNitf({ width: 512, height: 384, bands: 1, type: 'u8', planes: [r] }, { irep: 'MONO', iid1: 'FX21ARID', title: `FX-21 ARIDPCM ${comrat}`, corners, aridpcm: { ...ar, comrat } }));
  }

  // 2. MrSID MG3 and ECW v2 header-only stand-ins (no codestream), with world files.
  const rec = (key, type, val) => {
    const k = new TextEncoder().encode(key);
    const b = new Uint8Array(4 + k.length + 1 + 16 + val.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, k.length + 16);
    b.set(k, 4);
    [type, val.length / ({ 2: 2, 3: 4, 7: 8 }[type] ?? 1), 1, 1].forEach((v, i) => dv.setUint32(4 + k.length + 1 + 4 * i, v));
    b.set(val, 4 + k.length + 1 + 16);
    return b;
  };
  const be = (n, bytes, set) => {
    const u = new Uint8Array(bytes);
    set(new DataView(u.buffer), n);
    return u;
  };
  const sid = [new TextEncoder().encode('msid'), new Uint8Array([3]), new Uint8Array(75)];
  sid.push(rec('IMAGE::WIDTH', 3, be(4000, 4, (d, v) => d.setUint32(0, v))));
  sid.push(rec('IMAGE::HEIGHT', 3, be(3000, 4, (d, v) => d.setUint32(0, v))));
  const xy = new Uint8Array(16);
  new DataView(xy.buffer).setFloat64(0, 500000.5);
  new DataView(xy.buffer).setFloat64(8, 4500000.5 - 1);
  sid.push(rec('IMAGE::XY_ORIGIN', 7, xy));
  sid.push(rec('IMAGE::X_RESOLUTION', 7, be(1, 8, (d, v) => d.setFloat64(0, v))));
  sid.push(rec('IMAGE::Y_RESOLUTION', 7, be(1, 8, (d, v) => d.setFloat64(0, v))));
  sid.push(rec('GEOTIFF_NUM::3072::ProjectedCSTypeGeoKey', 2, be(32633, 2, (d, v) => d.setUint16(0, v))));
  const sidBytes = new Uint8Array(sid.reduce((t, a) => t + a.length, 0));
  sid.reduce((at, a) => (sidBytes.set(a, at), at + a.length), 0);
  put('footprint_mg3.sid', sidBytes);
  put('footprint_mg3.sdw', '1.0\n0.0\n0.0\n-1.0\n500000.5\n4499999.5\n');
  const ecw = new Uint8Array(120);
  const ed = new DataView(ecw.buffer);
  ecw.set([0x65, 2, 1, 2, 4, 4]);
  ed.setUint32(6, 2048);
  ed.setUint32(10, 1024);
  ed.setUint16(14, 3);
  ed.setUint16(16, 1);
  ed.setUint16(18, 64);
  ed.setUint16(20, 64);
  ed.setUint16(22, 20);
  ecw[24] = 1;
  [2, -2, 300000, 5000000].forEach((v, i) => ed.setFloat64(25 + 8 * i, v, true));
  ecw.set(new TextEncoder().encode('WGS84'), 57);
  ecw.set(new TextEncoder().encode('NUTM33'), 73);
  put('footprint_v2.ecw', ecw);
  put('footprint_v2.eww', '2.0\n0.0\n0.0\n-2.0\n300001.0\n4999999.0\n');

  // 4. POC J2K and old-style JPEG TIFF through the gw-te tools (skipped without them).
  if (existsSync(tool('opj_compress')) && existsSync(tool('gdal_translate'))) {
    const tmp = join(outDir, '_tmp');
    mkdirSync(tmp, { recursive: true });
    const pgm = join(tmp, 'g.pgm');
    const [gr] = scene(256, 256, 1);
    writeFileSync(pgm, Buffer.concat([Buffer.from('P5\n256 256\n255\n'), Buffer.from(gr)]));
    execFileSync(tool('opj_compress'), ['-i', pgm, '-o', join(outDir, 'poc_lrcp_rpcl.j2k'), '-n', '4', '-r', '20,5,1', '-POC', 'T1=0,0,2,4,1,LRCP/T1=0,0,3,4,1,RPCL'], { env, stdio: 'ignore' });
    made.push('poc_lrcp_rpcl.j2k');
    // OJPEG: a baseline YCbCr (2 × 2) JPEG's header as JPEGInterchangeFormat, its SOS and scan as the
    // one strip (the layout of libtiff's ojpeg_chewey sample).
    const ppm = join(tmp, 'c.ppm');
    const [cr, cg, cb] = scene(256, 256, 3);
    const rgb = Buffer.alloc(256 * 256 * 3);
    for (let i = 0; i < 256 * 256; i++) (rgb[3 * i] = cr[i]), (rgb[3 * i + 1] = cg[i]), (rgb[3 * i + 2] = cb[i]);
    writeFileSync(ppm, Buffer.concat([Buffer.from('P6\n256 256\n255\n'), rgb]));
    const jpg = join(tmp, 'c.jpg');
    execFileSync(tool('gdal_translate'), ['-q', '-of', 'JPEG', '-co', 'QUALITY=90', ppm, jpg], { env });
    const j = readFileSync(jpg);
    const sos = j.indexOf(Buffer.from([0xff, 0xda]));
    const hdr = j.subarray(0, sos);
    const strip = j.subarray(sos);
    // [tag, type, count, value] (value: inline, or the offset of an array placed after the IFD)
    const tags = [[256, 3, 1, 256], [257, 3, 1, 256], [258, 3, 3, 0], [259, 3, 1, 6], [262, 3, 1, 6], [273, 4, 1, 0], [277, 3, 1, 3], [278, 3, 1, 256], [279, 4, 1, strip.length], [284, 3, 1, 1], [512, 3, 1, 1], [513, 4, 1, 0], [514, 4, 1, hdr.length], [530, 3, 2, 0]];
    const ifdLen = 2 + 12 * tags.length + 4;
    const bpsAt = 8 + ifdLen;
    const hdrAt = bpsAt + 6;
    const stripAt = hdrAt + hdr.length;
    tags.find((t) => t[0] === 258)[3] = bpsAt;
    tags.find((t) => t[0] === 273)[3] = stripAt;
    tags.find((t) => t[0] === 513)[3] = hdrAt;
    const tif = Buffer.alloc(stripAt + strip.length);
    tif.write('II', 0);
    tif.writeUInt16LE(42, 2);
    tif.writeUInt32LE(8, 4);
    tif.writeUInt16LE(tags.length, 8);
    tags.forEach(([tag, type, count, v], i) => {
      const o = 10 + 12 * i;
      tif.writeUInt16LE(tag, o);
      tif.writeUInt16LE(type, o + 2);
      tif.writeUInt32LE(count, o + 4);
      if (tag === 530) (tif.writeUInt16LE(2, o + 8), tif.writeUInt16LE(2, o + 10));
      else if (type === 3 && count === 1) tif.writeUInt16LE(v, o + 8);
      else tif.writeUInt32LE(v, o + 8);
    });
    [8, 8, 8].forEach((v, i) => tif.writeUInt16LE(v, bpsAt + 2 * i));
    hdr.copy(tif, hdrAt);
    strip.copy(tif, stripAt);
    put('ojpeg_ycbcr.tif', tif);
    rmSync(tmp, { recursive: true, force: true });
  }
  return made;
}
