// The language of a document the tool writes for people (reports, the feedback report): the UI
// locale and its direction (REQ-L10N-06). A pseudo-locale writes the language it stands for, as
// applyDocument() does for the page itself.

import { locale, dir, PSEUDO } from '../i18n/index.js';

/** The BCP 47 tag for a written document's lang attribute. */
export const docLang = () => (PSEUDO[locale()] ? (dir() === 'rtl' ? 'ar' : 'en') : locale());

/** ` lang="…" dir="…"` for an <html> element. */
export const htmlLangAttrs = () => ` lang="${docLang()}" dir="${dir()}"`;
