// TE-C31 Phase 4 — products from real imagery, checked independently (REQ-PRD-01/10, REQ-FMT-05,
// AT-01.4): source chips (GeoTIFF with RPC or geotransform, NITF 2.1 with RPC00B/ICHIPB) and
// display chips (PNG + world file) are written, described by GDAL (oracles/products.py), then
// reopened in a fresh app — the app's geolocation of each product must match GDAL's reading of
// the same file, so the writers' RPC / ICHIPB / geotransform / world-file metadata are proven.
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openApp, openFiles, settledAny, record, item, paths, CORPUS } from './helpers.js';
import { REPO } from '../../build/campaign/corpus-lib.mjs';

const SOURCES = [
  ['rs-nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf', ['tif-source', 'nitf-source', 'png']],
  ['eo-maxar-libya-floods-wv3-prepost', '1040010087AB7E00-ms.tif', ['tif-source', 'png']],
  ['s2-l1c-jp2-safe-10seh-20240816', 'T10SEH_20240816T184919_B04.jp2', ['tif-source', 'png']],
  ['naip-ca-m3812157-sw-2022', null, ['tif-source', 'png']],
];
const OUT = join(CORPUS, '_products');
const MAMBA = join(REPO, '..', 'TE-tools', 'micromamba.exe');

const metres = (a, b) => 6378137 * Math.hypot(((b.lat - a.lat) * Math.PI) / 180, (((b.lon - a.lon) * Math.PI) / 180) * Math.cos((a.lat * Math.PI) / 180));

test.describe.configure({ mode: 'serial', timeout: 900_000 });

for (const [id, name, fmts] of SOURCES) {
  test(`TE-C31 REQ-PRD-01 REQ-PRD-10 REQ-FMT-05 products from ${id} reopen with GDAL-consistent geolocation`, async ({ page, browser }, info) => {
    let it;
    try {
      it = item(id);
    } catch {
      test.skip(true, 'item not in corpus');
    }
    const src = paths(it, ['primary']).find((p) => (name ? p.endsWith(name) : /\.(tif|ntf)$/i.test(p)));
    test.skip(!src || !existsSync(src), 'not on disk');
    const dir = join(OUT, info.project.name, id); // per browser: projects run in parallel
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // 1. Write products from a centred, slightly rotated view.
    const { frame, logs } = await openApp(page, 'file');
    await openFiles(frame, [src]);
    await settledAny(frame);
    const written = await frame.evaluate(async (fmts) => {
      const app = window.gisworkbench;
      const l = [...app.layers.values()].find((x) => x.modelId);
      app.activePane().setView({ cx: l.width / 2, cy: l.height / 2, zoom: Math.min(1, 900 / l.width), rot: 0.2, mode: 'native' });
      await new Promise((r) => setTimeout(r, 300));
      const out = [];
      for (const fmt of fmts) {
        const chip = await app.makeChip({ width: 800, height: 600 });
        const p = await app.encodeProduct(chip, fmt);
        const u8 = new Uint8Array(await p.blob.arrayBuffer());
        let s = '';
        for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
        out.push({ fmt, name: p.name, b64: btoa(s), corners: chip.record.cornersGround });
      }
      return out;
    }, fmts);
    for (const w of written) writeFileSync(join(dir, w.name), Buffer.from(w.b64, 'base64'));
    expect(logs).toEqual([]);
    // 2. GDAL describes what was written.
    execFileSync(MAMBA, ['run', '-n', 'gw-te', 'python', '-I', join(REPO, 'build/campaign/oracles/products.py'), dir], { env: { ...process.env, MAMBA_ROOT_PREFIX: join(REPO, '..', 'TE-tools', 'mamba') }, stdio: 'pipe', timeout: 300_000 });
    const T = JSON.parse(readFileSync(join(dir, '_products_truth.json'), 'utf8'));
    // 3. Reopen each raster product in a fresh app; compare with GDAL at its RPC grid or corners.
    const results = [];
    for (const [rel, f] of Object.entries(T)) {
      if (f.kind !== 'raster') {
        results.push({ rel, error: f.error ?? null });
        continue;
      }
      const pts = Array.isArray(f.rpcGrid) && f.rpcGrid.length ? f.rpcGrid.map((p) => ({ x: p.x, y: p.y, h: p.h, lat: p.lat, lon: p.lon })) : f.corners ? ['ul', 'ur', 'lr', 'll', 'c'].map((k, i) => ({ x: [0, f.width, f.width, 0, f.width / 2][i], y: [0, 0, f.height, f.height, f.height / 2][i], h: 0, lat: f.corners[k][0], lon: f.corners[k][1] })) : null;
      if (!pts) {
        results.push({ rel, error: 'GDAL finds no georeferencing in the product' });
        continue;
      }
      const ctx = await browser.newContext();
      const pg = await ctx.newPage();
      const { frame: f2, logs: l2 } = await openApp(pg, 'file');
      const base = join(dir, rel);
      const side = ['.pgw', '.jgw', '.prj', '.tfw'].map((e) => base.replace(/\.[^.]+$/, e)).filter(existsSync);
      await openFiles(f2, [base, ...side]);
      await settledAny(f2);
      const got = await f2.evaluate((pp) => {
        const a = window.gisworkbench;
        const l = [...a.layers.values()].find((x) => x.modelId);
        if (!l) return { error: 'no model on reopen' };
        return { model: l.modelName, g: pp.map((p) => a.core.i2g(l.modelId, p.x, p.y, p.h)) };
      }, pts);
      await ctx.close();
      const max = got.g ? Math.max(...got.g.map((g, i) => metres(g, pts[i]))) : Infinity;
      const gsd = f.geotransform ? Math.abs(f.geotransform[1]) * (Math.abs(f.geotransform[1]) < 0.1 ? 111320 : 1) : null;
      results.push({ rel, model: got.model ?? null, error: got.error ?? null, maxM: max, gsd, rpc: !!f.rpc, logs: l2 });
    }
    record('c31-products', info.project.name, { key: id, written: written.map((w) => w.name), results });
    for (const r of results) {
      expect(r.error, `${r.rel} readable and georeferenced`).toBeNull();
      if (r.maxM !== undefined) expect(r.maxM, `${r.rel}: app vs GDAL geolocation (m), model ${r.model}`).toBeLessThanOrEqual(Math.max(0.1, 0.5 * (r.gsd ?? 0.5)));
      expect(r.logs ?? []).toEqual([]);
    }
  });
}
