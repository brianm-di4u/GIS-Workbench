// SCN-66 REQ-ING-04 OD-2.27: anything that can take more than 2 s says what is running, for how long,
// how far along when known, and offers Cancel when it can stop, in Full and in Lite. The start-up
// splash is in the file's first bytes. A large pack is checked in a worker, by the same rules.
//
//   GW_DIST=dist-sizeux npx playwright test activity.spec.js --project=chrome
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { openApp, DIST_DIR } from './helpers.js';

const pill = '[data-id="activity"]';
const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test('SCN-66 a tracked job appears at 300 ms with its name, time and percent; Cancel reaches the work', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await frame.evaluate(() => {
    window.__res = {};
    window.gisworkbench.activity
      .track(
        'Long work',
        (job) =>
          new Promise((res) => {
            window.__j = job;
            job.signal.addEventListener('abort', () => res('stopped'));
          }),
        { cancel: true },
      )
      .then((r) => (window.__res.out = r));
  });
  const before = await frame.evaluate((s) => !document.querySelector(s) || document.querySelector(s).hidden, pill);
  expect(before, 'not shown before 300 ms').toBe(true);
  await expect(frame.locator(pill)).toBeVisible();
  await expect(frame.locator(`${pill} .activity-label`)).toHaveText('Long work');
  await expect(frame.locator(pill)).toHaveClass(/indeterminate/);
  await frame.evaluate(() => window.__j.set(0.42));
  await expect(frame.locator(`${pill} .activity-time`)).toContainText('42 %');
  await expect(frame.locator(`${pill} [role="progressbar"]`)).toHaveAttribute('aria-valuenow', '42');
  await expect(frame.locator(`${pill} .activity-time`)).toContainText(/[1-9] s/, { timeout: 3000 });
  await frame.locator('[data-id="activity:cancel"]').click();
  await expect.poll(() => frame.evaluate(() => window.__res.out)).toBe('stopped');
  expect(await frame.evaluate(() => window.__j.cancelled)).toBe(true);
  await expect(frame.locator(pill)).toBeHidden();
});

test('SCN-66 start() paints before main-thread work, and the bar runs on the compositor', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const r = await frame.evaluate(async () => {
    const job = await window.gisworkbench.activity.start('Blocking work');
    const shown = !document.querySelector('[data-id="activity"]').hidden;
    const anim = document.querySelector('.activity-bar i').getAnimations().map((a) => a.animationName);
    job.end();
    return { shown, anim };
  });
  expect(r).toEqual({ shown: true, anim: ['gw-slide'] });
});

test('SCN-66 a worker job shows with no call from its feature; no progress is not a false 0 %', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const out = await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.pool.jobs.set('fake', { id: 'fake', op: 'tsindex', label: 'tsindex', created: performance.now() - 1000, progress: 0, state: 'running' });
    const row = app.activity.items().find((i) => i.id === 'fake');
    app.activity.render();
    const el = document.querySelector('[data-id="activity"]');
    const text = el.querySelector('.activity-label').textContent;
    const indeterminate = el.classList.contains('indeterminate');
    app.pool.jobs.delete('fake');
    return { label: row.label, text, indeterminate, cancel: typeof row.cancel };
  });
  expect(out).toEqual({ label: 'Indexing video…', text: 'Indexing video…', indeterminate: true, cancel: 'function' });
});

test('SCN-66 axe passes on the indicator (WCAG 2.2 AA)', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await frame.evaluate(AXE);
  const v = await frame.evaluate(async () => {
    const job = await window.gisworkbench.activity.start('Axe work', { cancel: true });
    const r = await window.axe.run(document.querySelector('[data-id="activity"]'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    job.end();
    return r.violations.map((x) => x.id);
  });
  expect(v).toEqual([]);
});

test('SCN-66 the splash shows while the file starts and leaves when it is ready', async ({ page }) => {
  await page.addInitScript(() => {
    const look = () => {
      const el = document.getElementById('gw-splash');
      if (el && !document.body?.dataset.ready && getComputedStyle(el).display !== 'none') window.__splash = true;
      if (!document.body?.dataset.ready) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  const { frame } = await openApp(page, 'file');
  expect(await frame.evaluate(() => window.__splash)).toBe(true);
  await expect(frame.locator('#gw-splash')).toBeHidden();
  const html = readFileSync(join(DIST_DIR, 'gis-workbench.html'), 'latin1');
  expect(html.indexOf('id="gw-splash"'), 'before every block').toBeLessThan(html.indexOf('id="blk-'));
  const lite = readFileSync(join(DIST_DIR, 'gis-workbench-lite.html'), 'latin1');
  expect(lite.indexOf('id="gw-splash"'), 'before the Lite payload').toBeLessThan(lite.indexOf('id="gw-payload"'));
});

function pack() {
  const data = randomBytes(6 * 1024 * 1024);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const json = { format: 'gw-pack/1', name: 'test-large', version: '1', entries: [{ path: 'data.bin', kind: 'data', sha256 }] };
  return { data, zip: zipSync({ 'pack.json': strToU8(JSON.stringify(json)), 'data.bin': [data, { level: 0 }] }) };
}

test('SCN-66 a large pack is checked in a worker with progress, by the same rules', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  const check = (bytes) =>
    frame.evaluate(async (b64) => {
      const app = window.gisworkbench;
      const u8 = Uint8Array.fromBase64(b64);
      const seen = [];
      const watch = (j) => {
        if (j.op === 'packUnzip') seen.push(j.progress);
      };
      app.pool.on('job', watch);
      try {
        const v = await app.packs.verify(u8, 'large.gwpack', { transfer: true });
        return { name: v.json.name, size: v.entries.get('data.bin').length, top: Math.max(...seen), given: u8.length === 0 };
      } catch (e) {
        return { code: e.code, given: u8.length === 0 };
      }
    }, Buffer.from(bytes).toString('base64'));
  const { zip, data } = pack();
  expect(await check(zip)).toMatchObject({ name: 'test-large', size: data.length, given: true });
  expect((await check(zip)).top).toBeGreaterThan(0.5);
  const bad = pack();
  bad.zip[bad.zip.indexOf(bad.data[0], 200) + 1000] ^= 1; // a byte inside the stored entry
  expect(await check(bad.zip)).toMatchObject({ code: 'E_PACK_HASH', given: true });
});

test('SCN-66 Lite: the indicator shows, with a 44 px Cancel', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`file:///${join(DIST_DIR, 'gis-workbench-lite.html').split('\\').join('/')}`);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  await page.evaluate(() => window.gisworkbench.activity.start('Lite work', { cancel: true }).then((j) => (window.__j = j)));
  await expect(page.locator(pill)).toBeVisible();
  const box = await page.locator('[data-id="activity:cancel"]').boundingBox();
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.width).toBeGreaterThanOrEqual(44);
  await page.evaluate(() => window.__j.end());
  await ctx.close();
});

// Found by the Firefox run (OD-2.31 D24): a fixed aria-label hid the visible count (WCAG 2.5.3).
test('REQ-UI-16 the status bar job button holds its visible text in its name, and passes axe', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await frame.evaluate(() => {
    void window.gisworkbench.activity.track('Long work', (job) => new Promise((res) => (window.__end = res)));
  });
  const b = frame.locator('.status-jobs').first();
  await expect(b).toBeVisible();
  const text = await b.locator('.job-text').textContent();
  expect(text).toMatch(/1 job/);
  expect(await b.getAttribute('aria-label')).toContain(text);
  await frame.evaluate(AXE);
  const v = await frame.evaluate(async () => (await window.axe.run(document.querySelector('.status-jobs'), { runOnly: { type: 'rule', values: ['label-content-name-mismatch'] }, rules: { 'label-content-name-mismatch': { enabled: true } } })).violations.length);
  expect(v).toBe(0);
  await frame.evaluate(() => window.__end());
});
