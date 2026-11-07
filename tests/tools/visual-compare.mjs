// GUI3 campaign: compare visual-audit runs. Prints findings per layout × theme and kind for each
// run (axe duplicates the text check and is listed apart), and the distinct problems still left
// in the last run, worst first. Writes reports/gui3/compare.json for the report.
//   node tests/tools/visual-compare.mjs before-full after-full [--top 40]
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const top = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 40;
const labels = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--top');
const BASE = resolve('reports', 'gui3');
const KINDS = ['text', 'hover-text', 'ui', 'focus', 'hover', 'state', 'tier', 'chart', 'axe'];
const runs = labels.map((l) => ({ label: l, ...JSON.parse(readFileSync(join(BASE, l, 'audit.json'), 'utf8')) }));
const table = {};
for (const r of runs) {
  const t = (table[r.label] = {});
  for (const x of r.results) {
    if (!x.shot) continue;
    const row = (t[x.combo] ??= Object.fromEntries([['surfaces', 0], ...KINDS.map((k) => [k, 0])]));
    row.surfaces++;
    for (const f of x.findings ?? []) if (row[f.kind] !== undefined) row[f.kind]++;
  }
}
for (const r of runs) {
  console.log(`\n== ${r.label}`);
  console.log(['combo'.padEnd(20), 'surf', ...KINDS.map((k) => k.slice(0, 6).padStart(6))].join(' '));
  const tot = Object.fromEntries([['surfaces', 0], ...KINDS.map((k) => [k, 0])]);
  for (const [c, row] of Object.entries(table[r.label])) {
    console.log([c.padEnd(20), String(row.surfaces).padStart(4), ...KINDS.map((k) => String(row[k]).padStart(6))].join(' '));
    for (const k in tot) tot[k] += row[k];
  }
  console.log(['TOTAL'.padEnd(20), String(tot.surfaces).padStart(4), ...KINDS.map((k) => String(tot[k]).padStart(6))].join(' '));
}
// Distinct problems in the last run, grouped by kind + element, worst value first.
const last = runs.at(-1);
const groups = new Map();
for (const x of last.results)
  for (const f of x.findings ?? []) {
    if (f.kind === 'axe') continue;
    const key = `${f.kind} | ${String(f.el).replace(/\[data-id="[^"]+"\]/g, '[id]')}`;
    const g = groups.get(key) ?? { kind: f.kind, el: key.split(' | ')[1], n: 0, combos: new Set(), surfaces: new Set(), worst: f };
    g.n++;
    g.combos.add(x.combo);
    g.surfaces.add(x.surface);
    if ((f.value ?? 99) < (g.worst.value ?? 99)) g.worst = f;
    groups.set(key, g);
  }
const rows = [...groups.values()].sort((a, b) => b.n - a.n);
console.log(`\n== ${last.label}: ${rows.length} distinct problems (top ${top})`);
for (const g of rows.slice(0, top)) console.log(`${g.kind.padEnd(10)} ${String(g.n).padStart(4)}  ${g.el.slice(0, 70).padEnd(70)} worst ${g.worst.value} ${g.worst.fg ?? ''}/${g.worst.bg ?? ''} "${(g.worst.text ?? g.worst.what ?? g.worst.against ?? '').slice(0, 24)}" in ${[...g.combos].slice(0, 4).join(',')}${g.combos.size > 4 ? '…' : ''} | ${[...g.surfaces].slice(0, 2).join(',')}`);
writeFileSync(join(BASE, 'compare.json'), JSON.stringify({ table, distinct: rows.map((g) => ({ ...g, combos: [...g.combos], surfaces: [...g.surfaces].slice(0, 10) })) }, null, 1));
