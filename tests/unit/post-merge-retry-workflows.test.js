// post-merge-retry.yml and the step it relies on in post-merge.yml (decision 0011). These are text
// checks: only GitHub can show that a re-run is accepted from `workflow_run`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGS } from '../../.pipeline/lib/classify-failure.mjs';

const read = (path) => readFileSync(path, 'utf8');
const retry = read('.github/workflows/post-merge-retry.yml');
const record = read('.github/workflows/post-merge.yml');
const count = (text, part) => text.split(part).length - 1;

// The text of one top-level job, from its name to the next job.
function jobBlock(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}
const permissionsOf = (block) => block.match(/\n {4}permissions:\n((?: {6}\S.*\n)+)/)?.[1].trim().split('\n').map((line) => line.trim());

describe('post-merge-retry.yml', () => {
  it('classifies the legs that verify waits for', () => {
    const needs = record.match(/\n {2}verify:\n {4}needs: \[([^\]]*)\]/)[1].split(',').map((name) => name.trim());
    expect(LEGS).toEqual(needs);
  });

  it('gates record and the retry the same way, so neither can act without the other', () => {
    for (const guard of ["conclusion == 'failure'", "event == 'push'", "head_branch == 'main'", 'run_attempt == 1']) {
      expect(count(retry, guard), guard).toBe(3); // classify, retry and report
    }
    expect(record).toContain("needs.verify.result != 'success' && needs.verify.result != 'skipped'");
    expect(record).toContain("github.run_attempt == 1 && github.event_name == 'push' && github.ref == 'refs/heads/main'");
    expect(jobBlock(retry, 'retry')).toContain("needs.classify.outputs.result == 'infra'");
    expect(jobBlock(retry, 'report')).toContain("needs.retry.outputs.retried != 'true'");
  });

  it('gives each job only the permissions it needs, with an empty default', () => {
    expect(retry).toMatch(/\npermissions: \{\}\n/);
    expect(permissionsOf(jobBlock(retry, 'classify'))).toEqual(['actions: read', 'contents: read']);
    expect(permissionsOf(jobBlock(retry, 'retry'))).toEqual(['actions: write']);
    expect(permissionsOf(jobBlock(retry, 'report'))).toEqual(['contents: read', 'issues: write', 'pull-requests: read']);
  });

  it('keeps repository code out of the job that holds actions: write', () => {
    const block = jobBlock(retry, 'retry');
    expect(block).not.toContain('uses:');
    expect(block).not.toMatch(/\.pipeline|node |npm |build\//);
    expect(block).toContain('gh run rerun');
    expect(jobBlock(retry, 'classify')).toContain('.pipeline/lib/classify-failure.mjs');
  });

  it('uses no third-party action, and pins the ones it does use', () => {
    for (const [, action] of retry.matchAll(/uses: (\S+)/g)) expect(action).toMatch(/^actions\/(checkout|setup-node)@[0-9a-f]{40}$/);
  });
});
