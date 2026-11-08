// Localisation build tooling (REQ-L10N-02, REQ-L10N-14, REQ-L10N-16, REQ-L10N-22; SDP-2.3 §4).
//
//   node build/i18n.mjs extract        → app/src/i18n/catalog/en.json (the source catalogue)
//   node build/i18n.mjs extract --check → exit 1 if en.json differs from what extract would write
//   node build/i18n.mjs lint [--json]  → bare user-visible literals still in the code, per file
//   node build/i18n.mjs check          → every locale catalogue against en.json (ICU, placeholders,
//                                        do-not-translate tokens, length); exit 1 on an error
//   node build/i18n.mjs coverage       → per-locale counts
//
// Keys are the English source text (with an optional context, `ctx\u0004src`), as gettext msgids
// are. Sources: t('…'), tc('ctx', '…'), N_('…') in modules that import from app/src/i18n; and the
// static messages of `throw new Error('…')` (JS) and `Error::kind("…")` (Rust), which reach the UI
// as they are and are translated by exact match (msgOf). build/build.mjs calls i18nBuild().

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, signature } from '../app/src/i18n/icu.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'app', 'src');
const CAT = join(SRC, 'i18n', 'catalog');
const CTX_SEP = '\u0004';

function walk(dir, ext, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (f === 'node_modules' || f === 'target' || f === 'vendor') continue;
      walk(p, ext, out);
    } else if (ext.some((e) => f.endsWith(e))) out.push(p);
  }
  return out;
}

const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\$]|\\.|\$(?!\{))*\``;

/** A JS string literal's value. */
export function unquote(lit) {
  const q = lit[0];
  const body = lit.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = body[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === 'u') {
      if (body[i + 1] === '{') {
        const e = body.indexOf('}', i);
        out += String.fromCodePoint(parseInt(body.slice(i + 2, e), 16));
        i = e;
      } else {
        out += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16));
        i += 4;
      }
    } else if (n === 'x') {
      out += String.fromCharCode(parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (n === '\n') {
      /* line continuation */
    } else out += n;
  }
  return q === '`' ? out : out;
}

/** Remove comments (keeping line structure) so commented-out code is neither extracted nor linted. */
function stripComments(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && code[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) out += code[i++] === '\n' ? '\n' : '';
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += code[i++];
      while (i < n && code[i] !== q) {
        if (code[i] === '\\') out += code[i++];
        if (q === '`' && code[i] === '$' && code[i + 1] === '{') {
          // keep template expressions verbatim (they may hold t() calls)
          let depth = 0;
          do {
            if (code[i] === '{') depth++;
            if (code[i] === '}') depth--;
            out += code[i++];
          } while (i < n && depth > 0);
          continue;
        }
        out += code[i++];
      }
      out += code[i++] ?? '';
    } else out += code[i++];
  }
  return out;
}

// A local identity N_ counts: a lazy block loaded with no host modules cannot import i18n.
const usesI18n = (code) => /from\s+['"][./]*(?:\.\.\/)*i18n\/index\.js['"]/.test(code) || /from\s+['"]\.\/index\.js['"]/.test(code) || /^const N_ = \(s\) => s;$/m.test(code);

/** Messages in one JS file: [{key, src, ctx, line}]. */
export function messagesInJs(code, { file = '', errors = true } = {}) {
  const out = [];
  const clean = stripComments(code);
  const lineAt = (idx) => clean.slice(0, idx).split('\n').length;
  if (usesI18n(code) || file.includes(`i18n${'/'}`)) {
    for (const m of clean.matchAll(new RegExp(String.raw`(?<![\w$.])(t|N_|gwError)\(\s*(${STR})`, 'g'))) {
      const src = unquote(m[2]);
      if (src) out.push({ key: src, src, ctx: null, line: lineAt(m.index) });
    }
    for (const m of clean.matchAll(new RegExp(String.raw`(?<![\w$.])(?:tc|NC_)\(\s*(${STR})\s*,\s*(${STR})`, 'g'))) {
      const ctx = unquote(m[1]);
      const src = unquote(m[2]);
      if (src) out.push({ key: `${ctx}${CTX_SEP}${src}`, src, ctx, line: lineAt(m.index) });
    }
  }
  if (errors) {
    for (const m of clean.matchAll(new RegExp(String.raw`throw new (?:Error|TypeError|RangeError)\(\s*(${STR})\s*[,)]`, 'g'))) {
      const src = unquote(m[1]);
      if (src && !/\$\{/.test(m[1]) && /[a-z]{3}/i.test(src)) out.push({ key: src, src, ctx: null, line: lineAt(m.index), error: true });
    }
  }
  return out;
}

/** Static error messages in one Rust file. */
export function messagesInRust(source) {
  const out = [];
  // Comment lines (doc examples of err! included) are not messages.
  const code = source.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const m of code.matchAll(/Error::(?:invalid|range|limit|unsupported|internal|new|parse|io)\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g)) {
    const src = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (/[a-z]{3}/i.test(src) && !src.includes('{')) out.push({ key: src, src, ctx: null, error: true, rust: true });
  }
  // Templated errors (gw_abi::err!): the template is the key; the JS side gets its params through
  // gw_last_error_i18n and renders it in the UI language (REQ-L10N-05).
  for (const m of code.matchAll(/err!\(\s*(?:INVALID|RANGE|LIMIT|UNSUPPORTED|INTERNAL)\s*,\s*"((?:[^"\\]|\\.)*)"/g)) {
    const src = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (/[a-z]{3}/i.test(src)) out.push({ key: src, src, ctx: null, error: true, rust: true });
  }
  return out;
}

/** The `title = "…"` values of a TOML file (sidecar job profiles and their options). */
export function titlesInToml(code) {
  const out = [];
  code.split(/\r?\n/).forEach((l, i) => {
    const m = /^\s*title\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*(?:#.*)?$/.exec(l);
    if (!m) return;
    const src = m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2];
    if (src.trim()) out.push({ key: src, src, ctx: null, line: i + 1 });
  });
  return out;
}

/**
 * The titles and descriptions of this build's data packs (build/packs.mjs definitions): the Data
 * Packs list and the "needs the … data pack" messages show them with tr(). Literal `title: '…'` and
 * `description: '…'` members, and the title and description of each pack('name', 'title',
 * 'version', 'description', …) model pack.
 */
export function messagesInPacks(code) {
  const out = [];
  const lineAt = (idx) => code.slice(0, idx).split('\n').length;
  const S1 = String.raw`'((?:[^'\\\n]|\\.)*)'`;
  const add = (lit, idx) => {
    const src = unquote(`'${lit}'`);
    if (/[a-z]{3}/i.test(src)) out.push({ key: src, src, ctx: null, line: lineAt(idx) });
  };
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:title|description):\s*${S1}`, 'g'))) add(m[1], m.index);
  for (const m of code.matchAll(new RegExp(String.raw`\bpack\(\s*'[^']*',\s*${S1},\s*'[^']*',\s*${S1}`, 'g'))) {
    add(m[1], m.index);
    add(m[2], m.index);
  }
  return out;
}

/** Build the source catalogue from the code. */
export function extract({ root = ROOT } = {}) {
  const src = join(root, 'app', 'src');
  const msgs = new Map();
  // refs name files, not lines, so an edit that only moves a string leaves en.json alone and
  // `extract --check` can run on every change. `at` keeps the first line for error messages.
  const at = new Map();
  const add = (m, file) => {
    let e = msgs.get(m.key);
    if (!e) {
      e = { key: m.key, src: m.src, ...(m.ctx ? { ctx: m.ctx } : {}), refs: [], ...(m.error ? { error: true } : {}) };
      msgs.set(m.key, e);
      at.set(m.key, m.line ? `${file}:${m.line}` : file);
    }
    if (!m.error) delete e.error;
    if (e.refs.length < 6 && !e.refs.includes(file)) e.refs.push(file);
  };
  for (const f of walk(src, ['.js'])) {
    const rel = relative(src, f).replace(/\\/g, '/');
    if (rel.startsWith('i18n/')) continue;
    const code = readFileSync(f, 'utf8');
    for (const m of messagesInJs(code, { file: rel })) add(m, rel);
  }
  const crates = join(root, 'crates');
  if (existsSync(crates)) for (const f of walk(crates, ['.rs'])) for (const m of messagesInRust(readFileSync(f, 'utf8'))) add(m, relative(root, f).replace(/\\/g, '/'));
  // Sidecar job profile titles and option titles (REQ-L10N-20): the app shows them with t().
  const profiles = join(root, 'sidecar', 'profiles');
  if (existsSync(profiles)) for (const f of walk(profiles, ['.toml'])) for (const m of titlesInToml(readFileSync(f, 'utf8'))) add(m, relative(root, f).replace(/\\/g, '/'));
  // Data pack titles and descriptions (features/packs.js, storage/packs.js show them with tr()).
  const packsMjs = join(root, 'build', 'packs.mjs');
  if (existsSync(packsMjs)) for (const m of messagesInPacks(readFileSync(packsMjs, 'utf8'))) add(m, 'build/packs.mjs');
  // Every message must parse as ICU: a stray brace in a source string is a bug to fix at source.
  const bad = [];
  for (const e of msgs.values()) {
    try {
      parse(e.src);
    } catch (err) {
      bad.push(`${at.get(e.key)}: ${err.message}`);
    }
  }
  const messages = [...msgs.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { messages, bad };
}

/** en.json's text for a catalogue. */
export function serializeSource(cat) {
  const words = cat.messages.reduce((n, m) => n + m.src.split(/\s+/).filter(Boolean).length, 0);
  return `${JSON.stringify({ comment: 'Generated by node build/i18n.mjs extract. Do not edit by hand.', count: cat.messages.length, words, messages: cat.messages }, null, 1)}\n`;
}

export function writeSource(cat) {
  mkdirSync(CAT, { recursive: true });
  writeFileSync(join(CAT, 'en.json'), serializeSource(cat));
}

/** The keys en.json lacks and the keys it has that the code no longer uses, when it is out of date. */
export function sourceDrift(cat, current) {
  if (serializeSource(cat) === current.replace(/\r\n/g, '\n')) return null;
  const was = new Set(JSON.parse(current).messages.map((m) => m.key));
  const now = new Set(cat.messages.map((m) => m.key));
  return { added: [...now].filter((k) => !was.has(k)), removed: [...was].filter((k) => !now.has(k)) };
}

// ---- lint: user-visible literals that bypass t() ----
const LINT = [
  ['toast', new RegExp(String.raw`\btoast\(\s*(${STR})`, 'g')],
  ['title', new RegExp(String.raw`\btitle:\s*(${STR})`, 'g')],
  ['aria-label', new RegExp(String.raw`'aria-label':\s*(${STR})`, 'g')],
  ['placeholder', new RegExp(String.raw`\bplaceholder:\s*(${STR})`, 'g')],
  ['label', new RegExp(String.raw`\blabel:\s*(${STR})`, 'g')],
  ['field', new RegExp(String.raw`\b(?:field|section)\(\s*(${STR})`, 'g')],
  ['buttons', new RegExp(String.raw`\bbuttons:\s*\[\s*(${STR})`, 'g')],
  ['box', new RegExp(String.raw`\b(?:alertBox|confirmBox|promptBox)\(\s*(${STR})`, 'g')],
  ['text', new RegExp(String.raw`\bh\(\s*'[a-z0-9]+'\s*,\s*(?:\{[^{}()]*\}|null|\{\})\s*,\s*(${STR})`, 'g')],
];
const visible = (s) => /[A-Za-z]{2}/.test(s) && !/^[a-z0-9_.:/#-]+$/.test(s) && !/^(https?:|data:|blob:|#|\.|\/)/.test(s);

export function lintJs(code, rel) {
  if (/i18n-ignore-file/.test(code)) return [];
  const clean = stripComments(code);
  const lines = code.split('\n');
  const hits = [];
  for (const [kind, re] of LINT) {
    for (const m of clean.matchAll(re)) {
      const lit = m[1];
      const s = unquote(lit);
      if (!visible(s)) continue;
      const line = clean.slice(0, m.index).split('\n').length;
      if (/i18n-ignore/.test(lines[line - 1] ?? '')) continue;
      hits.push({ file: rel, line, kind, text: s.length > 70 ? `${s.slice(0, 67)}…` : s });
    }
  }
  return hits;
}

export function lint({ root = ROOT } = {}) {
  const src = join(root, 'app', 'src');
  const hits = [];
  for (const f of walk(src, ['.js'])) {
    const rel = relative(src, f).replace(/\\/g, '/');
    if (rel.startsWith('i18n/') || rel.startsWith('workers/') || rel.startsWith('boot/') || rel.startsWith('lazy/')) continue;
    hits.push(...lintJs(readFileSync(f, 'utf8'), rel));
  }
  return hits;
}

// ---- locale catalogues ----
export function registry(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'app', 'src', 'i18n', 'locales.json'), 'utf8')).locales;
}
export function readSource(root = ROOT) {
  const p = join(root, 'app', 'src', 'i18n', 'catalog', 'en.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { messages: [] };
}
export function readLocale(tag, root = ROOT) {
  const p = join(root, 'app', 'src', 'i18n', 'catalog', `${tag}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
export function readDnt(root = ROOT) {
  const p = join(root, 'app', 'src', 'i18n', 'glossary', 'dnt.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')).tokens ?? [] : [];
}

/** Problems with one translation (empty when it can ship). */
export function checkMessage(src, tr, dnt = []) {
  const errs = [];
  let sa;
  let ta;
  try {
    sa = parse(src);
  } catch (e) {
    return [`source: ${e.message}`];
  }
  try {
    ta = parse(tr);
  } catch (e) {
    return [`translation: ${e.message}`];
  }
  const ss = signature(sa).join(',');
  const ts = signature(ta).join(',');
  if (ss !== ts) errs.push(`placeholders differ: source {${ss}} translation {${ts}}`);
  for (const tok of dnt) if (src.includes(tok) && !tr.includes(tok)) errs.push(`do-not-translate token "${tok}" is missing`);
  const lenS = src.length;
  if (lenS >= 8 && tr.length > Math.max(lenS * 3, lenS + 60)) errs.push(`translation is ${tr.length} characters for a ${lenS}-character source`);
  if (/‮|‬/.test(tr)) errs.push('bidi override characters');
  return errs;
}

/** Validate every locale catalogue; returns {tag: {total, translated, errors: [...]}}. */
export function check({ root = ROOT } = {}) {
  const source = readSource(root);
  const dnt = readDnt(root);
  const byKey = new Map(source.messages.map((m) => [m.key, m]));
  const out = {};
  for (const l of registry(root)) {
    if (l.tag === 'en') continue;
    const cat = readLocale(l.tag, root);
    const rec = { wave: l.wave, total: source.messages.length, translated: 0, stale: 0, errors: [] };
    if (cat) {
      for (const [k, v] of Object.entries(cat.messages ?? {})) {
        const m = byKey.get(k);
        if (!m) {
          rec.stale++;
          continue;
        }
        const e = checkMessage(m.src, v, dnt);
        if (e.length) rec.errors.push({ key: k.slice(0, 80), errors: e });
        else rec.translated++;
      }
    }
    out[l.tag] = rec;
  }
  return out;
}

/**
 * For build/build.mjs: wave 1 blocks, wave 2–3 pack definitions and the manifest record. Only
 * translations that pass checkMessage ship; others fall back to English (REQ-L10N-17).
 */
export function i18nBuild({ root = ROOT, version, minCoverage = 0.98 } = {}) {
  const source = readSource(root);
  const keys = source.messages.map((m) => m.key);
  const dnt = readDnt(root);
  const blocks = [];
  const packDefs = [];
  const warnings = [];
  const locales = [];
  const coverage = {};
  for (const l of registry(root)) {
    if (l.tag === 'en') {
      locales.push({ tag: 'en', name: l.name, english: l.english, wave: 0 });
      continue;
    }
    const cat = readLocale(l.tag, root);
    if (!cat) continue;
    let n = 0;
    const values = source.messages.map((m) => {
      const v = cat.messages?.[m.key];
      if (!v) return '';
      if (checkMessage(m.src, v, dnt).length) return '';
      n++;
      return v;
    });
    const cov = keys.length ? n / keys.length : 0;
    coverage[l.tag] = Math.round(cov * 1000) / 10;
    // OD-2.22: every locale ships as a pack and the HTML carries English only (size budget). The
    // inline path stays for a build that sets `inline: true` on a locale in locales.json.
    const inline = l.inline === true && cov >= minCoverage;
    if (cov < minCoverage) warnings.push(`locale ${l.tag}: ${coverage[l.tag]} % translated (< ${minCoverage * 100} %)`);
    const rec = { tag: l.tag, name: l.name, english: l.english, wave: l.wave, coverage: coverage[l.tag], ai: true };
    if (inline) blocks.push({ name: `data-locale-${l.tag}`, bytes: Buffer.from(JSON.stringify(values)) });
    // Every locale is also a pack, for the Lite file (which leaves the inline catalogues out).
    const body = Buffer.from(JSON.stringify({ locale: l.tag, keys, values }));
    packDefs.push({ name: `locale-${l.tag}`, title: `${l.english} interface (${l.name})`, version, description: `GIS Workbench user interface in ${l.english}, translated with AI review (SDP-2.3 §4.11). ${coverage[l.tag]} % of messages.`, licence: 'Apache-2.0 (GIS Workbench translations)', entries: [{ path: 'messages.json', kind: 'data', bytes: body }] });
    locales.push(rec);
  }
  if (blocks.length) blocks.unshift({ name: 'data-i18n-keys', bytes: Buffer.from(JSON.stringify(keys)) });
  return { blocks, packDefs, manifest: { locales, messages: keys.length, coverage }, warnings };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === 'extract' && process.argv.includes('--check')) {
    const cat = extract();
    const drift = sourceDrift(cat, readFileSync(join(CAT, 'en.json'), 'utf8'));
    if (drift) {
      const show = (list) => list.slice(0, 20).map((k) => `   ${JSON.stringify(k)}`).join('\n');
      console.log(`en.json is out of date: ${drift.added.length} new, ${drift.removed.length} gone, the rest are moved files or counts.`);
      if (drift.added.length) console.log(`New:\n${show(drift.added)}`);
      if (drift.removed.length) console.log(`Gone:\n${show(drift.removed)}`);
      console.log('Run `node build/i18n.mjs extract` and commit en.json.');
      process.exitCode = 1;
    } else console.log(`en.json is up to date (${cat.messages.length} messages).`);
    if (cat.bad.length) {
      console.log(`${cat.bad.length} messages are not valid ICU:\n${cat.bad.slice(0, 40).join('\n')}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'extract') {
    const cat = extract();
    writeSource(cat);
    console.log(`en.json: ${cat.messages.length} messages (${cat.messages.filter((m) => m.error).length} static error messages)`);
    if (cat.bad.length) {
      console.log(`${cat.bad.length} messages are not valid ICU:\n${cat.bad.slice(0, 40).join('\n')}`);
      process.exitCode = 1;
    }
  } else if (cmd === 'lint') {
    const hits = lint();
    if (process.argv.includes('--json')) console.log(JSON.stringify(hits, null, 1));
    else {
      const by = {};
      for (const h of hits) by[h.file] = (by[h.file] ?? 0) + 1;
      for (const [f, n] of Object.entries(by).sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(5)}  ${f}`);
      console.log(`${hits.length} bare user-visible literals in ${Object.keys(by).length} files`);
    }
    if (process.argv.includes('--strict') && hits.length) process.exitCode = 1;
  } else if (cmd === 'check' || cmd === 'coverage') {
    const r = check();
    let bad = 0;
    for (const [tag, x] of Object.entries(r)) {
      console.log(`${tag.padEnd(8)} wave ${x.wave}  ${x.translated}/${x.total} (${x.total ? ((x.translated / x.total) * 100).toFixed(1) : '0.0'} %)  errors ${x.errors.length}  stale ${x.stale}`);
      if (cmd === 'check') for (const e of x.errors.slice(0, 10)) console.log(`   ${e.key}: ${e.errors.join('; ')}`);
      bad += x.errors.length;
    }
    if (cmd === 'check' && bad) process.exitCode = 1;
  } else console.log('usage: node build/i18n.mjs extract [--check] | lint [--json] [--strict] | check | coverage');
}
