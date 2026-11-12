// release.yml is owner-only on every job: only the repository owner can cut or promote a release.
// On an organization-owned repo the check does not apply, since it has no single owner login.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release.yml', () => {
  const text = readFileSync('.github/workflows/release.yml', 'utf8');
  // One entry per job, split at each two-space job key, with or without a trailing comment.
  const jobs = text.slice(text.indexOf('\njobs:\n')).split(/\n {2}(?=[a-z][\w-]*:[ \t]*(?:#.*)?\n)/).slice(1);
  const OWNER =
    "(github.event.repository.owner.type == 'Organization' || (github.actor == github.repository_owner && github.triggering_actor == github.repository_owner))";

  it('has the jobs it should', () => {
    expect(jobs.map((job) => job.match(/^([a-z][\w-]*):/)[1])).toEqual(['check', 'app', 'sidecar', 'rebuild', 'attest', 'draft', 'promote']);
  });

  it('runs every job only for the repository owner, with exactly the expected condition', () => {
    // check and promote also pick their action and skip a private repo, then the owner check follows.
    const prefix = {
      check: "inputs.action == 'cut' && !github.event.repository.private && ",
      promote: "inputs.action == 'promote' && !github.event.repository.private && ",
    };
    for (const job of jobs) {
      const name = job.match(/^([a-z][\w-]*):/)[1];
      const condition = job.match(/\n {4}if: (.*)\n/)?.[1];
      expect(condition, name).toBe(`\${{ ${prefix[name] ?? ''}${OWNER} }}`);
    }
  });
});
