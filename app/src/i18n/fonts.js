// Fonts and text direction for drawn text and office exports (REQ-L10N-10, SDP-2.3 §4.7–4.8).
//
// Canvas text (labels on images and maps, charts, banners, the HUD) takes its font from the theme
// tokens (ui-tokens.json `fonts`) with the UI locale's script fallbacks (`fontScripts`), the same
// stacks the CSS gets from build/tokens.mjs, and sets ctx.direction from the UI locale:
//
//   canvasText(g, 11, 'label');            g.font = '11px Arial, Helvetica, sans-serif' in English
//   canvasText(g, 12, 'label', { bold });  'bold 12px …'; Japanese adds "Yu Gothic UI", … before sans-serif
//
// Roles: 'ui' (chrome text drawn on canvas), 'label' (text on imagery: fonts.onImageLabel),
// 'hud' (HUD and video overlays: fonts.hud), 'mono' (fonts.monoLog).
// Alignment: text tied to a point on the image or map (feature labels, measurements, scale bar,
// north arrow, coordinates) keeps a physical textAlign ('left'/'center'), as panes never mirror;
// text laid out in a box (legends, captions, product titles) uses 'start' at startX(), so a
// right-to-left UI (wave 3, and the ar-XB pseudo-locale) lays it out from the right.

import { fonts as FONTS, fontScripts as SCRIPTS } from '../data/ui-tokens.json';
import { locale, dir, dirOf, isRtl } from './index.js';
import { scriptOfLocale, scriptFonts, withFonts } from './fontstack.js';

const ROLE = { ui: 'ui', label: 'onImageLabel', hud: 'hud', mono: 'monoLog' };
const cache = new Map();

/** The CSS font-family list of a role for a UI locale (Latin stack plus the script's fonts). */
export function fontFamily(role = 'label', tag = locale()) {
  const k = `${role}|${tag}`;
  let f = cache.get(k);
  if (f === undefined) {
    const tok = FONTS[ROLE[role] ?? role] ?? FONTS.onImageLabel;
    const base = tok.family === 'ui' ? FONTS.ui.family : tok.family;
    f = withFonts(base, scriptFonts(scriptOfLocale(tag), SCRIPTS?.stacks));
    cache.set(k, f);
  }
  return f;
}

/** A canvas font string: canvasFont(11, 'label', { bold: true }) → 'bold 11px Arial, Helvetica, sans-serif'. */
export function canvasFont(sizePx, role = 'label', { bold = false, weight = null } = {}) {
  const w = weight ? `${weight} ` : bold ? 'bold ' : '';
  return `${w}${sizePx}px ${fontFamily(role)}`;
}

/** Set a 2D context's font (canvasFont) and direction (the UI locale's). Returns the context. */
export function canvasText(g, sizePx, role = 'label', opts = {}) {
  g.font = canvasFont(sizePx, role, opts);
  g.direction = dir();
  return g;
}

/**
 * Text tied to a point on the image or map (labels, measurements, scale bar): canvasText with
 * textAlign 'left', so it starts at the point in any UI direction (panes never mirror).
 */
export function pointText(g, sizePx, role = 'label', opts = {}) {
  canvasText(g, sizePx, role, opts);
  g.textAlign = 'left';
  return g;
}

/** x of text aligned 'start' in the box [x0, x1] with padding: the left edge, or the right edge in RTL. */
export const startX = (x0, x1, pad = 0) => (isRtl() ? x1 - pad : x0 + pad);

// ---- DOCX / PPTX ----

// Full language tags for office files (Word and PowerPoint proof with a region). The UI's
// English is British (licence, colour, authorisation).
const OFFICE = { en: 'en-GB', 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW', 'en-XA': 'en-GB', 'ar-XB': 'ar-SA' };

/**
 * The UI locale for office files: {lang: 'ja-JP', eastAsia: true when the locale is CJK,
 * rtl, font: the East Asian or complex-script document font from the tokens, or null}.
 */
export function officeLang(tag = locale()) {
  let lang = OFFICE[tag];
  if (!lang) {
    try {
      const m = new Intl.Locale(tag).maximize();
      lang = m.region ? `${m.language}-${m.region}` : m.language;
    } catch {
      lang = 'en-GB';
    }
  }
  const script = scriptOfLocale(tag);
  return { lang, eastAsia: ['ja', 'ko', 'zh-Hans', 'zh-Hant'].includes(script), rtl: dirOf(tag) === 'rtl', font: (script && SCRIPTS?.document?.[script]) || null };
}
