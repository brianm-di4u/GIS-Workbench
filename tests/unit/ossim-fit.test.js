// REQ-GAP-21: the RPC fitted to OSSIM's rigorous RADARSAT-2 model, measured with no browser. The tool
// samples the model, the photo bundle fits, and the RPC is evaluated here by its published formula,
// so the wasm's own evaluator is not part of the check. Two oracles: OSSIM's ground-to-image, the
// plain call, and the geolocation grid in the vendor's product.xml. Needs the ossim module
// (GWB_SIDECAR_MODULES, or the dev bundle), the corpus (TE_CORPUS) and CARGO_TARGET_DIR.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

vi.mock('../../app/src/shell/dialogs.js', () => ({ modal: vi.fn(), field: vi.fn() }));
vi.mock('../../app/src/shell/dom.js', () => ({ h: vi.fn(), fmtNum: (v) => String(v) }));
const { sampleJob } = await import('../../app/src/features/ossim.js');
const { Photo } = await import('../../app/src/wasm/photo.js');

const LINUX = process.platform === 'linux';
const MOD = join(process.env.GWB_SIDECAR_MODULES ?? 'D:/gwb-sidecar-deps/bundle/modules', 'ossim');
const TOOL = join(MOD, 'bin', LINUX ? 'gwb-ossim-model' : 'gwb-ossim-model.exe');
const RS2 = join(process.env.TE_CORPUS ?? 'D:/TE-corpus', 'sar-radarsat2-quadpol-slc-samples');
const WASM = join(process.env.CARGO_TARGET_DIR ?? 'target', 'wasm32-unknown-unknown', 'release', 'gw_bundle_photo.wasm');
const SCENES = { SQ1: 'RS2_OK153952_PK1408403_DK1372522_SQ1_20231119_053723_HH_VV_HV_VH_SLC', FQ17: 'RS2_OK153952_PK1408399_DK1372518_FQ17_20150626_052324_HH_VV_HV_VH_SLC' };
const ready = existsSync(TOOL) && existsSync(WASM) && existsSync(RS2);
const env = { ...process.env, GWB_OSSIM_PLUGINS: join(MOD, LINUX ? 'lib/plugins' : 'plugins'), LD_LIBRARY_PATH: join(MOD, 'lib'), PATH: `${join(MOD, 'bin')}${delimiter}${process.env.PATH}` };

/** RPC00B by its formula: corner-origin image position of (lat, lon, h). */
function rpcG2i(r, lat, lon, h) {
  const [p, l, z] = [(lat - r[4]) / r[9], (lon - r[5]) / r[10], (h - r[6]) / r[11]];
  const t = [1, l, p, z, l * p, l * z, p * z, l * l, p * p, z * z, p * l * z, l * l * l, l * p * p, l * z * z, l * l * p, p * p * p, p * z * z, l * l * z, p * p * z, z * z * z];
  const sum = (o) => t.reduce((a, v, i) => a + v * r[o + i], 0);
  return [(sum(52) / sum(72)) * r[8] + r[3] + 0.5, (sum(12) / sum(32)) * r[7] + r[2] + 0.5];
}

function tiePoints(file) {
  const x = readFileSync(file, 'utf8');
  return [...x.matchAll(/<imageTiePoint>([\s\S]*?)<\/imageTiePoint>/g)].map(([, b]) => ['line', 'pixel', 'latitude', 'longitude', 'height'].map((k) => Number(new RegExp(`<${k}[^>]*>([^<]+)<`).exec(b)[1])));
}

const stats = (d) => ({ n: d.length, rms: Math.sqrt(d.reduce((a, x) => a + x * x, 0) / d.length), max: Math.max(...d) });

describe.skipIf(!ready)('REQ-GAP-21 an RPC fitted to OSSIM on RADARSAT-2', () => {
  const photo = ready ? new Photo(new WebAssembly.Module(readFileSync(WASM))) : null;
  for (const [name, dir, wide] of Object.entries(SCENES).flatMap(([n, d]) => [[n, d, false], [`${n}, the dialog's default heights`, d, true]])) {
    it(`${name}: follows OSSIM, and the vendor's grid as closely as OSSIM does`, { timeout: 180_000 }, () => {
      const product = join(RS2, dir, 'product.xml');
      const ties = tiePoints(product);
      const hs = ties.map((t) => t[4]);
      mkdirSync('test-results', { recursive: true });
      const work = mkdtempSync(join('test-results', 'ossim-fit-'));
      try {
        const out = join(work, 'g.json');
        const [h0, h1] = wide ? [-100, 3000] : [Math.floor(Math.min(...hs) - 100), Math.ceil(Math.max(...hs) + 400)];
        execFileSync(TOOL, ['grid', '--h-min', String(h0), '--h-max', String(h1), product, out], { env, stdio: 'ignore', timeout: 170_000 });
        const grid = JSON.parse(readFileSync(out, 'utf8'));
        expect(grid.model).toBe('ossimRadarSat2Model');
        const fit = photo.fitRpcSamples(sampleJob(grid));
        const rec = fit.record;
        expect(fit.poleFree).toBe(true);
        // OSSIM's own ground-to-image at the vendor's ground points.
        const [inp, res] = [join(work, 'p.csv'), join(work, 'r.csv')];
        writeFileSync(inp, ties.map((t) => `${t[2]},${t[3]},${t[4]}`).join('\n'));
        execFileSync(TOOL, ['g2i', product, inp, res], { env, stdio: 'ignore', timeout: 170_000 });
        const os = readFileSync(res, 'utf8').trim().split('\n').map((l) => l.split(',').map(Number));
        const rpc = ties.map((t) => rpcG2i(rec, t[2], t[3], t[4]));
        const vendor = ties.map((t) => [t[1] + 0.5, t[0] + 0.5]);
        const dist = (a, b) => a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1]));
        const r = { fitRmsPx: fit.rmsPx, fitMaxPx: fit.maxPx, rpcVsOssim: stats(dist(rpc, os)), rpcVsVendor: stats(dist(rpc, vendor)), ossimVsVendor: stats(dist(os, vendor)), size: [grid.width, grid.height], hRange: grid.box.h };
        console.log(`ossim-fit ${name} ${JSON.stringify(r)}`);
        expect(fit.rmsPx).toBeLessThan(0.1);
        expect(r.rpcVsOssim.rms).toBeLessThan(0.5);
        // No claim of accuracy here: the fit may not move the answer away from the vendor's grid.
        expect(r.rpcVsVendor.rms).toBeLessThan(r.ossimVsVendor.rms + 0.5);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }
});
