// Performance baseline from the c55 records (tests/campaign/c55-perf.spec.js): per file and per census
// format key, the open, first-tile, statistics, roaming, read-out, GPU and heap numbers, with every
// value over its budget listed. Writes reports/campaign/perf-baseline.json and a Markdown table.
//   node build/campaign/perf-report.mjs <run> [--project=chrome] [--out=docs/validation/TE-perf-baseline.md]
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './corpus-lib.mjs';

const args = process.argv.slice(2);
const run = args.find((a) => !a.startsWith('--'));
const opt = (k, d) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const project = opt('project', 'chrome');
const outMd = join(REPO, opt('out', 'docs/validation/TE-perf-baseline.md'));
const dir = join(REPO, 'reports/campaign/results', run ?? '');
if (!run || !existsSync(dir)) throw new Error('usage: perf-report.mjs <run>');

const recs = readdirSync(dir).filter((n) => n.startsWith(`c55-${project}-`) && n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8')));
const files = recs.map((r) => ({ key: r.key, bytes: r.bytes, keys: r.keys, openMs: r.openMs, firstTileMs: r.firstTileMs ?? null, statsMs: r.statsMs ?? null, fps: r.fps ?? null, frameMs: r.frameMs ?? null, readoutMs: r.readoutMs?.median ?? null, gpuMB: r.gpuMB ?? null, heapGrowthMB: r.heapMB?.growth ?? null, points: r.points ?? null, cloudFps: r.cloudFps ?? null, over: r.over ?? [] }));
const byKey = {};
for (const f of files) for (const k of f.keys ?? []) (byKey[k] ??= []).push(f);
const worst = (list, field, hi = true) => list.filter((f) => f[field] != null).reduce((m, f) => (m === null || (hi ? f[field] > m[field] : f[field] < m[field]) ? f : m), null);
const keys = Object.fromEntries(Object.entries(byKey).map(([k, list]) => [k, { files: list.length, maxFirstTileMs: worst(list, 'firstTileMs')?.firstTileMs ?? null, maxOpenMs: worst(list, 'openMs')?.openMs ?? null, minFps: worst(list, 'fps', false)?.fps ?? null, over: list.flatMap((f) => f.over.map((o) => `${f.key}: ${o}`)) }]));
writeFileSync(join(REPO, 'reports/campaign/perf-baseline.json'), JSON.stringify({ run, project, measured: new Date().toISOString(), budgets: recs[0]?.budget ?? null, files, keys }, null, 1));

const L = [`# Performance baseline: ${run} (${project})`, '', `From \`tests/campaign/c55-perf.spec.js\` on ${new Date().toISOString().slice(0, 10)}: the largest and the median file of each census format key, on this machine (Intel Arc, Chrome). Budgets: first tile ≤ 1 s (REQ-PRF-03), roaming ≥ 50 fps and frame ≤ 16.7 ms (REQ-PRF-02), read-out < 16.7 ms (REQ-PRF-04), GPU within budget (REQ-PRF-08), heap growth ≤ 64 MB after ten opens, point clouds over 5 M points ≥ 30 fps (REQ-PRF-05).`, ''];
const over = files.filter((f) => f.over.length);
L.push(`- Files measured: ${files.length}; over a budget: ${over.length}.`, '');
L.push('## Over budget', '', '| File | MB | Over |', '|---|---|---|');
for (const f of over.sort((a, b) => b.bytes - a.bytes)) L.push(`| ${f.key} | ${(f.bytes / 1e6).toFixed(0)} | ${f.over.join('; ')} |`);
L.push('', '## All files', '', '| File | MB | Open s | First tile ms | Stats ms | fps | Frame ms | Read-out ms | GPU MB | Heap +MB |', '|---|---|---|---|---|---|---|---|---|---|');
for (const f of files.sort((a, b) => b.bytes - a.bytes)) L.push(`| ${f.key} | ${(f.bytes / 1e6).toFixed(0)} | ${f.openMs != null ? (f.openMs / 1000).toFixed(1) : ''} | ${f.firstTileMs ?? ''} | ${f.statsMs ?? ''} | ${f.fps ?? (f.cloudFps != null ? `${f.cloudFps} (3D)` : '')} | ${f.frameMs ?? ''} | ${f.readoutMs != null ? f.readoutMs.toFixed(1) : ''} | ${f.gpuMB ?? ''} | ${f.heapGrowthMB ?? ''} |`);
writeFileSync(outMd, L.join('\n') + '\n');
console.log(`${files.length} files, ${over.length} over budget → ${outMd}`);
