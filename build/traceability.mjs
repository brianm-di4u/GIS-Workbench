// Traceability (SDP §7–8): every requirement (Appendix A) → where the code cites it → which tests cite
// it → the last result of the tests whose titles cite it (Playwright and Vitest JSON reports:
// reports/e2e.json, reports/unit.json, reports/campaign/playwright.json and pw-*.json, reports/campaign/golden.json),
// with the release and priority from the PRD tables. Also counts the other ID families (PT, SCN,
// AT, PRF, TE). Writes reports/traceability.json and reports/traceability.md.
// Usage: node build/traceability.mjs [--release R0,R1]
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Appendix A is the generated, complete matrix (348 rows); the PRD tables hold a subset.
const prd = readFileSync(join(root, '..', 'Docs', 'appendices', 'A-requirements-matrix.md'), 'utf8');
const want = (process.argv.find((a) => a.startsWith('--release='))?.split('=')[1] ?? 'R0,R1').split(',');

const reqs = new Map();
for (const line of prd.split('\n')) {
  const m = /^\|\s*(REQ-[A-Z0-9]+-\d+)\s*\|\s*(.*?)\s*\|\s*([MSCW])\s*\|\s*(R\d|—)\s*\|\s*([^|]*)\|\s*([^|]*)\|/.exec(line);
  if (m && !reqs.has(m[1])) reqs.set(m[1], { id: m[1], text: m[2], priority: m[3], release: m[4], impl: m[5].trim(), verify: m[6].trim(), code: [], tests: [] });
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'target' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs|rs|css)$/.test(f)) out.push(p);
  }
  return out;
}

// Ranges such as "REQ-WB-01..11" cite every id in between.
function cited(text) {
  const ids = new Set();
  for (const m of text.matchAll(/REQ-([A-Z0-9]+)-(\d+)(?:\s*(?:\.\.|–|-)\s*(?:REQ-\1-)?(\d+))?/g)) {
    const [, area, a, b] = m;
    const lo = Number(a);
    const hi = b ? Number(b) : lo;
    for (let n = lo; n <= Math.min(hi, lo + 40); n++) ids.add(`REQ-${area}-${String(n).padStart(a.length, '0')}`);
  }
  // Lists such as "REQ-EXT-01/02/05" cite each listed id.
  for (const m of text.matchAll(/REQ-([A-Z0-9]+)-(\d+)((?:\/\d+)+)/g)) {
    const [, area, a, rest] = m;
    for (const n of [a, ...rest.split('/').filter(Boolean)]) ids.add(`REQ-${area}-${n.padStart(a.length, '0')}`);
  }
  return ids;
}

const codeFiles = [...walk(join(root, 'app', 'src')), ...walk(join(root, 'crates')), ...walk(join(root, 'build'))].filter((f) => !f.includes(`${join('crates', 'gw-parse', 'data')}`));
const testFiles = [...walk(join(root, 'tests')), ...walk(join(root, 'crates')).filter((f) => /[\\/]tests[\\/]|#\[cfg\(test\)\]/.test(f) || readFileSync(f, 'utf8').includes('#[cfg(test)]'))];
for (const f of codeFiles) for (const id of cited(readFileSync(f, 'utf8'))) reqs.get(id)?.code.push(relative(root, f).replace(/\\/g, '/'));
for (const f of new Set(testFiles)) {
  if (!f.includes(`${join(root, 'tests')}`) && !f.includes('tests')) continue;
  for (const id of cited(readFileSync(f, 'utf8'))) reqs.get(id)?.tests.push(relative(root, f).replace(/\\/g, '/'));
}
for (const r of reqs.values()) {
  r.code = [...new Set(r.code)].filter((f) => !f.startsWith('tests/'));
  r.tests = [...new Set(r.tests)];
  r.status = r.tests.length ? 'tested' : r.code.length ? 'implemented, no test cites it' : 'not cited';
}

// ---- last results (TE campaign: SDP §8 asks for "last result", not only a citing test) ----
const results = []; // {title, status: passed|failed|skipped, source}
function playwright(file, source, dir) {
  if (!existsSync(file)) return;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const when = statSync(file).mtimeMs;
  const visit = (suite, prefix) => {
    for (const sp of suite.specs ?? [])
      for (const t of sp.tests ?? []) {
        // A test that never ran in this report (filtered out, --list) is not a result.
        if (!t.results?.length && t.status !== 'skipped') continue;
        const st = t.status === 'expected' || t.status === 'flaky' ? 'passed' : t.status === 'skipped' ? 'skipped' : 'failed';
        results.push({ title: `${prefix} ${sp.title}`.trim(), status: st, source: `${source}:${t.projectName ?? ''}`, file: `${dir}/${sp.file ?? suite.file ?? ''}`, when });
      }
    for (const s2 of suite.suites ?? []) visit(s2, `${prefix} ${s2.title ?? ''}`);
  };
  for (const s1 of j.suites ?? []) visit(s1, '');
}
function vitest(file, source) {
  if (!existsSync(file)) return;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  for (const f of j.testResults ?? []) for (const a of f.assertionResults ?? []) results.push({ title: a.fullName ?? a.title, status: a.status === 'passed' ? 'passed' : a.status === 'failed' ? 'failed' : 'skipped', source, file: relative(root, f.name ?? '').replace(/\\/g, '/') });
}
playwright(join(root, 'reports', 'e2e.json'), 'e2e', 'tests/e2e');
playwright(join(root, 'reports', 'campaign', 'playwright.json'), 'campaign', 'tests/campaign');
// T&E campaign phases (Phase 8 writes one JSON per phase: reports/campaign/pw-<phase>.json).
const campaignDir = join(root, 'reports', 'campaign');
if (existsSync(campaignDir)) for (const f of readdirSync(campaignDir).filter((n) => /^pw-.+\.json$/.test(n))) playwright(join(campaignDir, f), 'campaign', 'tests/campaign');
vitest(join(root, 'reports', 'unit.json'), 'unit');
vitest(join(root, 'reports', 'campaign', 'golden.json'), 'golden');
// "Last result": a test found in several reports (a phase report and a later re-run) counts once,
// from the newest report — a stale pw-*.json no longer outvotes the run that superseded it.
{
  const newest = new Map();
  for (const t of results) {
    const k = `${t.source}\u0000${t.file}\u0000${t.title}`;
    const prev = newest.get(k);
    if (!prev || (t.when ?? 0) >= (prev.when ?? 0)) newest.set(k, t);
  }
  results.splice(0, results.length, ...newest.values());
}
for (const t of results)
  for (const id of cited(t.title)) {
    const r = reqs.get(id);
    if (!r) continue;
    r.results ??= { passed: 0, failed: 0, skipped: 0 };
    r.results[t.status]++;
  }
// A requirement cited only in a test file's text (a header comment, a range such as REQ-GEO-01..03)
// takes the aggregate result of that file's tests: 'passing (file)' when every one passed. Rust test
// files report through reports/rust.json (build/rust-results.mjs).
const byFile = new Map();
for (const t of results) {
  if (!t.file) continue;
  const f = byFile.get(t.file) ?? { passed: 0, failed: 0, skipped: 0 };
  f[t.status]++;
  byFile.set(t.file, f);
}
const rustJson = join(root, 'reports', 'rust.json');
if (existsSync(rustJson)) for (const [f, v] of Object.entries(JSON.parse(readFileSync(rustJson, 'utf8')).files ?? {})) byFile.set(f, { passed: v.passed, failed: v.failed, skipped: v.ignored });
for (const r of reqs.values()) {
  if (r.results) continue;
  const fs = r.tests.map((f) => byFile.get(f)).filter(Boolean);
  if (fs.length) r.fileResults = fs.reduce((a, f) => ({ passed: a.passed + f.passed, failed: a.failed + f.failed, skipped: a.skipped + f.skipped }), { passed: 0, failed: 0, skipped: 0 });
}
for (const r of reqs.values())
  r.lastResult = r.results ? (r.results.failed ? 'failing' : r.results.passed ? 'passing' : 'skipped only') : r.fileResults ? (r.fileResults.failed ? 'failing (file)' : r.fileResults.passed ? 'passing (file)' : 'skipped only') : r.tests.length ? 'cited, no result in the reports' : 'no test';
const families = {};
for (const t of results)
  for (const m of t.title.matchAll(/\b(PT|SCN|AT|PRF|TE)-([A-Z]?\d+(?:\.\d+)?)/g)) {
    const k = `${m[1]}-${m[2]}`;
    families[k] ??= { passed: 0, failed: 0, skipped: 0 };
    families[k][t.status]++;
  }

const scoped = [...reqs.values()].filter((r) => want.includes(r.release));
const by = (k) => scoped.reduce((a, r) => ((a[r[k]] = (a[r[k]] ?? 0) + 1), a), {});
const summary = {
  generated: new Date().toISOString(),
  releases: want,
  total: scoped.length,
  status: by('status'),
  mustUntested: scoped.filter((r) => r.priority === 'M' && r.status !== 'tested').map((r) => `${r.id} (${r.release}, ${r.status})`),
  lastResult: by('lastResult'),
  mustWithoutPassingResult: scoped.filter((r) => r.priority === 'M' && !/^passing/.test(r.lastResult)).map((r) => `${r.id} (${r.release}, ${r.lastResult})`),
  testResults: results.length,
  families: Object.fromEntries(['PT', 'SCN', 'AT', 'PRF', 'TE'].map((f) => [f, Object.entries(families).filter(([k]) => k.startsWith(`${f}-`)).reduce((a, [, v]) => ({ ids: a.ids + 1, failing: a.failing + (v.failed ? 1 : 0) }), { ids: 0, failing: 0 })])),
};
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(join(root, 'reports', 'traceability.json'), JSON.stringify({ summary, requirements: scoped }, null, 1));
const md = [
  `# Traceability — ${want.join(', ')}`,
  '',
  `Generated ${summary.generated}. ${summary.total} requirements; ${Object.entries(summary.status).map(([k, v]) => `${v} ${k}`).join('; ')}.`,
  '',
  `Last results from ${summary.testResults} test results: ${Object.entries(summary.lastResult).map(([k, v]) => `${v} ${k}`).join('; ')}. Must requirements without a passing result: ${summary.mustWithoutPassingResult.length}.`,
  '',
  '| Requirement | P | Rel | Status | Last result | Tests | Code |',
  '|---|---|---|---|---|---|---|',
  ...scoped.map((r) => `| ${r.id} | ${r.priority} | ${r.release} | ${r.status} | ${r.lastResult}${r.results ? ` (${r.results.passed}✓ ${r.results.failed}✗)` : ''} | ${r.tests.map((t) => t.split('/').pop()).join(', ')} | ${r.code.slice(0, 3).map((t) => t.split('/').pop()).join(', ')}${r.code.length > 3 ? ` +${r.code.length - 3}` : ''} |`),
  '',
].join('\n');
writeFileSync(join(root, 'reports', 'traceability.md'), md);
console.log(`traceability: ${summary.total} requirements in ${want.join('+')}: ${JSON.stringify(summary.status)}; ${summary.mustUntested.length} Must without a citing test; last results ${JSON.stringify(summary.lastResult)}; ${summary.mustWithoutPassingResult.length} Must without a passing result`);
