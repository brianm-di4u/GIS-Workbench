// The post-merge retry classifier: `infra` only when a leg failed before it ran any of our code,
// `real` for everything else, and `real` whenever it can't tell.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFailure, classifyRun, isSetupStep } from '../../build/ci/classify-failure.mjs';

const step = (name, conclusion = 'success', status = 'completed') => ({ name, conclusion, status });
const SETUP = [step('Set up job'), step('Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1')];
const job = (name, conclusion, steps) => ({ name, status: 'completed', conclusion, steps });
const green = (name) => job(name, 'success', [...SETUP, step('Run node .pipeline/verify.mjs full')]);
const run = (...jobs) => ({ jobs });

describe('classifyFailure: infrastructure', () => {
  it('calls a leg that never started infra, whether it is missing or has no steps', () => {
    expect(classifyFailure(run(green('app'))).result).toBe('infra'); // sidecar missing
    expect(classifyFailure(run(green('app'), job('sidecar', 'cancelled', []))).result).toBe('infra');
    expect(classifyFailure(run(job('app', null, []), job('sidecar', 'failure', []))).result).toBe('infra'); // both, as in #130
  });

  it('calls a leg that failed in the app-setup action infra (the binaryen 504 in #103)', () => {
    const app = job('app', 'failure', [...SETUP, step('Run ./.github/actions/app-setup', 'failure'), step('Run npx playwright install --with-deps chromium', 'skipped'), step('Run node .pipeline/verify.mjs full', 'skipped')]);
    expect(classifyFailure(run(app, green('sidecar'))).result).toBe('infra');
  });

  it.each([
    ['checkout', 'Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1'],
    ['setup-node', 'Run actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'],
    ['sidecar-setup', 'Run ./.github/actions/sidecar-setup'],
    ['the job set-up itself', 'Set up job'],
    ['the browser download', 'Run npx playwright install --with-deps chromium'],
  ])('calls a failure in %s infra', (_what, name) => {
    const sidecar = job('sidecar', 'failure', [step(name, 'failure')]);
    expect(classifyFailure(run(green('app'), sidecar)).result).toBe('infra');
  });

  it('calls a cancelled leg infra only when nothing newer is running on main', () => {
    const cancelled = job('app', 'cancelled', [...SETUP, step('Run ./.github/actions/app-setup', 'cancelled')]);
    expect(classifyFailure(run(cancelled, green('sidecar'))).result).toBe('infra');
    expect(classifyFailure(run(cancelled, green('sidecar')), { newerRunOnMain: true }).result).toBe('real');
  });

  it('calls a leg that was cut off in setup infra', () => {
    const cutOff = job('app', 'failure', [step('Set up job'), step('Run ./.github/actions/app-setup', null, 'in_progress')]);
    expect(classifyFailure(run(cutOff, green('sidecar'))).result).toBe('infra');
  });
});

describe('classifyFailure: real', () => {
  it('never retries a failed test step', () => {
    const app = job('app', 'failure', [...SETUP, step('Run ./.github/actions/app-setup'), step('Run node .pipeline/verify.mjs full', 'failure')]);
    expect(classifyFailure(run(app, green('sidecar'))).result).toBe('real');
  });

  it('is real when one leg is infra and the other is a real failure', () => {
    const app = job('app', 'failure', [...SETUP, step('Run node .pipeline/verify.mjs full', 'failure')]);
    const sidecar = job('sidecar', 'failure', [step('Run ./.github/actions/sidecar-setup', 'failure')]);
    expect(classifyFailure(run(app, sidecar)).result).toBe('real');
  });

  it('is real when a setup step failed but a test step failed too', () => {
    const app = job('app', 'failure', [step('Run ./.github/actions/app-setup', 'failure'), step('Run node .pipeline/verify.mjs full', 'failure')]);
    expect(classifyFailure(run(app, green('sidecar'))).result).toBe('real');
  });

  it('is real for a leg cancelled inside a test step, which is how a job timeout looks', () => {
    const app = job('app', 'cancelled', [...SETUP, step('Run node .pipeline/verify.mjs full', 'cancelled')]);
    expect(classifyFailure(run(app, green('sidecar'))).result).toBe('real');
  });

  it('is real for a failure with no failed step to explain it, and a cancel with every step clean', () => {
    expect(classifyFailure(run(job('app', 'failure', SETUP), green('sidecar'))).result).toBe('real');
    expect(classifyFailure(run(job('app', 'cancelled', SETUP), green('sidecar'))).result).toBe('real');
  });

  it('is real when it can read nothing, or nothing failed', () => {
    for (const bad of [null, undefined, {}, { jobs: 'x' }, run(), run(green('app'), green('sidecar'))]) expect(classifyFailure(bad).result).toBe('real');
  });

  it('does not treat an unknown step name as setup', () => {
    expect(isSetupStep('Run npm run build')).toBe(false);
    expect(isSetupStep('Run node .pipeline/verify.mjs full')).toBe(false);
    expect(isSetupStep(undefined)).toBe(false);
    expect(isSetupStep('Run actions/checkout@abc')).toBe(true);
  });
});

describe('classifyRun', () => {
  const cancelled = run(job('app', 'cancelled', [...SETUP, step('Run ./.github/actions/app-setup', 'cancelled')]), green('sidecar'));
  const fakeGh = (tip, jobs = cancelled) => (args) => (args[1].includes('/actions/runs/') ? JSON.stringify(jobs) : `${tip}\n`);

  it('asks for the run and for main, and treats a moved main as a newer run', () => {
    const asked = [];
    const gh = (args) => (asked.push(args), fakeGh('aaa')(args));
    expect(classifyRun({ repo: 'o/r', runId: '7', headSha: 'aaa' }, gh).result).toBe('infra');
    expect(asked[0][1]).toBe('repos/o/r/actions/runs/7/jobs?per_page=100');
    expect(asked[1][1]).toBe('repos/o/r/git/ref/heads/main');
    expect(classifyRun({ repo: 'o/r', runId: '7', headSha: 'aaa' }, fakeGh('bbb')).result).toBe('real');
  });

  it("throws when GitHub can't be read, which the command line turns into real", () => {
    expect(() => classifyRun({ repo: 'o/r', runId: '7', headSha: 'a' }, () => 'not json')).toThrow();
  });
});

describe('the command line', () => {
  const cli = (body, ...flags) => {
    const dir = mkdtempSync(join(tmpdir(), 'gwb-classify-'));
    try {
      const file = join(dir, 'jobs.json');
      writeFileSync(file, body);
      return execFileSync('node', ['build/ci/classify-failure.mjs', file, ...flags], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('prints infra or real, and real for a file it cannot parse', () => {
    expect(cli(JSON.stringify(run(green('app'))))).toBe('infra');
    expect(cli(JSON.stringify(run(job('app', 'cancelled', []), job('sidecar', 'cancelled', []))), '--newer-run-on-main')).toBe('infra'); // never started, so a newer run doesn't matter
    expect(cli('not json')).toBe('real');
    expect(execFileSync(process.execPath, ['build/ci/classify-failure.mjs', '--run', '1', '--head-sha', 'x'], { encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: '', PATH: '' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()).toBe('real'); // no gh, so real
  });
});
