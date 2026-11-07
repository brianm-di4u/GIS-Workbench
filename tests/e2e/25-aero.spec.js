// 2.5 aero group (REQ-GAP-22) in the app: the aerial triangulation of a frame block.
//  - Twelve synthetic frame images (PNG) get approximate frame models through app.frames.applyFrame
//    (the Frame Import Wizard's path): a nominal lens and perturbed positions and attitudes. Their
//    block points (GCPs, checkpoints, tie points) are measured with the core bundle's own frame
//    models of the true lens (Brown k1, k2, p1, p2, a shifted principal point, another f).
//  - The Aerial Triangulation dialog solves the block with self-calibration in the analysis
//    worker, with progress; the report gives σ₀, the camera with σ and global correlations, the
//    checkpoints and the weak geometry; Apply gives every image its triangulated frame model,
//    which re-projects like the truth; undo removes it. A second solve is cancelled mid-way.
//  - Space Resection of one image from its control; Film Interior Orientation from the fiducials of
//    USGS report OSL/3707. The three dialogs pass axe (WCAG 2.2 AA).
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { openApp, openFiles } from './helpers.js';
import { frameParams } from '../../app/src/sensor/camera.js';

const W = 1200;
const H = 800;
const PIX = 0.02;

/** A grey 8-bit PNG (a gentle gradient), W × H. */
function png(seed) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) {
      c ^= b;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raw[y * (W + 1) + 1 + x] = (x + y + seed * 17) & 255;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function lcg(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) + 0.5) / 2 ** 32;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test('REQ-GAP-22 aerial triangulation with self-calibration, resection and film interior orientation; the dialogs pass axe', async ({ page }) => {
  test.setTimeout(300000);
  const { frame } = await openApp(page, 'file');
  const dir = mkdtempSync(join(tmpdir(), 'gw-aero-'));
  const files = [];
  for (let k = 0; k < 12; k++) {
    const p = join(dir, `aero_${String(k).padStart(2, '0')}.png`);
    writeFileSync(p, png(k));
    files.push(p);
  }
  await openFiles(frame, files);
  await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.kind === 'image').length === n, files.length, { timeout: 60000 });

  // The block: 3 strips of 4 images, 24 mm lens on a 24 × 16 mm, 20 µm sensor, 150 m above rolling ground.
  const rnd = lcg(11);
  const lat0 = 41.03;
  const lon0 = -83.3;
  const truthCam = { focalMm: 24.0, pixelMm: PIX, cx: W / 2 + 3.2, cy: H / 2 - 2.1, k: [6.5e-5, -1.2e-7, 0], p: [1.5e-5, -1e-5], aff: [0, 0], width: W, height: H };
  const nominal = { focalMm: 24.15, pixelMm: PIX, cx: null, cy: null, k: [0, 0, 0], p: [0, 0], aff: [0, 0] };
  const mN = 1 / 111000;
  const mE = 1 / (111000 * Math.cos((lat0 * Math.PI) / 180));
  const eo = [];
  for (let s = 0; s < 3; s++)
    for (let k = 0; k < 4; k++) {
      const e = (k - 1.5) * 25;
      const n = (s - 1) * 55;
      eo.push({ lat: lat0 + n * mN, lon: lon0 + e * mE, h: 400 + 2 * rnd(), omega: 2 * rnd(), phi: 2 * rnd(), kappa: (s % 2 ? -90 : 90) + 3 * rnd() });
    }
  const truth = eo.map((t) => frameParams(truthCam, { lat: t.lat, lon: t.lon, hae: t.h }, { kind: 'opk', omega: t.omega, phi: t.phi, kappa: t.kappa }));
  // Approximations: positions within ~0.1 m (GNSS-grade), attitudes within ~1°.
  const approx = eo.map((t) => ({ lat: t.lat + 0.1 * rnd() * mN, lon: t.lon + 0.1 * rnd() * mE, h: t.h + 0.1 * rnd(), omega: t.omega + rnd(), phi: t.phi + rnd(), kappa: t.kappa + rnd(), source: 'EO import' }));
  const ground = [];
  for (let e = -90; e <= 90; e += 7) for (let n = -100; n <= 100; n += 7) ground.push({ lat: lat0 + (n + 2 * rnd()) * mN, lon: lon0 + (e + 2 * rnd()) * mE, hae: 250 + 25 * Math.sin(e / 60) * Math.cos(n / 50) });
  const noise = ground.map(() => [0.3 * rnd(), 0.3 * rnd()]);

  const setup = await frame.evaluate(({ truth, approx, nominal, ground, noise }) => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].filter((l) => l.kind === 'image').sort((a, b) => a.rec.name.localeCompare(b.rec.name));
    ls.forEach((l, i) => app.frames.applyFrame(l, nominal, approx[i]));
    const ids = truth.map((r) => app.core.frameModelEx(r, 'truth'));
    let made = 0;
    app.store.transact('aero test points', (tx) => {
      ground.forEach((g, j) => {
        const obs = {};
        ids.forEach((id, i) => {
          const p = app.core.g2i(id, g.lat, g.lon, g.hae);
          if (p && p.x > 3 && p.y > 3 && p.x < 1197 && p.y < 797) obs[ls[i].id] = { x: p.x + noise[j][0], y: p.y + noise[j][1], sigma: 0.3 };
        });
        if (Object.keys(obs).length < 2) return;
        const kind = j % 29 === 0 ? 'gcp' : j % 17 === 0 ? 'check' : 'tie';
        tx.create('tripoint', { name: `P${j}`, kind, known: kind === 'tie' ? null : g, sigmaH: 0.01, sigmaV: 0.01, obs });
        made++;
      });
    });
    return { layers: ls.length, models: ls.map((l) => l.modelName), points: made };
  }, { truth, approx, nominal, ground, noise });
  expect(setup.layers).toBe(12);
  expect(setup.models.every((m) => /^Frame camera \(EO import\)$/.test(m))).toBe(true);
  expect(setup.points).toBeGreaterThan(300);

  // The dialog: self-calibration of f, the principal point, k1–k3 and p1, p2; GNSS σ 0.1 m.
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('tri.aero'); // resolves when the dialog closes
  });
  const dlg = frame.locator('[data-id="dialog:aero"]');
  await expect(dlg).toBeVisible({ timeout: 30000 });
  for (const id of ['f', 'pp', 'radial', 'tangential']) await dlg.locator(`[data-id="aero:${id}"]`).check();
  await dlg.locator('[data-id="aero:gnss-h"]').fill('0.1');
  await dlg.locator('[data-id="aero:gnss-v"]').fill('0.1');
  const t0 = Date.now();
  await dlg.locator('[data-id="aero:solve"]').click();
  await expect(dlg.locator('[data-id="aero:summary"]')).toBeVisible({ timeout: 120000 });
  const solveMs = Date.now() - t0;
  const summary = await dlg.locator('[data-id="aero:summary"]').textContent();
  expect(summary).toMatch(/σ₀/);
  expect(await dlg.locator('[data-id="aero:progress"]').getAttribute('value')).toBe('100');
  await expect(dlg.locator('[data-id="aero:camera-0"]')).toBeVisible();
  // axe on the dialog with its report.
  const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  await frame.evaluate(axeSource);
  const axe = (sel) => frame.evaluate(async ({ sel, tags }) => (await window.axe.run(document.querySelector(sel), { runOnly: { type: 'tag', values: tags } })).violations.map((x) => `${x.id}: ${x.nodes.map((n) => n.target.join(' ')).slice(0, 5).join(', ')}`), { sel, tags: AXE_TAGS });
  expect(await axe('[data-id="dialog:aero"]')).toEqual([]);
  await dlg.locator('[data-id="aero:apply"]').click();
  await dlg.getByRole('button', { name: 'Close' }).last().click();

  // The applied models re-project like the truth; the solved lens is within 4σ of it.
  const r = await frame.evaluate(async ({ truth, ground }) => {
    const app = window.gisworkbench;
    const core = app.core;
    const ls = [...app.layers.values()].filter((l) => l.kind === 'image').sort((a, b) => a.rec.name.localeCompare(b.rec.name));
    const ids = truth.map((t) => core.frameModelEx(t, 'truth'));
    let worst = 0;
    ls.forEach((l, i) => {
      for (const g of ground.filter((_, j) => j % 5 === 0)) {
        const a = core.g2i(ids[i], g.lat, g.lon, g.hae);
        if (!a || a.x < 0 || a.y < 0 || a.x > 1200 || a.y > 800) continue;
        const b = core.g2i(l.modelId, g.lat, g.lon, g.hae);
        worst = Math.max(worst, Math.hypot(a.x - b.x, a.y - b.y));
      }
    });
    const sol = app.store.all('aerosolution');
    const names = ls.map((l) => l.modelName);
    // Undo removes the solution: the images go back to their imported frame models.
    app.undo.undo();
    await new Promise((res) => setTimeout(res, 50));
    const after = ls.map((l) => l.modelName);
    app.undo.redo();
    await new Promise((res) => setTimeout(res, 50));
    const redone = ls.map((l) => l.modelName);
    return { worst, sol: sol.map((s) => ({ label: s.label, sigma0: s.sigma0, cameras: s.cameras, checks: s.checks })), names, after, redone };
  }, { truth, ground });
  expect(r.sol).toHaveLength(1);
  expect(r.names.every((n) => n === 'Frame camera (aerial triangulation AT-001)')).toBe(true);
  expect(r.after.every((n) => /^Frame camera \(EO import\)$/.test(n))).toBe(true);
  expect(r.redone.every((n) => n === 'Frame camera (aerial triangulation AT-001)')).toBe(true);
  // 0.3 px measurements on a 12-image block: about 0.2 px RMS, 0.6 px at the image edges.
  expect(r.worst).toBeLessThan(1.0);
  expect(Math.abs(r.sol[0].sigma0 - 1)).toBeLessThan(0.15);
  const c = r.sol[0].cameras[0];
  const want = { 0: 24.0, 1: 3.2 * PIX, 2: 2.1 * PIX, 3: 6.5e-5, 7: 1.5e-5, 8: -1e-5 };
  for (const [q, v] of Object.entries(want)) expect(Math.abs(c.io[q] - v) / c.sigma[q], `IO ${q}: ${c.io[q]} vs ${v} (σ ${c.sigma[q]})`).toBeLessThan(4);
  expect(r.sol[0].checks.n).toBeGreaterThan(3);
  expect(r.sol[0].checks.rmseR).toBeLessThan(0.15);

  // Cancel: a second solve stopped after its first progress report.
  const cancel = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    let job = null;
    let seen = 0;
    job = app.aero.solve({ selfCal: { f: true, pp: true, radial: true, tangential: true }, gnss: { use: true, sigmaH: 0.1, sigmaV: 0.1 }, maxIterations: 200 }, { onProgress: (p, part) => part?.phase === 'iterate' && seen++ === 0 && job.cancel() });
    try {
      await job;
      return { cancelled: false, seen };
    } catch (e) {
      return { cancelled: !!e.cancelled, seen, msg: String(e.message) };
    }
  });
  expect(cancel.cancelled, JSON.stringify(cancel)).toBe(true);

  // Space resection of the panel's image from its control (GCPs and checkpoints), in the dialog.
  const res = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const l = app.activePane().geoLayer();
    return { name: l?.rec?.name, n: l ? app.tri.points().filter((p) => p.known && p.obs?.[l.id]).length : 0 };
  });
  if (res.n >= 4) {
    await frame.evaluate(() => {
    window.gisworkbench.commands.run('tri.resect'); // resolves when the dialog closes
  });
    const rd = frame.locator('[data-id="dialog:aero-resect"]');
    await expect(rd).toBeVisible({ timeout: 30000 });
    await expect(rd.locator('[data-id="aero:resection"]')).toContainText(/σ₀/);
    expect(await axe('[data-id="dialog:aero-resect"]')).toEqual([]);
    await rd.getByRole('button', { name: 'Close' }).last().click();
  }
  const direct = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const ls = [...app.layers.values()].filter((l) => l.kind === 'image').sort((a, b) => a.rec.name.localeCompare(b.rec.name));
    const r = await app.aero.resect(ls[4]);
    return { method: r.method, sigma0: r.sigma0, dof: r.dof, record: !!r.record, n: r.points.length };
  });
  expect(['DLT', 'homography', 'approximation']).toContain(direct.method);
  expect(direct.record).toBe(true);
  expect(direct.sigma0).toBeLessThan(2);

  // Film interior orientation: the report's fiducials, scanned at 20 µm and turned 0.4°.
  const report = readFileSync(resolve('fixtures/fx25/aero/usgs-osl3707.txt'), 'utf8');
  await frame.evaluate(() => {
    window.gisworkbench.commands.run('tri.fiducials'); // resolves when the dialog closes
  });
  const fd = frame.locator('[data-id="dialog:aero-fiducials"]');
  await expect(fd).toBeVisible({ timeout: 30000 });
  await fd.locator('[data-id="aero:fid-report"]').fill(report);
  await fd.locator('[data-id="aero:fid-report"]').dispatchEvent('change');
  await expect(fd.locator('[data-id="aero:fid-note"]')).toContainText('8');
  const a = (0.4 * Math.PI) / 180;
  const rows = fd.locator('tr[data-fid]');
  expect(await rows.count()).toBe(8);
  for (let i = 0; i < 8; i++) {
    const row = rows.nth(i);
    const x = Number(await row.locator('[data-k="x"]').inputValue());
    const y = Number(await row.locator('[data-k="y"]').inputValue());
    await row.locator('[data-k="col"]').fill(String(5750 + (Math.cos(a) * x - Math.sin(a) * y) / 0.02));
    await row.locator('[data-k="row"]').fill(String(5750 - (Math.sin(a) * x + Math.cos(a) * y) / 0.02));
  }
  await fd.locator('[data-id="aero:fid-compute"]').click();
  await expect(fd.locator('[data-id="aero:fid-note"]')).toContainText('µm', { timeout: 30000 });
  expect(await axe('[data-id="dialog:aero-fiducials"]')).toEqual([]);
  await fd.getByRole('button', { name: 'OK' }).click();
  const fio = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const l = [...app.layers.values()].find((x) => x.rec?.fiducialIo);
    return l ? { pixelUm: l.rec.fiducialIo.pixelUm, rmsUm: l.rec.fiducialIo.rmsUm, focal: l.rec.fiducialIo.camera.focalMm, marks: l.rec.fiducialIo.marks.length } : null;
  });
  expect(fio).not.toBeNull();
  expect(fio.marks).toBe(8);
  expect(Math.abs(fio.pixelUm[0] - 20)).toBeLessThan(1e-3);
  expect(fio.rmsUm).toBeLessThan(0.01);
  expect(Math.abs(fio.focal - 153.32)).toBeLessThan(0.02);
  test.info().annotations.push({ type: 'timing', description: `12-image solve with self-calibration through the dialog: ${solveMs} ms` });
  console.log(`aero e2e: solve ${solveMs} ms, worst re-projection ${r.worst.toFixed(4)} px, σ₀ ${r.sol[0].sigma0.toFixed(3)}, checks RMSE_r ${r.sol[0].checks.rmseR.toFixed(4)} m (n ${r.sol[0].checks.n})`);
  rmSync(dir, { recursive: true, force: true });
});
