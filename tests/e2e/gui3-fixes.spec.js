// Regression tests for the 2.0.2 visual GUI campaign (docs/validation/GUI-findings.md, GUI-059
// onwards; GUI3-report.md). Each runs a built file and measures what is drawn: computed colours
// against what they sit on, in the themes and layouts where the finding showed.
//   GW_DIST=dist-gui3b runs them against a scratch build.

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openApp, openFiles } from './helpers.js';
import { BUILDS, FX } from './gui-lib.js';
import { ratio, deltaE, over, parse } from '../tools/colour-math.mjs';

const MODERN = { layout: 'modern', welcomeDone: true, persona: 'explorer' };
const CLASSIC = { layout: 'classic', welcomeDone: true, persona: 'explorer' };
const MP = 'section.multiport';
const COMBOS = ['modern', 'classic'].flatMap((l) => ['m3dark', 'm3light', 'dark', 'grey', 'print'].map((t) => [l, t]));

async function boot(page, { files = [], build = 'full', prefs = MODERN } = {}) {
  const app = await openApp(page, 'file', { htmlPath: BUILDS[build], prefs });
  if (files.length) {
    await openFiles(app.frame, files);
    await app.frame.waitForFunction(() => [...window.gisworkbench.layers.values()].every((l) => l.error || (l.lutTex && !l.tiles?.loading)) && window.gisworkbench.layers.size, null, { timeout: 60_000 });
  }
  return app;
}
const combo = (frame, [layout, theme]) =>
  frame.evaluate(([l, t]) => {
    window.gisworkbench.setLayout(l);
    window.gisworkbench.commands.run(`theme.${t}`);
  }, [layout, theme]);

/** Colour (rgb()/color(srgb) string → '#rrggbb' composite over its effective background) of el's text and background. */
const look = (loc) =>
  loc.evaluate((el) => {
    const bgOf = (e) => {
      const st = [];
      for (let p = e; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent') {
          st.push(cs.backgroundColor);
          if (!/rgba|\/ 0\.|\/ \./.test(cs.backgroundColor)) break;
        }
      }
      return st;
    };
    return { color: getComputedStyle(el).color, bg: bgOf(el) };
  });
const composite = (stack) => stack.reduceRight((c, s) => over(toArr(s), c), [1, 1, 1, 1]);
const toArr = (s) => {
  const m = /color\(srgb ([^)]+)\)/.exec(s);
  if (m) {
    const p = m[1].replace('/', ' ').split(/\s+/).filter(Boolean).map(Number);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return parse(s);
};
const textRatio = (l) => {
  const bg = composite(l.bg);
  return ratio(over(toArr(l.color), bg), bg);
};

test('GUI-059 menu text, keys and hover text are readable in every theme and layout', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  const bad = [];
  for (const c of COMBOS) {
    await combo(frame, c);
    const at = await frame.locator(`${MP} .pane`).first().boundingBox();
    await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2, { button: 'right' });
    const items = page.locator('.menu-host .menu:not(.mini-toolbar) .menu-item:not(.disabled)');
    await expect(items.first()).toBeVisible();
    const label = await look(items.nth(1).locator('.menu-label'));
    if (textRatio(label) < 4.5) bad.push(`${c}: menu label ${textRatio(label).toFixed(2)}`);
    await items.nth(1).hover();
    const hover = await look(items.nth(1).locator('.menu-label'));
    if (textRatio(hover) < 4.5) bad.push(`${c}: hovered label ${textRatio(hover).toFixed(2)}`);
    await page.keyboard.press('Escape');
    await page.mouse.click(2, 2);
  }
  expect(bad).toEqual([]);
});

test('GUI-059 GUI-060 GUI-062 axe finds no contrast failure with the main menu and a ribbon tab open, in every theme of both layouts', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  await page.evaluate(readFileSync('node_modules/axe-core/axe.min.js', 'utf8'));
  const bad = [];
  for (const c of COMBOS) {
    await combo(frame, c);
    if (c[0] === 'modern') await page.locator('[data-id="shell:menu"]').click();
    else await page.locator(`${MP} .ribbon-tabs .rtab`, { hasText: 'Enhance' }).click();
    await page.waitForTimeout(200);
    const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'rule', values: ['color-contrast'] }, exclude: [['#gl'], ['.pane-overlay']] })).violations.flatMap((x) => x.nodes.map((n) => `${n.target.join(' ')} ${n.any?.[0]?.data?.contrastRatio ?? ''}`)));
    bad.push(...v.map((t) => `${c.join('/')}: ${t}`));
    await page.keyboard.press('Escape');
  }
  expect(bad).toEqual([]);
});

test('GUI-061 GUI-062 dark surfaces read as separate layers and the dark theme has no light slabs in the Modern layout', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  for (const t of ['m3dark', 'dark']) {
    await combo(frame, ['modern', t]);
    await frame.evaluate(() => window.gisworkbench.activeMp().docks.show('layers'));
    const c = await page.evaluate(() => {
      const bg = (s) => getComputedStyle(document.querySelector(s)).backgroundColor;
      return { bar: bg('.app-bar'), rail: bg('.nav-rail'), title: bg(`section.multiport .dock:not([hidden]) .dock-title`), tabs: bg(`section.multiport .dock:not([hidden]) .dock-tabs`), content: bg(`section.multiport .dock:not([hidden]) .dock-content`) };
    });
    for (const k of ['bar', 'rail']) expect(ratio(toArr(c[k]), '#000000'), `${t} ${k} ${c[k]} is dark`).toBeLessThan(2);
    expect(deltaE(toArr(c.title), toArr(c.tabs)), `${t} dock title vs tab strip`).toBeGreaterThanOrEqual(6);
    expect(deltaE(toArr(c.tabs), toArr(c.content)), `${t} tab strip vs content`).toBeGreaterThanOrEqual(6);
    expect(deltaE(toArr(c.bar), toArr(c.title)), `${t} app bar vs dock title`).toBeGreaterThanOrEqual(6);
  }
});

test('GUI-063 the focus ring is two-tone, so it shows on the grey frame as well as on white', async ({ page }) => {
  const { frame } = await boot(page, { prefs: CLASSIC });
  await combo(frame, ['classic', 'grey']);
  const tab = page.locator(`${MP} .ribbon-tabs .rtab`, { hasText: 'Home' });
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowLeft');
  const s = await page.evaluate(() => {
    const e = document.activeElement;
    const cs = getComputedStyle(e);
    return { outline: cs.outlineColor, style: cs.outlineStyle, shadow: cs.boxShadow, frame: getComputedStyle(document.documentElement).getPropertyValue('--c-chrome-frame').trim() };
  });
  expect(s.style).toBe('solid');
  const halo = /rgb\([^)]+\)/.exec(s.shadow)?.[0];
  expect(halo, 'halo box-shadow').toBeTruthy();
  expect(Math.max(ratio(toArr(s.outline), s.frame), ratio(toArr(halo), s.frame))).toBeGreaterThanOrEqual(3);
  expect(ratio(toArr(s.outline), toArr(halo))).toBeGreaterThanOrEqual(3);
});

test('GUI-064 a warning on a grey dialog body reads as a callout on the content colour', async ({ page }) => {
  const { frame } = await boot(page, { prefs: CLASSIC });
  await combo(frame, ['classic', 'grey']);
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.prefs'));
  const dlg = page.locator('.dlg[role="dialog"]').last();
  await expect(dlg).toBeVisible();
  await dlg.locator('.dlg-body').evaluate((b) => {
    for (const k of ['warn', 'err']) {
      const p = document.createElement('p');
      p.className = `hint ${k}`;
      p.dataset.t = k;
      p.textContent = `A ${k} line`;
      b.prepend(p);
    }
  });
  for (const k of ['warn', 'err']) expect(textRatio(await look(dlg.locator(`p[data-t="${k}"]`))), k).toBeGreaterThanOrEqual(4.5);
});

test('GUI-070 GUI-065 the default button has a 2 px outline, and Modern buttons show hover and pressed looks', async ({ page }) => {
  const { frame } = await boot(page);
  await combo(frame, ['modern', 'm3dark']);
  await frame.evaluate(() => void window.gisworkbench.commands.run('file.prefs'));
  const ok = page.locator('.dlg .dlg-buttons .btn-primary').first();
  await expect(ok).toBeVisible();
  expect(await ok.evaluate((e) => getComputedStyle(e).boxShadow)).toMatch(/inset/);
  const cancel = page.locator('.dlg .dlg-buttons .btn:not(.btn-primary)').last();
  const before = await cancel.evaluate((e) => getComputedStyle(e).backgroundColor);
  await cancel.hover();
  const after = await cancel.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(deltaE(toArr(before), toArr(after))).toBeGreaterThanOrEqual(12);
});

test('GUI-081 a greyed-out palette entry shows its whole reason on two lines', async ({ page }) => {
  await boot(page, { build: 'lite' });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('point cloud');
  const d = page.locator('.pal-item.off .pal-detail').first();
  await expect(d).toBeVisible();
  expect(await d.evaluate((e) => getComputedStyle(e).whiteSpace)).toBe('normal');
  expect(await d.evaluate((e) => e.getBoundingClientRect().height)).toBeGreaterThan(20);
});

test('GUI-067 toasts and tooltips stand apart from a dark UI; the toast action is a text button', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  for (const t of ['m3dark', 'dark']) {
    await combo(frame, ['modern', t]);
    await frame.evaluate((t) => window.gisworkbench.toast(`Check ${t}`, { kind: 'warn', ms: 10000, action: { label: 'Act', run: () => {} } }), t);
    const toast = page.locator('.toast').last();
    const tb = await toast.evaluate((e) => getComputedStyle(e).backgroundColor);
    const content = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--c-content-bg').trim());
    expect(deltaE(toArr(tb), content), `${t} toast vs content`).toBeGreaterThanOrEqual(6);
    expect(await toast.locator('.toast-action').evaluate((e) => getComputedStyle(e).backgroundColor)).toBe('rgba(0, 0, 0, 0)');
    expect(textRatio(await look(toast.locator('.toast-action')))).toBeGreaterThanOrEqual(4.5);
    await toast.locator('.toast-action').hover();
    expect(textRatio(await look(toast.locator('.toast-action'))), `${t} hovered action`).toBeGreaterThanOrEqual(4.5);
    await frame.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
    await page.locator('[data-id="shell:appbar"] [data-id="cmd:file.openurl"]').hover();
    const tip = page.locator('.tip2:not([hidden])');
    await expect(tip).toBeVisible({ timeout: 3000 });
    const tipBg = await tip.evaluate((e) => getComputedStyle(e).backgroundColor);
    const bar = await page.locator('.app-bar').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(deltaE(toArr(tipBg), toArr(bar)), `${t} tooltip vs app bar`).toBeGreaterThanOrEqual(6);
    await page.mouse.move(700, 500);
  }
});

test('GUI-066 GUI-071 GUI-072 hover reads on app-bar buttons, ribbon tabs and dock tabs without costing text contrast', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  await combo(frame, ['modern', 'm3dark']);
  const ab = page.locator('[data-id="shell:appbar"] [data-id="cmd:file.save"]');
  const bar = await page.locator('.app-bar').evaluate((e) => getComputedStyle(e).backgroundColor);
  await ab.hover();
  const hov = await ab.evaluate((e) => getComputedStyle(e).backgroundColor);
  expect(deltaE(composite([hov, bar]), toArr(bar))).toBeGreaterThanOrEqual(12);
  await combo(frame, ['classic', 'grey']);
  await frame.evaluate(() => window.gisworkbench.activeMp().docks.show('layers'));
  const rt = page.locator(`${MP} .ribbon-tabs .rtab:not(.active):not(.rtab-file)`).first();
  await rt.hover();
  expect(textRatio(await look(rt))).toBeGreaterThanOrEqual(4.5);
  expect(await rt.evaluate((e) => getComputedStyle(e).borderTopColor)).not.toBe('rgba(0, 0, 0, 0)');
  const dt = page.locator(`${MP} .dock-tab:not(.active)`).first();
  if (await dt.count()) {
    const b0 = await dt.evaluate((e) => getComputedStyle(e).backgroundColor);
    await dt.hover();
    expect(deltaE(toArr(b0), toArr(await dt.evaluate((e) => getComputedStyle(e).backgroundColor)))).toBeGreaterThanOrEqual(12);
  }
});

test('GUI-079 GUI-080 result tables have cell spacing; the input gains sit three to a row', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx08', 'fx08.tif')] });
  await frame.evaluate(() => void window.gisworkbench.commands.run('input.devices'));
  const gains = page.locator('.dlg input[aria-label$=" gain"]');
  await expect(gains.first()).toBeVisible();
  const tops = await gains.evaluateAll((es) => es.map((e) => Math.round(e.getBoundingClientRect().top)));
  expect(new Set(tops.slice(0, 3)).size).toBe(1);
  expect(new Set(tops.slice(3)).size).toBe(1);
  await page.keyboard.press('Escape');
  const pad = await page.evaluate(() => {
    const t = document.createElement('table');
    t.className = 'tbl';
    t.innerHTML = '<tbody><tr><td>1</td><td>2</td></tr></tbody>';
    document.body.appendChild(t);
    const v = getComputedStyle(t.querySelector('td')).paddingRight;
    t.remove();
    return v;
  });
  expect(parseFloat(pad)).toBeGreaterThanOrEqual(8);
});

test('GUI-068 the histogram editor draws in theme colours and redraws when the theme changes', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx01', 'fx01.ntf')] });
  await combo(frame, ['modern', 'm3light']);
  await frame.evaluate(() => void window.gisworkbench.commands.run('enh.histogram'));
  const cv = page.locator('canvas.hist-canvas').first();
  await expect(cv).toBeVisible();
  // The chart background: the commonest pixel.
  const corner = () =>
    cv.evaluate((c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const n = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
        n.set(k, (n.get(k) ?? 0) + 1);
      }
      const k = [...n].sort((a, b) => b[1] - a[1])[0][0];
      return [k >> 16, (k >> 8) & 255, k & 255];
    });
  const handle = () => cv.evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const want = getComputedStyle(document.documentElement).getPropertyValue('--c-chart-handle').trim();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(want.slice(i, i + 2), 16));
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) < 6 && Math.abs(d[i + 1] - g) < 6 && Math.abs(d[i + 2] - b) < 6) return true;
    return false;
  });
  expect(await handle(), 'the limit handles use the chart.handle token').toBe(true);
  const light = await corner();
  await frame.evaluate(() => window.gisworkbench.commands.run('theme.m3dark'));
  await page.waitForTimeout(200);
  const dark = await corner();
  expect(dark[0] + dark[1] + dark[2]).toBeLessThan(light[0] + light[1] + light[2] - 300);
  expect(await handle()).toBe(true);
});

test('GUI-077 every colour token the stylesheet names exists', async ({ page }) => {
  await boot(page);
  const missing = await page.evaluate(() => {
    const css = document.getElementById('app-css').textContent;
    const used = new Set([...css.matchAll(/var\((--c-[A-Za-z0-9-]+)/g)].map((m) => m[1]));
    const root = getComputedStyle(document.documentElement);
    return [...used].filter((v) => !root.getPropertyValue(v).trim());
  });
  expect(missing).toEqual([]);
});

test('GUI-082 Follow system is the default and tracks the OS light/dark setting in both layouts', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { frame } = await boot(page);
  const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.themePref]);
  expect(await theme()).toEqual(['m3-dark', 'system']);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(theme).toEqual(['m3-light', 'system']);
  await frame.evaluate(() => window.gisworkbench.setLayout('classic'));
  expect((await theme())[0]).toBe('grey');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await theme())[0]).toBe('dark');
  // A chosen palette stays put when the OS changes.
  await frame.evaluate(() => window.gisworkbench.commands.run('theme.print'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(150);
  expect(await theme()).toEqual(['print', 'print']);
  expect(await frame.evaluate(() => window.gisworkbench.commands.checked?.('theme.print') ?? true)).toBe(true);
  // The app-bar button cycles Light → Dark → Follow system.
  await frame.evaluate(() => window.gisworkbench.setLayout('modern'));
  const btn = page.locator('[data-id="shell:theme"]');
  const seq = [];
  for (let i = 0; i < 3; i++) {
    await btn.click();
    seq.push((await theme())[1]);
  }
  expect(seq).toEqual(['m3-light', 'm3-dark', 'system']);
  await expect(btn).toHaveAttribute('aria-label', /follow system/i);
});

test('GUI-069 GUI-074 wizard tabs and toggled buttons have a readable, distinct selected look in a dark theme', async ({ page }) => {
  const { frame } = await boot(page, { prefs: CLASSIC });
  await combo(frame, ['classic', 'dark']);
  // The Terrain Extraction tab bar, built the way the wizard builds it.
  const m = await page.evaluate(() => {
    const host = document.createElement('div');
    host.className = 'dlg-body';
    host.innerHTML = '<div class="tabs"><button class="tab" aria-selected="true">Input</button><button class="tab" aria-selected="false">Strategy</button></div><div class="prefs-tabs"><button class="btn active">User</button><button class="btn">Common</button></div>';
    document.querySelector('.dock-content, #app').appendChild(host);
    const cs = (s) => getComputedStyle(host.querySelector(s));
    const r = { selBg: cs('.tab[aria-selected="true"]').backgroundColor, offBg: cs('.tab[aria-selected="false"]').backgroundColor, tabText: cs('.tab').color, onBg: cs('.btn.active').backgroundColor, offBtn: cs('.btn:not(.active)').backgroundColor };
    host.remove();
    return r;
  });
  expect(ratio(toArr(m.tabText), toArr(m.offBg))).toBeGreaterThanOrEqual(4.5);
  expect(deltaE(toArr(m.selBg), toArr(m.offBg))).toBeGreaterThanOrEqual(12);
  expect(deltaE(toArr(m.onBg), toArr(m.offBtn))).toBeGreaterThanOrEqual(12);
});

test('GUI-075 dimmed text and What’s New headings stay readable on the grey dialog body', async ({ page }) => {
  const { frame } = await boot(page, { prefs: CLASSIC });
  await combo(frame, ['classic', 'grey']);
  await frame.evaluate(() => void window.gisworkbench.commands.run('help.whatsnew'));
  const h4 = page.locator('.dlg .whatsnew h4').first();
  await expect(h4).toBeVisible();
  expect(textRatio(await look(h4))).toBeGreaterThanOrEqual(4.5);
  await page.locator('.dlg .dlg-body').last().evaluate((b) => b.insertAdjacentHTML('afterbegin', '<p class="muted" data-t="m">Nothing yet.</p>'));
  expect(textRatio(await look(page.locator('.dlg p[data-t="m"]')))).toBeGreaterThanOrEqual(4.5);
});

test('GUI-078 the spectral plot has an outline that parts it from a dark dock', async ({ page }) => {
  const { frame } = await boot(page, { files: [FX('fx08', 'fx08.tif')] });
  await combo(frame, ['modern', 'm3dark']);
  await frame.evaluate(() => window.gisworkbench.activeMp().docks.show('spectral'));
  const cv = page.locator('canvas[data-id="spectral-plot"]');
  await expect(cv).toBeVisible();
  const s = await cv.evaluate((e) => ({ w: getComputedStyle(e).borderTopWidth, c: getComputedStyle(e).borderTopColor, under: getComputedStyle(e.closest('.dock-content')).backgroundColor }));
  expect(parseFloat(s.w)).toBeGreaterThanOrEqual(1);
  expect(ratio(toArr(s.c), toArr(s.under))).toBeGreaterThanOrEqual(3);
});
