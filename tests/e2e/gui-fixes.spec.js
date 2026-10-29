// Regression tests for the v1.1.0 GUI campaign findings (docs/validation/GUI-findings.md), each
// driven through the GUI of the built Standard or Lite file.

import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { openApp, openFiles, ROOT } from './helpers.js';

const LITE = join(ROOT, 'dist', 'gis-workbench-lite.html');
const FX = (...p) => join(ROOT, 'fixtures', ...p);
const MP = 'section.multiport';

async function settledImages(frame) {
  await frame.waitForFunction(() => {
    const ls = [...window.gisworkbench.layers.values()];
    return ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading));
  }, null, { timeout: 60_000 });
}

async function lastToast(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => ({ kind: [...t.classList].find((c) => c.startsWith('toast-')), text: t.textContent })).at(-1) ?? null);
}

test('GUI-001 Lite: a 3D view or video player names the module Lite leaves out', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: LITE });
  const msg = await frame.evaluate(() => window.__gw.runScript('js-three').then(() => 'loaded', (e) => e.message));
  expect(msg).toMatch(/3D module, which GIS Workbench Lite leaves out/);
  const vid = await frame.evaluate(() => window.__gw.runScript('js-mpegts').then(() => 'loaded', (e) => e.message));
  expect(vid).toMatch(/video module, which GIS Workbench Lite leaves out/);
});

test('GUI-002 LAS export writes the GIS Workbench version', async ({ page }) => {
  const { frame } = await openApp(page);
  await frame.evaluate(() => Object.assign(window.gisworkbench.runMode.caps, { fsaSave: false }));
  await openFiles(frame, [FX('fx09', 'fx09_ftus.las')]);
  await frame.waitForFunction(() => window.gisworkbench.store.all('pointcloud').length, null, { timeout: 60_000 });
  await frame.evaluate(() => void window.gisworkbench.commands.run('pc.export'));
  await page.locator('[data-id="dialog:pc-export"]').waitFor();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-id="dialog:pc-export"] .btn-primary').click()]);
  const bytes = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c));
  const version = await frame.evaluate(() => window.gisworkbench.build.version);
  expect(bytes.includes(Buffer.from(`GIS Workbench ${version}`))).toBe(true);
});

test('GUI-003 Ctrl+F1 minimises and restores the Ribbon', async ({ page }) => {
  await openApp(page);
  await page.locator(`${MP} .pane`).first().focus();
  await page.keyboard.press('Control+F1');
  await expect(page.locator(`${MP} .ribbon`)).toHaveClass(/\bmin\b/);
  await page.keyboard.press('Control+F1');
  await expect(page.locator(`${MP} .ribbon`)).not.toHaveClass(/\bmin\b/);
});

test('GUI-004 View ▸ Split toggles one panel and the last split layout', async ({ page }) => {
  await openApp(page);
  await page.locator(`${MP} [data-id="ribbon:tab:view"]`).click();
  const split = page.locator(`${MP} [data-id="cmd:win.split"]`);
  await split.click();
  await expect(page.locator(`${MP} .pane`)).toHaveCount(2);
  await page.locator(`${MP} [data-id="cmd:win.split:menu"]`).click();
  await page.locator('.menu-host .menu-item', { hasText: '2 × 2' }).click();
  await expect(page.locator(`${MP} .pane`)).toHaveCount(4);
  await split.click();
  await expect(page.locator(`${MP} .pane`)).toHaveCount(1);
  await split.click();
  await expect(page.locator(`${MP} .pane`)).toHaveCount(4);
});

test('GUI-005 Workspace View ▸ Import Log opens the Import Log dock', async ({ page }) => {
  await openApp(page);
  await page.locator('[data-id="menu:View"]').click();
  await page.locator('.menu-host .menu-item', { hasText: 'Import Log' }).click();
  await expect(page.locator(`${MP} [data-id="panel:importlog"]`)).toBeVisible();
});

test('GUI-007 Lite greys out 3D, LiDAR and SAR-analysis commands with a reason', async ({ page }) => {
  const { frame } = await openApp(page, 'file', { htmlPath: LITE });
  await page.locator(`${MP} [data-id="ribbon:tab:view"]`).click();
  const b = page.locator(`${MP} [data-id="cmd:3d.open"]`);
  await expect(b).toBeDisabled();
  await expect(b).toHaveAttribute('title', /not in GIS Workbench Lite/);
  expect(await frame.evaluate(() => ['file.openpointcloud', 'pc.stream', 'sar.ccd', 'sar.pauli'].map((c) => window.gisworkbench.commands.enabled(c)))).toEqual([false, false, false, false]);
  expect(await frame.evaluate(() => window.gisworkbench.commands.enabled('nav.zoomin') !== undefined && window.gisworkbench.commands.enabled('file.openimage'))).toBe(true);
  await frame.evaluate(() => window.gisworkbench.commands.run('3d.open'));
  expect((await lastToast(frame)).text).toMatch(/Lite leaves out: open the Standard file/);
});

test('GUI-008 About names the edition; Help ▸ What\'s New shows this version', async ({ page }) => {
  const { frame } = await openApp(page);
  const version = await frame.evaluate(() => window.gisworkbench.build.version);
  await page.locator('[data-id="menu:Help"]').click();
  await page.locator('.menu-host .menu-item', { hasText: 'About' }).click();
  await expect(page.locator('[data-id="dialog:about"]')).toContainText(`GIS Workbench ${version} · Standard edition`);
  await page.locator('[data-id="dialog:about"] .btn', { hasText: "What's New" }).click();
  const wn = page.locator('[data-id="dialog:whatsnew"]');
  await expect(wn).toContainText(`Version ${version}`);
  await expect(wn.locator('.whatsnew-this')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(wn).toHaveCount(0);

  const lite = await page.context().newPage();
  const { frame: lf } = await openApp(lite, 'file', { htmlPath: LITE });
  await lf.evaluate(() => void window.gisworkbench.commands.run('help.about'));
  await expect(lite.locator('[data-id="dialog:about"]')).toContainText('Lite edition');
  const head = (await import('node:fs')).readFileSync(LITE, 'utf8').slice(0, 2000);
  expect(head).toContain(`<meta name="generator" content="GIS Workbench ${version} (Lite)">`);
});

test('GUI-010 a hot key for a greyed-out command says it is not available', async ({ page }) => {
  const { frame } = await openApp(page);
  await page.locator(`${MP} .pane`).first().focus();
  await page.keyboard.press('KeyW');
  await expect.poll(() => lastToast(frame)).toMatchObject({ kind: 'toast-info', text: expect.stringMatching(/Whole Scene is not available right now/) });
});

test('GUI-011 panels redraw at the new size when the window is resized', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  const { frame } = await openApp(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await expect.poll(() => frame.evaluate(() => document.querySelector('canvas').width === Math.round(1500 * devicePixelRatio))).toBe(true);
  const ov = await frame.evaluate(() => {
    const o = document.querySelector('.pane-overlay');
    return [o.width, Math.round(o.getBoundingClientRect().width * devicePixelRatio)];
  });
  expect(ov[0]).toBe(ov[1]);
});

test('GUI-012 GUI-014 a stereo pair opens from Layer Tools and every tab stays in the window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { frame } = await openApp(page);
  await openFiles(frame, [FX('fx02', 'fx02_a.ntf'), FX('fx02', 'fx02_b.ntf')]);
  await settledImages(frame);
  await page.locator(`${MP} [data-id="ribbon:tab:layers"]`).click();
  await page.locator(`${MP} [data-id="cmd:stereo.open"]`).click();
  await expect(page.locator(`${MP} [data-id="ribbon:tab:stereo"]`)).toBeVisible();
  const fit = await frame.evaluate(() => {
    const s = document.querySelector('section.multiport .ribbon-tabs');
    const r = s.getBoundingClientRect();
    return [...s.querySelectorAll('.rtab')].every((t) => t.getBoundingClientRect().right <= r.right + 1);
  });
  expect(fit).toBe(true);
});

test('GUI-013 the first observation can be made from Products ▸ Reports', async ({ page }) => {
  const { frame } = await openApp(page);
  await page.locator(`${MP} [data-id="ribbon:tab:products"]`).click();
  await page.locator(`${MP} [data-id="cmd:obs.toolbox"]`).click();
  await page.locator('[data-id="obs-text"]').fill('(U) Two vehicles at the gate');
  await page.locator('[data-id="dialog:obs-toolbox"] .btn-primary').click();
  await expect.poll(() => frame.evaluate(() => window.gisworkbench.store.all('observation').length)).toBe(1);
  await expect(page.locator(`${MP} [data-id="ribbon:tab:observation"]`)).toBeVisible();
});

test('GUI-017 the mouse wheel scrolls an overflowing Ribbon sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await openApp(page);
  await page.locator(`${MP} [data-id="ribbon:tab:view"]`).click();
  const body = page.locator(`${MP} .ribbon-body`);
  expect(await body.evaluate((b) => b.scrollWidth > b.clientWidth)).toBe(true);
  await body.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => body.evaluate((b) => b.scrollLeft)).toBeGreaterThan(0);
});

test('GUI-019 GUI-020 a "do this first" refusal is a warning and toasts do not block clicks', async ({ page }) => {
  const { frame } = await openApp(page);
  await frame.evaluate(() => window.gisworkbench.toast('draw an AOI around one example of the object first', { kind: 'error' }));
  const t = page.locator('.toasts .toast').last();
  await expect(t).toHaveClass(/toast-warn/);
  expect(await t.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe('none');
});

test('GUI-021 undoing and redoing an image open leaves no errors or stale read-outs', async ({ page }) => {
  const { frame, logs } = await openApp(page);
  await openFiles(frame, [FX('fx01', 'fx01.ntf')]);
  await settledImages(frame);
  await page.locator(`${MP} [data-id="qat:qat.undo"]`).click();
  await expect(page.locator(`${MP} [data-id="status:model"]`)).toHaveText('Math Model: none');
  await expect(page.locator(`${MP} [data-id^="layer:"]`)).toHaveCount(0);
  await page.locator(`${MP} [data-id="qat:qat.redo"]`).click();
  await expect(page.locator(`${MP} [data-id^="layer:"]`)).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(logs).toEqual([]);
});

test('GUI-025 choosing a submenu item closes the submenu too', async ({ page }) => {
  await openApp(page);
  await page.locator('[data-id="menu:View"]').click();
  await page.locator('.menu-host .menu-item', { hasText: 'Theme' }).hover();
  // The Theme submenu also lists Dark (Material) since 2.0.2: pick the classic Dark by its exact label.
  await page.locator('.menu-host .menu-item').filter({ has: page.locator('.menu-label', { hasText: /^Dark$/ }) }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.menu')).toHaveCount(0);
});

test('GUI-026 Esc closes a panel context menu while focus is still on the panel', async ({ page }) => {
  const { frame } = await openApp(page);
  await openFiles(frame, [FX('fx01', 'fx01.ntf')]);
  await settledImages(frame);
  const box = await page.locator(`${MP} .pane`).first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await expect(page.locator('.menu-host')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.menu-host')).toHaveCount(0);
});
