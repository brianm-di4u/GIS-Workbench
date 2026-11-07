// A small XML reader for service documents (WMS/WMTS/WCS/WPS capabilities, exception reports,
// WFS transaction responses). It builds a plain element tree with namespace prefixes stripped, so
// the same parsers run in the page and in Node (unit tests) without DOMParser. It never resolves
// external entities or DTDs (the five predefined entities and character references only).

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unescapeXml = (s) =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === '#') {
          const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
        }
        return ENT[e] ?? m;
      });

const local = (q) => q.slice(q.indexOf(':') + 1);

/** Parse XML text → the root element {name, qname, attrs, children, text}. Throws on malformed input. */
export function parseXml(text) {
  const src = String(text);
  const root = { name: '#document', qname: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/gy;
  let m;
  let at = 0;
  while (at < src.length) {
    re.lastIndex = at;
    m = re.exec(src);
    if (!m) throw new Error(`malformed XML near offset ${at}`);
    at = re.lastIndex;
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2 || top.qname !== m[2]) throw new Error(`malformed XML: unexpected </${m[2]}>`);
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = unescapeXml(a[2] ?? a[3] ?? '');
      const el = { name: local(m[3]), qname: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
  }
  if (stack.length !== 1) throw new Error(`malformed XML: <${stack[stack.length - 1].qname}> is not closed`);
  const el = root.children[0];
  if (!el) throw new Error('not an XML document');
  return el;
}

/** The first child element with this local name (or a path "A/B/C"). */
export function child(el, path) {
  let cur = el;
  for (const p of path.split('/')) {
    cur = cur?.children.find((c) => c.name === p);
    if (!cur) return null;
  }
  return cur;
}
/** All child elements with this local name. */
export const kids = (el, name) => (el?.children ?? []).filter((c) => c.name === name);
/** Every descendant element with this local name. */
export function all(el, name, out = []) {
  for (const c of el?.children ?? []) {
    if (c.name === name) out.push(c);
    all(c, name, out);
  }
  return out;
}
/** Trimmed text of a child (path) or of the element itself. */
export const text = (el, path = null) => ((path ? child(el, path) : el)?.text ?? '').trim();
/** An attribute by local name (any prefix). */
export function attr(el, name) {
  if (!el) return null;
  if (name in el.attrs) return el.attrs[name];
  const k = Object.keys(el.attrs).find((a) => local(a) === name);
  return k ? el.attrs[k] : null;
}

/** The message of an OWS / WMS / WFS exception report, or null when the text is not one. */
export function exceptionText(xmlText) {
  if (!/Exception/.test(xmlText ?? '')) return null;
  try {
    const r = parseXml(xmlText);
    if (!/Exception/.test(r.name)) return null;
    const ex = all(r, 'ExceptionText')[0] ?? all(r, 'ServiceException')[0] ?? all(r, 'Exception')[0];
    const msg = ex ? text(ex) || attr(ex, 'exceptionCode') || attr(ex, 'code') : text(r);
    return msg || r.name;
  } catch {
    return null;
  }
}
