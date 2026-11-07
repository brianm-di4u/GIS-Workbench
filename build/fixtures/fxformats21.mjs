// FX-21 (SDP-2.1 §4 P9): synthetic inputs for the 2.1 format closure. Each format group owns one
// module in build/fixtures/fx21/ exporting `async function generate(outDir)`; this runner calls
// them all (or those named) and writes fixtures/fx21/<group>/.
//
//   node build/fixtures/fxformats21.mjs [outdir] [--only=group,group]

import { readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const only = (args.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const base = args.find((a) => !a.startsWith('--')) ?? join(ROOT, 'fixtures');
const dir = join(ROOT, 'build', 'fixtures', 'fx21');
for (const f of readdirSync(dir).filter((n) => n.endsWith('.mjs')).sort()) {
  const group = f.replace(/\.mjs$/, '');
  if (only.length && !only.includes(group)) continue;
  const out = join(base, 'fx21', group);
  mkdirSync(out, { recursive: true });
  const { generate } = await import(pathToFileURL(join(dir, f)).href);
  const made = await generate(out);
  console.log(`fx21/${group}: ${Array.isArray(made) ? made.length : 0} files`);
}
