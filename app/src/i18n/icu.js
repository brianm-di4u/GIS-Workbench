// ICU MessageFormat 1 (REQ-L10N-03): a small parser and interpreter with no dynamic code, so the
// strict CSP and the eval gate stay untouched. The build compiles every catalogue message with
// `parse` and checks it; the runtime parses each message once, caches the AST and formats it
// with the browser's Intl objects.
//
// Supported: literal text; {arg}; {arg, number[, integer|percent|::skeleton-free style]};
// {arg, date|time[, short|medium|long|full]}; {arg, plural|selectordinal, [offset:n] =k {…}
// one {…} … other {…}} with `#`; {arg, select, key {…} other {…}}. Apostrophes follow ICU:
// '' is a literal quote, and a quote before { } # or | starts a quoted literal up to the next
// single quote. Any other apostrophe ("can't") is literal text.

/** Parse a message into nodes: string | {type:'arg'|'number'|'date'|'time'|'plural'|'selectordinal'|'select', ...} | {type:'pound'}. */
export function parse(src) {
  const s = String(src);
  let i = 0;
  const fail = (m) => {
    throw new Error(`ICU message: ${m} at ${i} in "${s.length > 80 ? `${s.slice(0, 77)}…` : s}"`);
  };
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const ident = () => {
    ws();
    const m = /^[^\s{}#,|'=]+/.exec(s.slice(i));
    if (!m) fail('name expected');
    i += m[0].length;
    return m[0];
  };
  function nodes(inPlural, depth) {
    const out = [];
    let text = '';
    const flush = () => {
      if (text) out.push(text);
      text = '';
    };
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        if (s[i + 1] === "'") {
          text += "'";
          i += 2;
        } else if (s[i + 1] !== undefined && '{}#|'.includes(s[i + 1]) && (s[i + 1] !== '#' || inPlural)) {
          i++;
          while (i < s.length) {
            if (s[i] === "'") {
              if (s[i + 1] === "'") {
                text += "'";
                i += 2;
                continue;
              }
              i++;
              break;
            }
            text += s[i++];
          }
        } else {
          text += c;
          i++;
        }
      } else if (c === '{') {
        flush();
        i++;
        out.push(argument(depth));
      } else if (c === '}') {
        if (depth === 0) fail('unmatched }');
        break;
      } else if (c === '#' && inPlural) {
        flush();
        out.push({ type: 'pound' });
        i++;
      } else {
        text += c;
        i++;
      }
    }
    flush();
    return out;
  }
  function options(kind, depth) {
    const opts = {};
    let offset = 0;
    ws();
    if (kind !== 'select' && s.startsWith('offset:', i)) {
      i += 7;
      ws();
      const m = /^-?\d+/.exec(s.slice(i));
      if (!m) fail('offset number expected');
      offset = Number(m[0]);
      i += m[0].length;
    }
    for (;;) {
      ws();
      if (s[i] === '}') break;
      let key;
      if (s[i] === '=') {
        i++;
        const m = /^-?\d+(\.\d+)?/.exec(s.slice(i));
        if (!m) fail('number after = expected');
        key = `=${m[0]}`;
        i += m[0].length;
      } else key = ident();
      ws();
      if (s[i] !== '{') fail(`{ expected after ${key}`);
      i++;
      opts[key] = nodes(kind !== 'select', depth + 1);
      if (s[i] !== '}') fail('} expected');
      i++;
    }
    if (!opts.other) fail(`${kind} needs an "other" case`);
    return { opts, offset };
  }
  function argument(depth) {
    const name = ident();
    ws();
    if (s[i] === '}') {
      i++;
      return { type: 'arg', name };
    }
    if (s[i] !== ',') fail(', or } expected');
    i++;
    const kind = ident();
    ws();
    let node;
    if (kind === 'plural' || kind === 'selectordinal' || kind === 'select') {
      if (s[i] !== ',') fail(`, expected after ${kind}`);
      i++;
      const { opts, offset } = options(kind, depth);
      node = { type: kind, name, opts, offset };
    } else if (kind === 'number' || kind === 'date' || kind === 'time') {
      let style = null;
      if (s[i] === ',') {
        i++;
        ws();
        const m = /^[^{}]*/.exec(s.slice(i));
        style = m[0].trim();
        i += m[0].length;
      }
      node = { type: kind, name, style };
    } else fail(`unknown argument type ${kind}`);
    ws();
    if (s[i] !== '}') fail('} expected');
    i++;
    return node;
  }
  const out = nodes(false, 0);
  if (i < s.length) fail('unmatched }');
  return out;
}

/** Placeholder names and structure of a message, for catalogue parity checks. */
export function signature(ast) {
  const names = new Set();
  const walk = (ns) => {
    for (const n of ns) {
      if (typeof n === 'string' || n.type === 'pound') continue;
      names.add(`${n.name}:${n.type === 'selectordinal' ? 'plural' : n.type === 'time' ? 'date' : n.type}`);
      if (n.opts) for (const k of Object.keys(n.opts)) walk(n.opts[k]);
    }
  };
  walk(ast);
  return [...names].sort();
}

const cache = new Map();
const intl = (Ctor, locale, opts) => {
  const k = `${Ctor.name}|${locale}|${JSON.stringify(opts ?? {})}`;
  let f = cache.get(k);
  if (!f) {
    try {
      f = new Ctor(locale, opts);
    } catch {
      f = new Ctor('en', opts);
    }
    cache.set(k, f);
  }
  return f;
};

function numberOpts(style) {
  if (!style) return {};
  if (style === 'integer') return { maximumFractionDigits: 0 };
  if (style === 'percent') return { style: 'percent' };
  // ::.00 style fraction digits (the only skeleton form the catalogues use)
  const m = /^::\.(0+)$/.exec(style);
  if (m) return { minimumFractionDigits: m[1].length, maximumFractionDigits: m[1].length };
  return {};
}

/** Format parsed nodes with params for a locale. Missing params render as {name}. */
export function format(ast, params = {}, locale = 'en', pound = null) {
  let out = '';
  for (const n of ast) {
    if (typeof n === 'string') {
      out += n;
      continue;
    }
    if (n.type === 'pound') {
      out += pound === null ? '#' : intl(Intl.NumberFormat, locale).format(pound);
      continue;
    }
    const v = params?.[n.name];
    if (v === undefined) {
      out += `{${n.name}}`;
      continue;
    }
    switch (n.type) {
      case 'arg':
        out += typeof v === 'number' ? intl(Intl.NumberFormat, locale, { maximumFractionDigits: 20 }).format(v) : String(v);
        break;
      case 'number':
        out += Number.isFinite(Number(v)) ? intl(Intl.NumberFormat, locale, numberOpts(n.style)).format(Number(v)) : String(v);
        break;
      case 'date':
      case 'time': {
        const d = v instanceof Date ? v : new Date(v);
        const st = ['short', 'medium', 'long', 'full'].includes(n.style) ? n.style : 'medium';
        out += Number.isFinite(d.getTime()) ? intl(Intl.DateTimeFormat, locale, n.type === 'date' ? { dateStyle: st } : { timeStyle: st }).format(d) : String(v);
        break;
      }
      case 'select':
        out += format(n.opts[String(v)] ?? n.opts.other, params, locale, pound);
        break;
      default: {
        const x = Number(v) - n.offset;
        const exact = n.opts[`=${Number(v)}`];
        const cat = intl(Intl.PluralRules, locale, { type: n.type === 'selectordinal' ? 'ordinal' : 'cardinal' }).select(x);
        out += format(exact ?? n.opts[cat] ?? n.opts.other, params, locale, x);
      }
    }
  }
  return out;
}

/** Map every literal text run (not placeholders) through fn: for pseudo-locales. */
export function mapText(ast, fn) {
  return ast.map((n) => {
    if (typeof n === 'string') return fn(n);
    if (n.opts) return { ...n, opts: Object.fromEntries(Object.entries(n.opts).map(([k, v]) => [k, mapText(v, fn)])) };
    return n;
  });
}
