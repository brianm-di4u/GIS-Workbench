// Translation pipeline (REQ-L10N-15, REQ-L10N-17; SDP-2.3 §4.11; OD-2.12, OD-2.15): draft, then an
// independent review-and-refine pass, then validation. Build-time only: only UI strings leave the
// machine, never user data, and nothing here ships in the app.
//
//   node build/i18n-translate.mjs status
//   node build/i18n-translate.mjs work  <tag> [--batch 150] [--out E:/gwb23/i18n-work]
//        → batch-NNN.json files of pending messages (missing, or source changed) with context
//   node build/i18n-translate.mjs merge <tag> <result.json> [...]
//        → accepted translations into app/src/i18n/catalog/<tag>.json, states into state/<tag>.json
//   node build/i18n-translate.mjs api   <tag> [--batch 80] [--limit N]
//        → the same loop through the Claude API (credentials from the environment or `ant auth`)
//
// A result file is { "locale": tag, "translations": [ { "key", "text", "state": "passed" |
// "flagged", "note"? } ] }. Only "passed" texts that also pass checkMessage (ICU structure,
// placeholders, do-not-translate tokens, length) are written; the rest fall back to English.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSource, readLocale, readDnt, registry, checkMessage } from './i18n.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAT = join(ROOT, 'app', 'src', 'i18n', 'catalog');
const STATE = join(ROOT, 'app', 'src', 'i18n', 'state');
const GLOSS = join(ROOT, 'app', 'src', 'i18n', 'glossary');
const MODEL = 'claude-opus-5-5';

export const hashOf = (src) => createHash('sha256').update(src).digest('hex').slice(0, 12);
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};

function readJson(p, def) {
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : def;
}
function writeJson(p, v) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(v, null, 1)}\n`);
}

export function glossaryFor(tag) {
  const terms = readJson(join(GLOSS, 'terms.json'), { terms: [] }).terms;
  const loc = readJson(join(GLOSS, `${tag}.json`), { terms: {}, style: '' });
  return { terms, map: loc.terms ?? {}, style: loc.style ?? '' };
}

/** Messages of the source catalogue that need (re)translation for a locale. */
export function pending(tag) {
  const src = readSource();
  const cat = readLocale(tag) ?? { messages: {} };
  const state = readJson(join(STATE, `${tag}.json`), { strings: {} }).strings;
  return src.messages.filter((m) => {
    const s = state[m.key];
    if (!cat.messages?.[m.key]) return !(s?.state === 'flagged' && s.h === hashOf(m.src));
    return s?.h !== hashOf(m.src);
  });
}

function contextOf(m, g, dnt) {
  // Glossary hints from the words of the message, not from its ICU syntax ({n, plural, …}).
  const low = m.src.replace(/\{\s*\w+\s*,\s*(plural|selectordinal|select|number|date|time)\b[^{}]*/g, '{').replace(/\b(one|few|many|other|zero|two|offset)\s*\{/g, '{').toLowerCase();
  const terms = {};
  for (const t of g.terms) {
    const en = t.en.toLowerCase();
    if (en.length > 2 && new RegExp(`\\b${en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es|ed|ing)?\\b`, 'i').test(low) && g.map[t.en]) terms[t.en] = g.map[t.en];
  }
  return {
    key: m.key,
    src: m.src,
    ...(m.ctx ? { ctx: m.ctx } : {}),
    where: m.refs?.slice(0, 3) ?? [],
    ...(m.error ? { kind: 'error message' } : {}),
    ...(Object.keys(terms).length ? { glossary: terms } : {}),
    ...(dnt.some((d) => m.src.includes(d)) ? { keep: dnt.filter((d) => m.src.includes(d)) } : {}),
  };
}

export function work(tag, { batch = 150, out = 'E:/gwb23/i18n-work' } = {}) {
  const l = registry().find((x) => x.tag === tag);
  if (!l) throw new Error(`unknown locale ${tag}`);
  const g = glossaryFor(tag);
  const dnt = readDnt();
  const todo = pending(tag);
  const dir = join(out, tag);
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (/^batch-\d+\.json$/.test(f)) rmSync(join(dir, f)); // stale batches go
  const files = [];
  for (let i = 0; i < todo.length; i += batch) {
    const f = join(dir, `batch-${String(i / batch).padStart(3, '0')}.json`);
    writeJson(f, { locale: tag, language: l.english, native: l.name, style: g.style, messages: todo.slice(i, i + batch).map((m) => contextOf(m, g, dnt)) });
    files.push(f);
  }
  return { tag, pending: todo.length, files };
}

/** Merge reviewed results; returns {accepted, rejected: [{key, errors}], flagged}. */
export function merge(tag, results) {
  const src = new Map(readSource().messages.map((m) => [m.key, m]));
  const dnt = readDnt();
  const catPath = join(CAT, `${tag}.json`);
  const cat = readJson(catPath, { locale: tag, comment: 'AI-translated and AI-reviewed (OD-2.15). Edit through build/i18n-translate.mjs.', messages: {} });
  const statePath = join(STATE, `${tag}.json`);
  const st = readJson(statePath, { locale: tag, strings: {} });
  const out = { accepted: 0, flagged: 0, rejected: [] };
  for (const r of results.flatMap((x) => x.translations ?? [])) {
    const m = src.get(r.key);
    if (!m) continue;
    if (r.state !== 'passed' || !r.text) {
      st.strings[r.key] = { h: hashOf(m.src), state: 'flagged', note: r.note ?? 'flagged by review' };
      delete cat.messages[r.key];
      out.flagged++;
      continue;
    }
    const errs = checkMessage(m.src, r.text, dnt);
    if (errs.length) {
      out.rejected.push({ key: r.key, errors: errs });
      st.strings[r.key] = { h: hashOf(m.src), state: 'flagged', note: errs.join('; ') };
      delete cat.messages[r.key];
      continue;
    }
    cat.messages[r.key] = r.text;
    st.strings[r.key] = { h: hashOf(m.src), state: 'passed', ...(r.note ? { note: r.note } : {}) };
    out.accepted++;
  }
  // Drop translations of messages the code no longer has.
  for (const k of Object.keys(cat.messages)) if (!src.has(k)) delete cat.messages[k];
  for (const k of Object.keys(st.strings)) if (!src.has(k)) delete st.strings[k];
  cat.messages = Object.fromEntries(Object.entries(cat.messages).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeJson(catPath, cat);
  writeJson(statePath, st);
  return out;
}

// ---- Claude API mode ----
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, text: { type: 'string' }, state: { type: 'string', enum: ['passed', 'flagged'] }, note: { type: 'string' } },
        required: ['key', 'text', 'state', 'note'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

function draftPrompt(b) {
  return [
    `Translate the user-interface messages of GIS Workbench, a GIS, imagery-analysis and photogrammetry application for civilian use, from English into ${b.language} (${b.native}).`,
    'Rules:',
    '- Each message is ICU MessageFormat. Keep every placeholder ({name}, {n, plural, …}, #) exactly; translate the text inside plural and select cases, and give every plural category the language needs.',
    '- Use the glossary renderings given for a message. Keep every "keep" token character for character.',
    '- Match the register and conventions of professional GIS software in this language. Keep labels as short as the English. Keep "…" and "▸" where the English has them.',
    `- Style for ${b.language}: ${b.style || 'formal, concise UI language'}`,
    '- "where" shows the source files; use it only to understand the context. An error message is shown to the user as it is.',
    '- Set state to "passed" for every message you translated; note is "" unless something needs attention.',
    '',
    JSON.stringify(b.messages),
  ].join('\n');
}

function reviewPrompt(b, drafts) {
  return [
    `You are the independent reviewer of ${b.language} (${b.native}) translations of GIS Workbench's user interface (a professional GIS and photogrammetry application for civilian use). You did not write them.`,
    'For each message compare the draft with the English source and its context. Check meaning, technical terminology (and the glossary), tone, length, ICU placeholders and plural forms, and kept tokens.',
    '- If the draft is right, return it unchanged with state "passed".',
    '- If it can be fixed, return your corrected text with state "passed" and a short note saying what you changed.',
    '- If you cannot produce a reliable translation, return state "flagged" with the reason in note; it will be shown in English.',
    '',
    `Sources: ${JSON.stringify(b.messages)}`,
    '',
    `Drafts: ${JSON.stringify(drafts)}`,
  ].join('\n');
}

async function callClaude(client, prompt) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: RESULT_SCHEMA } },
        messages: [{ role: 'user', content: prompt }],
      });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error(`refused (${msg.stop_details?.category ?? 'no category'})`);
      if (msg.stop_reason === 'max_tokens') throw new Error('output truncated at max_tokens: use a smaller --batch');
      const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
      return JSON.parse(text);
    } catch (e) {
      if (attempt === 4 || /truncated|refused/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt * attempt));
    }
  }
  return null;
}

export async function api(tag, { batch = 80, limit = Infinity } = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();
  const { files } = work(tag, { batch, out: join(ROOT, '.cache', 'i18n-work') });
  let done = 0;
  for (const f of files.slice(0, limit)) {
    const b = JSON.parse(readFileSync(f, 'utf8'));
    const draft = await callClaude(client, draftPrompt(b));
    const reviewed = await callClaude(client, reviewPrompt(b, draft.translations));
    const r = merge(tag, [{ locale: tag, translations: reviewed.translations }]);
    done += r.accepted;
    console.log(`${tag} ${f.split(/[\\/]/).pop()}: ${r.accepted} accepted, ${r.flagged} flagged, ${r.rejected.length} rejected`);
  }
  return done;
}

/**
 * In-session agent route: a translator writes draft-NNN.json ({translations: [{key, text}]}) beside
 * each batch, and a different reviewer writes review-NNN.json ({changes: [{key, text, note}],
 * flagged: [{key, note}]}). combine() takes the draft, applies the review and merges the result.
 */
export function combine(tag, dir = join('E:/gwb23/i18n-work', tag)) {
  const results = [];
  const missing = [];
  for (const f of readdirSync(dir).filter((x) => /^batch-\d+\.json$/.test(x)).sort()) {
    const n = f.match(/\d+/)[0];
    const batch = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const dp = join(dir, `draft-${n}.json`);
    const rp = join(dir, `review-${n}.json`);
    if (!existsSync(dp) || !existsSync(rp)) {
      missing.push(n);
      continue;
    }
    const draft = new Map(JSON.parse(readFileSync(dp, 'utf8')).translations.map((x) => [x.key, x.text]));
    const review = JSON.parse(readFileSync(rp, 'utf8'));
    const changes = new Map((review.changes ?? []).map((x) => [x.key, x]));
    const flagged = new Map((review.flagged ?? []).map((x) => [x.key, x.note]));
    const translations = batch.messages.map((m) => {
      if (flagged.has(m.key)) return { key: m.key, text: '', state: 'flagged', note: flagged.get(m.key) || 'flagged by review' };
      const c = changes.get(m.key);
      const text = c?.text ?? draft.get(m.key);
      return text ? { key: m.key, text, state: 'passed', ...(c?.note ? { note: `review: ${c.note}` } : {}) } : { key: m.key, text: '', state: 'flagged', note: 'no draft' };
    });
    results.push({ locale: tag, translations });
  }
  return { ...merge(tag, results), missing };
}

export function status() {
  const total = readSource().messages.length;
  return registry()
    .filter((l) => l.tag !== 'en')
    .map((l) => {
      const st = readJson(join(STATE, `${l.tag}.json`), { strings: {} }).strings;
      const states = Object.values(st);
      return { tag: l.tag, wave: l.wave, total, passed: states.filter((s) => s.state === 'passed').length, flagged: states.filter((s) => s.state === 'flagged').length, pending: pending(l.tag).length };
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, tag, ...rest] = process.argv.slice(2);
  if (cmd === 'status') for (const s of status()) console.log(`${s.tag.padEnd(8)} wave ${s.wave}  passed ${s.passed}/${s.total}  flagged ${s.flagged}  pending ${s.pending}`);
  else if (cmd === 'work') {
    const r = work(tag, { batch: Number(arg('--batch', 150)), out: arg('--out', 'E:/gwb23/i18n-work') });
    console.log(`${tag}: ${r.pending} pending in ${r.files.length} batches\n${r.files.join('\n')}`);
  } else if (cmd === 'merge') {
    const r = merge(tag, rest.filter((f) => !f.startsWith('--')).map((f) => JSON.parse(readFileSync(f, 'utf8'))));
    console.log(`${tag}: ${r.accepted} accepted, ${r.flagged} flagged, ${r.rejected.length} rejected`);
    for (const x of r.rejected.slice(0, 30)) console.log(`  ${x.key.slice(0, 70)}: ${x.errors.join('; ')}`);
  } else if (cmd === 'combine') {
    const r = combine(tag, arg('--dir', join('E:/gwb23/i18n-work', tag)));
    console.log(`${tag}: ${r.accepted} accepted, ${r.flagged} flagged, ${r.rejected.length} rejected${r.missing.length ? `; batches without draft or review: ${r.missing.join(', ')}` : ''}`);
    for (const x of r.rejected.slice(0, 30)) console.log(`  ${x.key.slice(0, 70)}: ${x.errors.join('; ')}`);
  } else if (cmd === 'api') await api(tag, { batch: Number(arg('--batch', 80)), limit: Number(arg('--limit', Infinity)) });
  else console.log('usage: node build/i18n-translate.mjs status | work <tag> | merge <tag> <files…> | api <tag>');
}
