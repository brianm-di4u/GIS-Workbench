// Build-time data blocks (PRD §8.3): the embedded EGM96 15′ geoid and the Natural Earth
// 1:110m basemap. Inputs are public-domain data from pinned packages and the research
// sample folder; outputs are deterministic bytes the inliner stores as gzip+base64.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { readShapefile } from '../app/src/formats/shapefile.js';

const require = createRequire(import.meta.url);

/** Decode the EGM96 15′ grid carried by egm96-universal (MIT; NGA public-domain data). */
export function egm96Grid() {
  const pkg = dirname(require.resolve('egm96-universal/package.json'));
  const js = readFileSync(join(pkg, 'dist', 'egm96-universal.cjs.js'), 'utf8');
  const m = /var data = "([A-Za-z0-9+/=]+)"/.exec(js);
  if (!m) throw new Error('egm96-universal: data block not found');
  const raw = Buffer.from(m[1], 'base64');
  if (raw.length !== 721 * 1440 * 2) throw new Error(`egm96-universal: unexpected size ${raw.length}`);
  return raw; // big-endian int16 cm, row 0 = 90°N, col 0 = 0°E
}

/** 2-D predictor residual (A + B − C) in two byte planes — must match gw-geodesy geoid.rs. */
export function encodePredicted(rawBE, width, height) {
  const n = width * height;
  const v = new Int16Array(n);
  for (let i = 0; i < n; i++) v[i] = (rawBE[2 * i] << 8) | rawBE[2 * i + 1];
  const out = new Uint8Array(2 * n);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      const a = c > 0 ? v[i - 1] : 0;
      const b = r > 0 ? v[i - width] : 0;
      const cc = r > 0 && c > 0 ? v[i - width - 1] : 0;
      const res = (v[i] - (a + b - cc)) << 16 >> 16;
      out[i] = res & 0xff;
      out[n + i] = (res >> 8) & 0xff;
    }
  }
  return out;
}

/** Natural Earth 1:110m countries → compact JSON: names + delta-encoded rings at 1e-4°. */
export function basemap(researchRoot) {
  const zip = join(researchRoot, 'samples', 'vector-naturalearth-110m', 'ne_110m_admin_0_countries.zip');
  if (!existsSync(zip)) return null;
  const files = {};
  for (const [name, bytes] of Object.entries(unzipSync(readFileSync(zip)))) {
    const ext = name.split('.').pop().toLowerCase();
    files[ext] = bytes;
  }
  const { features } = readShapefile(files);
  const Q = 1e4;
  const countries = [];
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    const rings = [];
    for (const p of polys) {
      for (const ring of p) {
        const enc = [];
        let px = 0;
        let py = 0;
        for (const [x, y] of ring) {
          const qx = Math.round(x * Q);
          const qy = Math.round(y * Q);
          enc.push(qx - px, qy - py);
          px = qx;
          py = qy;
        }
        rings.push(enc);
      }
    }
    const p = f.properties;
    countries.push({ n: p.NAME ?? p.ADMIN ?? '', a: p.ISO_A3 ?? '', r: rings });
  }
  return JSON.stringify({ v: 1, source: 'Natural Earth 1:110m admin 0 countries (public domain)', q: Q, countries });
}

/** Write the decoded geoid for the Rust geoid test (fixtures/data is generated, not shipped). */
export function writeGeoidFixture(root) {
  const out = join(root, 'fixtures', 'data', 'egm96-15.i16be');
  if (existsSync(out)) return;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, egm96Grid());
}
