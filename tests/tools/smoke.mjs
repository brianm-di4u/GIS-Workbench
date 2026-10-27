// Developer smoke run: open the built file over file:// in headless Chrome, wait for
// data-ready, optionally open files and run a script, print console output, save a screenshot.
//   node tests/tools/smoke.mjs [--shot out.png] [--open path …] [--eval "js"] [--wait ms]

import { chromium } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const opens = [];
for (let i = 0; i < args.length; i++) if (args[i] === '--open') opens.push(resolve(args[i + 1]));
const html = resolve(opt('--html', 'dist/gis-workbench.html'));
const shot = opt('--shot', null);
const evalJs = opt('--eval', null);
const wait = Number(opt('--wait', '1500'));
const width = Number(opt('--width', '1600'));
const height = Number(opt('--height', '900'));

const browser = await chromium.launch({ channel: opt('--channel', 'chrome'), args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width, height } });
const logs = [];
const requests = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('request', (r) => {
  const u = r.url();
  if (!/^(file|data|blob|about):/.test(u)) requests.push(u);
});
await page.addInitScript(() => {
  window.__csp = [];
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
});
await page.goto(pathToFileURL(html).href);
try {
  await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 30000 });
} catch {
  logs.push('TIMEOUT waiting for data-ready');
}
console.log('ready =', await page.evaluate(() => document.body.dataset.ready));
if (opens.length) {
  const input = await page.evaluateHandle(() => {
    const i = document.createElement('input');
    i.type = 'file';
    i.multiple = true;
    i.id = '__smoke_input';
    document.body.appendChild(i);
    return i;
  });
  await input.asElement().setInputFiles(opens);
  const t0 = Date.now();
  const res = await page.evaluate(async () => {
    const files = [...document.getElementById('__smoke_input').files];
    try {
      await window.gisworkbench.openFiles(files);
      return 'opened';
    } catch (e) {
      return `error: ${e.message}`;
    }
  });
  console.log('open:', res, `${Date.now() - t0} ms`);
}
if (evalJs) console.log('eval:', JSON.stringify(await page.evaluate(evalJs), null, 1));
await page.waitForTimeout(wait);
if (shot) await page.screenshot({ path: shot });
console.log('csp violations:', JSON.stringify(await page.evaluate(() => window.__csp)));
console.log('network requests:', JSON.stringify(requests));
console.log(logs.join('\n'));
await browser.close();
