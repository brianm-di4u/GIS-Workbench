// REQ-L10N-10 (SDP-2.3 §4.7–4.8): per-script font stacks from ui-tokens.json for CSS and canvas,
// canvas text direction, and the language of office exports. Latin stacks do not change.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { setLocale } from '../../app/src/i18n/index.js';
import { canvasFont, canvasText, fontFamily, officeLang, startX } from '../../app/src/i18n/fonts.js';
import { withFonts, scriptOfLocale, scriptFonts } from '../../app/src/i18n/fontstack.js';
import { tokensCss } from '../../build/tokens.mjs';

const T = JSON.parse(readFileSync('app/src/data/ui-tokens.json', 'utf8'));

afterEach(() => setLocale('en'));

describe('font stacks', () => {
  it('adds a script after the named fonts and before the generic families', () => {
    expect(withFonts('Arial, Helvetica, sans-serif', ['Yu Gothic UI', 'Meiryo'])).toBe('Arial, Helvetica, "Yu Gothic UI", Meiryo, sans-serif');
    expect(withFonts('Consolas, ui-monospace, monospace', ['Malgun Gothic'])).toBe('Consolas, "Malgun Gothic", ui-monospace, monospace');
    expect(withFonts('"Segoe UI", Arial, sans-serif', ['Segoe UI', 'Noto Naskh Arabic'])).toBe('"Segoe UI", Arial, "Noto Naskh Arabic", sans-serif');
    expect(withFonts('Arial, sans-serif', [])).toBe('Arial, sans-serif');
  });
  it('maps UI locales to scripts, own CJK stack first', () => {
    expect(['en', 'de', 'uk', 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'zh-TW', 'ar', 'ar-XB', 'he', 'th', 'hi'].map(scriptOfLocale)).toEqual([null, null, null, 'ja', 'ko', 'zh-Hans', 'zh-Hant', 'zh-Hant', 'ar', 'ar', 'he', 'th', 'hi']);
    const ja = scriptFonts('ja', T.fontScripts.stacks);
    expect(ja.slice(0, 2)).toEqual(['Yu Gothic UI', 'Meiryo UI']);
    expect(ja).toContain('Microsoft YaHei UI');
    expect(ja).toContain('Malgun Gothic');
    expect(ja.indexOf('Noto Sans CJK JP')).toBeLessThan(ja.indexOf('Microsoft YaHei UI'));
    expect(scriptFonts(null, T.fontScripts.stacks)).toEqual([]);
  });
  it('keeps the Latin CSS stacks and adds :lang() rules for the scripts', () => {
    const css = tokensCss('app/src/data/ui-tokens.json');
    const root = css.split('\n')[1];
    expect(root).toContain(`--f-ui:${T.fonts.ui.family};`);
    expect(root).toContain(`--f-onImageLabel:${T.fonts.onImageLabel.family};`);
    expect(css).toContain(':root:lang(ja){--f-ui:"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, "Yu Gothic UI",');
    expect(css).toMatch(/:root:lang\(zh\)\{[^}]*--f-hud:Consolas, "Microsoft YaHei UI",[^}]*ui-monospace, monospace;/);
    expect(css.indexOf(':root:lang(zh-Hant)')).toBeGreaterThan(css.indexOf(':root:lang(zh)'));
  });
});

describe('canvas text', () => {
  it('is unchanged for Latin, with CJK fallbacks for a CJK UI', () => {
    expect(canvasFont(11)).toBe(`11px ${T.fonts.onImageLabel.family}`);
    expect(canvasFont(12, 'label', { bold: true })).toBe('bold 12px Arial, Helvetica, sans-serif');
    expect(canvasFont(10, 'ui', { weight: 600 })).toBe(`600 10px ${T.fonts.ui.family}`);
    setLocale('ja');
    expect(canvasFont(11)).toMatch(/^11px Arial, Helvetica, "Yu Gothic UI", .*, sans-serif$/);
    expect(fontFamily('hud', 'ko')).toMatch(/^Consolas, "Malgun Gothic", /);
  });
  it('sets the direction and lays out box text from the right in RTL', () => {
    const g = {};
    canvasText(g, 11, 'label');
    expect(g.direction).toBe('ltr');
    expect(startX(10, 110, 4)).toBe(14);
    setLocale('ar-XB');
    canvasText(g, 11, 'label');
    expect(g.direction).toBe('rtl');
    expect(startX(10, 110, 4)).toBe(106);
  });
});

describe('office language', () => {
  it('gives Word and PowerPoint a full tag, East Asian and RTL flags and the document font', () => {
    expect(officeLang('en')).toEqual({ lang: 'en-GB', eastAsia: false, rtl: false, font: null });
    expect(officeLang('de').lang).toBe('de-DE');
    expect(officeLang('pt-BR').lang).toBe('pt-BR');
    expect(officeLang('uk').lang).toBe('uk-UA');
    expect(officeLang('cs').lang).toBe('cs-CZ');
    expect(officeLang('ja')).toEqual({ lang: 'ja-JP', eastAsia: true, rtl: false, font: 'Yu Gothic' });
    expect(officeLang('zh-Hans')).toEqual({ lang: 'zh-CN', eastAsia: true, rtl: false, font: 'Microsoft YaHei' });
    expect(officeLang('ko').font).toBe('Malgun Gothic');
    expect(officeLang('ar-XB')).toEqual({ lang: 'ar-SA', eastAsia: false, rtl: true, font: 'Arial' });
  });
});
