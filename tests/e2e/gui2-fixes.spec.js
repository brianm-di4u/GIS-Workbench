// Regression tests for the 2.0.1 GUI campaign findings (docs/validation/GUI-findings.md, GUI-028
// onwards), each driven through the GUI of a built file in the Modern layout unless it says so.
//   GW_DIST=dist-gui runs them against a scratch build.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, openFiles } from './helpers.js';
import { BUILDS, FX } from './gui-lib.js';

const MODERN = { layout: 'modern', welcomeDone: true, persona: 'explorer' };
const MP = 'section.multiport';

async function modern(page, files = [], { build = 'full', prefs = MODERN } = {}) {
  const app = await openApp(page, 'file', { htmlPath: BUILDS[build], prefs });
  if (files.length) {
    await openFiles(app.frame, files);
    await app.frame.waitForFunction(() => {
      const a = window.gisworkbench;
      const ls = [...a.layers.values()];
      return (ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading))) || a.fmv?.clips?.size;
    }, null, { timeout: 60_000 });
  }
  return app;
}

const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((t) => ({ kind: [...t.classList].find((c) => c.startsWith('toast-')), text: t.textContent })));

test('GUI-028 after undoing "Open image" the report and AI draft still open', async ({ page }) => {
  const { frame, logs } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  await page.locator('[data-id="shell:appbar"] [data-id="cmd:qat.undo"]').click();
  expect(await frame.evaluate(() => window.gisworkbench.layers.size)).toBe(0);
  await page.locator('[data-id="shell:rail"] [data-rail="products"]').click();
  await page.locator('.menu-host .menu-item', { hasText: 'Report Template' }).click();
  await expect(page.locator('.dlg[aria-label="Report Template"]')).toBeVisible();
  expect((await toasts(page)).filter((t) => t.kind === 'toast-error')).toEqual([]);
  expect(logs).toEqual([]);
});

test('GUI-029 Map Backgrounds and Prompt Helper name every control', async ({ page }) => {
  const { frame } = await modern(page);
  for (const cmd of ['online.add', 'ai.prompthelper']) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    const dlg = page.locator('.dlg[role="dialog"]').last();
    await dlg.waitFor();
    const unnamed = await dlg.evaluate((d) => [...d.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter((e) => !(e.getAttribute('aria-label') || e.labels?.length || e.closest('label') || e.title)).length);
    expect(unnamed, cmd).toBe(0);
    await page.keyboard.press('Escape');
  }
});

test('GUI-030 the radial menu slices do not overlap', async ({ page }) => {
  await modern(page, [FX('fx01', 'fx01.ntf')]);
  const b = await page.locator(`${MP} .pane`).first().boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.locator(`${MP} .pane`).first().focus();
  await page.keyboard.press('Space');
  const rects = await page.locator('[data-id="radial"] .radial-item').evaluateAll((bs) => bs.map((e) => e.getBoundingClientRect().toJSON()));
  expect(rects.length).toBe(8);
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const [a, c] = [rects[i], rects[j]];
    if (a.left < c.right && c.left < a.right && a.top < c.bottom && c.top < a.bottom) overlaps++;
  }
  expect(overlaps).toBe(0);
});

test('GUI-031 the light theme has a light status bar', async ({ page }) => {
  await modern(page, [], { prefs: { ...MODERN, theme: 'm3-light' } });
  const bg = await page.locator(`${MP} .statusbar`).evaluate((e) => getComputedStyle(e).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g).map(Number);
  expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeGreaterThan(200);
});

test('GUI-032 Triangulation steps that cannot run are greyed out and say why', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  await frame.evaluate(() => window.gisworkbench.activeMp().docks.show('triangulation'));
  for (const id of ['tri:auto', 'tri:solve', 'tri:apply', 'tri:remove']) {
    const b = page.locator(`[data-id="${id}"]`);
    await expect(b, id).toBeDisabled();
    expect(await b.getAttribute('title'), id).toBeTruthy();
  }
});

test('GUI-033 undoing an image of an open stereo pair closes stereo without draw errors', async ({ page }) => {
  const { frame, logs } = await modern(page, [FX('fx02', 'fx02_a.ntf'), FX('fx02', 'fx02_b.ntf')]);
  await frame.evaluate(() => window.gisworkbench.commands.run('stereo.open'));
  expect(await frame.evaluate(() => !!window.gisworkbench.activePane().stereo)).toBe(true);
  await page.locator('[data-id="shell:appbar"] [data-id="cmd:qat.undo"]').click();
  await page.waitForTimeout(800);
  expect(await frame.evaluate(() => !!window.gisworkbench.activePane().stereo)).toBe(false);
  expect(logs).toEqual([]);
});

test('GUI-034 the contextual pill offers the video tools over a video', async ({ page }) => {
  await modern(page, [FX('fx10', 'fx10.ts')]);
  await expect(page.locator('[data-id="pill"]')).toBeVisible();
  await expect(page.locator('[data-id="pill"] [data-id="cmd:fmv.play"]')).toBeVisible();
  await page.locator('[data-id="pill"] [data-id="cmd:fmv.klv"]').click();
  await expect(page.locator('.tool-panel[data-id="dialog:fmv-klv"]')).toBeVisible();
});

test('GUI-035 a wide editor docked in the Modern layout widens the dock', async ({ page }) => {
  await modern(page, [FX('fx10', 'fx10.ts')]);
  await page.locator('[data-id="pill"] [data-id="cmd:fmv.klv"]').click();
  const w = await page.locator('[data-id="dock:right"]').evaluate((e) => e.getBoundingClientRect().width);
  expect(w).toBeGreaterThan(400);
  expect(w).toBeLessThanOrEqual(1440 * 0.4 + 1);
});

test('GUI-036 About names the air-gapped edition', async ({ page }) => {
  const { frame } = await modern(page, [], { build: 'airgap' });
  await frame.evaluate(() => void window.gisworkbench.commands.run('help.about'));
  await expect(page.locator('.dlg .about')).toContainText('Air-gapped edition');
  await expect(page.locator('.dlg .about')).toContainText('makes no network requests');
});

test('GUI-037 a failure outside a command reaches the message log and the user once', async ({ page }) => {
  const { frame } = await modern(page);
  await frame.evaluate(() => {
    Promise.reject(new Error('probe failure'));
    Promise.reject(new Error('probe failure'));
  });
  await page.waitForTimeout(300);
  const t = (await toasts(page)).filter((x) => /probe failure/.test(x.text));
  expect(t.length).toBe(1);
  expect(t[0].kind).toBe('toast-error');
  expect(await frame.evaluate(() => window.gisworkbench.messages.some((m) => m.level === 'error' && /probe failure/.test(m.msg)))).toBe(true);
});

test('GUI-038 Modern hints name Modern controls: empty panel, AI connection', async ({ page }) => {
  const { frame } = await modern(page);
  await expect(page.locator(`${MP} .pane`).first()).toContainText('press Ctrl+K');
  await frame.evaluate(() => window.gisworkbench.commands.run('ai.assistant'));
  await page.locator('[data-id="ai:setup"]').click();
  await expect(page.locator('[data-id="dialog:ai-connections"]')).toBeVisible();
});

test('GUI-039 every rail item has its own icon', async ({ page }) => {
  await modern(page);
  const icons = await page.locator('[data-id="shell:rail"] .rail-item .rail-ic').evaluateAll((es) => es.map((e) => e.innerHTML));
  expect(new Set(icons).size).toBe(icons.length);
});

test('GUI-040 the AI attach options keep each label on one line', async ({ page }) => {
  const { frame } = await modern(page);
  await frame.evaluate(() => window.gisworkbench.commands.run('ai.assistant'));
  const hs = await page.locator('.ai-attach label').evaluateAll((ls) => ls.map((l) => l.getBoundingClientRect().height));
  for (const hh of hs) expect(hh).toBeLessThan(28);
});

test('GUI-041 About shows the worker pool in words', async ({ page }) => {
  const { frame } = await modern(page);
  await frame.evaluate(() => void window.gisworkbench.commands.run('help.about'));
  await expect(page.locator('.dlg .about')).toContainText(/Workers: \d+, \d+ busy, \d+ queued/);
});

test('GUI-042 New Project in the Modern layout raises no error', async ({ page }) => {
  const { frame, logs } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.newproject'));
  // Unsaved work: confirm discarding it.
  const dlg = page.locator('.dlg[role="dialog"]');
  if (await dlg.count()) await dlg.locator('.dlg-buttons .btn').filter({ hasText: /Discard|Don|OK|Yes|New/ }).first().click();
  await page.waitForTimeout(800);
  expect(await frame.evaluate(() => window.gisworkbench.messages.filter((m) => m.level === 'error').map((m) => m.msg))).toEqual([]);
  expect(logs).toEqual([]);
  expect((await toasts(page)).filter((t) => t.kind === 'toast-error')).toEqual([]);
});

test('GUI-045 after New Project and in a new window every dock panel is there', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  const panels = () => frame.evaluate(() => [...window.gisworkbench.activeMp().docks.registry.keys()].filter((k) => !k.startsWith('tool:')).sort());
  const before = await panels();
  expect(before.length).toBeGreaterThanOrEqual(20);
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.newproject'));
  const dlg = page.locator('.dlg[role="dialog"]');
  if (await dlg.count()) await dlg.locator('.dlg-buttons .btn').filter({ hasText: /Discard|Don|OK|Yes|New/ }).first().click();
  await page.waitForTimeout(500);
  expect(await panels()).toEqual(before);
  for (const rail of ['catalog', 'recipes', 'convert']) {
    await page.locator(`[data-id="shell:rail"] [data-rail="${rail}"]`).click();
    await expect(page.locator(`[data-id="shell:rail"] [data-rail="${rail}"]`)).toHaveAttribute('aria-pressed', 'true');
  }
  expect((await toasts(page)).filter((t) => t.kind === 'toast-error')).toEqual([]);
  await frame.evaluate(() => window.gisworkbench.commands.run('win.new'));
  expect(await panels()).toEqual(before);
});

test('GUI-043 a two-band image drapes in 3D', async ({ page }) => {
  const { frame, logs } = await modern(page, [FX('fx02', 'fx02_a.ntf'), FX('fx02', 'fx02_b.ntf')]);
  await frame.evaluate(() => void window.gisworkbench.commands.run('msi.stack'));
  await page.locator('[data-id="dialog:msi-stack"] .btn', { hasText: 'Stack' }).click();
  await frame.waitForFunction(() => [...window.gisworkbench.layers.values()].some((l) => l.bands === 2 && l.lutTex), null, { timeout: 60_000 });
  await frame.evaluate(() => window.gisworkbench.commands.run('glb.toggle'));
  await frame.waitForFunction(() => !!window.gisworkbench.activePane().view3d, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  expect(logs).toEqual([]);
  expect((await toasts(page)).filter((t) => t.kind === 'toast-error')).toEqual([]);
});

test('GUI-044 Classify without training classes is a warning, not an error', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx08', 'fx08.tif')]);
  await frame.evaluate(() => void window.gisworkbench.commands.run('search.find'));
  await page.locator('[data-id="dialog:find-in-scene"] .btn', { hasText: 'Classify' }).click();
  await page.waitForTimeout(400);
  const t = (await toasts(page)).filter((x) => /training classes/.test(x.text));
  expect(t.length).toBe(1);
  expect(t[0].kind).toBe('toast-warn');
});

test('GUI-046 Lite greys out 2D / 3D and shows no 3D button', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx01', 'fx01.ntf')], { build: 'lite' });
  expect(await frame.evaluate(() => window.gisworkbench.commands.liteGap('glb.toggle'))).toMatch(/Lite leaves out/);
  await expect(page.locator('.fab-3d')).toBeHidden();
  await page.keyboard.press('Control+k');
  await page.locator('[data-id="palette:input"]').fill('2D / 3D');
  await expect(page.locator('[data-id="palette:cmd:glb.toggle"]')).toHaveAttribute('aria-disabled', 'true');
});

test('GUI-047 greyed-out commands say what to open first', async ({ page }) => {
  await modern(page);
  const reason = async (q, id) => {
    await page.keyboard.press('Control+k');
    await page.locator('[data-id="palette:input"]').fill(q);
    const t = await page.locator(`[data-id="palette:cmd:${id}"] .pal-detail`).textContent();
    await page.keyboard.press('Escape');
    return t;
  };
  expect(await reason('NDVI', 'msi.index.ndvi')).toMatch(/open a multispectral image first/);
  expect(await reason('KLV Table', 'fmv.klv')).toMatch(/open a video/);
  expect(await reason('Auto Enhance', 'enh.auto')).toMatch(/open an image first/);
  expect(await reason('Stereo Panel', 'stereo.open')).toMatch(/3-D sensor models/);
});

test('GUI-048 greyed-out buttons look greyed out', async ({ page }) => {
  const { frame } = await modern(page);
  await frame.evaluate(() => window.gisworkbench.commands.run('rcp.open'));
  const run = page.locator('[data-id="recipe:run"]');
  await expect(run).toBeDisabled();
  expect(Number(await run.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.6);
  expect(Number(await page.locator('[data-id="recipe:open"]').evaluate((e) => getComputedStyle(e).opacity))).toBe(1);
});

test('GUI-049 dock tabs, buttons and hints are readable in every theme', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  await page.evaluate(readFileSync('node_modules/axe-core/axe.min.js', 'utf8')); // evaluate is not bound by the page's CSP
  const bad = [];
  for (const [layout, theme] of [['modern', 'm3dark'], ['modern', 'm3light'], ['modern', 'dark'], ['classic', 'grey'], ['classic', 'dark']]) {
    await frame.evaluate(([l, t]) => {
      window.gisworkbench.setLayout(l);
      window.gisworkbench.commands.run(`theme.${t}`);
      const d = window.gisworkbench.activeMp().docks;
      d.show('layers');
      d.show('recipes');
      d.show('catalog');
    }, [layout, theme]);
    await page.waitForTimeout(300);
    const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, exclude: [['#gl'], ['.pane-overlay'], ['.toasts']] })).violations.flatMap((x) => x.nodes.map((n) => n.target.join(' '))));
    bad.push(...v.map((t) => `${layout}/${theme}: ${t}`));
  }
  expect(bad).toEqual([]);
});

test('GUI-050 every dock panel fits the default dock width and opens at its top-left', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx01', 'fx01.ntf')]);
  const over = await frame.evaluate(async () => {
    const D = window.gisworkbench.activeMp().docks;
    const out = [];
    for (const id of [...D.registry.keys()].filter((k) => !k.startsWith('tool:'))) {
      D.show(id);
      await new Promise((r) => setTimeout(r, 200));
      const p = D.registry.get(id);
      const c = p.area?.content;
      if (c && c.scrollWidth > c.clientWidth + 1) out.push(`${id} ${c.scrollWidth}/${c.clientWidth}`);
      if (c) c.scrollTo(50, 50);
      D.close(p);
    }
    return out;
  });
  expect(over).toEqual([]);
  // Switching panels in one dock does not carry the scroll position over.
  const pos = await frame.evaluate(async () => {
    const D = window.gisworkbench.activeMp().docks;
    D.show('toolbox', 'right');
    const c = D.registry.get('toolbox').area.content;
    c.scrollTo(0, 200);
    D.show('layers', 'right');
    return [c.scrollLeft, c.scrollTop];
  });
  expect(pos).toEqual([0, 0]);
});

test('GUI-051 Catalog and Convert say what to do: empty Open and List, date labels, click-to-choose', async ({ page }) => {
  await modern(page);
  await page.locator('[data-id="shell:rail"] [data-rail="catalog"]').click();
  for (const [btn, re] of [['catalog:open-url', /Type an image address/], ['catalog:list', /Type a bucket address/]]) {
    await page.locator(`[data-id="${btn}"]`).click();
    await expect(page.locator('.toasts .toast').last()).toContainText(re);
  }
  await expect(page.locator('[data-id="panel:catalog"] label.fld', { hasText: 'From' })).toBeVisible();
  await page.locator('[data-id="shell:rail"] [data-rail="convert"]').click();
  await expect(page.locator('[data-id="convert:drop"]')).toContainText('click to choose');
});

test('GUI-052 Network Allow-List ▸ Save New Copy works with the list unchanged', async ({ page }) => {
  const { frame } = await modern(page);
  const r = await frame.evaluate(() => {
    try {
      // The origins the file already allows: saving them again changes nothing in the file.
      const csp = document.getElementById('csp').content;
      const now = /connect-src([^;]*)/.exec(csp)[1].trim().split(/\s+/).filter((o) => o !== 'blob:');
      return window.gisworkbench.__test.htmlWithOrigins(now).length > 1000;
    } catch (e) {
      return e.message;
    }
  });
  expect(r).toBe(true);
});

test('GUI-053 an empty or partial address is a warning that says what to enter', async ({ page }) => {
  const { frame } = await modern(page);
  for (const [cmd, id] of [['pc.stream', 'pc-stream'], ['3d.tiles', '3d-tiles'], ['3d.qmesh', '3d-qmesh'], ['vec.remoteopen', 'remote-edit']]) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    const dlg = page.locator(`[data-id="dialog:${id}"]`);
    await dlg.waitFor();
    await dlg.locator('.dlg-buttons .btn-primary').click();
    await page.waitForTimeout(300);
    const t = (await toasts(page)).at(-1);
    expect(t?.kind, cmd).toBe('toast-warn');
    expect(t?.text, cmd).toMatch(/enter .* first/i);
  }
});

test('GUI-054 Network Allow-List and Send to a Google Sheet name every field', async ({ page }) => {
  const { frame } = await modern(page);
  for (const cmd of ['ai.allowlist', 'hub.relay']) {
    await frame.evaluate((c) => void window.gisworkbench.commands.run(c), cmd);
    const dlg = page.locator('.dlg[role="dialog"]').last();
    await dlg.waitFor();
    const unnamed = await dlg.evaluate((d) => [...d.querySelectorAll('input:not([type="hidden"]), select, textarea')].filter((e) => !(e.getAttribute('aria-label') || e.labels?.length || e.closest('label') || e.title)).length);
    expect(unnamed, cmd).toBe(0);
    await page.keyboard.press('Escape');
  }
});

test('GUI-055 the air-gapped status stays on one line in a narrow window', async ({ page }) => {
  await modern(page, [], { build: 'airgap' });
  await page.setViewportSize({ width: 800, height: 600 });
  const b = page.locator('[data-id^="status:net:"]');
  await expect(b).toHaveText('Air-gapped');
  const h = await b.evaluate((e) => e.getBoundingClientRect().height);
  const line = await b.evaluate((e) => parseFloat(getComputedStyle(e).lineHeight) || 16);
  expect(h).toBeLessThan(line * 1.6 + 4);
});

test('GUI-056 a GeoTIFF DEM offers Use as Terrain, which brings up the Surface tools', async ({ page }) => {
  const { frame } = await modern(page, [FX('fx05', 'fx05_dem_hae.tif')]);
  await expect(page.locator('.toasts .toast', { hasText: 'looks like elevation data' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.locator('[data-id="palette:input"]').fill('Use as Terrain');
  await page.locator('[data-id="palette:cmd:dem.useterrain"]').click();
  await page.locator('[data-id="dialog:use-terrain"] .btn-primary').click();
  await frame.waitForFunction(() => window.gisworkbench.terrain.available);
  expect(await frame.evaluate(() => window.gisworkbench.ribbonContext(window.gisworkbench.activeMp()).hasDem)).toBe(true);
  expect(await frame.evaluate(() => window.gisworkbench.commands.enabled('los.viewshed') || window.gisworkbench.commands.enabled('dem.volume') || window.gisworkbench.commands.enabled('dem.contourlines'))).toBe(true);
});
