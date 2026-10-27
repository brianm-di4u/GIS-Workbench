// PT-11 (whiteboard: draw, pin, capture with WebGL pixels and banners, review, export,
// re-import) and PT-12 (AI with the mock provider: consent, tool loop, proposal
// accept/reject/stale, key never persisted) on the built file.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, openFiles, sample } from './helpers.js';

const CHIP = () => sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');

async function ready(page) {
  const { frame, logs } = await openApp(page, 'file');
  await openFiles(frame, [CHIP()]);
  // Pickers fall back to <input type=file> and saves to downloads, which Playwright can drive.
  await frame.evaluate(() => Object.assign(window.gisworkbench.runMode.caps, { fsaPicker: false, fsaSave: false }));
  await frame.waitForFunction(() => {
    const l = [...window.gisworkbench.layers.values()][0];
    return l?.lutTex && !l.tiles.loading;
  });
  return { frame, logs };
}

test('PT-11 REQ-WB-01..11 REQ-WB-15 whiteboard draws, pins, captures, reviews, exports and re-imports', async ({ page }) => {
  const { frame, logs } = await ready(page);
  const pane = await frame.evaluate(() => window.gisworkbench.activePane().el.getBoundingClientRect().toJSON());
  const cx = pane.left + pane.width / 2;
  const cy = pane.top + pane.height / 2;
  await frame.evaluate(() => (window.gisworkbench.feedback.method = 'snapshot'));
  await page.mouse.click(cx, cy);
  await page.keyboard.press('b');
  expect(await frame.evaluate(() => window.gisworkbench.feedback.active)).toBe(true);

  // A pen stroke across the image (red, width 4) and a pin on the Layer Manager row.
  await page.keyboard.press('p');
  await page.mouse.move(cx - 120, cy - 60);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 120 + i * 20, cy - 60);
  await page.mouse.up();
  await page.keyboard.press('n');
  const row = await frame.locator('.lm-row[data-id^="layer:"]').first().boundingBox();
  await page.mouse.click(row.x + 60, row.y + row.height / 2);
  // Keys reach the whiteboard, not the application (the key shield).
  const zoomBefore = await frame.evaluate(() => window.gisworkbench.activePane().view.zoom);
  await page.keyboard.press('+');
  expect(await frame.evaluate(() => window.gisworkbench.activePane().view.zoom)).toBe(zoomBefore);

  await frame.locator('[data-id="wb:capture"]').click();
  await frame.waitForFunction(() => window.gisworkbench.feedback.pages.length === 1);
  const pg = await frame.evaluate(async ({ cx, cy }) => {
    const p = window.gisworkbench.feedback.pages[0];
    const img = new Image();
    img.src = p.image;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const s = img.width / innerWidth;
    const at = (x, y) => [...g.getImageData(Math.round(x * s), Math.round(y * s), 1, 1).data].slice(0, 3);
    return {
      w: img.width,
      stroke: at(cx, cy - 60),
      image: at(cx + 40, cy + 80),
      top: at(innerWidth / 2, 3),
      bottom: at(innerWidth / 2, innerHeight - 3),
      chrome: at(30, 42),
      pins: p.pins,
      context: p.context,
      capture: p.capture,
    };
  }, { cx, cy });
  expect(pg.capture).toBe('rendered snapshot');
  // WebGL pixels are in the page (the chip is not black), and so are the marks and the chrome.
  expect(Math.max(...pg.image)).toBeGreaterThan(20);
  expect(pg.stroke[0]).toBeGreaterThan(150);
  expect(pg.stroke[1]).toBeLessThan(110);
  expect(pg.chrome.some((v) => v > 100)).toBe(true);
  // Classification banners stamped top and bottom (UNCLASSIFIED green).
  for (const b of [pg.top, pg.bottom]) expect(b[1] > b[0] && b[1] > b[2]).toBe(true);
  expect(pg.pins).toHaveLength(1);
  expect(pg.pins[0].target.id).toMatch(/^layer:/);
  expect(pg.context.imageFile).toBe('wv3_a_chip.ntf');
  expect(pg.context.centre.mgrs).toMatch(/^\d{1,2}[C-X][A-Z]{2}\d{10}$/);
  expect(pg.context.marking).toBe('UNCLASSIFIED');

  // Review: edit the summary, go to Send, export the HTML report and the JSON.
  await page.keyboard.press('Escape');
  await frame.evaluate(() => void window.gisworkbench.commands.run('wb.review'));
  const dlg = frame.locator('[data-id="dialog:wb-review"]');
  await dlg.getByLabel('Summary of page 1').fill('Pan lags on the chip');
  await dlg.getByRole('button', { name: 'Next: Send' }).click();
  const [dl] = await Promise.all([page.waitForEvent('download'), dlg.locator('[data-id="wb:export:HTML report"]').click()]);
  const htmlPath = await dl.path();
  const html = readFileSync(htmlPath, 'utf8');
  expect(html).toContain('<div class="banner">UNCLASSIFIED</div>');
  expect(html).toContain('Pan lags on the chip');
  expect(html).toMatch(/<img alt="Page 1 screenshot" src="data:image\/png;base64,/);
  const [dj] = await Promise.all([page.waitForEvent('download'), dlg.locator('[data-id="wb:export:JSON"]').click()]);
  const json = JSON.parse(readFileSync(await dj.path(), 'utf8'));
  expect(json).toMatchObject({ kind: 'gisworkbench-feedback', version: 1 });
  expect(json.pages[0].summary).toBe('Pan lags on the chip');
  await dlg.getByRole('button', { name: 'Close' }).last().click();

  // Re-import the HTML report into an empty session: the page comes back intact.
  const before = await frame.evaluate(() => JSON.stringify(window.gisworkbench.feedback.pages[0]));
  await frame.evaluate(() => (window.gisworkbench.feedback.pages = []));
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('wb.import'))]);
  await fc.setFiles(htmlPath);
  await frame.waitForFunction(() => window.gisworkbench.feedback.pages.length === 1);
  const after = await frame.evaluate(() => JSON.stringify(window.gisworkbench.feedback.pages[0]));
  expect(JSON.parse(after)).toEqual(JSON.parse(before));
  // Importing the same report again adds nothing.
  const [fc2] = await Promise.all([page.waitForEvent('filechooser'), frame.evaluate(() => void window.gisworkbench.commands.run('wb.import'))]);
  await fc2.setFiles(htmlPath);
  await page.waitForTimeout(300);
  expect(await frame.evaluate(() => window.gisworkbench.feedback.pages.length)).toBe(1);
  expect(logs).toEqual([]);
});

test('PT-12 REQ-AI-01..07 REQ-AI-13 REQ-AI-17 the mock assistant asks consent, runs the tool loop and makes proposals', async ({ page }) => {
  const { frame, logs } = await ready(page);
  // AI is off by default: no connection, the Send button is disabled.
  await frame.evaluate(() => window.gisworkbench.commands.run('ai.assistant'));
  const dock = frame.locator('.ai-page').first();
  await expect(dock.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(dock.locator('.ai-status')).toContainText('AI is off');

  await frame.evaluate(() => {
    const app = window.gisworkbench;
    app.prefs.set('aiConnections', [{ id: 'conn_mock', name: 'Mock', provider: 'mock', baseURL: '', model: 'mock-model', effort: 'medium' }]);
    app.prefs.set('aiActive', 'conn_mock');
    app.emit('ai');
  });
  const input = dock.getByLabel('Message to the assistant');
  const ask = async (text, answer) => {
    await input.fill(text);
    await dock.getByRole('button', { name: 'Send' }).click();
    if (answer) await frame.locator('.dlg').getByRole('button', { name: answer }).click();
    await frame.waitForFunction(() => !window.gisworkbench.ai.assistant.busy);
  };

  // Consent: declining sends nothing.
  await ask('Propose a graphic at the view centre', 'Cancel');
  expect(await frame.evaluate(() => window.gisworkbench.ai.mock.requests.length)).toBe(0);
  // Agreeing runs the loop: gw_get_view → gw_create_graphic (a proposal) → final text.
  await ask('Propose a graphic at the view centre', 'Agree and send');
  const r1 = await frame.evaluate(() => {
    const app = window.gisworkbench;
    return {
      requests: app.ai.mock.requests.length,
      tools: app.ai.mock.requests[0].tools,
      transcript: app.ai.assistant.transcript.map((t) => t.who),
      pending: app.proposals.pending().length,
      graphics: app.store.all('graphic').length,
      lastUserBlocks: app.ai.mock.requests[1].messages.at(-1).content.map((b) => b.type),
    };
  });
  expect(r1.requests).toBe(3);
  expect(r1.tools).toEqual(expect.arrayContaining(['gw_list_layers', 'gw_get_view', 'gw_create_graphic']));
  expect(r1.transcript).toEqual(['user', 'ai', 'tool', 'tool', 'ai']);
  expect(r1.lastUserBlocks).toEqual(['tool_result']);
  expect(r1.pending).toBe(1);
  expect(r1.graphics).toBe(0); // nothing changes until accepted

  // Two more proposals: consent is not asked again in this session.
  await ask('Propose another graphic marking it');
  await ask('And mark one more graphic');
  const ids = await frame.evaluate(() => window.gisworkbench.proposals.items.map((p) => p.id).reverse());
  expect(ids).toHaveLength(3);
  await frame.locator('[data-id="ai:tab:proposals"]').click();
  await frame.locator(`[data-id="ai:reject:${ids[2]}"]`).click();
  await frame.locator(`[data-id="ai:accept:${ids[0]}"]`).click();
  const r2 = await frame.evaluate((ids) => {
    const app = window.gisworkbench;
    const st = (id) => app.proposals.items.find((p) => p.id === id).status;
    const g = app.store.all('graphic');
    return { status: ids.map(st), graphics: g.length, prov: g[0]?.provenance, acceptStale: app.proposals.accept(ids[1]), undoAuthor: app.undo.history()[0]?.author };
  }, ids);
  // The second proposal was made against the same base as the first and is now stale.
  expect(r2.status).toEqual(['accepted', 'stale', 'rejected']);
  expect(r2.acceptStale).toBe(false);
  expect(r2.graphics).toBe(1);
  expect(r2.prov).toMatchObject({ kind: 'ai', connection: 'Mock', model: 'mock-model' });
  expect(r2.undoAuthor).toBe('ai');
  await expect(frame.locator(`[data-id="proposal:${ids[1]}"] .ai-prop-status`)).toHaveText('stale');

  // Keys stay in memory (or sessionStorage on request) and never reach localStorage, the
  // project, the feedback export or a saved copy of the file.
  const k = await frame.evaluate(async () => {
    const app = window.gisworkbench;
    const SECRET = 'sk-ant-pt12-0123456789abcdef';
    app.ai.keys.set('conn_real', SECRET);
    const ls = Object.keys(localStorage).map((x) => localStorage.getItem(x)).join('\n');
    const ss1 = Object.keys(sessionStorage).map((x) => sessionStorage.getItem(x)).join('\n');
    app.ai.keys.set('conn_real', SECRET, { session: true });
    const ss2 = Object.keys(sessionStorage).map((x) => sessionStorage.getItem(x)).join('\n');
    const proj = new TextDecoder().decode(app.__test.serialiseProject(app));
    const fb = JSON.stringify(app.feedbackForAi());
    const self = document.documentElement.outerHTML;
    const has = app.ai.keys.has('conn_real');
    app.ai.keys.clear('conn_real');
    return { ls: ls.includes(SECRET), ss1: ss1.includes(SECRET), ss2: ss2.includes(SECRET), proj: proj.includes(SECRET), fb: fb.includes(SECRET), self: self.includes(SECRET), has, cleared: !app.ai.keys.has('conn_real') && !Object.values(sessionStorage).some((v) => v.includes(SECRET)) };
  });
  expect(k).toEqual({ ls: false, ss1: false, ss2: true, proj: false, fb: false, self: false, has: true, cleared: true });
  expect(logs).toEqual([]);
});
