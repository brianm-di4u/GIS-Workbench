// Font stacks per script (SDP-2.3 §4.8, REQ-L10N-10): pure functions shared by the build
// (build/tokens.mjs, CSS :lang() rules) and the app (i18n/fonts.js, canvas text). The stacks
// themselves are ui-tokens.json `fontScripts`.

/** The script stack a UI locale uses, or null for Latin, Greek and Cyrillic (no extra fonts). */
export function scriptOfLocale(tag) {
  const t = String(tag ?? '').toLowerCase();
  const lang = t.split(/[-_]/)[0];
  if (lang === 'ja') return 'ja';
  if (lang === 'ko') return 'ko';
  if (lang === 'zh') return /^zh[-_](hant|tw|hk|mo)\b/.test(t) ? 'zh-Hant' : 'zh-Hans';
  if (['ar', 'fa', 'ur', 'ps', 'sd', 'ckb', 'ug'].includes(lang) || t === 'ar-xb') return 'ar';
  if (lang === 'he' || lang === 'yi') return 'he';
  if (lang === 'th') return 'th';
  if (['hi', 'mr', 'ne'].includes(lang)) return 'hi';
  return null;
}

const CJK = ['ja', 'zh-Hans', 'zh-Hant', 'ko'];

/** CSS :lang() selectors of each script (zh-Hant after zh-Hans: :lang(zh) matches both). */
export const SCRIPT_LANGS = {
  ja: ['ja'],
  ko: ['ko'],
  'zh-Hans': ['zh'],
  'zh-Hant': ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO'],
  ar: ['ar', 'fa', 'ur', 'ps', 'sd', 'ckb', 'ug'],
  he: ['he', 'yi'],
  th: ['th'],
  hi: ['hi', 'mr', 'ne'],
};

/**
 * Font names to add for a script: its own stack, then (for CJK) the first and last font of each
 * other CJK stack (the Windows UI font and Noto Sans CJK), for text in the other CJK scripts.
 */
export function scriptFonts(script, stacks) {
  if (!script || !stacks?.[script]) return [];
  const others = CJK.includes(script) ? CJK.filter((s) => s !== script && stacks[s]?.length).flatMap((s) => [stacks[s][0], stacks[s].at(-1)]) : [];
  return [...new Set([...stacks[script], ...others])];
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'math', 'emoji', 'fangsong']);

const split = (family) => (String(family).match(/"[^"]*"|'[^']*'|[^,]+/g) ?? []).map((s) => s.trim()).filter(Boolean);
const bare = (name) => name.replace(/^["']|["']$/g, '').toLowerCase();
const quote = (name) => (/^[A-Za-z][\w-]*$/.test(name) ? name : `"${name}"`);

/**
 * A family list with `names` added after its named fonts and before its trailing generic
 * families ("Segoe UI", Arial, sans-serif → "Segoe UI", Arial, "Yu Gothic UI", …, sans-serif).
 * Names already in the list are not repeated; no names → the list unchanged.
 */
export function withFonts(family, names) {
  if (!names?.length) return family;
  const parts = split(family);
  let at = parts.length;
  while (at > 0 && GENERIC.has(bare(parts[at - 1]))) at--;
  const have = new Set(parts.map(bare));
  const add = names.filter((n) => !have.has(n.toLowerCase())).map(quote);
  return [...parts.slice(0, at), ...add, ...parts.slice(at)].join(', ');
}
