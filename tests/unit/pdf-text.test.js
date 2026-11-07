// REQ-L10N-11, S-56 (SDP-2.3 §4.8): Unicode text in PDF and GeoPDF. English output keeps the 2.2
// bytes (Helvetica, ASCII text strings); other scripts use Type0 fonts subset from the fonts-noto
// pack (Noto Sans TrueType, Noto Sans CJK CFF) with /W widths and a ToUnicode CMap. The font
// tests use the real pack inputs from .cache/packs-src/fonts and the pack's own fontkit bundle
// (with its build-time patches); pdftotext, when installed, is a second reader.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { unzlibSync } from 'fflate';
import * as esbuild from 'esbuild';
import fontkitNpm from '@pdf-lib/fontkit';
import { textStr, winStr, needsUnicode, fontRuns, hanFont, scriptClass, PdfFonts, FONT_FILES } from '../../app/src/formats/pdf-text.js';
import { layeredPdf, layerLabels } from '../../app/src/hub/layers.js';
import { writePdf } from '../../app/src/formats/pdf-writer.js';
import { pdfFontsFor, resetFontPackNotice } from '../../app/src/formats/font-pack.js';
import { fontkitBundle } from '../../build/packs.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const FONTS = join('.cache', 'packs-src', 'fonts');
const haveFonts = Object.values(FONT_FILES).every((f) => existsSync(join(FONTS, f)));
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const geo = [[1, 2], [1, 3], [0, 3], [0, 2]];

describe('PDF strings', () => {
  it('keeps ASCII text strings as 2.2 wrote them and writes the rest as UTF-16BE', () => {
    expect(textStr('A (test) \\ x')).toBe('(A \\(test\\) \\\\ x)');
    expect(textStr('a\tb')).toBe('(a?b)');
    expect(textStr('SAMPLE — 東京')).toBe('<FEFF00530041004D0050004C004500202014002067714EAC>');
    expect(textStr('𠀋')).toBe('<FEFFD840DC0B>');
  });
  it('encodes WinAnsi labels with octal escapes and knows when Unicode fonts are needed', () => {
    expect(winStr('100 m')).toBe('(100 m)');
    expect(winStr('Zürich – Œuvre (1)')).toBe('(Z\\374rich \\226 \\214uvre \\(1\\))');
    expect(winStr('Київ')).toBe('(????)');
    expect(needsUnicode(['Zürich', 'naïve’s “quote”', '€ 5', 'line\nbreak'])).toBe(false);
    expect(needsUnicode(['ok', 'Київ'])).toBe(true);
    expect(needsUnicode(['東京'])).toBe(true);
  });
  it('picks a font per run by script and UI locale', () => {
    expect([hanFont('ja'), hanFont('ko'), hanFont('zh-Hant'), hanFont('zh-TW'), hanFont('zh-Hans'), hanFont('de'), hanFont('en')]).toEqual(['jp', 'kr', 'tc', 'tc', 'sc', 'sc', 'sc']);
    expect(['東', 'カ', 'か', '한', '、', ' ', '3', 'A', 'Ж', 'Ω'].map((c) => scriptClass(c.codePointAt(0)))).toEqual(['han', 'kana', 'kana', 'hangul', 'cjk', 'neutral', 'neutral', 'text', 'text', 'text']);
    expect(fontRuns('東京タワー 333 m', { locale: 'ja' })).toEqual([{ key: 'jp', text: '東京タワー 333 ' }, { key: 'sans', text: 'm' }]);
    expect(fontRuns('北京 (Beijing)', { locale: 'zh-Hant' })).toEqual([{ key: 'tc', text: '北京 (' }, { key: 'sans', text: 'Beijing)' }]);
    expect(fontRuns('서울 東京', { locale: 'en' })).toEqual([{ key: 'kr', text: '서울 ' }, { key: 'sc', text: '東京' }]);
    expect(fontRuns('Київ, 2026', { locale: 'uk', bold: true })).toEqual([{ key: 'sans-bold', text: 'Київ, 2026' }]);
    // A character no font has becomes '?'; one the chosen font lacks moves to a font that has it.
    const has = (k, cp) => cp < 0x3000 || (k === 'jp' && cp < 0x10000);
    expect(fontRuns('A東\u{1F600}', { locale: 'zh-Hans', has })).toEqual([{ key: 'sans', text: 'A' }, { key: 'jp', text: '東' }, { key: 'sans', text: '?' }]);
  });
});

describe('English output is byte-identical to 2.2', () => {
  afterEach(() => vi.useRealTimers());
  it('layered PDF (Helvetica path)', () => {
    const layers = [{ name: 'Graphics', items: [{ kind: 'poly', pts: [[10, 10], [50, 10], [50, 40]], stroke: '#ff0000', fill: '#ff000040', label: 'AOI (north)' }, { kind: 'point', pts: [[20, 20]], stroke: '#00ff00', label: 'Well \\ 7' }, { kind: 'line', pts: [[1, 1], [9, 9]], stroke: '#0000ff' }] }, { name: 'Scale bar', items: [{ kind: 'text', pts: [[5, 90]], stroke: '#ffffff', label: '100 m' }, { kind: 'text', pts: [[5, 80]], stroke: '#ffffff' }] }];
    const a = layeredPdf({ width: 100, height: 100, jpeg, imgW: 100, imgH: 100, layers, title: 'Chip 3 (test)', geo });
    // SHA-256 of the 2.2.0 writer's output for the same input (commit 008b560b).
    expect([a.length, sha(a)]).toEqual([2125, '6676e4bfcb9f7dabb2f5ad8af0f4480a7c7c831f3184a6c017e826f19534dd98']);
  });
  it('product / GeoPDF writer (ASCII information strings)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 2, 12, 0, 0));
    const b = writePdf([{ widthMm: 210, heightMm: 297, strips: [{ jpeg, width: 10, height: 10, yMm: 0, hMm: 297 }], geo: { frameMm: { x: 10, y: 10, w: 100, h: 100 }, corners: geo } }], { title: 'SAMPLE - x (1)', subject: 'SAMPLE', author: 'A. Analyst', keywords: 'GIS Workbench GeoPDF' });
    expect([b.length, sha(b)]).toEqual([1463, '6aaaf3b41acb6b258c56cc47068ca848df8d15d2945b90bf0ee1897d8708a9d5']);
  });
  it('writes non-ASCII information strings as UTF-16BE (2.2 wrote UTF-8 bytes there)', () => {
    const s = new TextDecoder('latin1').decode(writePdf([{ widthMm: 10, heightMm: 10, strips: [] }], { title: 'SAMPLE — 東京', subject: 'Київ' }));
    expect(s).toContain('/Title <FEFF00530041004D0050004C004500202014002067714EAC>');
    expect(s).toContain('/Subject <FEFF041A043804570432>');
  });
});

// ---- a minimal reader: objects, streams, Type0 fonts, ToUnicode, text in content order ----
function readPdf(u8) {
  const s = new TextDecoder('latin1').decode(u8);
  const objs = new Map();
  for (const m of s.matchAll(/(\d+) 0 obj\n/g)) {
    const start = m.index + m[0].length;
    const end = s.indexOf('\nendobj', start);
    const body = s.slice(start, end);
    const si = body.indexOf('\nstream\n');
    let data = null;
    if (si >= 0) {
      const from = start + si + 8;
      const len = Number(/\/Length (\d+)/.exec(body)[1]);
      data = u8.subarray(from, from + len);
      if (/\/FlateDecode/.test(body.slice(0, si))) data = unzlibSync(data);
    }
    objs.set(Number(m[1]), { dict: si >= 0 ? body.slice(0, si) : body, data });
  }
  const ref = (d, key) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(d)?.[1]);
  const fonts = new Map(); // resource name → {base, sub, cmap Map(cid → string), widths, file, fileKind}
  const page = [...objs.values()].find((o) => /\/Type \/Page\b/.test(o.dict));
  const fontDict = /\/Font << ([^>]*) >>/.exec(page.dict)[1];
  for (const m of fontDict.matchAll(/\/(\w+) (\d+) 0 R/g)) {
    const t0 = objs.get(Number(m[2])).dict;
    const f = { base: /\/BaseFont \/(\S+)/.exec(t0)[1], type: /\/Subtype \/(\w+)/.exec(t0)[1], cmap: new Map() };
    if (f.type === 'Type0') {
      const cid = objs.get(Number(/\/DescendantFonts \[(\d+) 0 R\]/.exec(t0)[1])).dict;
      f.sub = /\/Subtype \/(\w+)/.exec(cid)[1];
      f.widths = /\/W \[(.*)\]/.exec(cid)[1];
      const desc = objs.get(ref(cid, 'FontDescriptor')).dict;
      f.fileKind = /\/(FontFile[23]?)/.exec(desc)[1];
      f.file = objs.get(ref(desc, f.fileKind));
      const cm = new TextDecoder().decode(objs.get(ref(t0, 'ToUnicode')).data);
      for (const b of cm.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)) {
        const units = b[2].match(/.{4}/g).map((h) => parseInt(h, 16));
        f.cmap.set(parseInt(b[1], 16), String.fromCharCode(...units));
      }
    }
    fonts.set(m[1], f);
  }
  const content = new TextDecoder('latin1').decode(objs.get(ref(page.dict, 'Contents')).data);
  const texts = [];
  for (const bt of content.matchAll(/BT (.*?) ET/g)) {
    let cur = null;
    let out = '';
    for (const tok of bt[1].matchAll(/\/(\w+) [\d.]+ Tf|<([0-9A-F]*)>|\((.*?)\) Tj/g)) {
      if (tok[1]) cur = fonts.get(tok[1]);
      else if (tok[2] !== undefined) for (const h of tok[2].match(/.{4}/g) ?? []) out += cur.cmap.get(parseInt(h, 16)) ?? '�';
      else out += tok[3];
    }
    texts.push(out);
  }
  return { s, objs, fonts, texts };
}

const pdftotext = (() => {
  try {
    const r = spawnSync('pdftotext', ['-v'], { encoding: 'utf8' }); // poppler exits 99 after printing its version
    return !r.error && /pdftotext/i.test(`${r.stdout}${r.stderr}`);
  } catch {
    return false;
  }
})();

describe('Unicode fonts from the fonts-noto pack inputs', async () => {
  // The pinned font inputs come from `node build/packs.mjs --fetch`; without them these checks are skipped.
  if (!haveFonts) {
    it.skip('needs the fonts-noto pack inputs in .cache/packs-src/fonts', () => {});
    return;
  }
  // The pack's fontkit.js, run as the app runs it (a classic script setting globalThis.__lib).
  vm.runInThisContext(await fontkitBundle(esbuild));
  const fontkit = globalThis.__lib.fontkit;
  const fontBytes = (k) => readFileSync(join(FONTS, FONT_FILES[k]));
  const labels = ['東京タワー 333 m', 'Київ — столиця', 'Office AV Wa', '日本語の地図、縮尺と方位', 'Zürich'];
  const layers = [{ name: 'Graphics', items: labels.map((label, i) => ({ kind: 'text', pts: [[5, 10 + i * 15]], stroke: '#ffffff', label })) }, { name: 'Ортофото', items: [{ kind: 'point', pts: [[30, 30]], stroke: '#00ff00', label: 'Пункт 7' }] }];
  const fonts = await new PdfFonts({ fontkit, fontBytes, locale: 'ja' }).add(layerLabels(layers)).finish();
  const pdf = layeredPdf({ width: 400, height: 120, jpeg, imgW: 400, imgH: 120, layers, title: '地図 — Київ', geo, fonts });
  const r = readPdf(pdf);

  it('embeds a CIDFontType0 (CFF) subset for Japanese and a CIDFontType2 (TrueType) subset for Latin and Cyrillic', () => {
    const list = [...r.fonts.values()];
    expect(list.map((f) => [f.base.replace(/^[A-Z]{6}\+/, ''), f.sub, f.fileKind]).sort()).toEqual([
      ['NotoSans-Regular', 'CIDFontType2', 'FontFile2'],
      ['NotoSansJP-Regular', 'CIDFontType0', 'FontFile3'],
    ]);
    for (const f of list) {
      expect(f.base).toMatch(/^[A-Z]{6}\+/);
      expect(f.widths.length).toBeGreaterThan(10);
    }
    expect(r.s).toContain('/Encoding /Identity-H');
    expect(r.s).toContain('/CIDToGIDMap /Identity');
    expect(r.s).not.toContain('/Helvetica');
    // Valid xref: every offset points at "n 0 obj".
    const xref = r.s.slice(r.s.lastIndexOf('\nxref\n'));
    const offs = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offs.forEach((o, i) => expect(r.s.slice(o, o + 12)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(Number(/\/Size (\d+)/.exec(r.s.slice(r.s.lastIndexOf('trailer')))[1])).toBe(offs.length + 1);
  });

  it('reads the labels back through the ToUnicode CMaps, and keeps the text strings in UTF-16BE', () => {
    expect(r.texts).toEqual([...labels, 'Пункт 7']);
    expect(r.s).toMatch(/\/Type \/OCG \/Name <FEFF041E04400442043E0444043E0442043E>/);
    expect(r.s).toContain('/Title <FEFF573056F3002020140020041A043804570432>');
  });

  it('writes subsets FreeType-family readers accept: CFF header offSize 1–4, each glyph on its own font dict', () => {
    const jp = [...r.fonts.values()].find((f) => f.sub === 'CIDFontType0');
    const cff = jp.file.data;
    expect([cff[0], cff[2]]).toEqual([1, 4]); // major version, header size
    expect(cff[3]).toBeGreaterThanOrEqual(1);
    expect(cff[3]).toBeLessThanOrEqual(4);
    // The subset's FDSelect must give each glyph the Private dict of its FD in the full font.
    const full = fontkitNpm.create(fontBytes('jp'));
    const otf = new Uint8Array(cff.length + 0);
    otf.set(cff);
    const sub = fontkitNpm.create(wrapCff(otf))['CFF '];
    const fullCff = full['CFF '];
    const gids = [...fonts.fonts.get('jp').cids.entries()]; // [original gid, cid]
    const fdsUsed = new Set(gids.map(([g]) => fullCff.fdForGlyph(g)));
    expect(fdsUsed.size).toBeGreaterThan(2); // kana, kanji, Latin and punctuation sit on different FDs
    for (const [g, cid] of gids) {
      const a = fullCff.topDict.FDArray[fullCff.fdForGlyph(g)].Private;
      const b = sub.topDict.FDArray[sub.fdForGlyph(cid)].Private;
      expect([b.defaultWidthX, b.nominalWidthX, JSON.stringify(b.BlueValues), b.Subrs?.length ?? 0]).toEqual([a.defaultWidthX, a.nominalWidthX, JSON.stringify(a.BlueValues), a.Subrs?.length ?? 0]);
    }
  });

  it.skipIf(!pdftotext)('pdftotext reads the same text (an independent reader)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-pdf-'));
    try {
      const f = join(dir, 'a.pdf');
      writeFileSync(f, pdf);
      const res = spawnSync('pdftotext', ['-enc', 'UTF-8', '-raw', f, '-'], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stderr).not.toMatch(/invalid|error/i);
      const got = res.stdout.replace(/\s+/g, ' ');
      for (const l of [...labels, 'Пункт 7']) expect(got).toContain(l);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('picks the Han font from the UI locale (zh-Hant → Traditional Chinese, ko → Korean)', async () => {
    for (const [loc, want] of [['zh-Hant', 'NotoSansTC-Regular'], ['ko', 'NotoSansKR-Regular'], ['de', 'NotoSansSC-Regular']]) {
      const f = await new PdfFonts({ fontkit, fontBytes, locale: loc }).add(['臺灣']).finish();
      expect(f.used.map((k) => f.fonts.get(k).font.postscriptName)).toEqual([want]);
    }
  });
});

/** A bare CFF table wrapped as an OpenType font (OTTO with one 'CFF ' table) so fontkit can parse it. */
function wrapCff(cff) {
  const out = new Uint8Array(12 + 16 + cff.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x4f54544f); // 'OTTO'
  dv.setUint16(4, 1);
  dv.setUint32(12, 0x43464620); // 'CFF '
  dv.setUint32(20, 28);
  dv.setUint32(24, cff.length);
  out.set(cff, 28);
  return out;
}

describe('pdfFontsFor without the pack', () => {
  it('keeps writing with Helvetica and tells the user once', async () => {
    resetFontPackNotice();
    const toasts = [];
    const app = { packs: { require: async () => Promise.reject(Object.assign(new Error('needs the pack'), { code: 'E_PACK_REQUIRED' })) }, toast: (m, o) => toasts.push([m, o.kind]), log: () => {} };
    expect(await pdfFontsFor(app, ['ASCII only'])).toBe(null);
    expect(toasts).toEqual([]);
    expect(await pdfFontsFor(app, ['東京'])).toBe(null);
    expect(await pdfFontsFor(app, ['Київ'])).toBe(null);
    expect(toasts.length).toBe(1);
    expect(toasts[0][1]).toBe('info');
    const s = new TextDecoder('latin1').decode(layeredPdf({ width: 10, height: 10, jpeg, imgW: 10, imgH: 10, layers: [{ name: 'G', items: [{ kind: 'text', pts: [[1, 1]], label: '東京 1' }] }], fonts: null }));
    expect(s).toContain('(?? 1) Tj');
    expect(s).toContain('/BaseFont /Helvetica');
  });
});
