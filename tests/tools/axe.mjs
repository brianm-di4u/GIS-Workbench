// Developer helper: list every axe-core WCAG 2.2 AA violation per theme in the built file.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(pathToFileURL(resolve('dist/gis-workbench.html')).href);
await page.waitForFunction(() => document.body.dataset.ready);
const input = await page.evaluateHandle(() => {
  const i = document.createElement('input');
  i.type = 'file';
  i.hidden = true;
  i.setAttribute('aria-label', 'Test files');
  document.body.appendChild(i);
  return i;
});
await input.asElement().setInputFiles(resolve('../Research/samples/nitf-wv3-mvs-stereo-chips/wv3_a_chip.ntf'));
await page.evaluate((i) => window.gisworkbench.openFiles([...i.files]), input);
await page.evaluate(axe);
for (const theme of (process.argv[2] ?? 'grey,dark,print').split(',')) {
  await page.evaluate((t) => window.gisworkbench.commands.run(`theme.${t}`), theme);
  await page.waitForTimeout(300);
  const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, exclude: [['#gl'], ['.pane-overlay']] })).violations.map((x) => ({ id: x.id, n: x.nodes.length, nodes: x.nodes.slice(0, 40).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 160)}`) })));
  console.log(`=== ${theme}: ${v.length} rule(s)`);
  for (const r of v) {
    console.log(`- ${r.id} (${r.n})`);
    for (const n of r.nodes) console.log(`    ${n}`);
  }
}
await browser.close();
