// REQ-PRF-02 (software half): one panel roaming on SwiftShader (Chrome's software WebGL) must
// hold ≥ 15 fps. Developer probe: node tests/tools/perf-swiftshader.mjs → reports/perf-swiftshader.json
import { chromium } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(pathToFileURL(resolve('dist/gis-workbench.html')).href);
await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 60000 });
const input = await page.evaluateHandle(() => {
  const i = document.createElement('input');
  i.type = 'file';
  i.hidden = true;
  document.body.appendChild(i);
  return i;
});
await input.asElement().setInputFiles(resolve('fixtures/fx01/fx01.ntf'));
await page.evaluate((i) => window.gisworkbench.openFiles([...i.files]), input);
await page.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.lutTex && !l.tiles.loading), null, { timeout: 60000 });
const r = await page.evaluate(async () => {
  const app = window.gisworkbench;
  const p = app.activePane();
  p.setView({ cx: 2048, cy: 2048, zoom: 0.6, rot: 0, mode: 'native' });
  await new Promise((res) => setTimeout(res, 2000));
  const f0 = app.renderer.frame;
  const t0 = performance.now();
  let k = 0;
  await new Promise((res) => {
    const step = () => {
      k++;
      p.setView({ cx: 2048 + 300 * Math.sin(k / 30), cy: 2048 + 300 * Math.cos(k / 30) });
      if (performance.now() - t0 < 4000) requestAnimationFrame(step);
      else res();
    };
    requestAnimationFrame(step);
  });
  const secs = (performance.now() - t0) / 1000;
  return { fps: (app.renderer.frame - f0) / secs, frameMs: app.renderer.stats.frameMs, renderer: app.runMode.caps.gl?.renderer, software: app.softwareGl, kernel: [...app.layers.values()][0].kernelEffective };
});
await browser.close();
mkdirSync('reports', { recursive: true });
writeFileSync('reports/perf-swiftshader.json', JSON.stringify({ measured: new Date().toISOString(), ...r }, null, 1));
console.log(JSON.stringify(r));
if (!(r.fps >= 15)) process.exitCode = 1;
