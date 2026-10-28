// Developer helper (GUI campaign): axe-core colour-contrast and naming checks over the chrome,
// the dock panels and the common dialogs, in every theme of both layouts.
//   node tests/tools/contrast.mjs [dist-dir] [build]   (defaults: dist, gis-workbench.html)
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const axe = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const dir = process.argv[2] ?? 'dist';
const file = process.argv[3] ?? 'gis-workbench.html';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify({ welcomeDone: true, persona: 'explorer' })));
await page.goto(pathToFileURL(resolve(dir, file)).href);
await page.waitForFunction(() => document.body.dataset.ready);
const input = await page.evaluateHandle(() => {
  const i = document.createElement('input');
  i.type = 'file';
  i.hidden = true;
  i.setAttribute('aria-label', 'Test files');
  document.body.appendChild(i);
  return i;
});
await input.asElement().setInputFiles(resolve('fixtures/fx01/fx01.ntf'));
await page.evaluate((i) => window.gisworkbench.openFiles([...i.files]), input);
await page.waitForTimeout(1500);
await page.evaluate(axe);

const RULES = ['color-contrast', 'button-name', 'label', 'select-name', 'link-name', 'aria-command-name'];
const scan = () =>
  page.evaluate(async (rules) => (await window.axe.run(document, { runOnly: { type: 'rule', values: rules }, exclude: [['#gl'], ['.pane-overlay'], ['.toasts']] })).violations.flatMap((x) => x.nodes.map((n) => `${x.id} :: ${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n').slice(1).join(' ').slice(0, 140)}`)), RULES);

const out = new Map();
const note = (where, list) => {
  for (const v of list) {
    const key = v.replace(/#[a-z]+_[a-z0-9_]+/gi, '#id').replace(/:nth-child\(\d+\)/g, '');
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(where);
  }
};
const DOCKS = ['layers', 'toolbox', 'menlog', 'ai', 'recipes', 'convert', 'catalog', 'jobs', 'netlog', 'detections', 'observations', 'spectral', 'triangulation', 'imagelist'];
const DIALOGS = ['file.prefs', 'help.about', 'enh.chain', 'nav.jump', 'ai.connections', 'help.keys'];
for (const layout of ['modern', 'classic']) {
  await page.evaluate((l) => window.gisworkbench.setLayout(l), layout);
  for (const theme of layout === 'modern' ? ['m3dark', 'm3light', 'dark'] : ['grey', 'dark', 'm3light']) {
    await page.evaluate((t) => window.gisworkbench.commands.run(`theme.${t}`), theme);
    await page.waitForTimeout(250);
    note(`${layout}/${theme} chrome`, await scan());
    for (const d of DOCKS) {
      await page.evaluate((d) => window.gisworkbench.activeMp().docks.show(d), d);
      await page.waitForTimeout(150);
      note(`${layout}/${theme} dock ${d}`, await scan());
      await page.evaluate((d) => {
        const m = window.gisworkbench.activeMp().docks;
        m.close(m.registry.get(d));
      }, d);
    }
    for (const c of DIALOGS) {
      await page.evaluate((c) => void window.gisworkbench.commands.run(c), c);
      await page.waitForTimeout(300);
      note(`${layout}/${theme} dialog ${c}`, await scan());
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        for (const mp of window.gisworkbench.desktop.multiports) for (const [id, p] of mp.docks.registry) if (id.startsWith('tool:') && p.area) mp.docks.close(p);
      });
    }
  }
}
for (const [k, w] of out) console.log(`${k}\n    in ${w.size}: ${[...w].slice(0, 4).join('; ')}`);
console.log(`${out.size} distinct violation(s)`);
await browser.close();
