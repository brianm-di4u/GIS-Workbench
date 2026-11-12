#!/usr/bin/env node
// How much this build's files grew or shrank against build/size-baseline.json, the sizes of the
// last release, with the limits beside them. It only reports: build/gates.mjs fails a build that
// goes over a limit. On CI it also goes in the job summary, one click from the PR.
//
//   node build/size-report.mjs             report dist/build-report.json against the baseline
//   node build/size-report.mjs --update    make this build the baseline (the release PR does this)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LIMITS, WASM_TOTAL_BUDGET } from './gates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'build', 'size-baseline.json');

const FILES = [
  { key: 'total', label: 'Full HTML', limit: LIMITS.totalFail },
  { key: 'airgap', label: 'Air-gap HTML', limit: LIMITS.totalFail },
  { key: 'lite', label: 'Lite HTML', limit: LIMITS.liteFail },
  { key: 'eager', label: 'Full eager part', limit: LIMITS.eagerFail },
  { key: 'rustTotalGzip', label: 'Rust WASM, gzip', limit: WASM_TOTAL_BUDGET },
];

/** A limit as gates.mjs states it: whole decimal megabytes, or else mebibytes. */
export const limitText = (n) => (n % 1_000_000 === 0 ? `${n / 1_000_000} MB` : `${Number((n / 1048576).toFixed(2))} MiB`);

/** The numbers a baseline keeps: the files above, and each embedded block's stored size. No commit:
 *  the release PR is squash-merged, so its branch head never reaches main (#212). */
export function snapshot(report) {
  const s = report.sizes;
  return {
    version: report.build.version,
    build: report.build.id,
    files: Object.fromEntries(FILES.map((f) => [f.key, s[f.key]])),
    blocks: Object.fromEntries(Object.entries(s.blocks ?? {}).map(([name, b]) => [name, b.stored]).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
}

const sign = (n) => (n > 0 ? `+${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'));
const pct = (n, of) => (of ? `${((n / of) * 100).toFixed(1)} %` : '');

/** The report as Markdown: each file against the baseline and its limit, then the blocks that moved most. */
export function sizeDelta(baseline, now, { blocks = 8 } = {}) {
  const rows = FILES.map((f) => {
    const was = baseline.files[f.key];
    const is = now.files[f.key];
    if (is == null) return `| ${f.label} | not built | | ${limitText(f.limit)} | |`;
    const delta = was == null ? '' : `${sign(is - was)} B`;
    return `| ${f.label} | ${is.toLocaleString('en-US')} B | ${delta} | ${limitText(f.limit)} | ${pct(is, f.limit)} |`;
  });
  const names = new Set([...Object.keys(baseline.blocks), ...Object.keys(now.blocks)]);
  const moved = [...names]
    .map((name) => ({ name, was: baseline.blocks[name] ?? 0, is: now.blocks[name] ?? 0 }))
    .filter((b) => b.was !== b.is)
    .sort((a, b) => Math.abs(b.is - b.was) - Math.abs(a.is - a.was) || (a.name < b.name ? -1 : 1));
  const out = [
    `### Size since ${baseline.version} at build ${baseline.build}`,
    '',
    'Changes count everything merged since then, not only this change.',
    '',
    '| File | Size | Change | Limit | Of limit |',
    '|---|--:|--:|--:|--:|',
    ...rows,
    '',
  ];
  if (moved.length === 0) out.push('No embedded block changed size.', '');
  else {
    out.push(`Blocks that changed most (${moved.length} changed in all):`, '');
    for (const b of moved.slice(0, blocks)) out.push(`- \`${b.name}\`: ${sign(b.is - b.was)} B${b.was === 0 ? ' (new)' : b.is === 0 ? ' (gone)' : ''}`);
    out.push('');
  }
  return out.join('\n');
}

function main() {
  const reportFile = join(ROOT, 'dist', 'build-report.json');
  if (!existsSync(reportFile)) {
    console.log('No dist/build-report.json, so no size report: build first.');
    return 0;
  }
  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  if (process.argv.includes('--update')) {
    const now = snapshot(report);
    const missing = FILES.filter((f) => now.files[f.key] == null).map((f) => f.label);
    if (missing.length || report.gates?.errors?.length) {
      console.error(`Not updating the baseline from a build that failed its gates or is missing: ${missing.join(', ') || 'none missing'}.`);
      return 1;
    }
    writeFileSync(BASELINE, `${JSON.stringify(now, null, 1)}\n`);
    console.log(`build/size-baseline.json is now ${now.version} at build ${now.build}.`);
    return 0;
  }
  if (report.gates?.errors?.length) console.log('The build failed its gates, so some sizes may be missing.\n');
  const text = sizeDelta(JSON.parse(readFileSync(BASELINE, 'utf8')), snapshot(report));
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
