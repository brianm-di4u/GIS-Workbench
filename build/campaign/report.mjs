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
phases['phase3-gaps'] = pwStats('reports/campaign/pw-phase3-gaps.json'); // c22: §5.2 checks added 2026-10-27
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
// c22: the §5.2 checks the first pass left unrun (one row per check, the Chrome record when both ran).
const gaps = [...new Map(bySpec('c22-accuracy-gaps').sort((a, b) => (a.project === 'chrome') - (b.project === 'chrome')).map((r) => [r.key, r])).values()];
const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const pf = (r) => (r.pass ? 'pass' : '**FAIL**');
const gapRow = (r) => {
  if (r.check === 'ccd') {
    const c = r.cmp ?? {};
    const g = r.oracle?.geometry ?? {};
    return `| CCD coherence vs numpy, Umbra Bingham pair, 5×5 (≥ 0.8 stable, ≤ 0.4 disturbed) | ${c.stableTiles ?? 0} stable / ${c.disturbedTiles ?? 0} disturbed 32² tiles (numpy) | ${pf(r)}: app ≤ 0.4 in ${c.disturbedOk ?? '—'}/${c.disturbedTiles ?? '—'}; numpy has no stable tile (B⊥ ${f(g.bPerpM, 0)} m, h_amb ${f(g.heightOfAmbiguityM, 2)} m) | mean γ app ${f(c.meanApp)} vs numpy ${f(c.meanNumpy)}${r.app?.error ? `; app error: ${r.app.error}` : ''} |`;
  }
  if (r.check === 'change') {
    const c = r.cmp ?? {};
    return `| chg.detect vs documented method in numpy, Maxar Derna WV3 ${r.key.endsWith("-crop") ? "co-located 2048² crop" : "pre/post as delivered"} | ${c.candidatesRef} reference candidates | ${pf(r)}: ${c.candidatesApp} app candidates, box-cover IoU ${f(c.boxCoverIoU)} | gain ${f(c.gainApp, 4)} vs ${f(c.gainRef, 4)}; threshold ${f(c.thresholdApp, 1)} vs ${f(c.thresholdRef, 1)}${r.run?.errors?.length ? `; ${r.run.errors[0]}` : ''} |`;
  }
  if (r.check === 'thermal') {
    const o = r.out ?? {};
    const ui = (b) => (o[b]?.ui?.toasts?.some((t) => /needs radiance/.test(t)) ? 'needs radiance' : o[b]?.ui?.outcome);
    const bt = (b) => (o[b]?.diffK?.n ? `${f(o[b].diffK.max)} K` : `${o[b]?.diffK?.nanApp ?? '—'} px NaN (${o[b]?.btSource})`);
    return `| msi.thermal vs numpy K1/K2, Landsat 8 B10/B11 + MTL (0.1 K) | 2 bands × 512² | ${pf(r)}: ribbon B10 ${ui('B10')}, B11 ${ui('B11')}; Radiometric Conversion ${o.B10?.radiometricEnabled ? 'enabled' : 'disabled'} on the band file | max \\|ΔBT\\| B10 ${bt('B10')}, B11 ${bt('B11')} |`;
  }
  if (r.check === 'terrain') {
    const x = r.res ?? {};
    return `| Hillshade, slope, aspect vs gdaldem (±1 DN, ±0.1°, ±0.5°; ≥ 99 % of posts) | ${x.hillshade?.n} / ${x.slope?.n} / ${x.aspect?.n} posts | ${pf(r)}: ${f(100 * x.hillshade?.within, 2)} % / ${f(100 * x.slope?.within, 2)} % / ${f(100 * x.aspect_truenorth?.within, 2)} % (aspect vs gdaldem turned to true north; raw ${f(100 * x.aspect?.within, 1)} %, TE-055) | p99 ${f(x.hillshade?.p99, 0)} DN, ${f(x.slope?.p99)}°, ${f(x.aspect_truenorth?.p99)}° (raw ${f(x.aspect?.p99)}°) |`;
  }
  if (r.check === 'toa') {
    const bands = Object.entries(r.res ?? {}).filter(([k]) => k !== 'ndvi');
    return `| TOA reflectance and NDVI vs numpy (±0.01), ${r.key.replace(/^toa-/, '')} | ${bands.length} bands × 512² | ${pf(r)}${bands.some(([, v]) => v.error) ? `: ${bands.find(([, v]) => v.error)[1].error}` : ''} | ${bands.map(([k, v]) => `${k} ${f(v.diff?.max, 5)}`).join(', ')}, NDVI ${f(r.res?.ndvi?.max, 5)} |`;
  }
  if (r.check === 'classify') {
    const m = r.runs?.ml ?? {};
    return `| Indian Pines ML classification vs truth (OA ≥ 90 %, κ to 3 decimals) | ${m.n ?? '—'} validation px, ${r.classes?.length} classes | ${pf(r)}: OA ${f(m.oa)}, κ ${f(m.kappa)} (independent ${f(m.check?.kappa)})${m.error ? `; ${m.error}` : ''} | MD OA ${f(r.runs?.md?.oa)}, SAM OA ${f(r.runs?.sam?.oa)}; sklearn SVM ${f(r.sklearn?.svm_rbf?.oa)} |`;
  }
  return `| ${r.key} | — | ${pf(r)} | — |`;
};
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

// ---- Phase F: field data a user supplied (docs/validation/TE-field-plan.md) ----
const fieldPhases = Object.fromEntries(['ingest', 'zip', 'accuracy', 'field', 'sweep', 'perf'].map((p) => [p, pwStats(`reports/campaign/pw-field-${p}.json`)]));
const isField = (r) => /^field-/.test(String(r.item ?? '')) || /field-/.test(JSON.stringify(r.data ?? ''));
const fieldIngest = records.filter((r) => r.spec === 'c01-ingest' && isField(r));
const fieldAcc = records.filter((r) => r.spec === 'c20-accuracy' && /^\w+-field-/.test(String(r.key ?? '')));
const fieldWf = [...new Map(bySpec('c43-field-workflows').map((r) => [r.key, r])).values()];
const fieldPerf = bySpec('c44-field-perf');
const fieldFindings = () => findings.filter((r) => r[3] === 'F');
const fph = (k, label) => {
  const s = fieldPhases[k];
  return s ? `| ${label} | ${s.passed} | ${s.failed} | ${s.skipped} | ${s.flaky} |` : `| ${label} | — | — | — | — |`;
};

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
  ph('phase3-gaps', '3 Accuracy, §5.2 checks added 2026-10-27 (c22, Chrome + Edge)'),
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
  ...gaps.map(gapRow),
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
  '## 2F. Field-data campaign (phase F)',
  '',
  'Imagery a first user supplied (tier U, never redistributed: OD-09). Plan: [TE-field-plan.md](TE-field-plan.md).',
  '',
  '| Phase F run | Passed | Failed | Skipped | Flaky |',
  '|---|---|---|---|---|',
  fph('ingest', 'F1 Ingest, every field file, first pass on the fixed build (c01, Chrome + Edge; the 2 failures are TE-067)'),
  fph('zip', 'F1 Ingest re-check, delivery ZIPs after TE-067 (c01, Chrome + Edge)'),
  fph('accuracy', 'F3 Corners vs GDAL (c20, Chrome)'),
  fph('sweep', 'F2 Functional sweep on field data (c02–c17, TE_ITEMS=field, Chrome)'),
  fph('field', 'F4 Workflows W1–W5 (c43, Chrome)'),
  fph('perf', 'F5 Performance (c44, Chrome + Edge)'),
  '',
  'The final regression run (phase 1 above) ingested every field file again on the final build.',
  '',
  `Ingest records (final run): ${fieldIngest.length} (${fieldIngest.filter((r) => r.rendered).length} displayed, ${fieldIngest.filter((r) => !r.rendered && (r.errors?.length || r.toasts?.some((t) => /^toast-(warn|error)/.test(t)))).length} refused or reported by name). Sweep records with field data: ${records.filter((r) => /^c(0[2-9]|1[0-7])-/.test(r.spec) && isField(r)).length}. Corner checks vs GDAL: ${fieldAcc.length} (Chrome + Edge), ${fieldAcc.filter((r) => !r.error && r.maxErrM <= r.tolM).length} within tolerance, worst ${Math.max(0, ...fieldAcc.map((r) => r.maxErrM).filter(Number.isFinite)).toFixed(3)} m.`,
  '',
  '| Workflow | Result |',
  '|---|---|',
  ...fieldWf.map((r) => `| ${r.key} | ${r.key.startsWith('w1') ? `whole scene ${r.whole?.n} candidates at 1/${r.whole?.method?.step} in ${Math.round((r.whole?.ms ?? 0) / 1000)} s; AOI ${r.aoi?.n} at full resolution` : r.key.startsWith('w2') ? `${r.n} candidates, ${r.area} px, resampled across grids` : r.key.startsWith('w3') ? `${(r.layers ?? []).filter((l) => !l.error).length}/12 tiles displayed in ${Math.round((r.msDisplay ?? 0) / 1000)} s; mosaic extent error ${Number(r.extentErrorPx).toFixed(3)} px` : r.key.startsWith('w4') ? `opened from the ZIP in ${Math.round((r.ms ?? 0) / 1000)} s; bands ${JSON.stringify(r.layers?.[0]?.bands)}; sun ${r.layers?.[0]?.sun?.azimuth?.toFixed(1)}°/${r.layers?.[0]?.sun?.elevation?.toFixed(1)}°` : r.key.startsWith('w5') ? `GCP error ${Number(r.geoErrPx).toFixed(2)} px; σ⁰ dB max |Δ| ${Number(r.dbMax).toExponential(1)} over ${r.dbCompared} px` : ''} |`),
  '',
  '| Field file (c44) | Browser | Size | First tile ms | Settled ms | Statistics ms after display |',
  '|---|---|---|---|---|---|',
  ...fieldPerf.map((r) => `| ${r.key.replace(/^perf-/, '')} | ${r.project} | ${fmtBytes(r.bytes ?? 0)} | ${r.firstTileMs ?? '—'} | ${r.settledMs ?? 'not settled'} | ${r.statsMsAfterDisplay ?? '—'} |`),
  '',
  `Phase F findings: ${fieldFindings().map((r) => `${r[0]} (${r[1]}, ${r[2]})`).join(', ') || 'none'}.`,
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
