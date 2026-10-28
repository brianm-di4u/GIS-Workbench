// TE-C44 Phase F performance on the field data: for the largest file of each field image item,
// time to the first displayed tile, to a settled whole-image view and to statistics (PRF-03 is
// logged; the hard limits are the app's own 60 s tile and 300 s statistics timeouts, which must
// never fire — TE-066). Results go to reports/campaign/results/c44-*.json for TE-report.md.
import { test, expect } from '@playwright/test';
import { existsSync, statSync } from 'node:fs';
import { openApp, openFiles, settled, record, itemsBy, paths } from './helpers.js';

const SPEC = 'c44-field-perf';
test.describe.configure({ mode: 'parallel', timeout: 900_000 });

const cases = itemsBy((it) => it.tier === 'U')
  .map((it) => {
    const p = paths(it, ['primary']).filter((x) => /\.tif$/i.test(x) && !/_BROWSE\./i.test(x) && existsSync(x));
    const big = p.sort((a, b) => statSync(b).size - statSync(a).size)[0];
    return big ? { it, p: big, side: paths(it, ['sidecar']).filter((s) => s.replace(/\.[^.]+$/, '') === big.replace(/\.[^.]+$/, '')) } : null;
  })
  .filter(Boolean)
  // One Spratly reef/date is enough (14 deliveries of the same kind).
  .filter((c, i, all) => !/spratly/.test(c.it.id) || all.findIndex((x) => /spratly/.test(x.it.id)) === i);

for (const { it, p, side } of cases) {
  const name = p.split(/[\\/]/).pop();
  test(`TE-C44 PRF-03 TE-066 ${it.id}/${name} (${(statSync(p).size / 1e6).toFixed(0)} MB): first tile, settled view, statistics`, async ({ page }, info) => {
    const { frame, logs } = await openApp(page, 'file');
    const t0 = Date.now();
    await openFiles(frame, [p, ...side]);
    const opened = Date.now() - t0;
    const first = await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.error || l.lutTex), null, { timeout: 600_000 }).then(() => Date.now() - t0, () => null);
    const ok = await settled(frame, 600_000);
    const all = Date.now() - t0;
    const st = await frame.evaluate(async () => {
      const l = [...window.gisworkbench.layers.values()][0];
      const t = performance.now();
      try {
        await l.ensureStats();
        return { ms: Math.round(performance.now() - t), error: l.error ?? null, w: l.width, h: l.height, bands: l.bands, type: l.sampleType };
      } catch (e) {
        return { error: e.message };
      }
    });
    const toasts = await frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent));
    record(SPEC, info.project.name, { key: `perf-${it.id}-${name}`, bytes: statSync(p).size, openMs: opened, firstTileMs: first, settledMs: ok ? all : null, statsMsAfterDisplay: st.ms, layer: st, toasts });
    expect(st.error ?? null, 'layer error').toBeNull();
    expect(first, 'first tile shown').not.toBeNull();
    expect(ok, 'whole-image view settled').toBe(true);
    expect(toasts.filter((t) => /timed out/i.test(t)), 'no tile or statistics timeouts').toEqual([]);
    expect(logs).toEqual([]);
  });
}
