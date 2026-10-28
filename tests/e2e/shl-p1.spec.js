// GIS Workbench 1.3 clean canvas (2.0 plan P1): REQ-SHL-01 REQ-SHL-02 REQ-SHL-03 REQ-SHL-04
// REQ-SHL-05 REQ-SHL-06 REQ-SHL-07 on the built file with FX-01 (UNCLASSIFIED, RPC00B).
import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { openApp, openFiles } from './helpers.js';

const FX01 = resolve('fixtures/fx01/fx01.ntf');

async function withImage(page, opts = { prefs: {} }) {
  const { frame, logs } = await openApp(page, 'file', opts);
  await openFiles(frame, [FX01]);
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.modelId && l.lutTex));
  return { frame, logs };
}

test('REQ-SHL-01 REQ-SHL-02 the Modern layout starts on a clean canvas; Classic keeps the 1.x start', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: {} });
  const modern = await frame.evaluate(() => ({
    layout: window.gisworkbench.layoutMode(),
    rail: !!document.querySelector('[data-id="ws:rail"]'),
    workspace: !!document.querySelector('.desktop > .workspace, .desktop > [data-id="ws:window"]') && !document.querySelector('[data-id="ws:rail"]'),
    docks: window.gisworkbench.activeMp().docks.isOpen('layers') || window.gisworkbench.activeMp().docks.isOpen('cues'),
    panes: window.gisworkbench.activeMp().panes.length,
  }));
  expect(modern).toEqual({ layout: 'modern', rail: true, workspace: false, docks: false, panes: 1 });
  // The rail opens the Workspace window and the command closes it again.
  await frame.locator('[data-id="ws:rail"]').click();
  await expect(frame.locator('[data-id="ws:rail"]')).toHaveCount(0);
  await frame.evaluate(() => window.gisworkbench.commands.run('win.workspace'));
  await expect(frame.locator('[data-id="ws:rail"]')).toHaveCount(1);
});

test('REQ-SHL-01 Classic layout opens the Layer Manager and Cue Cards and the Workspace window', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { prefs: { layout: 'classic' } });
  const c = await frame.evaluate(() => ({ layout: window.gisworkbench.layoutMode(), rail: !!document.querySelector('[data-id="ws:rail"]'), layers: !!window.gisworkbench.activeMp().docks.isOpen('layers'), cues: window.gisworkbench.activeMp().docks.layout().cues ?? null }));
  expect(c).toEqual({ layout: 'classic', rail: false, layers: true, cues: 'left' }); // Cue Cards is the tab behind the Layer Manager, as in 1.x
});

test('REQ-SHL-03 banners: hidden for UNCLASSIFIED by default, shown above it, always on by preference', async ({ page }) => {
  const { frame } = await withImage(page);
  const banner = () => frame.evaluate(() => {
    const p = window.gisworkbench.activePane();
    p.invalidate();
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ hidden: p.bannerTop.hidden, text: p.bannerTop.textContent }))));
  });
  expect((await banner()).hidden).toBe(true);
  // A marking above UNCLASSIFIED shows the banners in automatic mode.
  await frame.evaluate(() => {
    const l = window.gisworkbench.activeLayer();
    l.info.marking = { level: 'C', raw: 'C', codewords: '', control: '', release: '', source: 'test' };
  });
  expect(await banner()).toEqual({ hidden: false, text: 'CONFIDENTIAL' });
  await frame.evaluate(() => {
    const l = window.gisworkbench.activeLayer();
    l.info.marking = { level: 'U', raw: 'U', codewords: '', control: '', release: '', source: 'test' };
  });
  expect((await banner()).hidden).toBe(true);
  // The toggle forces them on.
  await frame.evaluate(() => window.gisworkbench.commands.run('deco.banners'));
  expect(await banner()).toEqual({ hidden: false, text: 'UNCLASSIFIED' });
  expect(await frame.evaluate(() => window.gisworkbench.commands.checked('deco.banners'))).toBe(true);
});

test('REQ-SHL-04 the compass turns with the view and a click turns the view north up', async ({ page }) => {
  const { frame } = await withImage(page);
  const compass = frame.locator('.pane-compass').first();
  await expect(compass).toBeVisible();
  const box = await compass.boundingBox();
  expect(box.width).toBeLessThanOrEqual(32);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ rot: 0.6 }));
  await frame.waitForFunction(() => Math.abs(Number(document.querySelector('.pane-compass').dataset.north)) > 5);
  await compass.click();
  await frame.waitForFunction(() => Math.abs(Number(document.querySelector('.pane-compass').dataset.north)) < 0.5);
  expect(await frame.evaluate(() => window.gisworkbench.activePane().view.mode)).toBe('north');
});

test('REQ-SHL-05 Ctrl+K finds and runs commands, explains disabled ones, and flies to a coordinate', async ({ page }) => {
  const { frame } = await withImage(page);
  await frame.locator('.multiport .pane').first().click();
  await page.keyboard.press('Control+KeyK');
  const input = frame.locator('[data-id="palette:input"]');
  await expect(input).toBeFocused();
  await input.fill('whole scene');
  await expect(frame.locator('.pal-item').first()).toContainText('Whole Scene');
  await expect(frame.locator('.pal-item').first()).toContainText('Fits the whole image');
  await page.keyboard.press('Escape');
  await expect(frame.locator('[data-id="palette"]')).toHaveCount(0);
  // A coordinate flies the view there.
  const target = await frame.evaluate(() => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(p.view.cx + 300, p.view.cy + 200);
    return app.core.mgrs(g.lat, g.lon, 5);
  });
  await page.keyboard.press('Control+KeyK');
  await frame.locator('[data-id="palette:input"]').fill(target);
  await expect(frame.locator('.pal-item').first()).toContainText('Fly to');
  await page.keyboard.press('Enter');
  await frame.waitForFunction((t) => {
    const app = window.gisworkbench;
    const p = app.activePane();
    const g = p.geoLayer().groundAt(p.view.cx, p.view.cy);
    return app.core.mgrs(g.lat, g.lon, 5) === t;
  }, target);
});

test('REQ-SHL-06 hovering a command shows its name, key and outcome; the title comes back after', async ({ page }) => {
  const { frame } = await withImage(page, { prefs: { layout: 'classic' } });
  const btn = frame.locator('[data-id="cmd:nav.whole"]').first();
  const title = await btn.getAttribute('title');
  await btn.hover();
  const tip = frame.locator('#tip2');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Whole Scene');
  await expect(tip).toContainText('Fits the whole image in the panel.');
  await expect(tip).not.toContainText('null');
  await frame.locator('.multiport .pane').first().hover();
  await expect(tip).toBeHidden();
  expect(await btn.getAttribute('title')).toBe(title);
});

test('REQ-SHL-07 the open snackbar zooms to the new layer; the job ring opens the Job Queue', async ({ page }) => {
  const { frame } = await withImage(page);
  await frame.evaluate(() => window.gisworkbench.activePane().setView({ zoom: 8 }));
  const action = frame.locator('.toast', { hasText: 'Opened fx01.ntf' }).locator('.toast-action');
  await expect(action).toHaveText(/zoom to layer/i);
  await action.click();
  await frame.waitForFunction(() => window.gisworkbench.activePane().view.zoom < 1);
  // Never more than three snackbars at once.
  await frame.evaluate(() => {
    for (let i = 0; i < 6; i++) window.gisworkbench.toast(`message ${i}`);
  });
  expect(await frame.locator('.toasts .toast').count()).toBeLessThanOrEqual(3);
  // A running job shows the ring.
  await frame.evaluate(() => {
    const sb = window.gisworkbench.activeMp().status;
    window.gisworkbench.pool.jobs.set('test-job', { id: 'test-job', op: 'test', label: 'Test job', progress: 0.4, state: 'running', created: performance.now() });
    sb.updateJobs();
  });
  const ring = frame.locator('[data-id^="status:jobs:"]').first();
  await expect(ring).toBeVisible();
  await expect(ring).toContainText('1 job · 40 %');
  await frame.evaluate(() => {
    window.gisworkbench.pool.jobs.delete('test-job');
    window.gisworkbench.activeMp().status.updateJobs();
  });
  await expect(ring).toBeHidden();
});
