// GUI3 campaign (2.0.2): the visual audit. For each build × layout × theme it opens every
// surface a user can see (chrome, menus and submenus, ribbon tabs, docks, the dialogs each data
// state can open, palette, pill, radial menu, tooltip, toasts, welcome card, status bar,
// whiteboard and video bars), saves a screenshot, and measures in the DOM:
//   text   text against its effective background (WCAG 1.4.3; translucency and opacity included)
//   ui     icons and input boundaries against their background (WCAG 1.4.11)
//   state  hover / selected / active looks against the plain look (ΔE76, forced with CDP)
//   tier   adjacent regions that must read as separate surfaces (ΔE76, or a visible border)
//   chart  marks on chart canvases against the chart background
// Thresholds: tests/tools/colour-math.mjs MIN (DN-60). Output: reports/gui3/<label>/.
//   node tests/tools/visual-audit.mjs --dist dist-gui3 --label before [--builds full,lite]
//        [--states s0-empty,s1-image] [--combos modern:m3-dark,classic:grey] [--no-dialogs]
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { STATES, SEPARATE, ENDS_MODE, settle } from '../e2e/gui-lib.js';
import { openFiles } from '../e2e/helpers.js';
import { MIN } from './colour-math.mjs';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes(`--${k}`);
const DIST = resolve(arg('dist', 'dist'));
const LABEL = arg('label', 'run');
const OUT = resolve('reports', 'gui3', LABEL);
const BUILDS = arg('builds', 'full,lite').split(',');
const THEMES = ['m3-dark', 'm3-light', 'dark', 'grey', 'print'];
const COMBOS = (arg('combos', null)?.split(',') ?? ['modern', 'classic'].flatMap((l) => THEMES.map((t) => `${l}:${t}`))).map((c) => {
  const [layout, theme, scheme] = c.split(':');
  return { layout, theme, scheme, key: `${layout}-${theme}${scheme ? `-${scheme}` : ''}` };
});
const STATE_IDS = arg('states', STATES.map((s) => s.id).join(',')).split(',');
const DIALOGS = !flag('no-dialogs');
const FILES = { full: 'gis-workbench.html', lite: 'gis-workbench-lite.html', airgap: 'gis-workbench-airgap.html' };
const THEME_CMD = { 'm3-dark': 'theme.m3dark', 'm3-light': 'theme.m3light', dark: 'theme.dark', grey: 'theme.grey', print: 'theme.print', system: 'theme.system' };
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

/** Which command opens each dialog surface, and in which state (from the 2.0.1 palette sweep). */
function dialogMap() {
  const dir = resolve('reports', 'gui2');
  const map = new Map();
  for (const st of STATES) {
    const f = join(dir, `palette-full-chrome-${st.id}.json`);
    if (!existsSync(f)) continue;
    for (const r of JSON.parse(readFileSync(f, 'utf8')))
      for (const d of r.dialogs ?? []) if (d !== 'palette' && !map.has(d) && !SEPARATE.has(r.id) && !ENDS_MODE.test(r.id)) map.set(d, { state: st.id, cmd: r.id });
  }
  // Dialogs the 2.0.1 sweeps never opened, reached here with the extra set-up they need (GUI3 coverage).
  for (const [d, v] of Object.entries(EXTRA)) if (!map.has(d)) map.set(d, v);
  return map;
}
const EXTRA = {
  'dialog:use-terrain': { state: 's2-dem', cmd: 'dem.useterrain' },
  'dialog:bands': { state: 's3-msi', cmd: 'bands.select' },
  'dialog:blend': { state: 's5-pair', cmd: 'cmp.blend' },
  'dialog:flicker-rate': { state: 's5-pair', cmd: 'cmp.rate' },
  'dialog:link-manager': { state: 's5-pair', cmd: 'link.manager' },
  'dialog:stereo-finder': { state: 's6-stereo', cmd: 'stereo.finder' },
  'dialog:dsm-extract': { state: 's6-stereo', cmd: 'dem.extract' },
  'dialog:gfx-save': { state: 's9-vector', cmd: 'gfx.save' },
};

// ---------------------------------------------------------------- in-page measurement
/* eslint-disable no-undef */
function pageScan({ root, min, regions, floating, states }) {
  const parse = (s) => {
    if (!s || s === 'transparent') return [0, 0, 0, 0];
    let m = /^rgba?\(([^)]+)\)/.exec(s);
    if (m) {
      const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }
    m = /^color\(srgb ([^)]+)\)/.exec(s);
    if (m) {
      const p = m[1].replace('/', ' ').split(/\s+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return null;
  };
  const over = (f, b) => [0, 1, 2].map((i) => f[i] * f[3] + b[i] * (1 - f[3])).concat(1);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const lab = (c) => {
    const [r, g, b] = c.slice(0, 3).map(lin);
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  };
  const dE = (a, b) => {
    const p = lab(a);
    const q = lab(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  };
  const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  /** A gradient fill as the mean of its colour stops. */
  const gradFirst = (img) => {
    const m = [...img.matchAll(/(rgba?\([^)]+\)|color\(srgb [^)]+\))/g)].map((x) => parse(x[1])).filter(Boolean);
    return m.length ? [0, 1, 2, 3].map((k) => m.reduce((s, c) => s + c[k], 0) / m.length) : null;
  };
  /** Background a pixel of `el` sits on: its own and its ancestors' fills composited; over the image when it reaches the panel. */
  const bgOf = (el, { self = true } = {}) => {
    const stack = [];
    let overImage = false;
    for (let e = self ? el : el.parentElement; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      let c = parse(cs.backgroundColor);
      if ((!c || c[3] === 0) && cs.backgroundImage !== 'none') c = gradFirst(cs.backgroundImage);
      if (c && c[3] > 0) {
        stack.push(c);
        if (c[3] >= 0.999) break;
      }
      if (e.classList.contains('pane') || e.classList.contains('video-view')) {
        overImage = true;
        stack.push([0, 0, 0, 1]);
        break;
      }
      if (e === document.documentElement) stack.push(parse(getComputedStyle(document.body).backgroundColor) ?? [1, 1, 1, 1]);
    }
    let c = [1, 1, 1, 1];
    for (let i = stack.length - 1; i >= 0; i--) c = over(stack[i], c);
    return { c, overImage };
  };
  const opacityOf = (el) => {
    let o = 1;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= Number(getComputedStyle(e).opacity);
    return o;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const disabled = (el) => !!el.closest(':disabled, .disabled, [aria-disabled="true"], .off, .planned');
  const name = (el) => {
    const id = el.dataset?.id ? `[data-id="${el.dataset.id}"]` : '';
    const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const p = el.parentElement;
    const pc = p && typeof p.className === 'string' && p.className ? p.className.trim().split(/\s+/)[0] : p?.tagName.toLowerCase();
    return `${pc} > ${el.tagName.toLowerCase()}${cls}${id}`;
  };
  const scope = root ? document.querySelector(root) : document.body;
  const out = [];
  if (!scope) return { missing: true, out };
  const push = (o) => out.push(o);
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();

  // text
  for (const el of scope.querySelectorAll('*')) {
    if (el.closest('#gl, .pane-overlay, svg, canvas, .wb-canvas')) continue;
    const t = ownText(el);
    if (!t || !visible(el) || disabled(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const { c: bg, overImage } = bgOf(el);
    if (overImage && /shadow/.test(cs.textShadow)) continue; // labels on imagery carry a halo
    const op = opacityOf(el);
    const eff = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
    const px = parseFloat(cs.fontSize);
    const bold = Number(cs.fontWeight) >= 700;
    const need = px >= 24 || (bold && px >= 18.66) ? 3 : min.text;
    const r = ratio(eff, bg);
    if (r < need - 0.005) push({ kind: 'text', el: name(el), text: t.slice(0, 40), fg: hex(eff), bg: hex(bg), value: +r.toFixed(2), need, overImage });
  }
  // ui: icons in buttons, input boundaries
  for (const svg of scope.querySelectorAll('button svg, [role="menuitem"] svg, .tb-tool svg, .rail-ic svg')) {
    if (svg.closest('.pane-compass')) continue; // drawn with its own fills on the image, not currentColor
    const host = svg.closest('button, [role="menuitem"], .tb-tool, .rail-item');
    if (!host || !visible(svg) || disabled(host)) continue;
    const fg = parse(getComputedStyle(svg).color);
    const { c: bg } = bgOf(svg.parentElement);
    const eff = over([fg[0], fg[1], fg[2], fg[3] * opacityOf(svg)], bg);
    const r = ratio(eff, bg);
    if (r < min.ui - 0.005) push({ kind: 'ui', el: name(host) + ' svg', fg: hex(eff), bg: hex(bg), value: +r.toFixed(2), need: min.ui });
  }
  for (const el of scope.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="color"]):not([type="hidden"]), select, textarea')) {
    if (!visible(el) || disabled(el) || el.classList.contains('pal-input')) continue; // the palette is its own search box
    const cs = getComputedStyle(el);
    const { c: parentBg } = bgOf(el, { self: false });
    const { c: own } = bgOf(el);
    const bw = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    const border = bw > 0 ? over(parse(cs.borderBottomColor) ?? [0, 0, 0, 0], parentBg) : parentBg;
    const r = Math.max(ratio(border, parentBg), ratio(border, own), ratio(own, parentBg));
    if (r < min.ui - 0.005) push({ kind: 'ui', el: name(el), what: 'input boundary', fg: hex(border), bg: hex(parentBg), value: +r.toFixed(2), need: min.ui });
  }
  // tier: regions that must read as separate from what they sit on
  const regionCheck = (el, against, label) => {
    const own = bgOf(el).c;
    const d = dE(own, against);
    if (d >= min.tier) return;
    const cs = getComputedStyle(el);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((s) => parseFloat(cs[`border${s}Width`]) > 0).map((s) => over(parse(cs[`border${s}Color`]) ?? [0, 0, 0, 0], against));
    const edge = Math.max(0, ...sides.map((b) => Math.min(dE(b, against), dE(b, own))));
    if (edge >= min.tier) return;
    push({ kind: 'tier', el: name(el), against: label, fg: hex(own), bg: hex(against), value: +d.toFixed(1), edge: +edge.toFixed(1), need: min.tier });
  };
  for (const sel of regions) for (const el of scope.querySelectorAll(sel)) if (visible(el)) regionCheck(el, bgOf(el, { self: false }).c, 'parent');
  // Floating surfaces against what is under them (shadows vanish on dark surfaces).
  for (const sel of floating)
    for (const el of (root ? [scope, ...scope.querySelectorAll(sel)] : [...document.querySelectorAll(sel)]).filter((e) => e.matches?.(sel))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const probes = [[r.left - 6, r.top + r.height / 2], [r.right + 6, r.top + r.height / 2], [r.left + r.width / 2, r.top - 6], [r.left + r.width / 2, r.bottom + 6]];
      for (const [x, y] of probes) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const under = document.elementsFromPoint(x, y).find((u) => !el.contains(u) && u.id !== 'gl' && !u.classList.contains('menu-host') && !u.classList.contains('toasts') && !u.classList.contains('pane-overlay'));
        if (!under || under.closest('.pane')) continue;
        regionCheck(el, bgOf(under).c, `under ${name(under)}`);
        break;
      }
    }
  // state: elements marked selected / active against an unmarked sibling of the same kind
  for (const sel of states)
    for (const el of scope.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      const sib = [...el.parentElement.children].find((s) => s !== el && s.tagName === el.tagName && !s.matches(sel) && visible(s) && !disabled(s));
      if (!sib) continue;
      const a = bgOf(el).c;
      const b = bgOf(sib).c;
      const d = dE(a, b);
      const fw = getComputedStyle(el).fontWeight !== getComputedStyle(sib).fontWeight;
      if (d < min.state) push({ kind: 'state', el: name(el), against: name(sib), fg: hex(a), bg: hex(b), value: +d.toFixed(1), need: min.state, weightOnly: fw });
    }
  // chart canvases (not the WebGL canvas or the panel overlays)
  // Only chart canvases: image previews (chips, redaction, symbols) are pictures, not marks.
  for (const cv of scope.querySelectorAll('canvas.curve-canvas, canvas.hist-canvas, canvas.profile-canvas, canvas[data-id="spectral-plot"]')) {
    if (!visible(cv)) continue;
    let px;
    try {
      px = cv.getContext('2d')?.getImageData(0, 0, cv.width, cv.height).data;
    } catch {
      continue;
    }
    if (!px) continue;
    const hist = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const k = (px[i] >> 3) << 10 | (px[i + 1] >> 3) << 5 | (px[i + 2] >> 3);
      hist.set(k, (hist.get(k) ?? 0) + 1);
    }
    const n = px.length / 4;
    const sorted = [...hist].sort((a, b) => b[1] - a[1]);
    const col = (k) => [((k >> 10) & 31) / 31, ((k >> 5) & 31) / 31, (k & 31) / 31, 1];
    const bg = col(sorted[0][0]);
    const marks = sorted.slice(1).filter(([, c]) => c / n > 0.004).map(([k, c]) => ({ c: col(k), share: c / n, r: ratio(col(k), bg) }));
    // Guides, backdrops and masks are faint by design: flag a chart only when even its strongest mark is under 3:1.
    const weak = marks.filter((m) => m.r < min.ui);
    if (marks.length && weak.length === marks.length) push({ kind: 'chart', el: name(cv), bg: hex(bg), marks: weak.slice(0, 4).map((m) => `${hex(m.c)} ${(m.share * 100).toFixed(1)}% ${m.r.toFixed(2)}:1`), value: +Math.min(...weak.map((m) => m.r)).toFixed(2), need: min.ui });
  }
  return { out };
}
/* eslint-enable no-undef */

// The tab strip and the QAT row share their parent's colour by design; the token test covers their neighbours.
const REGIONS = ['.app-bar', '.nav-rail', '.ab-search', '.dock-title', '.dock-tab', '.dock-content', '.statusbar', '.dlg-title', '.dlg-body .inp', '.ribbon-body', '.rgroup-caption', '.ws-viewtab', '.ws-btab', '.panel-tab', '.desk-tab', '.grid-table th', '.welcome-card', '.tool-pill', '.ws-toolbar', '.menubar', '.gwin-title', '.tb-tool', '.btn'];
const FLOATING = ['.menu', '.tip2', '.toast', '.pal', '.welcome', '.dlg', '.radial-item', '.tool-pill'];
const STATE_SEL = ['.dock-tab.active', '.rtab.active', '.ws-viewtab.active', '.ws-btab.active', '.panel-tab.active', '.desk-tab.active', '.rail-item.active', '.pal-item.sel', '.ws-row.selected', '.lm-row.active', 'tr.selected', '.prefs-tree li.sel', '.pill-btn.on', '.rbtn.on', '.btn.on', '.btn.active', '.radial-item.sel'];
/** Pseudo-state check: the look under :hover / :focus against the plain look. */
const HOVER_SEL = ['.menu-item', '.rbtn', '.rtab', '.dock-tab', '.ab-btn', '.rail-item', '.btn', '.tb-tool', '.qat-btn', '.tb-btn', '.menubar-item', '.pill-btn', '.pal-item', '.lm-row', '.ws-row', '.dlg-x', '.welcome-card', '.ab-chip'];

// ---------------------------------------------------------------- driver
const results = [];
const shotsDir = (build, combo) => join(OUT, 'shots', build, combo.key);
const safe = (s) => s.replace(/[^a-z0-9._-]+/gi, '_').slice(0, 90);

async function boot(browser, build, st, combo, { welcome = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: combo.scheme ?? 'dark' });
  const page = await ctx.newPage();
  const logs = [];
  page.on('pageerror', (e) => logs.push(e.message));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));
  page.on('filechooser', (fc) => fc.setFiles([]).catch(() => {}));
  page.on('download', (d) => d.cancel().catch(() => {}));
  const prefs = { layout: combo.layout, persona: 'explorer', network: 'offline', ...(welcome ? {} : { welcomeDone: true }) };
  await page.addInitScript((p) => localStorage.setItem('gisworkbench.prefs.v1', JSON.stringify(p)), prefs);
  await page.goto(pathToFileURL(join(DIST, FILES[build])).href);
  await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 60_000 });
  if (st.files.length && !(build === 'lite' && st.lite === 'skip')) {
    await openFiles(page.mainFrame(), st.files).catch(() => {});
    await page
      .waitForFunction(() => {
        const a = window.gisworkbench;
        const ls = [...a.layers.values()];
        return (ls.length && ls.every((l) => l.error || (l.lutTex && !l.tiles?.loading))) || a.store.all('vlayer').length || a.store.all('pointcloud').length || a.fmv?.clips?.size;
      }, null, { timeout: 60_000 })
      .catch(() => {});
    if (st.terrain) await page.evaluate((v) => window.gisworkbench.useAsTerrain(window.gisworkbench.activeLayer(), v), st.terrain).catch(() => {});
    for (const c of st.setup ?? []) await page.evaluate((c) => window.gisworkbench.commands.run(c), c).catch(() => {});
  }
  await page.evaluate(AXE);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await page.waitForTimeout(600);
  return { ctx, page, cdp, logs };
}

async function setCombo(page, combo) {
  await page.evaluate(({ layout, cmd }) => {
    const a = window.gisworkbench;
    if (document.documentElement.dataset.layout !== layout) a.setLayout(layout);
    a.commands.run(cmd);
  }, { layout: combo.layout, cmd: THEME_CMD[combo.theme] });
  await page.waitForTimeout(250);
}

async function axeScan(page, root) {
  return page
    .evaluate(async (root) => {
      const r = await window.axe.run(root ? document.querySelector(root) ?? document : document, { runOnly: { type: 'rule', values: ['color-contrast'] }, exclude: [['#gl'], ['.pane-overlay']] });
      return r.violations.flatMap((v) => v.nodes.map((n) => ({ kind: 'axe', el: n.target.join(' '), detail: (n.any?.[0]?.message ?? '').slice(0, 160) })));
    }, root)
    .catch(() => []);
}

/** Force :hover (then :focus-visible) on up to `per` elements of each hover selector inside root; record the looks. */
async function hoverScan(page, cdp, root) {
  const found = [];
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: 0 });
  for (const sel of HOVER_SEL) {
    const q = `${root ?? 'body'} ${sel}`;
    let ids = [];
    try {
      ({ nodeIds: ids } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: q }));
    } catch {
      continue;
    }
    const idx = await page.evaluate(({ q }) => [...document.querySelectorAll(q)].map((e, i) => [i, e.getBoundingClientRect().width > 2 && !e.closest(':disabled, .disabled, .off, [aria-disabled="true"]') && !e.matches('.active, .sel, .on, .selected, [aria-pressed="true"]') && e !== document.activeElement]).filter(([, ok]) => ok).map(([i]) => i), { q });
    for (const i of idx.slice(0, 2)) {
      const nodeId = ids[i];
      if (!nodeId) continue;
      const before = await page.evaluate(({ q, i }) => {
        const e = document.querySelectorAll(q)[i];
        const cs = getComputedStyle(e);
        return { bg: cs.backgroundColor, img: cs.backgroundImage, border: cs.borderBottomColor, borderBottom: cs.borderBottomColor, borderTop: cs.borderTopColor, borderLeft: cs.borderLeftColor, borderRight: cs.borderRightColor, color: cs.color, filter: cs.filter, outline: cs.outlineStyle };
      }, { q, i });
      for (const pseudo of ['hover', 'focus-visible']) {
        // Menus show focus with :focus (the hover fill), the rest with :focus-visible (the ring): force both.
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: pseudo === 'hover' ? ['hover'] : ['focus', 'focus-visible'] }).catch(() => {});
        const m = await page.evaluate(({ q, i, before, min, pseudo }) => {
          const e = document.querySelectorAll(q)[i];
          const cs = getComputedStyle(e);
          const changed = cs.backgroundColor !== before.bg || cs.backgroundImage !== before.img || cs.borderBottomColor !== before.border || cs.filter !== before.filter || (pseudo === 'focus-visible' && cs.outlineStyle !== 'none');
          return { changed, sel: q, text: e.textContent.trim().slice(0, 30), now: { bg: cs.backgroundColor, color: cs.color, outline: cs.outlineStyle, outlineColor: cs.outlineColor }, min };
        }, { q, i, before, min: MIN, pseudo });
        // Measure the forced look with the same scanner (text on the hover fill, state ΔE against the plain fill).
        const r = await page.evaluate(({ q, i, before, pseudo }) => {
          const parse = (s) => {
            let m = /^rgba?\(([^)]+)\)/.exec(s);
            if (m) {
              const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
              return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
            }
            m = /^color\(srgb ([^)]+)\)/.exec(s);
            if (m) {
              const p = m[1].replace('/', ' ').split(/\s+/).filter(Boolean).map(Number);
              return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
            }
            return [0, 0, 0, 0];
          };
          const over = (f, b) => [0, 1, 2].map((k) => f[k] * f[3] + b[k] * (1 - f[3])).concat(1);
          const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
          const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
          const ratio = (a, b) => {
            const [x, y] = [lum(a), lum(b)].sort((p, q2) => q2 - p);
            return (x + 0.05) / (y + 0.05);
          };
          const lab = (c) => {
            const [r2, g, b] = c.slice(0, 3).map(lin);
            const X = (0.4124 * r2 + 0.3576 * g + 0.1805 * b) / 0.95047;
            const Y = 0.2126 * r2 + 0.7152 * g + 0.0722 * b;
            const Z = (0.0193 * r2 + 0.1192 * g + 0.9505 * b) / 1.08883;
            const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
            return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
          };
          const dE = (a, b) => Math.hypot(...lab(a).map((v, k) => v - lab(b)[k]));
          const hex = (c) => '#' + c.slice(0, 3).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
          const e0 = document.querySelectorAll(q)[i];
          // A rail item shows hover and focus on its icon pill, not on the item box.
          const e = pseudo === 'hover' ? (e0.querySelector(':scope > .rail-ic') ?? e0) : e0;
          const under = (() => {
            const st = [];
            for (let p = e.parentElement; p; p = p.parentElement) {
              const c = parse(getComputedStyle(p).backgroundColor);
              if (c[3] > 0) {
                st.push(c);
                if (c[3] > 0.999) break;
              }
              if (p.classList.contains('pane')) {
                st.push([0, 0, 0, 1]);
                break;
              }
            }
            let c = [1, 1, 1, 1];
            for (let k = st.length - 1; k >= 0; k--) c = over(st[k], c);
            return c;
          })();
          const cs = getComputedStyle(e);
          const grad = /(rgba?\([^)]+\))/.exec(cs.backgroundImage)?.[1];
          const now = over(grad ? parse(grad) : parse(cs.backgroundColor), under);
          const grad0 = /(rgba?\([^)]+\))/.exec(before.img)?.[1];
          const was = over(grad0 ? parse(grad0) : parse(before.bg), under);
          const fg = over(parse(cs.color), now);
          const side = ['Bottom', 'Top', 'Left', 'Right'].find((sd) => parseFloat(cs[`border${sd}Width`]) > 0) ?? 'Bottom';
          const border = over(parse(cs[`border${side}Color`]), under);
          const borderWas = over(parse(before[`border${side}`] ?? before.border), under);
          const res = { sel: q.replace(/^\S+ /, ''), text: e.textContent.trim().slice(0, 30), pseudo };
          if (pseudo === 'hover') {
            res.state = +Math.max(dE(now, was), parseFloat(cs[`border${side}Width`]) > 0 ? dE(border, borderWas) : 0).toFixed(1);
            res.text_ratio = e.textContent.trim() ? +ratio(fg, now).toFixed(2) : null;
            res.fg = hex(fg);
            res.bg = hex(now);
            res.was = hex(was);
          } else {
            const ring = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? over(parse(cs.outlineColor), under) : null;
            res.ring = ring ? +Math.max(ratio(ring, under), ratio(ring, now)).toFixed(2) : 0;
            res.fill = +dE(now, was).toFixed(1); // menus show keyboard focus as the hover fill
            res.ringColour = ring ? hex(ring) : null;
            // Two-tone ring (DN-60): the halo box-shadow under the ring also counts.
            const halo = /(rgba?\([^)]+\))/.exec(cs.boxShadow)?.[1];
            if (ring && halo) {
              const hc = over(parse(halo), under);
              if (ratio(hc, under) >= 3 && ratio(ring, hc) >= 3) res.ring = Math.max(res.ring, 3);
            }
          }
          return res;
        }, { q, i, before, pseudo });
        if (pseudo === 'hover') {
          if (r.state < MIN.state) found.push({ kind: 'hover', el: r.sel, text: r.text, fg: r.bg, bg: r.was, value: r.state, need: MIN.state });
          if (r.text_ratio !== null && r.text_ratio < MIN.text) found.push({ kind: 'hover-text', el: r.sel, text: r.text, fg: r.fg, bg: r.bg, value: r.text_ratio, need: MIN.text });
        } else if (r.ring < MIN.ui && r.fill < MIN.state) found.push({ kind: 'focus', el: r.sel, text: r.text, fg: r.ringColour, value: r.ring, fill: r.fill, need: MIN.ui });
        void m;
        await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
      }
    }
  }
  return found;
}

async function capture(page, cdp, build, combo, st, surface, { root = null, clip = null, hover = true } = {}) {
  const dir = shotsDir(build, combo);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${safe(surface)}.jpg`);
  try {
    if (root && !clip) {
      const box = await page.locator(root).first().boundingBox().catch(() => null);
      if (box) clip = { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1440 - Math.max(0, box.x - 8), box.width + 16), height: Math.min(900 - Math.max(0, box.y - 8), box.height + 16) };
    }
    await page.screenshot({ path: file, type: 'jpeg', quality: 82, ...(clip && clip.width > 4 && clip.height > 4 ? { clip } : {}) });
  } catch (e) {
    results.push({ build, combo: combo.key, state: st.id, surface, error: `screenshot: ${e.message.split('\n')[0]}` });
    return;
  }
  const dom = await page.evaluate(pageScan, { root, min: MIN, regions: REGIONS, floating: FLOATING, states: STATE_SEL }).catch((e) => ({ out: [{ kind: 'error', el: e.message.split('\n')[0] }] }));
  const ax = await axeScan(page, root);
  const hv = hover ? await hoverScan(page, cdp, root).catch(() => []) : [];
  results.push({ build, combo: combo.key, state: st.id, surface, shot: file.slice(OUT.length + 1).replace(/\\/g, '/'), missing: !!dom.missing, findings: [...dom.out, ...ax, ...hv] });
}

const run = (page, cmd) => page.evaluate((c) => void window.gisworkbench.commands.run(c), cmd).catch(() => {});
const closeAll = async (page, layout) => {
  await settle(page, { layout }).catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
  await page.mouse.click(2, 2).catch(() => {});
};
const paneCentre = (page) =>
  page.evaluate(() => {
    const r = document.querySelector('section.multiport .pane')?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });

async function menuSurfaces(page, cdp, build, combo, st, done) {
  const menus = combo.layout === 'modern'
    ? [['main-menu', '[data-id="shell:menu"]'], ['help-menu', '[data-id="shell:help"]'], ['persona-menu', '[data-id="shell:persona"]'], ['products-menu', '[data-id="shell:rail"] [data-rail="products"]']]
    : [['file-menu', '.rtab-file'], ...(await page.locator('.menubar .menubar-item').evaluateAll((bs) => bs.map((b, i) => [`ws-menu-${b.textContent.trim()}`, `.menubar .menubar-item >> nth=${i}`])))];
  for (const [id, sel] of menus) {
    if (done.has(id)) continue;
    done.add(id);
    const open = async () => {
      await page.locator(sel).first().click({ timeout: 2000 });
      await page.waitForTimeout(200);
    };
    try {
      await open();
      await capture(page, cdp, build, combo, st, `menu:${id}`, { root: '.menu-host .menu' });
      const subs = await page.locator('.menu-host .menu').first().locator(':scope > .menu-item[aria-haspopup="menu"]').evaluateAll((rs) => rs.map((r) => r.querySelector('.menu-label').textContent));
      for (const s of subs.slice(0, 12)) {
        await page.locator('.menu-host .menu').first().locator('.menu-item', { hasText: s }).first().hover();
        await page.waitForTimeout(220);
        await capture(page, cdp, build, combo, st, `menu:${id} > ${s}`, { root: '.menu-host .menu:last-of-type', hover: false });
      }
    } catch (e) {
      results.push({ build, combo: combo.key, state: st.id, surface: `menu:${id}`, error: e.message.split('\n')[0] });
    }
    await closeAll(page, combo.layout);
  }
}

async function ribbonSurfaces(page, cdp, build, combo, st, done) {
  if (combo.layout !== 'classic') return;
  const tabs = await page.locator('section.multiport .ribbon-tabs .rtab:not(.rtab-file)').evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
  for (const [i, t] of tabs.entries()) {
    const id = `ribbon:${t}`;
    if (done.has(id)) continue;
    done.add(id);
    await page.locator('section.multiport .ribbon-tabs .rtab:not(.rtab-file)').nth(i).click().catch(() => {});
    await page.waitForTimeout(150);
    await capture(page, cdp, build, combo, st, id, { root: 'section.multiport .ribbon' });
  }
}

async function dockSurfaces(page, cdp, build, combo, st, done) {
  const ids = await page.evaluate(() => [...window.gisworkbench.activeMp().docks.registry.keys()].filter((k) => !k.startsWith('tool:')));
  for (const d of ids) {
    const id = `dock:${d}`;
    if (done.has(id)) continue;
    done.add(id);
    const area = await page.evaluate((d) => {
      const m = window.gisworkbench.activeMp().docks;
      m.show(d);
      return m.registry.get(d)?.area?.el?.dataset.id?.slice(5) ?? null;
    }, d).catch(() => null);
    await page.waitForTimeout(300);
    await capture(page, cdp, build, combo, st, id, { root: area ? `section.multiport .dock-${area}` : null });
    await page.evaluate((d) => {
      const m = window.gisworkbench.activeMp().docks;
      m.close(m.registry.get(d));
    }, d).catch(() => {});
  }
}

async function transientSurfaces(page, cdp, build, combo, st, done) {
  const once = async (id, fn) => {
    if (done.has(id)) return;
    done.add(id);
    try {
      await fn();
    } catch (e) {
      results.push({ build, combo: combo.key, state: st.id, surface: id, error: e.message.split('\n')[0] });
    }
    await closeAll(page, combo.layout);
  };
  await once('chrome', () => capture(page, cdp, build, combo, st, 'chrome'));
  await once('statusbar', () => capture(page, cdp, build, combo, st, 'statusbar', { root: 'section.multiport .statusbar' }));
  await once('palette', async () => {
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(250);
    await page.keyboard.type('stretch');
    await page.waitForTimeout(300);
    await capture(page, cdp, build, combo, st, 'palette', { root: '.pal' });
  });
  await once('tooltip', async () => {
    const sel = combo.layout === 'modern' ? '[data-id="shell:appbar"] [data-id^="cmd:"]' : 'section.multiport .ribbon-body [data-id^="cmd:"]';
    await page.locator(sel).first().hover();
    await page.waitForTimeout(1100);
    await capture(page, cdp, build, combo, st, 'tooltip', { root: '.tip2', hover: false });
    await page.mouse.move(2, 2);
  });
  await once('toasts', async () => {
    await page.evaluate(() => {
      const a = window.gisworkbench;
      a.toast('Information: 3 layers opened.', { kind: 'info', ms: 20000 });
      a.toast('Warning: this needs terrain first.', { kind: 'warn', ms: 20000, action: { label: 'Set up…', run: () => {} } });
      a.toast('Error: the file could not be read.', { kind: 'error', ms: 20000 });
    });
    await page.waitForTimeout(400);
    await capture(page, cdp, build, combo, st, 'toasts', { root: '.toasts', hover: false });
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  });
  await once('whiteboard', async () => {
    await run(page, 'wb.toggle');
    await page.waitForTimeout(300);
    await capture(page, cdp, build, combo, st, 'whiteboard', { root: '.wb-bar' });
    await page.keyboard.press('Escape');
    await run(page, 'wb.toggle');
  });
}

async function dataSurfaces(page, cdp, build, combo, st, done) {
  const tag = (s) => `${s}@${st.id}`;
  if (!st.files.length) return;
  const at = await paneCentre(page);
  if (combo.layout === 'modern' && !done.has(tag('pill'))) {
    done.add(tag('pill'));
    if (await page.locator('[data-id="pill"]:not([hidden])').count()) await capture(page, cdp, build, combo, st, tag('pill'), { root: '[data-id="pill"]' });
  }
  if (combo.layout === 'modern' && at && !done.has(tag('radial'))) {
    done.add(tag('radial'));
    await page.mouse.move(at.x, at.y);
    await page.locator('section.multiport .pane').first().focus().catch(() => {});
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    if (await page.locator('[data-id="radial"]').count()) await capture(page, cdp, build, combo, st, tag('radial'), { root: '[data-id="radial"]' });
    await page.keyboard.press('Escape');
  }
  if (at && !done.has(tag('context-menu'))) {
    done.add(tag('context-menu'));
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.waitForTimeout(300);
    await capture(page, cdp, build, combo, st, tag('context-menu'), { clip: null });
    await closeAll(page, combo.layout);
  }
  if (st.id === 's8-video' && !done.has(tag('dvr'))) {
    done.add(tag('dvr'));
    if (await page.locator('.dvr').count()) await capture(page, cdp, build, combo, st, tag('dvr'), { root: '.video-view' });
  }
}

async function dialogSurfaces(page, cdp, build, combo, st, map, done) {
  for (const [d, v] of map) {
    if (v.state !== st.id || done.has(d)) continue;
    done.add(d);
    const ok = await page.evaluate((c) => {
      const C = window.gisworkbench.commands;
      if (C.liteGap?.(c)) return 'lite';
      if (C.enabled && !C.enabled(c)) return 'disabled';
      void C.run(c);
      return 'ran';
    }, v.cmd).catch((e) => `threw ${e.message}`);
    if (ok !== 'ran') {
      results.push({ build, combo: combo.key, state: st.id, surface: d, skipped: `${v.cmd}: ${ok}` });
      continue;
    }
    await page.waitForTimeout(450);
    const root = await page.evaluate(() => {
      const dl = [...document.querySelectorAll('.dlg[role="dialog"]')].at(-1);
      if (dl) return '.dlg[role="dialog"]:last-of-type';
      const tool = [...document.querySelectorAll('section.multiport .dock .tool-panel')].at(-1);
      return tool ? 'section.multiport .dock:has(.tool-panel)' : null;
    });
    if (!root) results.push({ build, combo: combo.key, state: st.id, surface: d, skipped: `${v.cmd}: nothing opened` });
    else await capture(page, cdp, build, combo, st, d, { root });
    await closeAll(page, combo.layout);
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const map = dialogMap();
  const t0 = Date.now();
  for (const build of BUILDS) {
    for (const combo of COMBOS) {
      const done = new Set();
      // Welcome card: first start, nothing open.
      {
        const st = STATES[0];
        const { ctx, page, cdp } = await boot(browser, build, st, combo, { welcome: true });
        await setCombo(page, combo);
        if (await page.locator('[data-id^="welcome:"]').count()) await capture(page, cdp, build, combo, st, 'welcome', { root: '.welcome' });
        await ctx.close();
      }
      for (const sid of STATE_IDS) {
        const st = STATES.find((s) => s.id === sid);
        if (!st || (build === 'lite' && st.lite === 'skip') || (build === 'airgap' && !['s0-empty', 's1-image'].includes(sid))) continue;
        let session;
        try {
          session = await boot(browser, build, st, combo);
          const { page, cdp } = session;
          await setCombo(page, combo);
          if (sid === 's0-empty' || sid === 's1-image') {
            await transientSurfaces(page, cdp, build, combo, st, done);
            await menuSurfaces(page, cdp, build, combo, st, done);
            await dockSurfaces(page, cdp, build, combo, st, done);
          }
          await ribbonSurfaces(page, cdp, build, combo, st, done);
          await dataSurfaces(page, cdp, build, combo, st, done);
          if (DIALOGS && build !== 'airgap') await dialogSurfaces(page, cdp, build, combo, st, map, done);
          if (session.logs.length) results.push({ build, combo: combo.key, state: sid, surface: '(page errors)', errors: session.logs.slice(0, 10) });
        } catch (e) {
          results.push({ build, combo: combo.key, state: sid, surface: '(state)', error: e.message.split('\n')[0] });
        }
        await session?.ctx.close().catch(() => {});
        writeFileSync(join(OUT, 'audit.json'), JSON.stringify({ meta: { dist: DIST, builds: BUILDS, combos: COMBOS.map((c) => c.key), min: MIN, at: new Date().toISOString() }, results }, null, 1));
        console.log(`${build} ${combo.key} ${sid}: ${results.length} surfaces so far (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
      }
    }
  }
  await browser.close();
  summarise();
}

/** Group findings by kind, element and combo for the report; print the top of each kind. */
export function summarise(dir = OUT) {
  const { results: rs } = JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8'));
  const groups = new Map();
  for (const r of rs)
    for (const f of r.findings ?? []) {
      const key = `${f.kind} | ${f.el.replace(/\[data-id="[^"]+"\]/g, '[id]')}`;
      if (!groups.has(key)) groups.set(key, { kind: f.kind, el: key.split(' | ')[1], combos: new Set(), surfaces: new Set(), worst: f, n: 0 });
      const g = groups.get(key);
      g.n++;
      g.combos.add(`${r.build}/${r.combo}`);
      g.surfaces.add(r.surface);
      if (typeof f.value === 'number' && f.value < (g.worst.value ?? Infinity)) g.worst = f;
    }
  const rows = [...groups.values()].map((g) => ({ kind: g.kind, el: g.el, n: g.n, combos: [...g.combos].sort(), surfaces: [...g.surfaces].slice(0, 8), worst: g.worst })).sort((a, b) => a.kind.localeCompare(b.kind) || b.n - a.n);
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(rows, null, 1));
  const byKind = {};
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
  const surfaces = rs.filter((r) => r.shot).length;
  console.log(`${surfaces} surfaces captured, ${rs.filter((r) => r.error).length} errors, ${rs.filter((r) => r.skipped).length} skipped; findings by kind:`, byKind, `; ${rows.length} distinct`);
  return rows;
}

if (flag('summarise')) summarise(resolve(arg('dir', OUT)));
else await main();
