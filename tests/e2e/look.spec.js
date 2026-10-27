// PT-09 REQ-UI-03 REQ-UI-07 REQ-UI-12 REQ-UI-13: shell colours match ui-tokens.json (ΔE ≤ 2)
// and sizes match (±1 px) in the built file; PT-10 REQ-UI-16: axe-core finds no WCAG 2.2 AA
// violation in the chrome in all three themes.
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { openApp, openFiles, sample } from './helpers.js';

const tokens = JSON.parse(readFileSync('app/src/data/ui-tokens.json', 'utf8'));
const hex = (k, theme = 'colors') => (tokens[theme][k] ?? tokens.colors[k]).hex;
const px = (k) => parseFloat(tokens.sizes[k].value);

function rgb(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (m) return m[1].split(',').slice(0, 3).map((v) => parseFloat(v));
  const h = s.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

// CIE76 ΔE in Lab.
function lab([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92;
  };
  const [R, G, B] = [f(r), f(g), f(b)];
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const t = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * t(Y) - 16, 500 * (t(X) - t(Y)), 200 * (t(Y) - t(Z))];
}
const dE = (a, b) => {
  const [l1, a1, b1] = lab(rgb(a));
  const [l2, a2, b2] = lab(rgb(b));
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

test('PT-09 REQ-UI-12 REQ-UI-07 REQ-UI-03 REQ-UI-13 shell colours and sizes match the tokens', async ({ page }) => {
  const { frame } = await openApp(page, 'file');
  await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
  await frame.evaluate(() => window.gisworkbench.activeMp().setLayout('1x2'));
  await page.waitForTimeout(400);
  const m = await frame.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el)[prop] : null;
    };
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect().toJSON();
    return {
      menubar: cs('.menubar', 'backgroundColor'),
      toolbar: cs('.ws-toolbar', 'backgroundColor'),
      fileTab: cs('.rtab-file', 'backgroundColor'),
      ribbon: cs('.ribbon-body', 'backgroundImage'),
      caption: cs('.rgroup-caption', 'backgroundColor'),
      status: cs('.multiport .statusbar', 'backgroundColor'),
      statusText: cs('.multiport .statusbar', 'color'),
      dockTitle: cs('.dock-title', 'backgroundColor'),
      dockBody: cs('.dock-left', 'backgroundColor'),
      content: cs('.dock-content', 'backgroundColor'),
      activeRow: cs('.lm-row.active', 'backgroundColor'),
      paneOutline: cs('.pane.active', 'boxShadow'),
      ctxCaption: (() => {
        const el = document.querySelector('.rtab-set');
        return el ? getComputedStyle(el, '::before').backgroundColor : null;
      })(),
      terrainCell: cs('.sc-terrain.bad', 'backgroundColor'),
      sizes: {
        title: box('.multiport .gwin-title').height,
        qat: box('.qat-row').height,
        tabs: box('.ribbon-tabs').height,
        ribbon: box('.ribbon-body').height,
        groupCaption: box('.rgroup-caption').height,
        statusRow: box('.multiport .status-row').height,
        statusRows: document.querySelectorAll('.multiport .statusbar .status-row').length,
        menubar: box('.menubar').height,
        leftDock: box('.dock-left').width,
        dockTitle: box('.dock-title').height,
        font: getComputedStyle(document.body).fontSize,
        statusFont: cs('.multiport .statusbar', 'fontSize'),
      },
    };
  });
  const checks = [
    ['menubar', 'chrome.frame'],
    ['toolbar', 'chrome.toolbar'],
    ['fileTab', 'ribbon.fileTab'],
    ['caption', 'ribbon.captionBand'],
    ['status', 'status.bg'],
    ['statusText', 'status.text'],
    ['dockTitle', 'dock.title'],
    ['dockBody', 'dock.body'],
    ['content', 'content.bg'],
    ['activeRow', 'layer.activeHighlight'],
    ['ctxCaption', 'ctx.imageTools'],
    ['terrainCell', 'status.bad'],
  ];
  for (const [k, t] of checks) expect(dE(m[k], hex(t)), `${k} vs ${t}: ${m[k]} / ${hex(t)}`).toBeLessThanOrEqual(2);
  const stops = m.ribbon.match(/rgba?\([^)]+\)/g);
  expect(dE(stops[0], hex('ribbon.bodyTop'))).toBeLessThanOrEqual(2);
  expect(dE(stops.at(-1), hex('ribbon.bodyBottom'))).toBeLessThanOrEqual(2);
  expect(m.paneOutline).toContain('rgb(255, 255, 0)');
  const s = m.sizes;
  for (const [k, t] of [['title', 'titleBarHeight'], ['qat', 'qatRowHeight'], ['tabs', 'ribbonTabStripHeight'], ['groupCaption', 'ribbonGroupCaptionHeight'], ['statusRow', 'statusBarRowHeight'], ['menubar', 'menuBarHeight'], ['dockTitle', 'dockTitleHeight']]) {
    expect(Math.abs(s[k] - px(t)), `${k} ${s[k]} vs ${px(t)}`).toBeLessThanOrEqual(1);
  }
  // Ribbon body height includes its 1 px bottom rule.
  expect(Math.abs(s.ribbon - px('ribbonBodyHeight'))).toBeLessThanOrEqual(1);
  expect(Math.abs(s.leftDock - 255)).toBeLessThanOrEqual(1);
  expect(s.statusRows).toBe(2);
  expect(s.font).toBe('12px');
  expect(s.statusFont).toBe('11px');
});

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

for (const theme of ['grey', 'dark', 'print']) {
  test(`PT-10 REQ-UI-16 no WCAG 2.2 AA violations in the chrome (${theme})`, async ({ page }) => {
    const { frame } = await openApp(page, 'file');
    await openFiles(frame, [sample('nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf')]);
    await frame.evaluate((t) => window.gisworkbench.commands.run(`theme.${t}`), theme);
    await page.waitForTimeout(300);
    // axe arrives as a page script through CDP (the page CSP blocks injected inline scripts).
    await page.evaluate(axeSource);
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, exclude: [['#gl'], ['.pane-overlay']] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, sample: v.nodes.slice(0, 3).map((x) => x.target.join(' ') + ' — ' + (x.failureSummary ?? '').split('\n')[1]) }));
    });
    expect(res, JSON.stringify(res, null, 1)).toEqual([]);
  });
}
