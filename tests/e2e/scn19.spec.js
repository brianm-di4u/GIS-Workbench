// SCN-19 (PRD §5, R0 exit): a reviewer opens the whiteboard on a 2×2 Multiport, pins a
// measurement row and a Ribbon command, captures two pages (WebGL panes and banners appear),
// adds notes, exports an HTML report and re-imports it on another machine (a fresh browser
// context with empty storage).
import { test, expect } from '@playwright/test';
import { openApp, openFiles, sample } from './helpers.js';

test('SCN-19 review feedback end to end', async ({ page, browser }) => {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  await frame.evaluate(() => {
    const app = window.gisworkbench;
    Object.assign(app.runMode.caps, { fsaPicker: false, fsaSave: false });
    app.activeMp().setLayout('2x2');
    app.feedback.method = 'snapshot';
  });
  await frame.waitForFunction(() => window.gisworkbench.activeMp().panes.length === 4);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()][0]?.lutTex);

  // A measurement in the active pane → a Mensuration Log row.
  await frame.evaluate(() => window.gisworkbench.commands.run('men.log'));
  const r = await frame.evaluate(() => window.gisworkbench.activePane().el.getBoundingClientRect().toJSON());
  await frame.evaluate(() => window.gisworkbench.commands.run('men.point'));
  await page.mouse.click(r.left + r.width / 2, r.top + r.height / 2);
  const row = frame.locator('tr[data-id^="measurement:"]').first();
  await expect(row).toBeVisible();

  // Whiteboard: pin the log row and a Ribbon command, capture page 1.
  await page.keyboard.press('Escape');
  await frame.evaluate(() => window.gisworkbench.feedback.toggle(true));
  await page.keyboard.press('n');
  const rb = await row.boundingBox();
  await page.mouse.click(rb.x + 40, rb.y + rb.height / 2);
  const cmd = await frame.locator('.ribbon-body [data-id^="cmd:"]').first().boundingBox();
  await page.mouse.click(cmd.x + cmd.width / 2, cmd.y + cmd.height / 2);
  await frame.locator('[data-id="wb:capture"]').click();
  // Page 2: an arrow over a pane.
  await page.keyboard.press('a');
  await page.mouse.move(r.left + 40, r.top + 40);
  await page.mouse.down();
  await page.mouse.move(r.left + 160, r.top + 120, { steps: 5 });
  await page.mouse.up();
  await frame.locator('[data-id="wb:capture"]').click();
  await frame.waitForFunction(() => window.gisworkbench.feedback.pages.length === 2);
  const pins = await frame.evaluate(() => window.gisworkbench.feedback.pages[0].pins.map((p) => p.target));
  expect(pins.map((t) => t.kind)).toEqual(['measurement', 'cmd']);
  expect(pins[0].label).toMatch(/^Measurement /);
  expect(pins[1].label).toMatch(/^Command: /);
  // Every page carries WebGL pixels from the panes and both banners.
  const px = await frame.evaluate(async () => {
    const out = [];
    const app = window.gisworkbench;
    const rects = app.activeMp().panes.map((p) => p.el.getBoundingClientRect());
    for (const p of app.feedback.pages) {
      const img = new Image();
      img.src = p.image;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const s = img.width / innerWidth;
      const at = (x, y) => [...g.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data].slice(0, 3);
      const a = rects[0];
      out.push({ pane: at(a.left + a.width * 0.6, a.top + a.height * 0.7), top: at(innerWidth / 2, 2), bottom: at(innerWidth / 2, innerHeight - 2) });
    }
    return out;
  });
  for (const p of px) {
    expect(Math.max(...p.pane)).toBeGreaterThan(20);
    for (const b of [p.top, p.bottom]) expect(b[1] > b[0] && b[1] > b[2]).toBe(true);
  }

  // Review: notes on both pages, then export the HTML report.
  await page.keyboard.press('Escape');
  await frame.evaluate(() => void window.gisworkbench.commands.run('wb.review'));
  const dlg = frame.locator('[data-id="dialog:wb-review"]');
  await dlg.getByLabel('Summary of page 1').fill('Pinned items for the review');
  await dlg.getByLabel('Notes for page 2').fill('Arrow points at the parking lot');
  await dlg.getByRole('button', { name: 'Next: Send' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.locator('[data-id="wb:export:HTML report"]').click()]);
  const report = await dl.path();
  await dlg.getByRole('button', { name: 'Close' }).last().click();

  // Another machine: a fresh context, no project, no storage.
  const ctx2 = await browser.newContext({ acceptDownloads: true });
  const page2 = await ctx2.newPage();
  const { frame: f2, logs: logs2 } = await openApp(page2, 'file');
  await f2.evaluate(() => Object.assign(window.gisworkbench.runMode.caps, { fsaPicker: false }));
  const [fc] = await Promise.all([page2.waitForEvent('filechooser'), f2.evaluate(() => void window.gisworkbench.commands.run('wb.import'))]);
  await fc.setFiles(report);
  await f2.waitForFunction(() => window.gisworkbench.feedback.pages.length === 2);
  const imported = await f2.evaluate(() => window.gisworkbench.feedback.pages.map((p) => ({ summary: p.summary, notes: p.notes, pins: p.pins.map((x) => x.target?.label), img: !!p.image })));
  expect(imported[0]).toMatchObject({ summary: 'Pinned items for the review', img: true });
  expect(imported[1]).toMatchObject({ notes: 'Arrow points at the parking lot', img: true });
  expect(imported[0].pins).toHaveLength(2);
  // The pinned items do not exist on the other machine: they are shown as gone, not broken.
  await f2.evaluate(() => void window.gisworkbench.commands.run('wb.review'));
  await expect(f2.locator('[data-id="dialog:wb-review"]')).toContainText('(gone)');
  await ctx2.close();
  expect(logs).toEqual([]);
  expect(logs2).toEqual([]);
});
