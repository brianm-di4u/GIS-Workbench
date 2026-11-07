// The fonts pack (REQ-L10N-11, SDP-2.3 §4.8, S-56): Noto Sans and Noto Sans CJK with fontkit, from
// the hash-checked `fonts-noto` data pack (File ▸ Open ▸ Open Data Pack), for Unicode text in PDF
// and GeoPDF exports (formats/pdf-text.js). The pack's fontkit.js runs from a blob: URL (CSP
// script-src blob:) and sets globalThis.__lib.fontkit; nothing is fetched.
//
// pdfFontsFor(app, strings) is what a PDF export calls before writing:
//   null       every string fits Helvetica (WinAnsi), or the pack is not loaded: the writer uses
//              Helvetica and '?' for what it cannot show; the export is never blocked, and the
//              user is told once per session that the pack gives full text;
//   PdfFonts   ready (laid out and subset) for the writer's show()/emit().

import { entryUrl } from '../storage/packs.js';
import { t, N_, msgOf, locale } from '../i18n/index.js';
import { PdfFonts, FONT_FILES, needsUnicode } from './pdf-text.js';

export const FONTS_PACK = 'fonts-noto';

let ready = null;
let told = false;

async function runClassic(url) {
  await new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = res;
    s.onerror = () => rej(new Error('the fonts pack script failed to run'));
    document.head.appendChild(s);
  });
}

/** {fontkit, pack} from the loaded pack (throws E_PACK_REQUIRED from app.packs.require when it is not loaded). */
export function fontPack(app) {
  ready ??= (async () => {
    if (!app.packs) throw Object.assign(new Error('data packs are not available in this file'), { code: 'E_PACK_REQUIRED' });
    const pack = await app.packs.require(FONTS_PACK, N_('Text in other scripts in PDF exports'));
    if (!globalThis.__lib?.fontkit) {
      const url = entryUrl(pack, 'fontkit.js');
      try {
        await runClassic(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    const fontkit = globalThis.__lib?.fontkit;
    if (!fontkit) throw new Error('the fonts pack did not load');
    return { fontkit, pack };
  })();
  ready.catch(() => (ready = null));
  return ready;
}

/**
 * Unicode fonts for a PDF holding `strings` (see the header), laid out for the UI locale.
 * opts.bold: strings drawn bold (laid out with Noto Sans Bold for Latin, Greek and Cyrillic).
 */
export async function pdfFontsFor(app, strings, { bold = [] } = {}) {
  const all = [...strings, ...bold];
  if (!needsUnicode(all)) return null;
  let fk;
  try {
    fk = await fontPack(app);
  } catch (e) {
    app.log?.('info', `PDF export without the ${FONTS_PACK} pack: text outside WinAnsi becomes '?' (${e.message})`);
    if (!told) {
      told = true;
      const how = e.code === 'E_PACK_REQUIRED' && e.i18n ? msgOf(e) : t('Load the Noto fonts data pack: File ▸ Open ▸ Open Data Pack');
      app.toast?.(t('The PDF shows ? for text that Helvetica cannot show. {how}', { how }), { kind: 'info', ms: 9000 });
    }
    return null;
  }
  const fonts = new PdfFonts({ fontkit: fk.fontkit, fontBytes: (key) => fk.pack.entries.get(FONT_FILES[key]) ?? null, locale: locale() });
  fonts.add(strings);
  if (bold.length) fonts.add(bold, { bold: true });
  return fonts.finish();
}

/** Forget the "pack missing" notice (tests). */
export const resetFontPackNotice = () => {
  told = false;
};
