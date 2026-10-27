// Write docs/validation/TE-data-catalogue.md from build/campaign/corpus.json: every item with
// source, licence, tier, format and on-disk state, grouped by area. Re-run after make-corpus/fetch.
//   node build/campaign/catalogue.mjs

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, loadManifest, present, fmtBytes } from './corpus-lib.mjs';

const m = loadManifest();
const areas = [...new Set(m.items.map((i) => i.area))].sort();
const bytes = (it) => it.files.reduce((s, f) => s + (f.bytes ?? 0), 0);
const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const out = [
  '# T&E data catalogue',
  '',
  `Generated ${new Date().toISOString()} from \`build/campaign/corpus.json\` (${m.items.length} items). Tier A = anonymous download by \`build/campaign/fetch.mjs\`; tier B = free login, downloaded by the owner into \`TE-corpus/<id>/\`; RS = already held in \`Research/samples\`.`,
  '',
  '| Area | Items | Size | On disk |',
  '|---|---|---|---|',
  ...areas.map((a) => {
    const its = m.items.filter((i) => i.area === a);
    return `| ${a} | ${its.length} | ${fmtBytes(its.reduce((s, i) => s + bytes(i), 0))} | ${its.filter(present).length} |`;
  }),
  '',
];
for (const a of areas) {
  out.push(`## ${a}`, '', '| Id | Format | Source | Licence | Tier | Size | On disk |', '|---|---|---|---|---|---|---|');
  for (const it of m.items.filter((i) => i.area === a)) {
    const tier = it.origin === 'research-samples' ? 'RS' : it.tier;
    const src = it.landing ? `[${esc(it.source || 'link')}](${it.landing.split(/[ ,]/)[0]})` : esc(it.source);
    out.push(`| \`${it.id}\` | ${esc(it.format)}${it.profile ? ` (${esc(it.profile)})` : ''} | ${src} | ${esc(it.licence).slice(0, 90)} | ${tier} | ${fmtBytes(bytes(it))} | ${it.service ? 'service' : present(it) ? 'yes' : 'no'} |`);
  }
  out.push('');
}
writeFileSync(join(REPO, 'docs/validation/TE-data-catalogue.md'), `${out.join('\n')}\n`);
console.log(`wrote docs/validation/TE-data-catalogue.md (${m.items.length} items)`);
