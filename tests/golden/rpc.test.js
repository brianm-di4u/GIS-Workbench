// Differential test (SDP §7): the WASM core's RPC00B ground↔image against an independent
// JavaScript oracle and the WV3 truth file. The truth rows/cols are GDAL pixel/line (corner
// origin), i.e. the raw RPC pixel-centre value + 0.5 — the same convention as the core.
// REQ-SNS-01 REQ-SNS-03 REQ-RUST-10.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { Core } from '../../app/src/wasm/core.js';

const DIST = 'dist/gis-workbench.html';
const TRUTH = '../Research/samples/nitf-wv3-mvs-stereo-chips/wv3_chips_truth.json';
const ready = existsSync(DIST) && existsSync(TRUTH);

export function loadCore() {
  const html = readFileSync(DIST, 'utf8');
  const manifest = JSON.parse(/<script type="application\/json" id="build-manifest">([\s\S]*?)<\/script>/.exec(html)[1]);
  const b64 = new RegExp('<script type="application/octet-stream" id="blk-wasm-core"[^>]*>([\\s\\S]*?)</script>').exec(html)[1];
  let u8 = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (manifest.blocks['wasm-core'].gz) u8 = gunzipSync(u8);
  return new Core(new WebAssembly.Module(u8));
}

// GDAL/RPC00B term order.
const terms = (P, L, H) => [1, L, P, H, L * P, L * H, P * H, L * L, P * P, H * H, P * L * H, L * L * L, L * P * P, L * H * H, L * L * P, P * P * P, P * H * H, L * L * H, P * P * H, H * H * H];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

/** Oracle: full-image (row, col) in the RPC pixel-centre convention. */
function oracle(r, lat, lon, h) {
  const t = terms((lat - r.lat_off) / r.lat_scale, (lon - r.long_off) / r.long_scale, (h - r.height_off) / r.height_scale);
  return {
    row: (dot(r.line_num_coeff, t) / dot(r.line_den_coeff, t)) * r.line_scale + r.line_off,
    col: (dot(r.samp_num_coeff, t) / dot(r.samp_den_coeff, t)) * r.samp_scale + r.samp_off,
  };
}

function record(r, chip) {
  const s = [r.err_bias ?? -1, r.err_rand ?? -1, r.line_off, r.samp_off, r.lat_off, r.long_off, r.height_off, r.line_scale, r.samp_scale, r.lat_scale, r.long_scale, r.height_scale];
  // ICHIPB as chip → full affine, corner origin on both sides.
  const aff = chip ? [chip.col0, 1, 0, chip.row0, 0, 1] : [0, 0, 0, 0, 0, 0];
  return [...s, ...r.line_num_coeff, ...r.line_den_coeff, ...r.samp_num_coeff, ...r.samp_den_coeff, ...aff];
}

describe.skipIf(!ready)('RPC00B differential: WASM core vs JS oracle vs WV3 truth', () => {
  let core;
  let truth;
  beforeAll(() => {
    core = loadCore();
    truth = JSON.parse(readFileSync(TRUTH, 'utf8'));
  });

  for (const name of ['wv3_a_chip.ntf', 'wv3_b_chip.ntf']) {
    it(`${name}: check points agree to 1e-6 px; inverse round-trips to 1e-9°`, () => {
      const c = truth.chips[name];
      const r = c.rpc_full_image;
      const full = core.rpcModel(record(r, null));
      const chip = core.rpcModel(record(r, c));
      try {
        for (const p of c.check_points) {
          const o = oracle(r, p.lat, p.lon, p.h_hae_m);
          expect(Math.abs(o.row + 0.5 - p.full_row)).toBeLessThan(1e-6);
          expect(Math.abs(o.col + 0.5 - p.full_col)).toBeLessThan(1e-6);
          // Core convention: corner origin, first pixel centre at 0.5.
          const f = core.g2i(full, p.lat, p.lon, p.h_hae_m);
          expect(Math.abs(f.y - p.full_row)).toBeLessThan(1e-6);
          expect(Math.abs(f.x - p.full_col)).toBeLessThan(1e-6);
          const q = core.g2i(chip, p.lat, p.lon, p.h_hae_m);
          expect(Math.abs(q.y - p.chip_row)).toBeLessThan(1e-6);
          expect(Math.abs(q.x - p.chip_col)).toBeLessThan(1e-6);
          const g = core.i2g(chip, q.x, q.y, p.h_hae_m);
          expect(Math.abs(g.lat - p.lat)).toBeLessThan(1e-9);
          expect(Math.abs(g.lon - p.lon)).toBeLessThan(1e-9);
        }
      } finally {
        core.freeModel(full);
        core.freeModel(chip);
      }
    });
  }

  it('parallax: raising the ground point 100 m moves it as the truth note says', () => {
    const exp = { 'wv3_a_chip.ntf': [-80.1, 102.3], 'wv3_b_chip.ntf': [99.2, 59.3] };
    for (const [name, [dr, dc]] of Object.entries(exp)) {
      const c = truth.chips[name];
      const m = core.rpcModel(record(c.rpc_full_image, c));
      const p = c.check_points[0];
      const a = core.g2i(m, p.lat, p.lon, p.h_hae_m);
      const b = core.g2i(m, p.lat, p.lon, p.h_hae_m + 100);
      core.freeModel(m);
      expect(Math.abs(b.y - a.y - dr)).toBeLessThan(0.1);
      expect(Math.abs(b.x - a.x - dc)).toBeLessThan(0.1);
    }
  });
});
