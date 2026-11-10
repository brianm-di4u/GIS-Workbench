// What this repo adds on top of dev-pipeline's delegate feature (decision 0012): the grant, the
// extra admin-only paths, and the owner-only check on every release job.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { authority } from '../../.pipeline/lib/authority.mjs';
import { loadConfig } from '../../.pipeline/lib/config.mjs';
import { delegateRefusals } from '../../.pipeline/lib/contract.mjs';
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

describe("the grant's since", () => {
  it('refuses a gardener approval posted before it, and not one after', () => {
    const config = loadConfig('pipeline.config.json', { warn: () => {} });
    const hash = 'abc123def456abc123def456';
    const approval = (at) => ({ user: { login: 'gwb-gardener', type: 'User' }, body: `/approve ${hash.slice(0, 12)}`, created_at: at, updated_at: at });
    const before = delegateRefusals([approval('2026-11-10T02:52:59Z')], config, hash, {});
    const after = delegateRefusals([approval('2026-11-10T02:53:01Z')], config, hash, {});
    expect(before[0].reasons.join(' ')).toContain('posted before');
    expect((after[0]?.reasons ?? []).join(' ')).not.toContain('posted before');
  });
});

describe('the admin-only paths in use', () => {
  it('flag real file names, and leave ordinary code alone', () => {
    const config = loadConfig('pipeline.config.json', { warn: () => {} });
    const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b' });
    const flagged = (path) => classify({ changes: [change(path)], config, author: config.admins[0] }).flags.adminOnly;
    // Real file names, one for every glob the admin chose.
    const adminOnly = [
      'docs/POLICY.md', 'docs/PRD.md', 'LICENSE', 'LICENSE-APACHE', 'THIRD_PARTY.md', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', 'SECURITY.md',
      'build/check-policy.mjs', 'build/check-policy.terms.json', 'crates/deny.toml', 'build/origins.json', 'build/airgap.mjs',
      'sidecar/installer/licences.json', 'build/packs-sources.json', 'build/csm/NOTICES.txt',
      'crates/vendor/fax/LICENSE', 'crates/vendor/hayro-jpeg2000/LICENSE-APACHE', 'crates/vendor/hayro-jpeg2000/LICENSE-MIT',
      '.claude/skills/release/SKILL.md', '.claude/skills/decision/SKILL.md', 'docs/decisions/0012-gardener-delegate.md', '.pipeline/gate.mjs',
    ];
    for (const path of adminOnly) expect(flagged(path), path).toEqual([path]);
    // Left with the Gardener on purpose (decision 0012), and ordinary code.
    for (const path of ['CLAUDE.md', 'REVIEW.md', 'AGENTS.md', '.claude/agents/council-architect.md', '.claude/workflows/council-round.js', '.claude/skills/full-send/SKILL.md', 'crates/vendor/fax/src/lib.rs', 'app/src/main.js']) {
      expect(flagged(path), path).toEqual([]);
    }
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
