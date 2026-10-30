// TE-C54 values against independent truth (2.0.4 campaign): for the stratified corpus, what the app
// reports is compared with the oracles' truth (TE-corpus/_truth, oracles/truth.py): raster band
// statistics against GDAL (the app's come from the level nearest 1024², so: mean within 1 % of the
// range, σ within 5 %, min/max inside GDAL's), vector feature counts and extents against OGR, and
// point counts and bounds against laspy. Layer sizes and band counts are c01's; geolocation is c20's.
//
//   TE_DIST=dist-cx5/gis-workbench.html TE_RUN=cx-oracle [TE_ONLY=<regex>]
//   npx playwright test -c playwright.campaign.config.js c54-oracles --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ASCII_CRS, truth } from './helpers.js';
import { cases, EXPECT, refusedKeys, ROBUST, stratify } from './cases.js';
import { session, recordWriter, outDir } from './cross-lib.js';

const RUN = process.env.TE_RUN ?? 'cx-oracle';
const OUT = outDir(RUN);
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;

const chosen = stratify(cases).filter((c) => (!ONLY || ONLY.test(`${c.it.id}/${c.f.name}`)) && c.files.every(existsSync) && !EXPECT[c.f.name.split('/').pop()]?.refuse && !refusedKeys(c.it, c.f).length && !ROBUST(c.it));

test.describe.configure({ mode: 'parallel' });
for (const c of chosen) {
  const name = c.f.name.split('/').pop();
  const key = `${c.it.id}/${c.f.name}`;
  const tf = truth(c.it.id)?.files;
  const t = tf?.[c.f.name] ?? tf?.[name];
  test(`TE-C54 REQ-FMT-16 REQ-LDR-01 REQ-EXT-21 ${key}`, async ({ page }, info) => {
    test.skip(!t || t.error, 'no oracle truth for this file');
    test.setTimeout(900_000);
    mkdirSync(OUT, { recursive: true });
    const rec = { spec: 'c54-oracles', project: info.project.name, key, item: c.it.id, file: name, kind: t.kind, checks: [] };
    const save = recordWriter(join(OUT, `c54-${info.project.name}-${key.replace(/[^\w.-]+/g, '_')}.json`), rec);
    const add = (what, ok, detail) => rec.checks.push({ what, ok: !!ok, detail });
    const s = await session(page, { files: c.files, epsg: ASCII_CRS[name] ?? null, setupSteps: [] });
    const o = await s.open();
    rec.open = { ok: o.ok, errors: o.errors };
    const app = await s.frame.evaluate(async () => {
      const a = window.gisworkbench;
      const out = { layers: [], vlayers: [], cloud: null };
      for (const l of [...a.layers.values()].filter((x) => !x.error && x.handle).slice(0, 1)) {
        const bands = Array.from({ length: Math.min(l.bands, 12) }, (_, i) => i);
        const r = await a.pool.run('stats', { handle: l.handle, bands }, { affinity: l.affinity, timeout: 300000 }).catch((e) => ({ error: String(e.message) }));
        out.layers.push({ w: l.width, h: l.height, bands: l.bands, sar: !!l.info?.sar, palette: !!l.info?.palette, stats: r.bands ?? null, error: r.error ?? null });
      }
      for (const v of a.store.all('vlayer')) {
        const fs = a.store.all('feature').filter((f) => f.vlayer === v.id);
        let b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const f of fs) for (let i = 0; i < (f.geom?.xyz?.length ?? 0); i += 3) b = [Math.min(b[0], f.geom.xyz[i]), Math.min(b[1], f.geom.xyz[i + 1]), Math.max(b[2], f.geom.xyz[i]), Math.max(b[3], f.geom.xyz[i + 1])];
        out.vlayers.push({ name: v.name, features: fs.length, bbox: b });
      }
      const c = a.pc?.cloudOf?.();
      if (c) out.cloud = { n: c.n, streamed: !!c.streamed || !!c.copc };
      return out;
    });
    rec.app = app;
    if (t.kind === 'raster' && app.layers[0]?.stats && Array.isArray(t.stats) && !app.layers[0].sar && !app.layers[0].palette) {
      app.layers[0].stats.forEach((h, b) => {
        const g = t.stats[b];
        if (!g || !Number.isFinite(g.mean) || !h?.bins) return;
        // The app's statistics are a histogram: bin i holds values from min + i·binWidth.
        const a = histStats(h);
        const range = Math.max(1e-9, g.max - g.min);
        const am = a.mean;
        const as = a.std;
        if (Number.isFinite(am)) add(`band ${b + 1} mean`, Math.abs(am - g.mean) <= 0.01 * range + 1e-6, `${am} vs GDAL ${g.mean} (range ${range})`);
        if (Number.isFinite(as) && Number.isFinite(g.std)) add(`band ${b + 1} σ`, Math.abs(as - g.std) <= 0.05 * Math.max(g.std, 0.01 * range) + 1e-6, `${as} vs GDAL ${g.std}`);
        // Bins round values down to their bin: allow one bin width.
        if (Number.isFinite(a.min)) add(`band ${b + 1} min ≥ GDAL min`, a.min >= g.min - h.binWidth - 1e-6 * range, `${a.min} vs ${g.min}`);
        if (Number.isFinite(a.max)) add(`band ${b + 1} max ≤ GDAL max`, a.max <= g.max + h.binWidth + 1e-6 * range, `${a.max} vs ${g.max}`);
      });
    }
    if (t.kind === 'vector' && Array.isArray(t.layers)) {
      // Attribute-only tables (geometry type None) are not layers in the app.
      const ogr = t.layers.filter((l) => l.geomType !== 'None').reduce((n, l) => n + (l.features ?? 0), 0);
      const mine = app.vlayers.reduce((n, l) => n + l.features, 0);
      // Shapefile MultiPatch is skipped by design; GeometryCollections are split into features;
      // features with no geometry or a curve type are skipped with a note in the import log.
      const skipped = (o.warnings ?? []).some((w) => /skipped|not read|curve/i.test(w));
      if (app.vlayers.length) add('feature count', mine === ogr || (mine > ogr && t.layers.some((l) => /Collection/i.test(l.geomType ?? ''))) || (mine < ogr && skipped), `${mine} vs OGR ${ogr}${skipped ? ' (skips noted)' : ''}`);
      const ext = t.layers.map((l) => l.extent).filter((e) => Array.isArray(e) && e.length === 4 && t.layers[0].epsg === '4326');
      if (ext.length && app.vlayers.length) {
        const ob = [Math.min(...ext.map((e) => e[0])), Math.min(...ext.map((e) => e[2])), Math.max(...ext.map((e) => e[1])), Math.max(...ext.map((e) => e[3]))];
        const ab = app.vlayers.reduce((b, l) => [Math.min(b[0], l.bbox[0]), Math.min(b[1], l.bbox[1]), Math.max(b[2], l.bbox[2]), Math.max(b[3], l.bbox[3])], [Infinity, Infinity, -Infinity, -Infinity]);
        add('extent (WGS 84)', ob.every((v, i) => Math.abs(v - ab[i]) <= 1e-6 + 1e-7 * Math.abs(v)), `${ab.map((x) => x.toFixed(6))} vs OGR ${ob.map((x) => x.toFixed(6))}`);
      }
    }
    if (t.kind === 'lidar' && app.cloud && !app.cloud.streamed && !t.copc) add('point count', app.cloud.n === t.points, `${app.cloud.n} vs laspy ${t.points}`);
    save();
    const bad = rec.checks.filter((x) => !x.ok).map((x) => `${x.what}: ${x.detail}`);
    expect(bad, `${key}: values match the independent readers`).toEqual([]);
  });
}

/** Mean, σ, min and max of an app histogram {min, binWidth, bins: {i: count}} (bin centres). */
function histStats(h) {
  let n = 0;
  let s = 0;
  let s2 = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const [k, c] of Object.entries(h.bins)) {
    if (!c) continue;
    const v0 = (h.min ?? h.offset ?? 0) + Number(k) * h.binWidth;
    const v = h.binWidth === 1 && /^[ui]/.test(h.type ?? '') ? v0 : v0 + h.binWidth / 2;
    n += c;
    s += c * v;
    s2 += c * v * v;
    lo = Math.min(lo, v0);
    hi = Math.max(hi, v0 + (h.binWidth === 1 ? 0 : h.binWidth));
  }
  const mean = s / n;
  return { mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)), min: lo, max: hi, n };
}
