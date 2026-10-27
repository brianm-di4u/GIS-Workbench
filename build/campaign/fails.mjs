import { readFileSync, existsSync } from 'node:fs';
for (const ph of process.argv.slice(2)) {
  const f = `reports/campaign/pw-${ph}.json`;
  if (!existsSync(f)) continue;
  const j = JSON.parse(readFileSync(f, 'utf8'));
  const out = [];
  let pass = 0, skip = 0;
  const v = (s) => { for (const sp of s.specs ?? []) for (const t of sp.tests ?? []) { if (t.status === 'expected' || t.status === 'flaky') pass++; else if (t.status === 'skipped') skip++; else { const e = (t.results?.[0]?.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim()).slice(0, 3).join(' ¦ '); out.push(`[${t.projectName}] ${sp.title.slice(0, 110)} :: ${e.slice(0, 230)}`); } } for (const x of s.suites ?? []) v(x); };
  for (const s of j.suites ?? []) v(s);
  console.log(`=== ${ph}: ${pass} passed, ${out.length} failed, ${skip} skipped`);
  console.log(out.join('\n'));
}
