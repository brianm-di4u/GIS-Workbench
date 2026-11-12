// Decision 0016: the release jobs that sign or publish wait for the release environment, and the
// dependency review workflow is read-only and pinned by commit SHA.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const release = readFileSync('.github/workflows/release.yml', 'utf8');
const review = readFileSync('.github/workflows/dependency-review.yml', 'utf8');
const dependabot = readFileSync('.github/dependabot.yml', 'utf8');

const jobs = (text) => text.slice(text.indexOf('\njobs:\n')).split(/\n {2}(?=[a-z][\w-]*:[ \t]*(?:#.*)?\n)/).slice(1);

describe('release.yml environments', () => {
  it('holds attest for a cut and promote for a promotion, one approval each', () => {
    const held = jobs(release)
      .filter((job) => /\n {4}environment: release\n/.test(job))
      .map((job) => job.match(/^([a-z][\w-]*):/)[1]);
    expect(held).toEqual(['attest', 'promote']);
  });

  it('makes draft wait for attest, so a cut is not published without the approval', () => {
    const draft = jobs(release).find((job) => job.startsWith('draft:'));
    expect(draft).toMatch(/\n {4}needs: \[[^\]]*\battest\b[^\]]*\]\n/);
  });

  it('puts no other environment anywhere', () => {
    expect((release.match(/^\s+environment:.*$/gm) ?? []).map((line) => line.trim())).toEqual(['environment: release', 'environment: release']);
  });
});

describe('dependency-review.yml', () => {
  it('runs on pull requests with only read access, and no write permission anywhere', () => {
    expect(review).toMatch(/\non:\n {2}pull_request:\n/);
    expect(review).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(review).not.toMatch(/: write/);
  });

  it('pins every action by a full commit SHA', () => {
    const uses = [...review.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use, use).toMatch(/@[0-9a-f]{40}$/);
  });

  it('fails on high and critical, and keeps licences from failing the run', () => {
    const code = review.replace(/^\s*#.*$/gm, '');
    expect(code).toMatch(/fail-on-severity: high\n/);
    expect(code).not.toMatch(/warn-only/);
    expect(code).not.toMatch(/allow-licenses|deny-licenses/);
  });
});

describe('dependabot.yml', () => {
  it('batches security updates in each application ecosystem', () => {
    const code = dependabot.replace(/^\s*#.*$/gm, '');
    expect(code.match(/applies-to: security-updates/g)).toHaveLength(3);
  });
});
