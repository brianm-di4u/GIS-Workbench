// Tells an infrastructure failure from a real one, for a post-merge run that went red.
//
//   node .pipeline/lib/classify-failure.mjs <jobs.json>
//   node .pipeline/lib/classify-failure.mjs --run <id>      (reads GitHub with `gh`)
//
// `jobs.json` is the body of `gh api repos/<repo>/actions/runs/<id>/jobs`. The `--run` form fetches
// that itself and needs GITHUB_REPOSITORY and a token for `gh` with `actions: read`. The answer,
// `infra` or `real`, goes to stdout and the reason to stderr. Anything this can't read, or isn't
// sure about, is `real`: a wrong `real` costs a person one click, and a wrong `infra` would hide a bug.
//
// `infra` needs every failing leg to have failed before it ran any of our code:
//   - a leg that never started (missing from the list, or no steps at all), or
//   - a leg whose only failed steps are setup steps (checkout, node, the setup actions, the browser
//     download).
// A failed build, lint or test step is `real`, whatever else went wrong, and so is any cancelled leg
// that did start, since a cancel is also how a job timeout looks. Nothing here ever retries a test
// failure. A setup action is one step to the jobs API, so a deterministic failure inside it (a bad
// lockfile in `npm ci`, a checksum mismatch) reads as `infra` too: the caller retries once, and the
// repeat is what reports it (see docs/decisions/0011).
//
// This runs on main in jobs that hold tokens, so it lives under `.pipeline/`, which needs the
// admin's approval to change.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The legs whose failure turns `verify` red. `verify` itself only reports on them.
export const LEGS = ['app', 'sidecar'];

// A step name from the jobs API: `Run <uses or command>`, or the step's own `name`. A composite action
// is one step, so the rust-cache, toolchain and binaryen installs sit inside the two setup actions.
// Only steps that exist in post-merge.yml are listed. A name that isn't here is real.
const SETUP_STEPS = [
  /^Set up job$/,
  /^Complete job$/,
  /^Post Run /,
  /^Run actions\/checkout@/,
  /^Run actions\/setup-node@/,
  /^Run \.\/\.github\/actions\/(app|sidecar)-setup$/,
  /^Run npx playwright install\b/,
];

export const isSetupStep = (name) => SETUP_STEPS.some((pattern) => pattern.test(String(name ?? '').trim()));

// A step that did not finish cleanly: it failed, was cancelled or timed out, or was cut off.
const unclean = (step) => step.status !== 'completed' || ['failure', 'cancelled', 'timed_out'].includes(step.conclusion);

function judgeLeg(name, job) {
  if (!job) return { verdict: 'infra', why: `${name}: never started (no such job)` };
  const steps = Array.isArray(job.steps) ? job.steps : [];
  if (job.conclusion === 'success' || job.conclusion === 'skipped') return { verdict: 'fine', why: `${name}: ${job.conclusion}` };
  if (steps.length === 0) return { verdict: 'infra', why: `${name}: never started (${job.conclusion ?? job.status}, no steps)` };

  const culprits = steps.filter(unclean);
  const real = culprits.filter((step) => !isSetupStep(step.name));
  if (real.length > 0) return { verdict: 'real', why: `${name}: ${real[0].conclusion ?? real[0].status} in "${real[0].name}"` };

  if (job.conclusion === 'cancelled') return { verdict: 'real', why: `${name}: cancelled after it started, so not known why` };
  if (culprits.length === 0) return { verdict: 'real', why: `${name}: ${job.conclusion} with no failed step to explain it` };
  return { verdict: 'infra', why: `${name}: failed only in setup step "${culprits[0].name}"` };
}

// The pure part. Returns { result: 'infra' | 'real', reasons: string[] }.
export function classifyFailure(jobsJson) {
  const jobs = jobsJson && Array.isArray(jobsJson.jobs) ? jobsJson.jobs : null;
  if (!jobs || jobs.length === 0) return { result: 'real', reasons: ['no jobs list to read'] };
  const verdicts = LEGS.map((name) => judgeLeg(name, jobs.find((job) => job.name === name)));
  const failing = verdicts.filter((v) => v.verdict !== 'fine');
  const reasons = failing.map((v) => v.why);
  if (failing.length === 0) return { result: 'real', reasons: ['no failing leg found'] };
  return { result: failing.every((v) => v.verdict === 'infra') ? 'infra' : 'real', reasons };
}

// `gh` is a function from an argument list to the command's stdout, so tests can stand in for it.
export function classifyRun({ repo, runId }, gh) {
  return classifyFailure(JSON.parse(gh(['api', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`])));
}

const ghCli = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const option = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

function main(argv) {
  let result = { result: 'real', reasons: ['could not read the jobs'] };
  try {
    if (argv.includes('--run')) {
      result = classifyRun({ repo: process.env.GITHUB_REPOSITORY, runId: option(argv, '--run') }, ghCli);
    } else {
      result = classifyFailure(JSON.parse(readFileSync(argv[0], 'utf8')));
    }
  } catch {
    /* stays real */
  }
  console.error(result.reasons.join('\n'));
  console.log(result.result);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
