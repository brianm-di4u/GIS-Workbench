// 2.4 gap wave T0a, group terrsar (GR-13, GR-14):
// * REQ-GAP-37 bare earth in a polygon and Block Status; REQ-GAP-38 re-correlation inside a polygon
//   through the SGM path, with the edit log replayed by the Rust kernels (REQ-DEM-08), on FX-02
//   (stereo pair and its truth DSM);
// * REQ-GAP-40 polarimetric decomposition on the FX-07 quad-pol SICDs (Freeman–Durden, Yamaguchi,
//   H/A/α, Wishart, compact-pol), the Pauli composite unchanged;
// * the new dialogs pass axe.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fromArrayBuffer } from 'geotiff';
import { openApp, openFiles } from './helpers.js';

const FX02 = resolve('fixtures/fx02');
const truth02 = JSON.parse(readFileSync(resolve(FX02, 'fx02_truth.json'), 'utf8'));
const FX07 = resolve('fixtures/fx07');
const truth07 = JSON.parse(readFileSync(resolve(FX07, 'fx07_truth.json'), 'utf8'));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function axeOn(frame, sel) {
  return frame.evaluate(async ({ s, tags }) => (await window.axe.run(document.querySelector(s), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { s: sel, tags: AXE_TAGS });
}

async function truthDsm() {
  const b = readFileSync(resolve(FX02, 'fx02_dsm_truth.tif'));
  const tif = await fromArrayBuffer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const im = await tif.getImage();
  const [v] = await im.readRasters();
  const [x0, y0] = im.getOrigin();
  const [dx, dy] = im.getResolution();
  return { w: im.getWidth(), h: im.getHeight(), x0, y0, dx, dy, v: Array.from(v) };
}

test('REQ-GAP-37 REQ-GAP-38 REQ-DEM-08 FX-02 bare earth, re-correlation and Block Status on the Rust kernels', async ({ page }) => {
  test.setTimeout(600000);
  const T = await truthDsm();
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [...truth02.images.map((i) => resolve(FX02, i.file)), resolve(FX02, 'fx02_dsm_truth.tif')]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length === 3, null, { timeout: 90000 });
  await frame.evaluate(axeSource);
  const r = await frame.evaluate(
    async ({ boxes, flatAreas }) => {
      const app = window.gisworkbench;
      const all = [...app.layers.values()];
      const dsmL = all.find((l) => /dsm_truth/.test(l.rec.name));
      const pair = all.filter((l) => l !== dsmL).sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
      await app.useAsTerrain(dsmL, 'hae');
      const d = app.terrain.entry(dsmL.id);
      const p = app.activePane();
      app.store.transact('a', (tx) => tx.set(p.id, 'activeLayer', dsmL.id), { kind: 'load' });
      const E = app.demEdit;
      const g = d.grid;
      const src = d.grid.heights.slice();
      const H = () => E.heightsOf(d);
      const at = (lat, lon) => {
        const i = Math.round((lon - g.lon0) / g.dlon);
        const j = Math.round((g.lat0 - lat) / g.dlat);
        return j * g.width + i;
      };
      const mPerLat = 110950;
      const mPerLon = 111320 * Math.cos((g.lat0 * Math.PI) / 180);
      const square = (c, halfM) => [[c.lon - halfM / mPerLon, c.lat - halfM / mPerLat], [c.lon + halfM / mPerLon, c.lat - halfM / mPerLat], [c.lon + halfM / mPerLon, c.lat + halfM / mPerLat], [c.lon - halfM / mPerLon, c.lat + halfM / mPerLat]];
      // REQ-GAP-37 bare earth: a ring around box B05a (24 × 16 m, 5 m tall) with 8 m of margin.
      const b0 = boxes[0];
      const ringB = square(b0.roofCentre, Math.max(...b0.sizeM) / 2 + 8);
      const roofBefore = H()[at(b0.roofCentre.lat, b0.roofCentre.lon)];
      await E.edit('bareearth', { ring: ringB, maxWindowM: 40 });
      const engine = E.engine();
      const roofAfter = H()[at(b0.roofCentre.lat, b0.roofCentre.lon)];
      // Outside the ring nothing moved.
      let outside = 0;
      const h1 = H();
      for (let k = 0; k < src.length; k += 7) {
        const lon = g.lon0 + (k % g.width) * g.dlon;
        const lat = g.lat0 - Math.floor(k / g.width) * g.dlat;
        const inBox = lon > ringB[0][0] - g.dlon && lon < ringB[1][0] + g.dlon && lat > ringB[0][1] - g.dlat && lat < ringB[2][1] + g.dlat;
        if (!inBox && h1[k] !== src[k] && !(Number.isNaN(h1[k]) && Number.isNaN(src[k]))) outside++;
      }
      // REQ-GAP-38 re-correlation: a blunder (+8 m over a 70 m square on flat area 1), then the pair
      // is matched again inside the square.
      const fa = flatAreas[0].centre;
      const ringR = square(fa, 35);
      await E.edit('raise', { ring: ringR, dh: 8, feather: 0 });
      const inside = [];
      for (let j = 0; j < g.height; j++)
        for (let i = 0; i < g.width; i++) {
          const lon = g.lon0 + i * g.dlon;
          const lat = g.lat0 - j * g.dlat;
          if (lon > ringR[0][0] + g.dlon && lon < ringR[1][0] - g.dlon && lat > ringR[0][1] + g.dlat && lat < ringR[2][1] - g.dlat) inside.push(j * g.width + i);
        }
      const rmse = (arr) => Math.sqrt(inside.reduce((s, k) => s + (Number.isFinite(arr[k]) ? (arr[k] - src[k]) ** 2 : 0), 0) / inside.length);
      const blunder = rmse(H());
      const t0 = performance.now();
      const rc = await E.recorrelate(ringR, { pair });
      const rcMs = Math.round(performance.now() - t0);
      const after = rmse(H());
      const log = E.log(d).map((o) => o.kind);
      // Block Status: the edited blocks, a mark, its undo.
      const rows = await E.blocks(d);
      const edited = rows.filter((x) => x.edited > 0).map((x) => [x.tx, x.ty]);
      E.setBlockStatus([edited[0]], 'reviewed', d);
      const marked = (await E.blocks(d)).find((x) => x.tx === edited[0][0] && x.ty === edited[0][1]).status;
      app.undo.undo();
      const unmarked = (await E.blocks(d)).find((x) => x.tx === edited[0][0] && x.ty === edited[0][1]).status;
      // Undo the three edits: the source comes back exactly.
      for (let k = 0; k < 3; k++) app.undo.undo();
      await E.sync();
      const restored = H().every((v, k) => v === src[k] || (Number.isNaN(v) && Number.isNaN(src[k])));
      return { engine, roofBefore, roofAfter, base: b0.baseHae, outside, blunder, after, rc: { matched: rc.matched, patchPosts: rc.patchPosts, changed: rc.changed, inside: rc.inside, matcher: rc.stats.matcher, engine: rc.stats.engine }, rcMs, log, blocks: rows.length, edited: edited.length, marked, unmarked, restored };
    },
    { boxes: truth02.boxes, flatAreas: truth02.flatAreas },
  );
  console.log(JSON.stringify(r));
  expect(r.engine).toBe('rust');
  // The roof (5 m above the base) comes down to the ground.
  expect(r.roofBefore - r.base).toBeGreaterThan(4);
  expect(Math.abs(r.roofAfter - r.base)).toBeLessThan(1.5);
  expect(r.outside).toBe(0);
  // The blunder is 8 m; re-correlation brings the area back to the truth within 1.5 m RMSE
  // (3 × the 0.5 m GSD, the SCN-08 flat-area bound).
  expect(r.blunder).toBeGreaterThan(7.5);
  expect(r.after).toBeLessThan(1.5);
  expect(r.rc.changed / r.rc.inside).toBeGreaterThan(0.9);
  expect(r.log).toEqual(['bareearth', 'raise', 'recorrelate']);
  expect(r.edited).toBeGreaterThanOrEqual(1);
  expect(r.marked).toBe('reviewed');
  expect(r.unmarked).toBe('edited');
  expect(r.restored).toBe(true);
  // The dialogs: DEM Edit lists the new edits; Block Status shows the blocks; both pass axe.
  await frame.evaluate(() => void window.gisworkbench.commands.run('dem.edit'));
  const dlgE = frame.locator('[data-id="dialog:dem-edit"]');
  await expect(dlgE).toBeVisible();
  const opts = await dlgE.locator('select').first().locator('option').evaluateAll((os) => os.map((o) => o.value));
  expect(opts).toEqual(expect.arrayContaining(['bareearth', 'recorrelate']));
  expect(await axeOn(frame, '[data-id="dialog:dem-edit"]')).toEqual([]);
  await dlgE.getByRole('button', { name: 'Cancel' }).click();
  await frame.evaluate(() => void window.gisworkbench.commands.run('dem.blockstatus'));
  const dlgB = frame.locator('[data-id="dialog:dem-blocks"]');
  await expect(dlgB).toBeVisible();
  await expect(dlgB.locator('[data-id="dem:blocks"] tbody tr')).toHaveCount(r.blocks);
  expect(await axeOn(frame, '[data-id="dialog:dem-blocks"]')).toEqual([]);
  // Tick one block and mark it accepted through the dialog.
  await dlgB.locator('[data-id="dem:block:0:0"]').check();
  await dlgB.getByRole('button', { name: 'Mark Accepted' }).click();
  const st = await frame.evaluate(async () => (await window.gisworkbench.demEdit.blocks()).find((x) => x.tx === 0 && x.ty === 0).status);
  expect(st).toBe('accepted');
  expect(logs.filter((l) => l.type === 'error')).toEqual([]);
});

test('REQ-GAP-40 REQ-SAR-13 FX-07 polarimetric decomposition: Freeman–Durden, Yamaguchi, H/A/α, Wishart, compact-pol; Pauli unchanged', async ({ page }) => {
  test.setTimeout(300000);
  const { frame, logs } = await openApp(page, 'file');
  const quad = Object.values(truth07.quadPol.files).map((f) => resolve(FX07, f));
  await openFiles(frame, quad);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].filter((l) => l.modelId && l.lutTex).length === 3, null, { timeout: 120000 });
  await frame.evaluate(axeSource);
  const r = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const quads = [...app.layers.values()].filter((l) => /fx07_q/.test(l.rec.name));
    const sets = app.sar.polSets();
    const chip = { x0: 0, y0: 0, w: 512, h: 512 };
    const before = app.layers.size;
    const res = await app.sar.polsar(sets[0], { chip, filter: 'boxcar', win: 5, products: ['freeman', 'yamaguchi', 'haalpha', 'wishart'] });
    const opened = app.layers.size - before;
    const by = (nm) => res.products.find((p) => p.name.startsWith(nm)).planes;
    const at = (pl, x, y) => pl[y * 512 + x];
    const fd = by('Freeman');
    const y4 = by('Yamaguchi');
    const ha = by('H/A');
    const wi = by('H/alpha Wishart');
    const pts = { dih: [130, 130], vol: [330, 330] };
    const v = Object.fromEntries(Object.entries(pts).map(([k, [x, y]]) => [k, { ps: at(fd.Ps, x, y), pd: at(fd.Pd, x, y), pv: at(fd.Pv, x, y), yps: at(y4.Ps, x, y), ypd: at(y4.Pd, x, y), ypv: at(y4.Pv, x, y), H: at(ha.H, x, y), alpha: at(ha.alpha, x, y), cls: at(wi.class, x, y) }]));
    const classes = res.wishart.classes.length;
    const cp = await app.sar.polsar(sets[0], { chip, compact: true, products: ['halpha2'], open: false });
    const cpa = cp.products[0];
    const pa = await app.sar.pauli(quads, { chip });
    const paDih = [0, 1, 2].map((k) => pa.planes[k][130 * 512 + 130]);
    return { sets: sets.map((s) => s.kind), opened, v, classes, iterations: res.wishart.iterations, compact: { name: cpa.name, alphaDih: cpa.planes.alpha[130 * 512 + 130], Hvol: cpa.planes.H[330 * 512 + 330] }, paDih, ms: res.ms, enabled: app.commands.enabled('sar.polsar') };
  });
  console.log(JSON.stringify(r));
  expect(r.sets).toEqual(['quad']);
  expect(r.enabled).toBe(true);
  expect(r.opened).toBe(4);
  // FX-07 places a dihedral target at (130, 130) and a cross-pol (HV) target at (330, 330) that the
  // Pauli test calls volume.
  expect(r.v.dih.pd).toBeGreaterThan(2 * Math.max(r.v.dih.ps, r.v.dih.pv));
  expect(r.v.dih.ypd).toBeGreaterThan(2 * Math.max(r.v.dih.yps, r.v.dih.ypv));
  expect(r.v.dih.alpha).toBeGreaterThan(60);
  expect(r.v.vol.pv).toBeGreaterThan(Math.max(r.v.vol.ps, r.v.vol.pd));
  // Both FX-07 targets are deterministic (one mechanism each): low entropy.
  expect(r.v.dih.H).toBeLessThan(0.3);
  expect(r.v.vol.alpha).toBeGreaterThan(60);
  expect(r.v.dih.cls).not.toBe(r.v.vol.cls);
  expect(r.classes).toBeGreaterThanOrEqual(2);
  expect(r.compact.name).toBe('Compact-pol H/A/alpha');
  expect(r.compact.Hvol).toBeGreaterThan(0.5);
  // Pauli is unchanged: double bounce red.
  expect(r.paDih[0]).toBeGreaterThan(2 * Math.max(r.paDih[1], r.paDih[2]));
  // The dialog passes axe and runs.
  await frame.evaluate(() => void window.gisworkbench.commands.run('sar.polsar'));
  const dlg = frame.locator('[data-id="dialog:sar-polsar"]');
  await expect(dlg).toBeVisible();
  expect(await axeOn(frame, '[data-id="dialog:sar-polsar"]')).toEqual([]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  expect(logs.filter((l) => l.type === 'error')).toEqual([]);
});
