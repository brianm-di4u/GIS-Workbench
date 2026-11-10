// What this repo adds on top of dev-pipeline's delegate feature (decision 0012): the grant, the
// extra admin-only paths, and the owner-only check on every release job.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authority } from '../../.pipeline/lib/authority.mjs';
import { loadConfig } from '../../.pipeline/lib/config.mjs';
import { classify } from '../../.pipeline/lib/tier.mjs';

describe('the delegate grant', () => {
  const warnings = [];
  const config = loadConfig('pipeline.config.json', { warn: (message) => warnings.push(message) });
  const auth = authority(config);

  it('loads without warnings and gives gwb-gardener the granted powers only', () => {
    expect(warnings).toEqual([]);
    const grant = auth.delegateOf('gwb-gardener');
    expect(grant).toMatchObject({ approve: true, rearm: true, direct: true, approveWorkflows: false, approveExternal: false });
    expect(grant.decide).toEqual(['design', 'security', 'determination']);
    // Commands the account posted before this moment never count (it was signed in by mistake earlier).
    expect(grant.since).toBe('2026-11-10T02:53:00Z');
    expect(auth.isAdmin('gwb-gardener')).toBe(false);
  });

  it('keeps the rule files, and the floor, admin-only', () => {
    for (const path of ['docs/POLICY.md', 'docs/PRD.md', 'LICENSE*', 'THIRD_PARTY*', 'TRADEMARKS.md', 'pipeline.config.json', '.pipeline/**']) {
      expect(auth.adminOnlyPaths, path).toContain(path);
    }
  });
});

describe('the admin-only paths in use', () => {
  it('flag real file names, and leave ordinary code alone', () => {
    const config = loadConfig('pipeline.config.json', { warn: () => {} });
    const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b' });
    const flagged = (path) => classify({ changes: [change(path)], config, author: config.admins[0] }).flags.adminOnly;
    for (const path of ['docs/POLICY.md', 'LICENSE', 'LICENSE-APACHE', 'THIRD_PARTY.md', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', '.pipeline/gate.mjs']) {
      expect(flagged(path), path).toEqual([path]);
    }
    expect(flagged('app/src/main.js')).toEqual([]);
    // The root-level globs do not reach nested licence files. See "Left to the admin's choice" in decision 0012.
    expect(flagged('crates/vendor/fax/LICENSE')).toEqual([]);
  });
});

describe('release.yml', () => {
  const text = readFileSync('.github/workflows/release.yml', 'utf8');
  // One entry per job, split at each two-space job key, with or without a trailing comment.
  const jobs = text.slice(text.indexOf('\njobs:\n')).split(/\n {2}(?=[a-z][\w-]*:[ \t]*(?:#.*)?\n)/).slice(1);
  const OWNER =
    "(github.event.repository.owner.type == 'Organization' || (github.actor == github.repository_owner && github.triggering_actor == github.repository_owner))";

  it('has the jobs it should', () => {
    expect(jobs.map((job) => job.match(/^([a-z][\w-]*):/)[1])).toEqual(['check', 'app', 'sidecar', 'rebuild', 'attest', 'draft', 'promote']);
  });

  it('runs every job only for the repository owner, by the same expression', () => {
    for (const job of jobs) {
      const condition = job.match(/\n {4}if: (.*)\n/)?.[1];
      expect(condition, job.split('\n')[0]).toBeDefined();
      expect(condition, job.split('\n')[0]).toContain(OWNER);
      expect(condition).toMatch(/^\$\{\{ (.* && )?\(github\.event\.repository\.owner\.type/);
    }
  });
});
