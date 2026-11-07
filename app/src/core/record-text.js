// English texts kept in records, shown in the UI language (REQ-L10N-06, DN-62 L5). A record keeps
// its text in English (the project file, exports, tests, logic such as /^RPC/.test(modelName));
// what the user reads is the same text matched against N_-marked templates and rendered with
// t(). A placeholder value that is a plain decimal number is shown in the locale's notation; one
// that matches a template itself is translated too (one level down). Anything unmatched (image
// ids, DEM names, MGRS) is data and stays as it is.

import { t } from '../i18n/index.js';
import { num } from '../i18n/format.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A function (text) → the text in the UI language, for these English templates. split: a
 * separator whose parts are matched one by one ('; ' for Mensuration Log methods).
 */
export function textMatcher(templates, { split = null } = {}) {
  let m = null;
  const build = () => {
    m = { exact: new Set(), re: [] };
    for (const src of templates) {
      if (!src.includes('{')) {
        m.exact.add(src);
        continue;
      }
      const names = [];
      const body = src
        .split(/\{(\w+)\}/)
        .map((x, i) => (i % 2 ? (names.push(x), '(.+)') : esc(x)))
        .join('');
      m.re.push({ src, names, re: new RegExp(`^${body}$`), literal: src.replace(/\{\w+\}/g, '').length });
    }
    // The most specific template first: "GCPs ({n}, GeoTIFF)" before "GCPs ({n}, {crs})".
    m.re.sort((a, b) => b.literal - a.literal);
    return m;
  };
  const one = (part, depth) => {
    const { exact, re } = m ?? build();
    if (exact.has(part)) return t(part);
    for (const x of re) {
      const r = x.re.exec(part);
      if (r) return t(x.src, Object.fromEntries(x.names.map((n, i) => [n, param(r[i + 1], depth)])));
    }
    return null;
  };
  const param = (v, depth) => {
    const d = /^(-?\d+)(?:\.(\d+))?$/.exec(v);
    if (d) return num(Number(v), d[2]?.length ?? 0);
    return (depth < 1 && one(v, depth + 1)) || v;
  };
  return (s) => {
    if (typeof s !== 'string' || !s) return s;
    return split ? s.split(split).map((p) => one(p, 0) ?? p).join(split) : one(s, 0) ?? s;
  };
}
