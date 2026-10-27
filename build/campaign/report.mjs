// T&E campaign report: aggregate the run artifacts into docs/validation/TE-report.md (SDP §7.3).
//   node build/campaign/report.mjs [--notes path/to/notes.md]
// Inputs: dist/build-report.json, reports/campaign/pw-*.json (Playwright, per phase),
// reports/campaign/results/*.json (per-test records), reports/campaign/golden.json,
// reports/campaign/matrix.json, reports/traceability.json, docs/validation/TE-findings.md,
// docs/validation/TE-improvements.md, build/campaign/corpus.json.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { REPO, loadManifest, present, fmtBytes } from './corpus-lib.mjs';

const J = (p) => (existsSync(join(REPO, p)) ? JSON.parse(readFileSync(join(REPO, p), 'utf8')) : null);
const notesArg = process.argv.find((a) => a.startsWith('--notes='))?.slice(8);

// ---- Playwright phase reports ----
function pwStats(file) {
  const j = J(file);
  if (!j) return null;
  const out = { passed: 0, failed: 0, skipped: 0, flaky: 0, failures: [] };
  const visit = (s) => {
    for (const sp of s.specs ?? [])
      for (const t of sp.tests ?? []) {
        if (t.status === 'expected') out.passed++;
        else if (t.status === 'flaky') out.flaky++;
        else if (t.status === 'skipped') out.skipped++;
        else {
          out.failed++;
          out.failures.push(`[${t.projectName}] ${sp.title} — ${(t.results?.[0]?.error?.message ?? '').split('\n').find((l) => l.trim()) ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '').slice(0, 260));
        }
      }
    for (const x of s.suites ?? []) visit(x);
  };
  for (const s of j.suites ?? []) visit(s);
  return out;
}
const phases = Object.fromEntries(['phase1', 'phase2', 'phase3', 'phase4', 'phase5', 'phase6'].map((p) => [p, pwStats(`reports/campaign/pw-${p}.json`)]));
phases['phase8-e2e'] = pwStats('reports/e2e.json'); // the full E2E suite on the final build

// ---- per-test records ----
const recDir = join(REPO, 'reports/campaign/results');
const records = existsSync(recDir) ? readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(recDir, f), 'utf8'))) : [];
const bySpec = (s) => records.filter((r) => r.spec === s);

// Phase 1 by area.
const corpus = loadManifest();
const areaOf = new Map(corpus.items.map((i) => [i.id, i.area]));
const p1 = {};
for (const r of bySpec('c01-ingest')) {
  const a = areaOf.get(r.item) ?? 'other';
  p1[a] ??= { files: 0, opened: 0, refused: 0, issues: 0 };
  p1[a].files++;
  const o = r.others ?? {};
  // glTF models open in the 3-D view ("placed by" in the import log), not as layers.
  const opened = (r.layers?.filter((l) => !l.error).length ?? 0) + (o.vlayers ?? 0) + (o.clouds ?? 0) + (o.clips ?? 0) > 0 || (r.warnings ?? []).some((w) => /placed by/.test(w));
  if (opened && !r.errors?.length) p1[a].opened++;
  else if (r.errors?.length) p1[a].refused++;
  if (r.logs?.length || r.requests?.length || r.csp?.length || r.diffs?.length) p1[a].issues++;
}

// Phase 2 coverage.
const matrix = J('reports/campaign/matrix.json');
const sweep = records.filter((r) => /^c(0[2-9]|1[0-7])-/.test(r.spec));
const outcomes = {};
for (const r of sweep) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
const exercised = new Set(sweep.filter((r) => r.outcome === 'done' || r.outcome === 'dialog').map((r) => r.id));

// Phase 3 accuracy.
const acc = bySpec('c20-accuracy');
const accByKind = {};
for (const r of acc) {
  // An ortho product with RPCs rightly uses its map model; c20 skips the RPC comparison for it.
  if (r.kind === 'rpc' && !/RPC/.test(r.model ?? '')) continue;
  accByKind[r.kind] ??= { n: 0, pass: 0, worst: 0, unit: r.unit ?? 'm' };
  accByKind[r.kind].n++;
  if (r.maxErrM <= r.tolM) accByKind[r.kind].pass++;
  if (Number.isFinite(r.maxErrM)) accByKind[r.kind].worst = Math.max(accByKind[r.kind].worst, r.maxErrM);
}
const vs = bySpec('c21-viewshed')[0];
const golden = J('reports/campaign/golden.json');
// One row per workflow check (the Chrome record when both browsers ran it).
const wf = [...new Map(bySpec('c30-workflows').sort((a, b) => (a.project === 'chrome') - (b.project === 'chrome')).map((r) => [r.key, r])).values()];
const prf = bySpec('c19-nonfunctional').filter((r) => String(r.key).startsWith('prf03-'));
const modes = bySpec('c19-nonfunctional').filter((r) => r.mode);

// Findings and improvements registers.
function table(md, idRe) {
  return readFileSync(join(REPO, md), 'utf8').split('\n').filter((l) => idRe.test(l)).map((l) => l.split(' | ').map((c) => c.replace(/^\| /, '').trim()));
}
const findings = table('docs/validation/TE-findings.md', /^\| TE-\d+ \|/);
const sev = {};
for (const f of findings) {
  const k = `${f[1]} / ${f[2].replace(/\s*\(.*\)/, '')}`;
  sev[k] = (sev[k] ?? 0) + 1;
}
const imps = table('docs/validation/TE-improvements.md', /^\| IMP-\d+ \|/);
const trace = J('reports/traceability.json');
const build = J('dist/build-report.json');
const distHash = existsSync(join(REPO, 'dist/gis-workbench.html')) ? createHash('sha256').update(readFileSync(join(REPO, 'dist/gis-workbench.html'))).digest('hex') : '?';
const distSize = existsSync(join(REPO, 'dist/gis-workbench.html')) ? statSync(join(REPO, 'dist/gis-workbench.html')).size : 0;
const onDiskItems = corpus.items.filter(present).length;
const corpusBytes = corpus.items.filter((i) => i.origin !== 'research-samples').reduce((s, i) => s + i.files.reduce((t, f) => t + (f.bytes ?? 0), 0), 0);

const ph = (k, label) => {
  const s = phases[k];
  return s ? `| ${label} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.flaky} |` : `| ${label} | — | — | — | — |`;
};
const lines = [
  '# GIS Workbench — T&E campaign report',
  '',
  `Generated ${new Date().toISOString()} by \`build/campaign/report.mjs\`. Plan: [TE-master-plan.md](TE-master-plan.md). Registers: [findings](TE-findings.md), [improvements](TE-improvements.md), [owner decisions](TE-owner-decisions.md), [data catalogue](TE-data-catalogue.md).`,
  '',
  '## 1. Build under test',
  '',
  `- \`dist/gis-workbench.html\`: ${fmtBytes(distSize)}, SHA-256 \`${distHash.slice(0, 16)}…\`, build ${build?.build?.id ?? build?.build ?? '?'}.`,
  `- Corpus: ${corpus.items.length} items (${onDiskItems} on disk), ${fmtBytes(corpusBytes)} of public downloads plus the 29 Research samples; every file pinned by SHA-256.`,
  '- Machine: Windows 11, Intel Arc integrated GPU, Chrome and Edge stable (OD-01: not the reference laptop).',
  '',
  '## 2. Results by phase',
  '',
  '| Phase | Passed | Failed | Skipped | Flaky |',
  '|---|---|---|---|---|',
  ph('phase1', '1 Ingest conformance (c01, Chrome + Edge)'),
  ph('phase2', '2 Functional sweep (c02–c17, Chrome + Edge)'),
  ph('phase3', '3 Accuracy (c20, c21, Chrome + Edge)'),
  ph('phase4', '4 Workflows and products on real data (c30, c31, Chrome + Edge)'),
  ph('phase5', '5 Live services (c18, Chrome + Edge)'),
  ph('phase6', '6 Non-functional (c19, Chrome + Edge)'),
  ph('phase8-e2e', '8 Regression: SDP E2E suite (Chrome + Edge)'),
  '',
  ...(golden ? [`Node accuracy suites (golden): ${golden.numPassedTests}/${golden.numTotalTests} passed.`, ''] : []),
  '### Phase 1 — ingest by area (Chrome and Edge records)',
  '',
  '| Area | Files | Opened | Refused by name | With issues |',
  '|---|---|---|---|---|',
  ...Object.entries(p1).sort().map(([a, v]) => `| ${a} | ${v.files} | ${v.opened} | ${v.refused} | ${v.issues} |`),
  '',
  '### Phase 2 — command coverage',
  '',
  `${matrix?.summary?.commands ?? '?'} catalogued commands, ${matrix?.summary?.implemented ?? '?'} implemented. Sweep outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(', ') || 'not run'}. Commands exercised without error on real data: **${exercised.size}**.`,
  '',
  '### Phase 3 — accuracy against independent oracles',
  '',
  '| Check | Cases | Within tolerance | Worst difference |',
  '|---|---|---|---|',
  ...Object.entries(accByKind).map(([k, v]) => `| Geolocation, ${k} model vs ${k === 'rpc' ? 'GDAL RPC transformer' : k === 'sicd' ? 'sarpy' : 'GDAL corners'} | ${v.n} | ${v.pass} | ${v.worst.toFixed(4)} ${v.unit} |`),
  ...(vs ? [`| Viewshed vs gdal_viewshed -cc 0.87 (S-15, AT-18.2 ≥ 99 %) | ${vs.cc?.n} posts | ${(vs.cc?.frac * 100).toFixed(2)} % agree | — |`] : []),
  ...wf.map((r) => (r.key.startsWith('ndvi') ? `| NDVI vs DN reference (${r.key}) | ${r.n} px | mean |Δ| ${r.meanAbs?.toFixed(5)} | ${r.max?.toFixed(5)} |` : r.key.startsWith('klv') ? `| KLV ST 0601 vs klvdata (${r.key}) | ${r.compared} packets | ${r.bad?.length ? `${r.bad.length} differ` : 'all equal'} | — |` : r.key === 'smrf-3dep' ? `| SMRF vs USGS 3DEP classes; DTM RMSEz at USGS ground | ${r.n} points | ${(r.agree * 100).toFixed(1)} % agree | RMSEz ${r.rmse?.toFixed(3)} m |` : '')).filter(Boolean),
  '',
  '### Phase 6 — performance and run modes (this machine)',
  '',
  '| PRF-03 first tile | Size | ms |',
  '|---|---|---|',
  ...prf.map((r) => `| ${r.key.replace(/^prf03-/, '')} (${r.project}) | ${fmtBytes(r.bytes ?? 0)} | ${r.firstTileMs ?? 'timeout'} |`),
  '',
  `Run modes (file, http, cross-origin iframe, srcdoc): ${modes.length} records, ${modes.filter((r) => !r.errors?.length && !r.logs?.length).length} clean.`,
  '',
  '## 3. Findings',
  '',
  `${findings.length} findings in the register:`,
  '',
  '| Severity / status | Count |',
  '|---|---|',
  ...Object.entries(sev).sort().map(([k, v]) => `| ${k} | ${v} |`),
  '',
  '| TE | Sev | Status | Summary |',
  '|---|---|---|---|',
  ...findings.map((f) => `| ${f[0]} | ${f[1]} | ${f[2]} | ${f[6]} |`),
  '',
  '## 4. Improvements',
  '',
  '| IMP | Improvement | Before → after | Status |',
  '|---|---|---|---|',
  ...imps.map((i) => `| ${i[0]} | ${i[3]} | ${i[6]} | ${i[7]} |`),
  '',
  '## 5. Traceability',
  '',
  trace ? `${trace.summary.total} requirements (${trace.summary.releases.join(', ')}): last results ${Object.entries(trace.summary.lastResult ?? {}).map(([k, v]) => `${v} ${k}`).join(', ')}. Must requirements without a passing result: ${trace.summary.mustWithoutPassingResult?.length ?? '?'}.` : 'Not generated.',
  '',
  '## 6. Failures still open at report time',
  '',
  ...(Object.values(phases).some((s) => s?.failures?.length) ? Object.entries(phases).flatMap(([k, s]) => (s?.failures?.length ? [`**${k}**`, '', ...s.failures.slice(0, 40).map((f) => `- ${f}`), ''] : [])) : ['None: every phase passed on the final build.']),
  '',
  ...(notesArg && existsSync(notesArg) ? [readFileSync(notesArg, 'utf8')] : []),
];
writeFileSync(join(REPO, 'docs/validation/TE-report.md'), `${lines.join('\n')}\n`);
console.log(`wrote docs/validation/TE-report.md (${findings.length} findings, ${imps.length} improvements, ${records.length} records)`);
