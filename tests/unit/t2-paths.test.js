// Which paths need the admin's approval (decision 0014). The list is pinned, so a change to it
// is a change a test shows, and a typical code or docs path stays T1.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../.pipeline/lib/config.mjs';
import { classify } from '../../.pipeline/lib/tier.mjs';

const warnings = [];
const config = loadConfig('pipeline.config.json', { warn: (message) => warnings.push(message) });
const change = (path) => ({ path, oldMode: '100644', newMode: '100644', oldSha: 'a', newSha: 'b' });
const tierOf = (...paths) => classify({ changes: paths.map(change), config, author: config.admins[0] }).tier;

// What needs the admin: pipeline and permission files, the review machinery, the rule and licence
// files, and four things kept for security: the sidecar, build-time code, vendored crates and the
// release tools.
const KEPT = [
  '.github/**', '.pipeline/**', 'pipeline.config.json', 'pipeline.lock.json', '.claude/settings*.json', '.claude/hooks/**',
  '.claude/agents/**', '.claude/workflows/**', '.claude/skills/**', 'REVIEW.md', '**/CLAUDE.md', '**/AGENTS.md',
  'docs/POLICY.md', 'docs/PRD.md', 'LICENSE*', 'THIRD_PARTY*', 'TRADEMARKS.md', 'SECURITY.md',
  'build/check-policy*', 'crates/deny.toml', 'build/origins.json', 'build/airgap.mjs',
  'sidecar/installer/licences.json', 'build/packs-sources.json', 'build/csm/NOTICES.txt', 'sidecar/installer/**/*NOTICE*',
  'crates/vendor/**/LICENSE*', 'crates/vendor/**/COPYING*', 'crates/vendor/**/NOTICE*',
  'docs/decisions/**',
  'sidecar/**', '**/build.rs', '.cargo/**', 'crates/.cargo/**', 'crates/vendor/**', 'build/release/**',
];

describe('tiers.t2Paths', () => {
  it('loads without warnings, with no delegate and no admin-only list', () => {
    expect(warnings).toEqual([]);
    expect(config.delegates).toBeUndefined();
    expect(config.tiers.adminOnlyPaths).toBeUndefined();
  });

  it('is exactly the kept list', () => {
    expect(config.tiers.t2Paths).toEqual(KEPT);
  });

  it('needs the admin for a real file name under each kept glob', () => {
    for (const path of [
      '.github/workflows/gate.yml', '.pipeline/gate.mjs', 'pipeline.config.json', 'pipeline.lock.json', '.claude/settings.json', '.claude/hooks/guard.mjs',
      '.claude/agents/council-architect.md', '.claude/workflows/council-round.js', '.claude/skills/council/SKILL.md', '.claude/skills/reviewer-eval/SKILL.md',
      '.claude/skills/full-send/SKILL.md', '.claude/skills/autopilot/SKILL.md', '.claude/skills/babysit-pr/scripts/pr-wait',
      'REVIEW.md', 'CLAUDE.md', 'sidecar/CLAUDE.md', 'AGENTS.md',
      'docs/POLICY.md', 'docs/PRD.md', 'LICENSE', 'LICENSE-APACHE', 'THIRD_PARTY.md', 'THIRD_PARTY_NOTICES.md', 'TRADEMARKS.md', 'SECURITY.md',
      'build/check-policy.mjs', 'build/check-policy.terms.json', 'crates/deny.toml', 'build/origins.json', 'build/airgap.mjs',
      'sidecar/installer/licences.json', 'build/packs-sources.json', 'build/csm/NOTICES.txt', 'sidecar/installer/linux/OPENH264-NOTICE.txt',
      'crates/vendor/fax/LICENSE', 'crates/vendor/hayro-jpeg2000/LICENSE-APACHE', 'crates/vendor/fax/src/lib.rs',
      '.claude/skills/release/SKILL.md', '.claude/skills/decision/SKILL.md', 'docs/decisions/0014-no-delegate-approver.md',
      'sidecar/gwb-stereo/src/lib.rs', 'crates/gw-tin/build.rs', '.cargo/config.toml', 'crates/.cargo/config.toml', 'build/release/stage.mjs',
    ]) {
      expect(tierOf(path), path).toBe(2);
    }
  });

  it('leaves a typical moved path at T1', () => {
    for (const path of [
      'app/src/features/files.js', 'app/src/shell/commands.js', 'crates/gw-tin/src/lib.rs', 'tests/unit/tin25.test.js',
      'build/build.mjs', 'build/gates.mjs', 'build/rust.mjs', 'build/verify-scope.mjs', 'build/check-quarantine.mjs',
      '.gitattributes', '.node-version', 'crates/rust-toolchain.toml', 'package-lock.json', 'crates/Cargo.lock',
      'docs/RUNBOOK.md',
    ]) {
      expect(tierOf(path), path).toBe(1);
    }
  });
});
