// GUI3 campaign (2.0.2, DN-60): every theme's tokens keep text readable, controls and chart
// marks visible, states (hover, selected, active tab) distinct, and adjacent regions separate.
// Checked on the resolved token table, so a palette change that breaks a pair fails here before
// any screenshot is taken. The visual audit (tests/tools/visual-audit.mjs) checks the rendered UI.
import { describe, it, expect } from 'vitest';
import { tokenTable } from '../../build/tokens.mjs';
import { ratio, deltaE, luminance, over, MIN } from '../tools/colour-math.mjs';

const T = tokenTable('app/src/data/ui-tokens.json');
const THEMES = { grey: T.grey, dark: T.dark, print: T.print, 'm3-light': T.m3Light, 'm3-dark': T.m3Dark };
const DARK = ['dark', 'm3-dark'];

const lit = (v) => (v.startsWith('#') ? v : null);
const col = (t, k) => lit(k) ?? t[k];

/** [foreground, [backgrounds…]] read as text (4.5:1). Literals are colours the CSS draws on a token. */
const TEXT = [
  ['content.text', ['content.bg', 'content.header', 'content.selected', 'content.dropdownHover', 'dock.body', 'dock.tabInactive', 'dock.tabActive', 'button.face']],
  ['content.errorText', ['content.bg']],
  ['content.warnText', ['content.bg']],
  ['content.successText', ['content.bg']],
  ['content.link', ['content.bg']],
  ['menu.text', ['menu.bg']],
  ['menu.hoverText', ['menu.hover']],
  ['menu.keyText', ['menu.bg', 'menu.hover']],
  ['chrome.textOnFrame', ['chrome.frame']],
  ['chrome.toolbarText', ['chrome.toolbar']],
  ['chrome.titlebarText', ['chrome.titlebar']],
  ['ribbon.text', ['ribbon.bodyTop', 'ribbon.bodyBottom', 'ribbon.selectedTab']],
  ['ribbon.hotText', ['ribbon.buttonHot', 'ribbon.buttonPressed']],
  ['ribbon.captionText', ['ribbon.captionBand']],
  ['dock.titleText', ['dock.title']],
  ['status.text', ['status.bg']],
  ['tooltip.text', ['tooltip.bg']],
  ['tooltip.textSecondary', ['tooltip.bg']],
  ['tooltip.textMuted', ['tooltip.bg']],
  ['tooltip.accent', ['tooltip.bg']],
  ['toast.text', ['toast.bg']],
  ['toast.action', ['toast.bg']],
  ['m3.onSurface', ['m3.surface', 'm3.surfaceContainer', 'm3.surfaceContainerHigh']],
  ['m3.onSurfaceVariant', ['m3.surface', 'm3.surfaceContainer', 'm3.surfaceContainerHigh']],
  ['m3.onPrimary', ['m3.primary']],
  ['m3.onPrimaryContainer', ['m3.primaryContainer']],
  ['#000000', ['status.ok', 'status.bad', 'layer.activeHighlight']],
  ['#ffffff', ['ribbon.fileTab', 'toolbox.drawerHeader', 'banner.U', 'banner.C', 'banner.S', 'banner.R']],
  ['#000000', ['banner.T']],
];
/** Non-text marks against what they sit on (3:1, WCAG 1.4.11). */
const UI = [
  ['control.border', ['content.bg']],
  ['m3.outline', ['m3.surface', 'm3.surfaceContainer', 'm3.surfaceContainerHigh']],
  ['chart.fill', ['content.bg']],
  ['chart.handle', ['content.bg']],
  ['chart.terrain', ['content.bg']],
  ['chart.losOk', ['content.bg']],
  ['chart.losBlocked', ['content.bg']],
  ['chart.cursor', ['content.bg']],
  ['chart.red', ['content.bg']],
  ['chart.green', ['content.bg']],
  ['chart.blue', ['content.bg']],
  ['chart.axis', ['content.bg']],
];
/** Looks that must read as a different state of the same thing (ΔE76 ≥ MIN.state). */
const STATE = [
  ['content.selected', 'content.bg'],
  ['content.dropdownHover', 'content.bg'],
  ['menu.hover', 'menu.bg'],
  ['ribbon.buttonHot', 'ribbon.bodyTop'],
  ['ribbon.buttonPressed', 'ribbon.bodyTop'],
  ['dock.tabActive', 'dock.tabInactive'],
  ['m3.primaryContainer', 'm3.surface'],
  ['button.hover', 'button.face'],
];
/** Adjacent regions (ΔE76 ≥ MIN.tier), or the named border between them separates them. */
const TIER = [
  ['dock.title', 'dock.body'],
  ['dock.body', 'content.bg'],
  ['dock.tabInactive', 'dock.body'],
  ['content.header', 'content.bg'],
  ['chrome.frame', 'content.bg'],
  ['chrome.frame', 'dock.title'],
  ['button.face', 'chrome.frame', 'control.border'],
  ['button.face', 'content.bg', 'control.border'],
  ['m3.surface', 'dock.title', 'm3.outlineVariant'],
  ['m3.surface', 'content.bg', 'm3.outlineVariant'],
  ['m3.surfaceContainerHigh', 'm3.surface'],
  ['m3.surfaceContainer', 'm3.surface'],
  ['menu.bg', 'content.bg', 'menu.border'],
  ['menu.bg', 'chrome.frame', 'menu.border'],
  ['tooltip.bg', 'content.bg', 'tooltip.border'],
  ['tooltip.bg', 'chrome.frame', 'tooltip.border'],
  ['tooltip.bg', 'm3.surface', 'tooltip.border'],
  ['toast.bg', 'pane.bg', 'toast.border'],
  ['toast.bg', 'content.bg', 'toast.border'],
  ['status.bg', 'chrome.frame'],
  ['status.bg', 'dock.body'],
  ['ribbon.captionBand', 'ribbon.bodyBottom'],
  ['ribbon.bodyTop', 'chrome.frame'],
  ['chrome.toolbar', 'chrome.frame'],
  ['chrome.titlebar', 'chrome.frame', 'chrome.titlebarBorder'],
  ['menu.separator', 'menu.bg'],
  ['divider', 'chrome.frame'],
  ['ribbon.selectedTab', 'chrome.frame', 'ribbon.groupSeparator'],
  ['chart.mask', 'content.bg'],
];
/** Surfaces a focus ring is drawn on; the ring is two-tone (focus.ring outside focus.halo). */
const FOCUS_ON = ['content.bg', 'chrome.frame', 'dock.body', 'dock.title', 'menu.bg', 'm3.surface', 'm3.surfaceContainerHigh', 'button.face', 'ribbon.bodyTop', 'status.bg'];
/** Surfaces inputs sit on: the input's fill or its outline must stand out 3:1. */
const INPUT_ON = ['chrome.frame', 'content.bg', 'm3.surfaceContainer', 'm3.surfaceContainerHigh'];
/** Surfaces a dark theme must draw dark (a light token left over shows as a white slab). */
const DARK_SURFACES = ['chrome.frame', 'chrome.toolbar', 'chrome.titlebar', 'chrome.qatTop', 'content.bg', 'dock.body', 'dock.title', 'menu.bg', 'm3.surface', 'm3.surfaceContainer', 'm3.surfaceContainerHigh', 'ribbon.bodyTop', 'ribbon.bodyBottom', 'status.bg'];

describe.each(Object.entries(THEMES))('theme %s', (name, t) => {
  it('every token the pairs name exists', () => {
    const names = new Set([...TEXT.flatMap(([f, bs]) => [f, ...bs]), ...UI.flatMap(([f, bs]) => [f, ...bs]), ...STATE.flat(), ...TIER.flat()].filter((k) => !lit(k)));
    expect([...names].filter((k) => !t[k])).toEqual([]);
  });
  it('text is readable (4.5:1)', () => {
    const bad = [];
    for (const [f, bs] of TEXT) for (const b of bs) if (col(t, f) && t[b] && ratio(col(t, f), t[b]) < MIN.text) bad.push(`${f} on ${b} ${ratio(col(t, f), t[b]).toFixed(2)}`);
    expect(bad).toEqual([]);
  });
  it('controls, focus rings and chart marks are visible (3:1)', () => {
    const bad = [];
    for (const [f, bs] of UI) for (const b of bs) if (t[f] && t[b] && ratio(t[f], t[b]) < MIN.ui) bad.push(`${f} on ${b} ${ratio(t[f], t[b]).toFixed(2)}`);
    expect(bad).toEqual([]);
  });
  it('the two-tone focus ring shows on every surface (3:1)', () => {
    const ring = t['focus.ring'];
    const halo = t['focus.halo'];
    const bad = FOCUS_ON.filter((b) => !(ratio(ring, t[b]) >= MIN.ui || (halo && ratio(halo, t[b]) >= MIN.ui && ratio(ring, halo) >= MIN.ui))).map((b) => `${b} ring ${ratio(ring, t[b]).toFixed(2)} halo ${halo ? ratio(halo, t[b]).toFixed(2) : '-'}`);
    expect(bad).toEqual([]);
  });
  it('inputs stand out from the surface they sit on (fill or outline 3:1)', () => {
    const bad = INPUT_ON.filter((b) => Math.max(ratio(t['control.border'], t[b]), ratio(t['content.bg'], t[b])) < MIN.ui).map((b) => `${b} outline ${ratio(t['control.border'], t[b]).toFixed(2)} fill ${ratio(t['content.bg'], t[b]).toFixed(2)}`);
    expect(bad).toEqual([]);
  });
  it('states are distinct (ΔE ≥ MIN.state)', () => {
    const bad = STATE.filter(([a, b]) => t[a] && t[b] && deltaE(t[a], t[b]) < MIN.state).map(([a, b]) => `${a} vs ${b} ΔE ${deltaE(t[a], t[b]).toFixed(1)}`);
    expect(bad).toEqual([]);
  });
  it('adjacent regions separate (ΔE ≥ MIN.tier, or a border that does)', () => {
    const bad = [];
    for (const [a, b, edge] of TIER) {
      if (!t[a] || !t[b]) continue;
      const ca = over(t[a], t[b]);
      if (deltaE(ca, t[b]) >= MIN.tier) continue;
      if (edge && t[edge] && Math.min(deltaE(over(t[edge], t[b]), t[b]), deltaE(over(t[edge], ca), ca)) >= MIN.tier) continue;
      bad.push(`${a} vs ${b} ΔE ${deltaE(ca, t[b]).toFixed(1)}${edge ? ` (border ${edge} too weak)` : ''}`);
    }
    expect(bad).toEqual([]);
  });
  it.runIf(DARK.includes(name))('dark surfaces are dark', () => {
    expect(DARK_SURFACES.filter((k) => luminance(t[k]) > 0.12).map((k) => `${k} ${t[k]}`)).toEqual([]);
  });
});
