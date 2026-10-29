// Archive coverage: does the corpus hold ≥ min distinct samples of every format the app reads or
// refuses (build/campaign/formats.json), and the supporting-data pairings every function needs
// (build/campaign/function-needs.json)? Format keys come from reports/campaign/format-census.json
// (build/campaign/census.py) plus 'covers' tags; pairings from 'pairs' on items. Tags for items whose
// source file is generated or not ours (field.json, Research/samples) live in coverage-tags.json.
// Tier-U field data never counts. Writes docs/validation/TE-archive-coverage.md; exits 1 on a gap.
//
//   node build/campaign/coverage.mjs [--report-only]

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, REPO, loadManifest } from './corpus-lib.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const { defaultMin, formats } = read(join(HERE, 'formats.json'));
const { needs } = read(join(HERE, 'function-needs.json'));
const censusPath = join(REPO, 'reports/campaign/format-census.json');
if (!existsSync(censusPath)) throw new Error('no format census: run build/campaign/census.py first');
const census = read(censusPath).files;
const overlay = existsSync(join(HERE, 'coverage-tags.json')) ? read(join(HERE, 'coverage-tags.json')) : {};
const items = loadManifest().items.map((it) => ({ ...it, covers: [...(it.covers ?? []), ...(overlay[it.id]?.covers ?? [])], pairs: [...(it.pairs ?? []), ...(overlay[it.id]?.pairs ?? [])] }));
const byId = new Map(items.map((it) => [it.id, it]));
const counts = (it) => it.tier !== 'U' && !String(it.origin).startsWith('field');

// key → Map(sample → producer)
const samples = new Map();
const add = (key, sample, producer) => {
  if (!samples.has(key)) samples.set(key, new Map());
  samples.get(key).set(sample, producer);
};
for (const r of census) {
  const it = byId.get(r.id);
  if (it && counts(it)) for (const k of r.keys) add(k, `${r.id}/${r.file}`, it.source || it.id);
}
// A tag stands in for files the census cannot classify; it is not an extra sample when the census already found the key in that item.
const inItem = (key, id) => [...(samples.get(key)?.keys() ?? [])].some((s) => s.startsWith(`${id}/`));
for (const it of items.filter(counts)) for (const c of it.covers) if (!inItem(c.replace(/^fmt:/, ''), it.id)) add(c.replace(/^fmt:/, ''), `${it.id} (tag)`, it.source || it.id);
const services = new Set(items.filter((it) => it.service).map((it) => it.service.type));

const pairs = new Map(); // role → [{id, with}]
for (const it of items.filter(counts)) for (const p of it.pairs) (pairs.get(p.role) ?? pairs.set(p.role, []).get(p.role)).push({ id: it.id, with: p.with ?? [] });

const fmtRows = Object.entries(formats).map(([key, f]) => {
  const s = samples.get(key) ?? new Map();
  const min = f.min ?? defaultMin;
  return { key, ...f, min, n: s.size, producers: new Set(s.values()).size, ok: s.size >= min, ex: [...s.keys()].slice(0, 3) };
});
const unknownKeys = [...samples.keys()].filter((k) => !formats[k] && !/^(tre\.|census\.|nitf\.unknown|zip$|pdf$|nitf$|dted$|gtiff$|fmv\.video|fmv\.mp4|fmv\.srt|las$)/.test(k)).sort();

const catalog = new Set([...readFileSync(join(REPO, 'app/src/shell/commands.js'), 'utf8').matchAll(/^\s*\['([a-z0-9]+\.[a-z0-9.]+)'/gm)].map((m) => m[1]));
const met = (n) => {
  const [kind, key] = [n.key.slice(0, n.key.indexOf(':')), n.key.slice(n.key.indexOf(':') + 1)];
  if (kind === 'fmt' && key === '*') return { ok: fmtRows.every((r) => r.ok), have: `${fmtRows.filter((r) => r.ok).length}/${fmtRows.length} formats` };
  if (kind === 'fmt') {
    const r = fmtRows.find((x) => x.key === key);
    return { ok: !!r?.ok, have: r ? `${r.n}/${r.min}` : 'unregistered key' };
  }
  if (kind === 'service') return { ok: services.has(key), have: services.has(key) ? 'service item' : 'none' };
  const list = pairs.get(key) ?? [];
  return { ok: list.length >= (n.min ?? 1), have: `${list.length}/${n.min ?? 1}${list.length ? ` (${list.slice(0, 4).map((p) => p.id).join(', ')}${list.length > 4 ? ', …' : ''})` : ''}` };
};
const fnRows = needs.map((x) => ({ ...x, res: x.need.map((n) => ({ ...n, ...met(n) })), unknown: x.cmds.filter((c) => !catalog.has(c)) }));

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|');
const gapsF = fmtRows.filter((r) => !r.ok);
const gapsN = fnRows.flatMap((r) => r.res.filter((n) => !n.ok).map((n) => `${r.area}: ${n.key}`));
const out = [
  '# T&E archive coverage',
  '',
  `Generated ${new Date().toISOString()} by \`build/campaign/coverage.mjs\` from \`corpus.json\` (${items.length} items), \`reports/campaign/format-census.json\` (${census.length} files), \`formats.json\` and \`function-needs.json\`. Field data (tier U) is excluded from all counts. Refused formats count negative samples.`,
  '',
  `**Formats:** ${fmtRows.length - gapsF.length}/${fmtRows.length} at minimum. **Function data roles:** ${fnRows.reduce((s, r) => s + r.res.filter((n) => n.ok).length, 0)}/${fnRows.reduce((s, r) => s + r.res.length, 0)} filled.`,
  '',
  '## Formats',
  '',
  '| Key | Format | Status | Samples | Min | Producers | OK | Examples |',
  '|---|---|---|---|---|---|---|---|',
  ...fmtRows.map((r) => `| \`${r.key}\` | ${esc(r.label)} | ${r.status} | ${r.n} | ${r.min} | ${r.producers} | ${r.ok ? 'yes' : '**no**'} | ${esc(r.ex.join('; '))} |`),
  '',
  '## Function data roles',
  '',
  '| Area | Commands | Need | Have | OK |',
  '|---|---|---|---|---|',
  ...fnRows.flatMap((r) => r.res.map((n) => `| ${r.area} | ${r.cmds.join(', ')} | \`${n.key}\`${n.desc ? ` ${esc(n.desc)}` : ''} | ${esc(n.have)} | ${n.ok ? 'yes' : '**no**'} |`)),
  '',
];
if (unknownKeys.length) out.push('## Census keys not in formats.json', '', unknownKeys.map((k) => `\`${k}\` (${samples.get(k).size})`).join(', '), '');
const tres = [...samples.keys()].filter((k) => k.startsWith('tre.')).sort();
out.push('## TREs present', '', tres.map((k) => `${k.slice(4)} (${samples.get(k).size})`).join(', ') || 'none', '');
writeFileSync(join(REPO, 'docs/validation/TE-archive-coverage.md'), `${out.join('\n')}\n`);

const unknownCmds = fnRows.flatMap((r) => r.unknown);
if (unknownCmds.length) console.warn(`function-needs.json names commands not in commands.js: ${unknownCmds.join(', ')}`);
console.log(`formats ${fmtRows.length - gapsF.length}/${fmtRows.length}; roles ${gapsN.length} unfilled; wrote docs/validation/TE-archive-coverage.md`);
if (gapsF.length) console.log(`format gaps: ${gapsF.map((r) => `${r.key} ${r.n}/${r.min}`).join(', ')}`);
if (gapsN.length) console.log(`role gaps: ${gapsN.join(', ')}`);
if ((gapsF.length || gapsN.length || unknownCmds.length) && !process.argv.includes('--report-only')) process.exitCode = 1;
