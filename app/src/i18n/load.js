// Choosing and loading the UI locale at start (REQ-L10N-01, REQ-L10N-14). The preference
// `locale` is 'auto' (negotiate navigator.languages), a tag, or a pseudo-locale for testing.
// Wave 1 catalogues are hash-checked data blocks in the HTML (data-i18n-keys plus
// data-locale-<tag>); waves 2 and 3 come from locale packs kept in this browser. A locale that
// is not available falls back to English and says so once the shell is up.

import { setLocale, applyDocument, negotiate, PSEUDO } from './index.js';
import { setUnits } from './format.js';
import { PackStore } from '../storage/packs.js';

/** The locales this build knows, with how each is delivered: [{tag, name, english, wave, inline, pack}]. */
export function availableLocales(gw) {
  const m = gw?.manifest;
  const reg = m?.i18n?.locales ?? [{ tag: 'en', name: 'English', english: 'English', wave: 0 }];
  return reg.map((l) => {
    const inline = l.tag === 'en' || !!m?.blocks?.[`data-locale-${l.tag}`];
    return { ...l, inline, pack: inline ? null : `locale-${l.tag}` };
  });
}

async function catalogue(gw, app, l) {
  if (l.tag === 'en') return null;
  if (l.inline) {
    const [keys, values] = await Promise.all([gw.text('data-i18n-keys'), gw.text(`data-locale-${l.tag}`)]);
    return { keys: JSON.parse(keys), values: JSON.parse(values) };
  }
  // A locale pack kept from an earlier session (never prompts at start).
  const store = app.packs ?? new PackStore(app);
  if (!app.packs) await store.restore();
  const p = await store.get(l.pack, { prompt: false });
  const b = p?.entries?.get('messages.json');
  if (!b) return { needPack: l.pack };
  return JSON.parse(new TextDecoder().decode(b));
}

/**
 * Pick and load the locale. Returns {locale, requested, fallback, needPack}; never throws (a
 * broken catalogue leaves the UI in English).
 */
export async function initI18n(app, { languages = globalThis.navigator?.languages ?? ['en'] } = {}) {
  const gw = app.gw;
  const pref = app.prefs?.get('locale') ?? 'auto';
  setUnits(app.prefs?.get('units') ?? 'metric');
  const all = availableLocales(gw);
  let tag;
  if (PSEUDO[pref]) tag = pref;
  else if (pref && pref !== 'auto') tag = negotiate([pref], all.map((l) => l.tag));
  else tag = negotiate(languages, all.map((l) => l.tag));
  const res = { locale: 'en', requested: tag, fallback: false, needPack: null };
  try {
    if (PSEUDO[tag]) {
      setLocale(tag);
      res.locale = tag;
    } else {
      const l = all.find((x) => x.tag === tag) ?? all[0];
      const data = await catalogue(gw, app, l);
      if (data?.needPack) {
        res.needPack = data.needPack;
        res.fallback = true;
        setLocale('en');
      } else {
        setLocale(l.tag, data, { wave: l.wave, name: l.name, source: l.inline ? 'build' : 'pack' });
        res.locale = l.tag;
      }
    }
  } catch (e) {
    app.log?.('warn', `locale ${tag}: ${e.message}; using English`);
    setLocale('en');
    res.fallback = true;
  }
  applyDocument();
  return res;
}
