// SCN-81 by hand (REG-151): a real scheduled run, before each release. Registers a uniquely named
// one-shot task from the example in docs/runner.md, waits for it to run, checks the run's files, its
// provenance and its log, and deletes the task in a finally block. The automated tests never
// register a task (sidecar/gwb-sidecar/tests/gwb_run.rs); this is the admin's check, and its report
// goes in the release evidence.
//
//   npm run test:schedule-live -- [--exe PATH] [--app-dir DIR] [--out DIR]
//
// Windows: Task Scheduler runs gwb-sidecar.exe run (no window), as the signed-in user.
// Linux: a transient systemd user timer runs gwb-run.
// --exe: gwb-sidecar.exe (Windows) or gwb-run (Linux); default: beside GWB_SIDECAR_EXE, as the
//        sidecar e2e suites find it.
// --app-dir: the app folder; default: a copy of dist/gis-workbench.html with its SHA256SUMS line.
//            Give the installed sidecar's `app` folder to check an installed build.
// The report is written to reports/schedule-live-<platform>.json; exit code 0 when it passed.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { EXE as SIDECAR } from '../e2e/sidecar/harness.js';

const LINUX = process.platform === 'linux';
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const exe = resolve(opt('exe', LINUX ? join(dirname(SIDECAR), 'gwb-run') : SIDECAR));
const work = resolve(opt('out', join('test-results', `schedule-live-${randomBytes(3).toString('hex')}`)));
const input = resolve('fixtures', 'fx25', 'aviation', 'nodata-utm15n-f32.tif');
const out = join(work, 'nightly');
const name = `GIS Workbench test ${randomBytes(4).toString('hex')}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The fenced block after `<!-- example: NAME -->` in docs/runner.md (as gwb_run.rs reads it). */
function example(id) {
  const doc = readFileSync('docs/runner.md', 'utf8').replace(/\r\n/g, '\n');
  const at = doc.indexOf(`<!-- example: ${id} -->`);
  if (at < 0) throw new Error(`docs/runner.md has no example ${id}`);
  const body = doc.slice(doc.indexOf('```', at));
  const from = body.indexOf('\n') + 1;
  return body.slice(from, body.indexOf('```', from));
}

function appDir() {
  if (opt('app-dir')) return resolve(opt('app-dir'));
  const dir = join(work, 'app');
  mkdirSync(dir, { recursive: true });
  const html = resolve('dist', 'gis-workbench.html');
  copyFileSync(html, join(dir, 'gis-workbench.html'));
  writeFileSync(join(dir, 'SHA256SUMS'), `${sha(readFileSync(html))}  gis-workbench.html\n`);
  return dir;
}

function sh(cmd, args, input) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, windowsHide: true });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

const ps = (script) => sh('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], script);

async function until(test, ms) {
  const t0 = Date.now();
  while (!test() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 1000));
  return test();
}

const report = { scenario: 'SCN-81', platform: process.platform, date: new Date().toISOString(), exe, exeSha256: existsSync(exe) ? sha(readFileSync(exe)) : null, task: name, checks: {}, ok: false };
const logText = () => (existsSync(join(out, 'gwb-run.log')) ? readFileSync(join(out, 'gwb-run.log'), 'utf8') : '');
let registered = false;
try {
  if (!existsSync(exe)) throw new Error(`no ${basename(exe)} at ${exe} (give --exe)`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const app = appDir();
  report.appSha256 = sha(readFileSync(join(app, 'gis-workbench.html')));
  if (LINUX) {
    const service = example('linux-service')
      .replace('/usr/bin/gwb-run', exe)
      .replace('%h/gis/in/site.tif', input)
      .replace('%h/gis/nightly', `${out} --app-dir ${app}`);
    const exec = service.split('\n').find((l) => l.startsWith('ExecStart=')).slice('ExecStart='.length).split(/\s+/).filter(Boolean);
    const unit = name.replace(/ /g, '-').toLowerCase();
    const pass = ['PATH', 'LD_LIBRARY_PATH'].filter((k) => process.env[k]).map((k) => `--setenv=${k}`);
    const r = sh('systemd-run', ['--user', '--quiet', '--collect', '--on-active=20', `--unit=${unit}`, ...pass, '--', ...exec]);
    if (r.code !== 0) throw new Error(`systemd-run: ${r.out}`);
    registered = unit;
    report.trigger = 'transient systemd user timer, 20 s';
  } else {
    // The documented task, with the paths changed and a one-shot trigger in place of the nightly one.
    const script = example('windows-task')
      .replace('C:\\Tools\\GIS Workbench Sidecar\\gwb-sidecar.exe', exe)
      .replace('C:\\GIS\\in\\site.tif', input)
      .replace('--out "C:\\GIS\\nightly"', `--out "${out}" --app-dir "${app}"`)
      .replace('New-ScheduledTaskTrigger -Daily -At 2am', 'New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(20)')
      .replace("-TaskName 'GIS Workbench nightly'", `-TaskName '${name}'`);
    if (!script.includes(`-TaskName '${name}'`) || !script.includes('-Once')) throw new Error('the example in docs/runner.md has changed; update this script');
    const r = ps(`$ErrorActionPreference = 'Stop'\n${script}\n`);
    if (r.code !== 0) throw new Error(`Register-ScheduledTask: ${r.out}`);
    registered = name;
    report.trigger = 'Task Scheduler, once, 20 s';
  }
  console.log(`registered "${registered}"; waiting for it to run…`);
  const ran = await until(() => /exit \d+/.test(logText()), 300_000);
  report.checks.ran = ran;
  report.log = logText();
  if (!LINUX) {
    // Task Scheduler's own view: the last result is gwb-run's exit code.
    await until(() => ps(`(Get-ScheduledTaskInfo -TaskName '${name}').LastTaskResult`).out === '0', 30_000);
    report.checks.lastTaskResult = Number(ps(`(Get-ScheduledTaskInfo -TaskName '${name}').LastTaskResult`).out);
  }
  report.checks.exit0 = /exit 0\s*$/.test(report.log);
  const files = existsSync(out) ? readdirSync(out) : [];
  const outputs = files.filter((f) => !/^gwb-run\.(log|json)$/.test(f) && !f.endsWith('.gwb-provenance.json'));
  report.outputs = outputs.map((f) => ({ name: f, sha256: sha(readFileSync(join(out, f))) }));
  report.checks.outputs = outputs.length > 0;
  report.checks.provenance = outputs.length > 0 && outputs.every((f) => {
    const p = join(out, `${f}.gwb-provenance.json`);
    if (!existsSync(p)) return false;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j.profile === 'recipe folder-to-cog' && j.inputs?.[0] === `s1=${basename(input)}` && j.steps?.[0]?.args?.[1] === 'done';
  });
  report.ok = Object.values(report.checks).every((v) => v === true || v === 0);
} catch (e) {
  report.error = e.message;
} finally {
  if (registered) {
    const r = LINUX ? sh('systemctl', ['--user', 'stop', `${registered}.timer`, `${registered}.service`]) : ps(`Unregister-ScheduledTask -TaskName '${registered}' -Confirm:$false`);
    const gone = LINUX ? sh('systemctl', ['--user', 'list-timers', '--all']).out.includes(registered) === false : ps(`Get-ScheduledTask -TaskName '${registered}' -ErrorAction SilentlyContinue`).out === '';
    report.checks.deleted = gone;
    if (!gone) {
      report.ok = false;
      console.error(`could not delete "${registered}": ${r.out}`);
    }
  }
}
mkdirSync('reports', { recursive: true });
const file = join('reports', `schedule-live-${process.platform}.json`);
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ok: report.ok, checks: report.checks, error: report.error, outputs: report.outputs }, null, 1));
console.log(`report: ${file}`);
process.exitCode = report.ok ? 0 : 1;
