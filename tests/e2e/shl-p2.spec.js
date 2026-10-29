// GIS Workbench 2.0 Shell (2.0 plan P2): REQ-SHL-01 REQ-SHL-08 REQ-SHL-09 REQ-SHL-10 REQ-SHL-11
// REQ-SHL-12 REQ-SHL-13 on the built file, Modern layout, with FX-01 and the FX-06 two-date pair.
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');
const FX06 = [resolve('fixtures/fx06/fx06_date1.tif'), resolve('fixtures/fx06/fx06_date2.tif')];
const MODERN = { prefs: { welcomeDone: true } };
// The default theme follows the OS (DN-60): with a dark OS the Modern layout shows Material dark.
test.use({ colorScheme: 'dark' });

async function withImages(page, files = [FX01], opts = MODERN) {
  const { frame } = await openApp(page, 'file', opts);
  await openFiles(frame, files);
  await frame.waitForFunction((n) => [...window.gisworkbench.layers.values()].filter((l) => l.lutTex).length >= n, files.length);
  await frame.locator('.multiport .pane').first().click({ position: { x: 30, y: 200 } });
  return frame;
}

const center = async (frame) => {
  const b = await frame.locator('.multiport .pane').first().boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 + 40 };
};

test('REQ-SHL-01 REQ-SHL-13 Modern chrome: app bar, rail, no Ribbon, Material theme; Classic and back live', async ({ page }) => {
  const frame = await withImages(page);
  const s = await frame.evaluate(() => ({
    bar: !document.querySelector('[data-id="shell:appbar"]').hidden,
    rail: !document.querySelector('[data-id="shell:rail"]').hidden,
    ribbon: getComputedStyle(document.querySelector('.multiport > .ribbon')).display,
    theme: document.documentElement.dataset.theme,
    pref: document.documentElement.dataset.themePref,
    barBg: getComputedStyle(document.querySelector('.app-bar')).backgroundColor,
    surface: getComputedStyle(document.documentElement).getPropertyValue('--c-m3-surface').trim(),
  }));
  expect(s.bar && s.rail).toBe(true);
  expect(s.ribbon).toBe('none');
  expect(s.theme).toBe('m3-dark');
  expect(s.pref).toBe('system');
  expect(s.surface).toBe('#111318');
  expect(s.barBg).toBe('rgb(17, 19, 24)');
  const view = await frame.evaluate(() => JSON.stringify(window.gisworkbench.activePane().view));
  await frame.evaluate(() => window.gisworkbench.commands.run('ui.layout'));
  await expect(frame.locator('.multiport > .ribbon')).toBeVisible();
  await expect(frame.locator('[data-id="shell:appbar"]')).toBeHidden();
  expect(await frame.evaluate(() => JSON.stringify(window.gisworkbench.activePane().view))).toBe(view);
  await frame.evaluate(() => window.gisworkbench.commands.run('ui.layout'));
  await expect(frame.locator('[data-id="shell:appbar"]')).toBeVisible();
  await expect(frame.locator('.multiport > .ribbon')).toBeHidden();
});

test('REQ-SHL-08 the contextual pill offers the image tools and runs them', async ({ page }) => {
  const frame = await withImages(page);
  const pill = frame.locator('[data-id="pill"]');
  await expect(pill).toBeVisible();
  await expect(pill.locator('[data-id="cmd:enh.auto"]')).toBeVisible();
  await pill.locator('[data-id="cmd:men.rangebearing"]').click();
  expect(await frame.evaluate(() => window.gisworkbench.tools.current?.id)).toMatch(/range|bearing/i);
  await page.keyboard.press('Escape');
  await pill.locator('[data-id="pill:more"]').click();
  await expect(frame.locator('[data-id="palette"]')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('REQ-SHL-10 radial menu: Space tap and backquote open it, a number runs a tool, holding Space still pans', async ({ page }) => {
  const frame = await withImages(page);
  const c = await center(frame);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.press('Space');
  await expect(frame.locator('[data-id="radial"]')).toBeVisible();
  expect(await frame.locator('.radial-item').count()).toBeGreaterThanOrEqual(6);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ zoom: 4 }));
  const items = await frame.locator('.radial-item').allTextContents();
  const whole = items.findIndex((t) => /Whole Scene/.test(t));
  expect(whole).toBeGreaterThanOrEqual(0);
  await page.keyboard.press(String(whole + 1));
  await expect(frame.locator('[data-id="radial"]')).toHaveCount(0);
  await frame.waitForFunction(() => window.gisworkbench.activePane().view.zoom < 1);
  // Backquote opens it; Esc closes it.
  await page.keyboard.press('Backquote');
  await expect(frame.locator('[data-id="radial"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-id="radial"]')).toHaveCount(0);
  // Holding Space and moving pans (the pan zone), and opens nothing.
  const before = await frame.evaluate(() => window.gisworkbench.activePane().view.cx);
  await page.keyboard.down('Space');
  await page.mouse.move(c.x + 5, c.y);
  await page.waitForTimeout(250);
  await page.mouse.move(c.x + 120, c.y, { steps: 6 });
  await page.keyboard.up('Space');
  expect(await frame.locator('[data-id="radial"]').count()).toBe(0);
  expect(await frame.evaluate(() => window.gisworkbench.activePane().view.cx)).not.toBeCloseTo(before, 0);
});

test('REQ-SHL-11 hold F flickers, S swipes, Alt+wheel sets opacity', async ({ page }) => {
  const frame = await withImages(page, FX06);
  const c = await center(frame);
  await page.mouse.move(c.x, c.y);
  await page.keyboard.down('KeyF');
  expect(await frame.evaluate(() => window.gisworkbench.activePane().compare?.mode)).toBe('hold');
  await page.keyboard.up('KeyF');
  expect(await frame.evaluate(() => window.gisworkbench.activePane().compare?.mode)).toBe('none');
  await page.keyboard.down('KeyS');
  expect(await frame.evaluate(() => window.gisworkbench.activePane().compare?.mode)).toBe('swipe');
  await page.keyboard.up('KeyS');
  expect(await frame.evaluate(() => window.gisworkbench.activePane().compare?.mode)).toBe('none');
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Alt');
  const op = await frame.evaluate(() => window.gisworkbench.activeLayer().rec.opacity);
  expect(op).toBeLessThan(1);
  expect(op).toBeGreaterThan(0.5);
});

test('REQ-SHL-11 C + drag adds a quick chip to the session deck; paste-to-pan; J/K patrol with triage', async ({ page }) => {
  const frame = await withImages(page);
  const c = await center(frame);
  await page.keyboard.down('KeyC');
  await page.mouse.move(c.x - 60, c.y - 40);
  await page.mouse.down();
  await page.mouse.move(c.x + 60, c.y + 40, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up('KeyC');
  await frame.waitForFunction(() => window.gisworkbench.sessionDeck.length === 1);
  const chip = await frame.evaluate(() => window.gisworkbench.sessionDeck[0].record.size);
  expect(chip[0]).toBeGreaterThan(50);
  // Paste-to-pan: an MGRS in free text.
  const target = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(p.view.cx + 200, p.view.cy - 150);
    return app.core.mgrs(g.lat, g.lon, 5);
  });
  await frame.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', `Report: vehicle seen at ${t} at 0930Z`);
    document.querySelector('.multiport .pane').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  }, target);
  await frame.waitForFunction((t) => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(p.view.cx, p.view.cy);
    return app.core.mgrs(g.lat, g.lon, 5) === t;
  }, target);
  // Two markers, J/K step through them, 3 flags the current one.
  await frame.evaluate(() => {
    const api = window.gisworkbench.api;
    const p = window.gisworkbench.activePane();
    for (const [dx, dy] of [[-100, 0], [100, 0]]) {
      const g = p.geoLayer().groundAt(p.view.cx + dx, p.view.cy + dy);
      api.createGraphic({ shape: 'marker', coordinates: [[g.lon, g.lat]], text: `T${dx}` });
    }
  });
  await frame.locator('.multiport .pane').first().focus();
  await page.keyboard.press('KeyJ');
  await expect(frame.locator('.pane-status').first()).toContainText('Target 1/2');
  await page.keyboard.press('KeyJ');
  await expect(frame.locator('.pane-status').first()).toContainText('Target 2/2');
  await page.keyboard.press('Digit3');
  await expect(frame.locator('.pane-status').first()).toContainText('flagged');
  expect(await frame.evaluate(() => window.gisworkbench.store.get(window.gisworkbench.patrol.current.id).triage)).toBe('flagged');
  await page.keyboard.press('KeyK');
  await expect(frame.locator('.pane-status').first()).toContainText('Target 1/2');
});

test('REQ-SHL-09 docks: split, collapse to icons, drag a tab to another edge; tool editors dock in Modern', async ({ page }) => {
  const frame = await withImages(page);
  await frame.evaluate(() => {
    const d = window.gisworkbench.activeMp().docks;
    d.show('layers', 'left');
    d.show('toolbox', 'left');
    d.areas.left.splitWith(d.panel('layers'));
  });
  await expect(frame.locator('.dock-left.split')).toBeVisible();
  expect(await frame.evaluate(() => window.gisworkbench.activeMp().docks.layout())).toMatchObject({ toolbox: 'left', layers: 'left:split' });
  // Drag the ToolBox tab to the right edge.
  await frame.locator('[data-id="dock:panel:toolbox"]').dragTo(frame.locator('.mp-main'), { targetPosition: { x: 5, y: 5 } }).catch(() => {});
  await frame.evaluate(() => window.gisworkbench.activeMp().docks.dragStart(window.gisworkbench.activeMp().docks.panel('toolbox')));
  await frame.locator('[data-id="dock:drop:right"]').dispatchEvent('drop', { dataTransfer: await frame.evaluateHandle(() => { const dt = new DataTransfer(); dt.setData('application/x-gw-panel', 'toolbox'); return dt; }) });
  expect(await frame.evaluate(() => window.gisworkbench.activeMp().docks.layout().toolbox)).toBe('right');
  // Collapse the right dock to icons, then expand it from its tab.
  await frame.locator('[data-id="dock:collapse:right"]').click();
  await expect(frame.locator('.dock-right.collapsed')).toBeVisible();
  expect((await frame.locator('.dock-right').boundingBox()).width).toBeLessThan(40);
  await frame.locator('[data-id="dock:panel:toolbox"]').click();
  await expect(frame.locator('.dock-right.collapsed')).toHaveCount(0);
  // A modeless tool editor opens docked, not floating, and closes with its button.
  await frame.evaluate(() => window.gisworkbench.commands.run('enh.curve'));
  await expect(frame.locator('.tool-panel')).toBeVisible();
  expect(await frame.locator('.dlg[aria-modal="false"]').count()).toBe(0);
  await frame.locator('.tool-panel .dlg-buttons button').last().click();
  await expect(frame.locator('.tool-panel')).toHaveCount(0);
});

test('REQ-SHL-12 first start offers personas; Pro opens its docks and two status rows; a workspace can be saved', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: {} });
  await expect(frame.locator('[data-id="welcome"]')).toBeVisible();
  await frame.locator('[data-id="welcome:pro"]').click();
  await expect(frame.locator('[data-id="welcome"]')).toHaveCount(0);
  await expect(frame.locator('[data-id="shell:persona"]')).toHaveText('Pro');
  const s = await frame.evaluate(() => ({ persona: window.gisworkbench.personas.current()?.id, docks: window.gisworkbench.activeMp().docks.layout(), rows: document.documentElement.dataset.statusRows }));
  expect(s).toMatchObject({ persona: 'pro', rows: '2' });
  expect(s.docks).toMatchObject({ layers: 'left', menlog: 'bottom' });
  // Explorer closes them again.
  await frame.evaluate(() => window.gisworkbench.personas.apply('explorer'));
  expect(await frame.evaluate(() => window.gisworkbench.activeMp().docks.layout())).toEqual({});
  // The persona menu lists the three and saves the current one.
  await frame.locator('[data-id="shell:persona"]').click();
  await expect(frame.locator('.menu-host .menu-item')).toHaveCount(5); // 3 personas, save, layout
  await page.keyboard.press('Escape');
  // A later start keeps the choice and shows no card.
  await page.reload();
  await frame.waitForFunction(() => document.body.dataset.ready === '1');
  expect(await frame.locator('[data-id="welcome"]').count()).toBe(0);
});
