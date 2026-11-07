// Text in the PDF writers (REQ-L10N-11, SDP-2.3 §4.8, S-56; DN-62).
//
// Two ways to show text, chosen per document:
// - Helvetica with WinAnsiEncoding when every string fits that encoding (English and most of the
//   Western European wave-1 languages). For ASCII the bytes are exactly those of the 2.2 writers.
// - Otherwise Type0 fonts with Identity-H: a CIDFontType2 (TrueType: Noto Sans for Latin, Greek
//   and Cyrillic) or CIDFontType0 (CFF: Noto Sans CJK SC/TC/JP/KR) per font used, each a subset
//   made by fontkit, with a /W widths array and a ToUnicode CMap so the text can be selected and
//   searched. CIDs are the subset's glyph ids (fontkit's layout picks the glyphs, so ligatures and
//   kerning come from the font). The fonts and fontkit come from the fonts-noto pack
//   (formats/font-pack.js); without it the writers use Helvetica and '?' for what it cannot show.
//
// Each run of text gets a font by script: Han by the UI locale (ja → JP, ko → KR, zh-Hant → TC,
// otherwise SC), kana JP, Hangul KR, everything else Noto Sans; spaces, digits and punctuation stay
// in the font of the text around them; a character the chosen font lacks tries the others.
// Wave 3 (ar he fa ur hi th) needs a shaper (HarfBuzz) and bidi reordering before layout; the run
// split below is where a script's font and shaper plug in.
//
// Text strings outside content streams (document information, layer and viewport names) are
// PDF text strings: ASCII as before, anything else UTF-16BE with a byte order mark.

import { zlibSync } from 'fflate';

// ---- strings outside content streams ----

const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF text string: (ASCII) as the 2.2 writers wrote it, else <FEFF…> UTF-16BE. Control characters become '?'. */
export function textStr(s) {
  const v = String(s ?? '');
  if (!/[^\x00-\x7f]/.test(v)) return `(${esc(v.replace(/[\x00-\x1f]/g, '?'))})`;
  let hex = 'FEFF';
  for (const ch of v.replace(/[\x00-\x1f\x7f-\x9f]/g, '?')) {
    const cp = ch.codePointAt(0);
    hex += cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp);
  }
  return `<${hex}>`;
}

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// ---- Helvetica / WinAnsiEncoding ----

// cp1252 code points in 0x80–0x9F (WinAnsiEncoding, ISO 32000-1 Annex D).
const WIN = new Map([[0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f]]);
const winCode = (cp) => ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) ? cp : (WIN.get(cp) ?? -1));
// Control characters are '?' on either path, so they never call for the Unicode fonts.
const isControl = (cp) => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

/** True when some string has a character Helvetica (WinAnsiEncoding) cannot show. */
export function needsUnicode(strings) {
  for (const s of strings) for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    if (!isControl(cp) && winCode(cp) < 0) return true;
  }
  return false;
}

/** A WinAnsi string operand: ASCII as is (escaped), other cp1252 characters as octal escapes, the rest '?'. */
export function winStr(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const cp = ch.codePointAt(0);
    const c = cp < 0x20 ? 0x3f : cp === 0x7f ? 0x7f : winCode(cp); // as in 2.2: C0 controls '?', DEL kept
    if (c < 0) out += '?';
    else if (c < 0x80) out += c === 0x5c || c === 0x28 || c === 0x29 ? `\\${String.fromCharCode(c)}` : String.fromCharCode(c);
    else out += `\\${c.toString(8).padStart(3, '0')}`;
  }
  return `(${out})`;
}

export const HELVETICA = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// ---- scripts and fonts ----

/** Pack entry of each font key. */
export const FONT_FILES = { sans: 'NotoSans-Regular.ttf', 'sans-bold': 'NotoSans-Bold.ttf', sc: 'NotoSansSC-Regular.otf', tc: 'NotoSansTC-Regular.otf', jp: 'NotoSansJP-Regular.otf', kr: 'NotoSansKR-Regular.otf' };

/** The CJK font for Han characters in a UI locale. */
export function hanFont(locale) {
  const l = String(locale ?? '').toLowerCase();
  if (l === 'ja' || l.startsWith('ja-')) return 'jp';
  if (l === 'ko' || l.startsWith('ko-')) return 'kr';
  if (/^zh-(hant|tw|hk|mo)\b/.test(l)) return 'tc';
  return 'sc';
}

const inR = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);
const HAN = [[0x2e80, 0x2fdf], [0x3005, 0x3005], [0x3007, 0x3007], [0x3021, 0x3029], [0x3038, 0x303b], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x3134f]];
const KANA = [[0x3040, 0x30ff], [0x31f0, 0x31ff], [0xff66, 0xff9f], [0x1b000, 0x1b16f]];
const HANGUL = [[0x1100, 0x11ff], [0x3130, 0x318f], [0xa960, 0xa97f], [0xac00, 0xd7ff], [0xffa0, 0xffdc]];
const CJK = [[0x3000, 0x303f], [0x3100, 0x312f], [0x3190, 0x31ef], [0x3200, 0x33ff], [0xfe30, 0xfe4f], [0xff00, 0xff65], [0xffe0, 0xffef]];

/** Script class of a code point: 'han', 'kana', 'hangul', 'cjk' (CJK punctuation and symbols), 'neutral' or 'text'. */
export function scriptClass(cp) {
  if (inR(cp, HAN)) return 'han';
  if (inR(cp, KANA)) return 'kana';
  if (inR(cp, HANGUL)) return 'hangul';
  if (inR(cp, CJK)) return 'cjk';
  if ((cp < 0x80 && !/[A-Za-z]/.test(String.fromCharCode(cp))) || (cp >= 0xa0 && cp <= 0xbf) || (cp >= 0x2000 && cp <= 0x206f) || cp === 0xd7 || cp === 0xf7) return 'neutral';
  return 'text';
}

/** Split a string into [{key, text}] runs by font (see the header). has(key, cp) says whether a font has a glyph. */
export function fontRuns(text, { locale = 'en', bold = false, has = () => true } = {}) {
  const han = hanFont(locale);
  const sans = bold ? 'sans-bold' : 'sans';
  const chars = [...String(text ?? '')].map((ch) => {
    const cp = ch.codePointAt(0);
    return { ch: isControl(cp) ? '?' : ch, cp: isControl(cp) ? 0x3f : cp };
  });
  let lastCjk = null;
  for (const c of chars) {
    const k = scriptClass(c.cp);
    c.key = k === 'han' ? han : k === 'kana' ? 'jp' : k === 'hangul' ? 'kr' : k === 'cjk' ? (lastCjk ?? han) : k === 'text' ? sans : null;
    if (k === 'han' || k === 'kana' || k === 'hangul') lastCjk = c.key;
  }
  // Neutrals take the font before them (or the first one after them at the start).
  let prev = chars.find((c) => c.key)?.key ?? sans;
  for (const c of chars) {
    if (!c.key) c.key = prev;
    prev = c.key;
  }
  const order = [sans, han, 'jp', 'sc', 'tc', 'kr'];
  for (const c of chars) {
    if (has(c.key, c.cp)) continue;
    const alt = [...new Set([c.key, ...order])].find((k) => has(k, c.cp));
    if (alt) c.key = alt;
    else {
      c.ch = '?';
      c.cp = 0x3f;
      c.key = sans;
    }
  }
  const runs = [];
  for (const c of chars) {
    if (runs.length && runs.at(-1).key === c.key) runs.at(-1).text += c.ch;
    else runs.push({ key: c.key, text: c.ch });
  }
  return runs;
}

// ---- Type0 fonts ----

const encodeSubset = (subset) =>
  new Promise((resolve, reject) => {
    const parts = [];
    subset
      .encodeStream()
      .on('data', (b) => parts.push(b))
      .on('end', () => {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let o = 0;
        for (const p of parts) {
          out.set(p, o);
          o += p.length;
        }
        resolve(out);
      })
      .on('error', reject);
  });

/** Six capital letters from the glyph set: the subset tag (ISO 32000-1 §9.6.4), stable for the same text. */
function subsetTag(name, gids) {
  let h = 0x811c9dc5;
  for (const v of [...String(name)].map((c) => c.charCodeAt(0)).concat(gids)) {
    h ^= v & 0xffff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + (i + 1) * 7919;
  }
  return tag;
}

const pdfName = (s) => String(s).replace(/[^A-Za-z0-9+\-_.]/g, '');

function toUnicodeCMap(map) {
  const lines = ['/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap', '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def', '/CMapName /Adobe-Identity-UCS def', '/CMapType 2 def', '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange'];
  const entries = [...map].sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100);
    lines.push(`${part.length} beginbfchar`);
    for (const [cid, str] of part) {
      let u = '';
      for (const ch of str) {
        const cp = ch.codePointAt(0);
        u += cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp);
      }
      lines.push(`<${hex4(cid)}> <${u}>`);
    }
    lines.push('endbfchar');
  }
  lines.push('endcmap', 'CMapName currentdict /CIDInit /ProcSet findresource exch defineresource pop', 'end', 'end');
  return lines.join('\n');
}

/** /W array: runs of consecutive CIDs → [c [w1 w2 …] …]. */
function widthsArray(widths) {
  const cids = [...widths.keys()].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  while (i < cids.length) {
    let j = i;
    while (j + 1 < cids.length && cids[j + 1] === cids[j] + 1) j++;
    out.push(`${cids[i]} [${cids.slice(i, j + 1).map((c) => widths.get(c)).join(' ')}]`);
    i = j + 1;
  }
  return `[${out.join(' ')}]`;
}

const enc = new TextEncoder();
const r1 = (v) => Math.round(v);

/**
 * Unicode fonts for one PDF. Use: `const f = new PdfFonts({fontkit, fontBytes, locale}); f.add(strings);
 * await f.finish();` then, while writing, `f.allocate(firstObj)` before the page dictionaries,
 * `f.resources()` in a page's /Font dictionary, `f.show(text, size)` inside BT … ET, and
 * `f.emit(obj)` to write the font objects. fontBytes(key) → Uint8Array of FONT_FILES[key].
 */
export class PdfFonts {
  constructor({ fontkit, fontBytes, locale = 'en' }) {
    this.fontkit = fontkit;
    this.fontBytes = fontBytes;
    this.locale = locale;
    this.fonts = new Map(); // key → {font, subset, upm, cids Map(gid → cid), widths Map(cid → w), uni Map(cid → string), name}
    this.layouts = new Map(); // `${bold}|${text}` → [{key, glyphs: [{cid, adj}]}]
    this.used = []; // keys in first-use order
    this.done = false;
  }

  _font(key) {
    let f = this.fonts.get(key);
    if (f === undefined) {
      const bytes = this.fontBytes(key);
      f = bytes ? { font: this.fontkit.create(bytes), key } : null;
      if (f) {
        f.upm = f.font.unitsPerEm || 1000;
        f.cff = !!f.font['CFF '];
        f.subset = null;
        f.cids = new Map();
        f.widths = new Map();
        f.uni = new Map();
      }
      this.fonts.set(key, f);
    }
    return f;
  }

  _has(key, cp) {
    const f = this._font(key);
    return !!f && f.font.hasGlyphForCodePoint(cp);
  }

  _include(f, glyph) {
    if (!f.subset) {
      f.subset = f.font.createSubset();
      this.used.push(f.key);
    }
    let cid = f.cids.get(glyph.id);
    if (cid === undefined) {
      cid = f.subset.includeGlyph(glyph.id);
      f.cids.set(glyph.id, cid);
      f.widths.set(cid, r1((glyph.advanceWidth * 1000) / f.upm));
      if (glyph.codePoints?.length) f.uni.set(cid, String.fromCodePoint(...glyph.codePoints));
    }
    return cid;
  }

  /** Lay out strings (before finish()). */
  add(strings, { bold = false } = {}) {
    if (this.done) throw new Error('PdfFonts: add() after finish()');
    for (const s of strings) {
      const text = String(s ?? '');
      const k = `${bold ? 1 : 0}|${text}`;
      if (this.layouts.has(k)) continue;
      const runs = fontRuns(text, { locale: this.locale, bold, has: (key, cp) => this._has(key, cp) });
      this.layouts.set(
        k,
        runs.map(({ key, text: rt }) => {
          const f = this._font(key);
          const run = f.font.layout(rt);
          return {
            key,
            glyphs: run.glyphs.map((g, i) => {
              const cid = this._include(f, g);
              // TJ adjustment (thousandths of the text size) for kerning in the layout.
              const adj = -r1(((run.positions[i].xAdvance - g.advanceWidth) * 1000) / f.upm);
              return { cid, adj };
            }),
          };
        }),
      );
    }
    return this;
  }

  /** Encode the subsets (async: fontkit's encoder is a stream). */
  async finish() {
    for (const key of this.used) {
      const f = this.fonts.get(key);
      const gids = [...f.cids.keys()];
      f.name = `${subsetTag(key, gids)}+${pdfName(f.font.postscriptName || key)}`;
      f.file = await encodeSubset(f.subset);
    }
    this.done = true;
    return this;
  }

  /** Number of PDF objects the fonts need (five per font used). */
  get objectCount() {
    return this.used.length * 5;
  }

  /** Give the font objects numbers from `first` on; returns the next free number. */
  allocate(first) {
    this.used.forEach((key, i) => (this.fonts.get(key).obj = first + i * 5));
    return first + this.objectCount;
  }

  /** The entries of a /Font resource dictionary. */
  resources() {
    return this.used.map((key, i) => `/U${i} ${this.fonts.get(key).obj} 0 R`).join(' ');
  }

  /** Text-showing operators for a string at a size (inside BT … ET); the string must have been add()ed. */
  show(text, size, { bold = false } = {}) {
    const runs = this.layouts.get(`${bold ? 1 : 0}|${String(text ?? '')}`);
    if (!runs) throw new Error('PdfFonts: show() of a string that was not add()ed');
    const out = [];
    for (const run of runs) {
      const i = this.used.indexOf(run.key);
      const parts = [];
      let hex = '';
      for (const g of run.glyphs) {
        hex += hex4(g.cid);
        if (g.adj) {
          parts.push(`<${hex}>`, String(g.adj));
          hex = '';
        }
      }
      if (hex || !parts.length) parts.push(`<${hex}>`);
      out.push(`/U${i} ${size} Tf ${parts.length === 1 ? `${parts[0]} Tj` : `[${parts.join(' ')}] TJ`}`);
    }
    return out.join(' ');
  }

  /** Write the font objects with the writer's obj(n, body) (body: string or {dict, data}). */
  emit(obj) {
    for (const key of this.used) {
      const f = this.fonts.get(key);
      const [n0, n1, n2, n3, n4] = [0, 1, 2, 3, 4].map((k) => f.obj + k);
      const s = 1000 / f.upm;
      const fk = f.font;
      const bb = fk.bbox ?? { minX: 0, minY: -300, maxX: 1000, maxY: 1000 };
      const cmap = enc.encode(toUnicodeCMap(f.uni));
      const cmapZ = zlibSync(cmap, { level: 9 });
      const fileZ = zlibSync(f.file, { level: 9 });
      obj(n0, `<< /Type /Font /Subtype /Type0 /BaseFont /${f.name} /Encoding /Identity-H /DescendantFonts [${n1} 0 R] /ToUnicode ${n4} 0 R >>`);
      obj(n1, `<< /Type /Font /Subtype /${f.cff ? 'CIDFontType0' : 'CIDFontType2'} /BaseFont /${f.name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${n2} 0 R /DW ${f.widths.get(0) ?? 1000} /W ${widthsArray(f.widths)}${f.cff ? '' : ' /CIDToGIDMap /Identity'} >>`);
      obj(n2, `<< /Type /FontDescriptor /FontName /${f.name} /Flags 4 /FontBBox [${r1(bb.minX * s)} ${r1(bb.minY * s)} ${r1(bb.maxX * s)} ${r1(bb.maxY * s)}] /ItalicAngle ${fk.italicAngle ?? 0} /Ascent ${r1(fk.ascent * s)} /Descent ${r1(fk.descent * s)} /CapHeight ${r1((fk.capHeight || fk.ascent) * s)} /StemV 80 /${f.cff ? 'FontFile3' : 'FontFile2'} ${n3} 0 R >>`);
      obj(n3, { dict: `<< /Filter /FlateDecode /Length ${fileZ.length}${f.cff ? ' /Subtype /CIDFontType0C' : ` /Length1 ${f.file.length}`} >>`, data: fileZ });
      obj(n4, { dict: `<< /Filter /FlateDecode /Length ${cmapZ.length} >>`, data: cmapZ });
    }
  }
}
