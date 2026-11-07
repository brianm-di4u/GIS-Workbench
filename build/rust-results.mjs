// Rust test results per test file for traceability (TE campaign, Phase 8): runs `cargo test` for each
// workspace crate and writes reports/rust.json as {files: {"crates/<crate>/tests/x.rs": {passed,
// failed, ignored}}}, so requirements cited in Rust test files get a last result.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const crates = join(root, 'crates');
const members = [];
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    if (!f.isDirectory() || f.name === 'target' || f.name === 'vendor' || f.name.startsWith('.')) continue;
    const p = join(d, f.name);
    const toml = join(p, 'Cargo.toml');
    if (existsSync(toml)) {
      const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(readFileSync(toml, 'utf8'))?.[1];
      if (name && (existsSync(join(p, 'tests')) || existsSync(join(p, 'src')))) members.push({ name, dir: p });
    }
    if (f.name === 'bundles') walk(p);
  }
};
walk(crates);
const files = {};
let failed = 0;
for (const m of members) {
  let out;
  try {
    out = execSync(`cargo test --manifest-path "${join(crates, 'Cargo.toml')}" -p ${m.name} 2>&1`, { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    out = String(e.stdout ?? '');
    failed++;
  }
  // "Running tests\fuzz.rs (…)" (stderr) precedes its "test result" (stdout): merged by 2>&1.
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    const r = /Running (?:unittests )?(\S+\.rs)/.exec(line);
    if (r) current = `${m.dir.slice(root.length + 1).replace(/\\/g, '/')}/${r[1].replace(/\\/g, '/')}`;
    const t = /test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(line);
    if (t && current) {
      const f = (files[current] ??= { passed: 0, failed: 0, ignored: 0 });
      f.passed += +t[1];
      f.failed += +t[2];
      f.ignored += +t[3];
    }
  }
}
mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(join(root, 'reports', 'rust.json'), JSON.stringify({ measured: new Date().toISOString(), crates: members.length, files }, null, 1));
console.log(`rust results: ${Object.keys(files).length} test files from ${members.length} crates${failed ? `; ${failed} crate run(s) failed` : ''}`);
