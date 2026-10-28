// Marketing screenshots for gis-workbench-site: open the built file over file:// in Chrome at
// 1600×1000, load real corpus data, set the view and save a PNG per shot. Re-run after UI changes.
//   node tests/tools/capture-marketing.mjs [--out reports/marketing] [--only fmv,hsi,lidar] [--headed]
// Data comes from ../TE-corpus (licences in each item's SOURCE.txt and the site's screenshot credits).

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const OUT = resolve(opt('--out', 'reports/marketing'));
const ONLY = opt('--only', null)?.split(',');
const CORPUS = resolve(process.env.TE_CORPUS ?? '../TE-corpus');
const C = (...p) => join(CORPUS, ...p);

/** Open files through a temporary input; `rename` maps a path to the name the app should see. */
async function open(page, paths, rename = {}) {
  const input = await page.evaluateHandle(() => {
    const i = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true });
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(paths);
  const names = paths.map((p) => rename[p] ?? basename(p));
  return page.evaluate(
    async ([i, names]) => {
      const files = [...i.files].map((f, k) => (f.name === names[k] ? f : new File([f], names[k], { type: f.type })));
      i.remove();
      const app = window.gisworkbench;
      const before = app.importLog.length;
      await app.openFiles(files);
      return app.importLog.slice(before);
    },
    [input, names],
  );
}

/** Hand one file to an in-page function `fn(app, file)` (e.g. a metadata import). */
async function withFile(page, path, fn) {
  const input = await page.evaluateHandle(() => {
    const i = Object.assign(document.createElement('input'), { type: 'file', hidden: true });
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(path);
  return page.evaluate(([i, src]) => {
    const f = i.files[0];
    i.remove();
    return new Function('app', 'file', `return (${src})(app, file)`)(window.gisworkbench, f);
  }, [input, fn.toString()]);
}

const SHOTS = {
  // BAMBI flight 258 (CC BY 4.0): DJI wide camera, platform metadata from the drone's SRT log.
  // Frame 84: the gimbal tilting down over the autumn forest, so the footprint is an oblique trapezoid.
  async fmv(page, { frame = Number(opt('--frame', '84')) } = {}) {
    const dir = C('fmv-bambi-flights', 'derived', 'flight_258');
    const stem = 'DJI_20241021165448_0001_V_point0';
    await open(page, [join(dir, `${stem}.ts`)]);
    await page.waitForFunction(() => {
      const f = window.gisworkbench.fmv;
      const v = f.activeClip() && f.viewOf(f.activeClip());
      return v && (v.metadataOnly || v.video.readyState >= 2);
    }, null, { timeout: 60_000 });
    await withFile(page, join(dir, `${stem}.csv`), async (app, file) => app.fmv.importCsv(app.fmv.activeClip(), file));
    const fp = await page.evaluate(async (n) => {
      const f = window.gisworkbench.fmv;
      const clip = f.activeClip();
      const v = f.viewOf(clip);
      await v.step(n - v.frame);
      for (let k = 0; k < 100 && (v.frame !== n || v._seekTarget !== null); k++) await new Promise((r) => setTimeout(r, 100));
      const e = [...clip.fpCache.entries()].find(([key]) => key.startsWith(`${n}|`));
      return { frame: v.frame, time: v.video.currentTime, corners: e?.[1]?.corners ?? null, source: e?.[1]?.source };
    }, frame);
    if (fp.corners) {
      await page.evaluate((c) => {
        const map = window.gisworkbench.desktop.workspace.map;
        const lats = c.map((p) => p[0]);
        const lons = c.map((p) => p[1]);
        const span = Math.max(Math.max(...lons) - Math.min(...lons), (Math.max(...lats) - Math.min(...lats)) * 1.4);
        const w = map.host?.getBoundingClientRect?.().width ?? 270;
        map.zoomTo((Math.max(...lats) + Math.min(...lats)) / 2, (Math.max(...lons) + Math.min(...lons)) / 2, (w * 0.55) / span);
      }, fp.corners);
    }
    return fp;
  },

  // 2018 IEEE GRSS DFC, University of Houston (CC BY 4.0): CASI 48-band ENVI BIP delivered as .pix.
  async hsi(page) {
    const hsi = C('ieee-dfc2018-houston', 'FullHSIDataset', '20170218_UH_CASI_S4_NAD83.pix');
    const hdr = hsi.replace(/\.pix$/, '.hdr');
    const log = await open(page, [hsi, hdr], { [hsi]: basename(hsi).replace(/\.pix$/, '.bip') });
    // 500 MB cube: wait until no tile is still loading.
    await page.waitForTimeout(3000);
    const t0 = Date.now();
    await page.waitForFunction(() => !/Jobs: [1-9]\d* running|loading \d+ tiles?/i.test(document.body.textContent), null, { timeout: 300_000, polling: 1000 }).catch(() => {});
    log.push({ tilesLoadedMs: Date.now() - t0 });
    // Colour-infrared composite zoomed in on the campus/stadium area. No Auto Enhance: run after a
    // preset it puts the header's default bands back (TE finding, 2026-10-27).
    const ids = [opt('--preset', 'msi.preset.cir'), ...(args.includes('--enh') ? ['enh.auto'] : [])];
    log.push(await page.evaluate(async ([ids, zoom, fx, fy]) => {
      const app = window.gisworkbench;
      const out = {};
      for (const id of ids) {
        out[id] = app.commands.enabled(id);
        if (out[id]) await app.commands.run(id);
      }
      const p = app.activePane();
      const r = p.el?.getBoundingClientRect?.() ?? { width: 940, height: 760 };
      p.zoomAt(zoom, r.width * fx, r.height * fy);
      return out;
    }, [ids, Number(opt('--zoom', '2.2')), Number(opt('--fx', '0.45')), Number(opt('--fy', '0.5'))]));
    await page.waitForFunction(() => !/Jobs: [1-9]\d* running|loading \d+ tiles?/i.test(document.body.textContent), null, { timeout: 300_000, polling: 1000 }).catch(() => {});
    return log;
  },

  // FLAME 2 (CC BY 4.0): structure-from-motion cloud of the Bluestem burn plot, Arizona (alternative).
  async lidarFlame(page) {
    return open(page, [C('ieee-flame2-sfm', 'RGB_Pointcloud.laz')]);
  },

  // 2018 IEEE GRSS DFC (CC BY 4.0): Optech Titan multispectral LiDAR tile over the UH campus.
  async lidar(page) {
    const log = await open(page, [C('ieee-dfc2018-houston', 'C123', '272652_3289689.las')]);
    // Hide never-classified (0) and noise (7) points, and ramp colour over ground..roof heights (HAE).
    await page.evaluate(() => {
      const v = window.gisworkbench.activePane().view3d;
      for (const c of [0, 7]) v.setClassVisible(c, false);
      v.settings.zRange = [-17, 8];
      v.uniforms.uZRange.value.set(...v.settings.zRange);
      v.invalidate();
    });
    return log;
  },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: opt('--channel', 'chrome'), headless: !args.includes('--headed'), args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
for (const [name, shot] of Object.entries(SHOTS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(pathToFileURL(resolve(opt('--html', 'dist/gis-workbench.html'))).href);
  await page.waitForFunction(() => document.body?.dataset.ready === '1', null, { timeout: 45_000 });
  const t0 = Date.now();
  let result;
  try {
    result = await shot(page);
  } catch (e) {
    result = { error: e.message };
  }
  await page.waitForTimeout(Number(opt('--settle', '4000')));
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(JSON.stringify({ shot: name, file, ms: Date.now() - t0, result, errors }).slice(0, 1500));
  await page.close();
}
await browser.close();
