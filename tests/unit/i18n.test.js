// Localisation core (REQ-L10N-01..07, REQ-L10N-16, REQ-L10N-21; S-52).
import { describe, it, expect, afterEach } from 'vitest';
import { parse, format, signature } from '../../app/src/i18n/icu.js';
import { t, tc, tr, N_, setLocale, negotiate, gwError, msgOf, keyOf, dirOf, locale } from '../../app/src/i18n/index.js';
import { num, int, length, area, setUnits, words, list } from '../../app/src/i18n/format.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { messagesInJs, messagesInRust, checkMessage, lintJs, unquote, extract, serializeSource, sourceDrift } from '../../build/i18n.mjs';

afterEach(() => {
  setLocale('en');
  setUnits('metric');
});

describe('ICU parser and formatter', () => {
  it('formats arguments, plurals, selects and numbers', () => {
    const f = (m, p, l = 'en') => format(parse(m), p, l);
    expect(f('Hello {name}', { name: 'Ana' })).toBe('Hello Ana');
    expect(f('{n, plural, one {# layer} other {# layers}}', { n: 1 })).toBe('1 layer');
    expect(f('{n, plural, one {# layer} other {# layers}}', { n: 3 })).toBe('3 layers');
    expect(f('{n, plural, =0 {no layers} one {# layer} other {# layers}}', { n: 0 })).toBe('no layers');
    expect(f('{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}', { n: 5 }, 'pl')).toBe('5 plików');
    expect(f('{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}', { n: 3 }, 'pl')).toBe('3 pliki');
    expect(f('{k, select, raster {Image} vector {Layer} other {Item}}', { k: 'vector' })).toBe('Layer');
    expect(f('{v, number, ::.00} m', { v: 3.14159 }, 'de')).toBe('3,14 m');
    expect(f('{p, number, percent}', { p: 0.25 })).toBe('25%');
  });
  it('keeps apostrophes as text unless they quote syntax', () => {
    const f = (m, p) => format(parse(m), p ?? {}, 'en');
    expect(f("Can't open {file}", { file: 'a.ntf' })).toBe("Can't open a.ntf");
    expect(f("Type '{'x'}' literally")).toBe('Type {x} literally');
    expect(f("It''s")).toBe("It's");
    expect(f("a 'b'")).toBe("a 'b'");
    expect(f("ends with '")).toBe("ends with '");
  });
  it('rejects malformed messages', () => {
    for (const bad of ['{', 'a } b', '{n, plural, one {x}}', '{n, bogus}']) expect(() => parse(bad)).toThrow();
  });
  it('leaves a missing argument visible', () => {
    expect(format(parse('File {name}'), {})).toBe('File {name}');
  });
  it('compares placeholder signatures', () => {
    expect(signature(parse('{n, plural, one {# x} other {# xs}} in {f}'))).toEqual(['f:arg', 'n:plural']);
  });
});

describe('runtime', () => {
  it('returns English without a catalogue and translates with one', () => {
    expect(t('Open Image…')).toBe('Open Image…');
    setLocale('de', { keys: ['Open Image…', keyOf('Open', 'verb'), 'Opened {n, plural, one {# file} other {# files}}'], values: ['Bild öffnen…', 'Öffnen', '{n, plural, one {# Datei} other {# Dateien}} geöffnet'] });
    expect(locale()).toBe('de');
    expect(t('Open Image…')).toBe('Bild öffnen…');
    expect(tc('verb', 'Open')).toBe('Öffnen');
    expect(t('Opened {n, plural, one {# file} other {# files}}', { n: 2 })).toBe('2 Dateien geöffnet');
    expect(t('Not in the catalogue')).toBe('Not in the catalogue');
    expect(tr(N_('Open Image…'))).toBe('Bild öffnen…');
  });
  it('negotiates locales', () => {
    const av = ['en', 'de', 'pt-BR', 'pt-PT', 'zh-Hans'];
    expect(negotiate(['de-AT', 'en'], av)).toBe('de');
    expect(negotiate(['pt-BR'], av)).toBe('pt-BR');
    expect(negotiate(['pt'], av)).toBe('pt-BR');
    expect(negotiate(['xx', 'fr'], av)).toBe('en');
    expect(negotiate(['zh-Hans-CN'], av)).toBe('zh-Hans');
    expect(dirOf('ar')).toBe('rtl');
    expect(dirOf('ar-XB')).toBe('rtl');
    expect(dirOf('ja')).toBe('ltr');
  });
  it('pseudo-locales change every text run and keep placeholders', () => {
    setLocale('en-XA');
    const s = t('Open {file} now', { file: 'a.ntf' });
    expect(s).toMatch(/^⟦Ó.*a\.ntf.*⟧$/);
    expect(s).not.toContain('Open');
    setLocale('ar-XB');
    expect(t('Close')).toContain('‮');
  });
  it('keeps message keys on errors across threads', () => {
    const e = gwError('Not a {kind} file', { kind: 'NITF' }, 'E_FORMAT');
    expect(e.message).toBe('Not a NITF file');
    expect(e.code).toBe('E_FORMAT');
    setLocale('de', { keys: ['Not a {kind} file', 'unknown coordinate format'], values: ['Keine {kind}-Datei', 'Unbekanntes Koordinatenformat'] });
    expect(msgOf(e)).toBe('Keine NITF-Datei');
    expect(msgOf(new Error('unknown coordinate format'))).toBe('Unbekanntes Koordinatenformat');
    expect(msgOf(new Error('dynamic 42'))).toBe('dynamic 42');
  });
});

describe('display formatting', () => {
  it('uses the locale decimal sign without grouping analytic values', () => {
    setLocale('de', { keys: [], values: [] });
    expect(num(1234.567, 2)).toBe('1234,57');
    expect(int(1234567)).toBe('1.234.567');
    setLocale('en');
    expect(num(1234.567, 2)).toBe('1234.57');
    expect(num(NaN)).toBe('–');
  });
  it('converts units for display only', () => {
    expect(length(1500)).toBe('1.500 km');
    setUnits('imperial');
    expect(length(1609.344)).toBe('1.00 mi');
    setUnits('nautical');
    expect(length(1852 * 3)).toBe('3.00 NM');
    setUnits('metric');
    expect(area(2e6)).toBe('2.000 km²');
  });
  it('segments CJK for search and formats lists', () => {
    setLocale('ja', { keys: [], values: [] });
    expect(words('画像を開く').length).toBeGreaterThan(1);
    setLocale('en');
    expect(list(['a', 'b', 'c'])).toBe('a, b, and c');
  });
});

describe('build tooling', () => {
  it('extracts t, tc, N_ and gwError literals only from modules that use i18n', () => {
    const code = `import { t, tc, N_ } from '../i18n/index.js';\nconst a = t('Open {file}', { file });\n// t('commented out')\nconst b = tc('verb', 'Open');\nconst rows = [N_('Label')];\nthrow new Error('static failure here');\nthrow new Error(\`dynamic \${x}\`);`;
    const m = messagesInJs(code);
    expect(m.map((x) => x.src)).toEqual(['Open {file}', 'Label', 'Open', 'static failure here']);
    expect(m.find((x) => x.src === 'Open').key).toBe('verb\u0004Open');
    expect(messagesInJs(`const t = (x) => x; t('not ours');`).map((x) => x.src)).toEqual([]);
  });
  it('extracts static Rust error messages', () => {
    const rs = 'return Err(Error::invalid("not a SICD model")); Err(Error::range(format!("{} rows", n)))';
    expect(messagesInRust(rs).map((x) => x.src)).toEqual(['not a SICD model']);
  });
  it('unquotes JS literals', () => {
    expect(unquote("'it\\'s \\u00e9'")).toBe("it's é");
    expect(unquote('"a\\nb"')).toBe('a\nb');
  });
  it('checks translations against their source', () => {
    expect(checkMessage('Open {file}', 'Öffnen {file}')).toEqual([]);
    expect(checkMessage('Open {file}', 'Öffnen {datei}')[0]).toMatch(/placeholders differ/);
    expect(checkMessage('GeoTIFF file', 'Fichier géoTIFF', ['GeoTIFF'])[0]).toMatch(/do-not-translate/);
    expect(checkMessage('Open', '{')[0]).toMatch(/translation/);
  });
  it('flags bare user-visible literals', () => {
    const hits = lintJs(`toast('Saved the file');\nmodal({ title: 'Jump to Point', buttons: ['Jump', 'Cancel'] });\nh('p', { class: 'hint' }, 'Type a coordinate');\ntoast(t('Already fine'));\nh('div', { class: 'x' }, 'ok'); // i18n-ignore`, 'x.js');
    expect(hits.map((h) => h.kind).sort()).toEqual(['buttons', 'text', 'title', 'toast']);
  });
  it('keeps en.json still when a string only moves, and reports a new or dropped string', () => {
    const root = mkdtempSync(join(tmpdir(), 'gwb-i18n-'));
    try {
      const file = join(root, 'app', 'src', 'a.js');
      mkdirSync(join(root, 'app', 'src'), { recursive: true });
      const write = (body) => writeFileSync(file, `import { t } from './i18n/index.js';\n${body}`);
      write(`t('Open');\nt('Close');`);
      const before = extract({ root });
      expect(before.messages.map((m) => m.refs)).toEqual([['a.js'], ['a.js']]);
      const saved = serializeSource(before);
      write(`\n\n\nt('Close');\nt('Open');`);
      expect(sourceDrift(extract({ root }), saved)).toBeNull();
      expect(sourceDrift(extract({ root }), saved.replace(/\n/g, '\r\n'))).toBeNull();
      write(`t('Open');\nt('Save');`);
      expect(sourceDrift(extract({ root }), saved)).toEqual({ added: ['Save'], removed: ['Close'] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('one source text, two meanings', () => {
  // #187: Buffer's line-end option "Square" shared its key with the Square command (make corners
  // square), so other locales showed the command's verb in the Line ends list.
  it("gives Buffer's Square line end its own key, apart from the Square command", () => {
    const read = (f) => messagesInJs(readFileSync(join('app', 'src', f), 'utf8')).filter((m) => m.src === 'Square');
    const option = read(join('features', 'geoproc-ui.js'));
    const command = read(join('shell', 'commands.js'));
    expect(option.map((m) => m.key)).toEqual([keyOf('Square', 'line end')]);
    expect(command.map((m) => m.key)).toEqual([keyOf('Square')]);
    expect(option[0].key).not.toBe(command[0].key);
  });

  // The keys of every message with this source text in one file under app/src.
  const keys = (file, src) => messagesInJs(readFileSync(join('app', 'src', ...file.split('/')), 'utf8')).filter((m) => m.src === src).map((m) => m.key);

  // #193: the vector Buffer dialog shared "Buffer" with the landing-zone clearance margin, so
  // Spanish titled the dialog "Margen libre".
  it('gives the landing-zone Buffer margin its own key, apart from the vector Buffer dialog', () => {
    expect(keys('features/terrain-analysis.js', 'Buffer')).toEqual([keyOf('Buffer', 'landing zone')]);
    expect(keys('features/geoproc-ui.js', 'Buffer')).toEqual([keyOf('Buffer')]);
  });

  // Overlay's Erase removes the overlap; the whiteboard's Erase is the eraser, and the locales
  // translated it as that (de "Radieren", fr "Gommer", it "Gomma").
  it("gives overlay's Erase operation its own key, apart from the whiteboard eraser", () => {
    expect(keys('features/geoproc-ui.js', 'Erase')).toEqual([keyOf('Erase', 'overlay')]);
    expect(keys('feedback/whiteboard.js', 'Erase')).toEqual([keyOf('Erase')]);
  });

  // #201: the overlay result layer is named "{a} {op} {b}" with op from the lowercase "erase", and
  // the locales kept the eraser sense there (de "A Radieren B" next to the Operation "Differenz").
  it("names the Erase overlay's layer with the same word as its Operation, in every locale", () => {
    const dir = join('app', 'src', 'i18n', 'catalog');
    const wrong = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
      const tag = f.slice(0, -5);
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8')).messages;
      const op = m[keyOf('Erase', 'overlay')];
      if (op && m.erase?.toLocaleLowerCase(tag) !== op.toLocaleLowerCase(tag)) wrong.push(`${tag}: ${m.erase} / ${op}`);
    }
    expect(wrong).toEqual([]);
  });

  // A storage bucket's Region is the provider's data centre region; spectral classification's
  // Region is a part of the image, and ja translated it as that ("領域").
  it("gives a bucket's Region its own key, apart from a region of the image", () => {
    expect(keys('features/catalog.js', 'Region')).toEqual([keyOf('Region', 'cloud storage')]);
    expect(keys('features/spectral-analysis.js', 'Region')).toEqual([keyOf('Region')]);
  });

  // #194: a control point's Ground is its ground coordinate; Extract from DSM's Ground is the
  // bare-earth surface (a DTM), the sense the locales translated (de "Boden", fr "Sol").
  it("gives a control point's Ground coordinate its own key, apart from the ground surface", () => {
    expect(keys('features/register.js', 'Ground')).toEqual([keyOf('Ground', 'control point')]);
    expect(keys('features/extract-r2.js', 'Ground')).toEqual([keyOf('Ground')]);
  });
});
