# 0014: The admin approves what needs approval, and there is no delegate approver

- **Date:** 2026-11-10
- **Class:** major
- **Issue:** none; the admin decided in chat on 2026-11-10 ("Yes, simplify")
- **Supersedes:** [0012](0012-gardener-delegate.md)

## Context

Decision 0012 added a delegate account that could approve and decide within a grant, so work kept moving when the admin was away. The admin chose to simplify instead: fewer changes need an approval, and no second approver exists. Branch freshness ([0013](0013-branch-freshness-by-overlap.md)) is part of the same simplification, since it lets PRs land in parallel.

## Decision

- **No delegate.** `delegates` and `tiers.adminOnlyPaths` are removed from `pipeline.config.json`. dev-pipeline's delegate code stays in the tree and does nothing without that key, so the gate behaves as it did before 0012. Only the admin's approve, decide and rearm commands count. The decision commands are unchanged. `models` stays.
- **A shorter list of what needs the admin.** `tiers.t2Paths` goes from 44 entries to 39, and the 16 it drops are those that only needed a person because everything did. Every other change merges at T1 once CI, the council and the gate pass. What stays T2:
  - pipeline and permission files: `.github/**`, `.pipeline/**`, `pipeline.config.json`, `pipeline.lock.json`, `.claude/settings*.json`, `.claude/hooks/**`;
  - the review machinery: `.claude/agents/**`, `.claude/workflows/**`, the `council` and `reviewer-eval` skills, `REVIEW.md`, `**/CLAUDE.md`, `**/AGENTS.md`;
  - the rule and licence files: `docs/POLICY.md`, `docs/PRD.md`, `LICENSE*`, `THIRD_PARTY*`, `TRADEMARKS.md`, `SECURITY.md`, `build/check-policy*`, `crates/deny.toml`, `build/origins.json`, `build/airgap.mjs`, `sidecar/installer/licences.json`, `build/packs-sources.json`, `build/csm/NOTICES.txt`, any `NOTICE` file under `sidecar/installer`, the licence files in `crates/vendor/**`, the `release` and `decision` skills, and `docs/decisions/**`;
  - four things kept for security, named so the admin can strike any of them: `sidecar/**` (the networked native helper), `**/build.rs` and `.cargo/**` (code that runs at build time), `crates/vendor/**` (vendored third-party code) and `build/release/**` (what gets published).
- **Moved to T1:** `.gitattributes`, `**/auth/**`, `**/billing/**`, `**/migrations/**`, `build/build.mjs`, `build/gates.mjs`, `build/rust.mjs`, `build/e2e.mjs`, `build/eval-allowlist.json`, `build/check-quarantine.mjs`, `build/verify-scope.mjs`, `crates/rust-toolchain.toml`, `package-lock.json`, `crates/Cargo.lock`, `.node-version`, and the skills other than `council`, `reviewer-eval`, `release` and `decision`. A change to `package.json` scripts still needs the admin.
- **The baseline** carries over from 0012: from 2026-11-07 to 2026-11-09, 62 merges (T0 4, T1 30, T2 27, 1 revert), 39 admin approvals, approval wait from PR opening a median of 0.98 hours and a p90 of 7.6 hours, and a decision wait with a median of 1 hour. Reviewing a week of the new setup against it is how to tell whether this helped.

## Consequences

- Fewer approvals: the 16 moved paths and the skills merge without the admin.
- A T1 change to a build or gate script, a lockfile or a toolchain pin can now merge without the admin. The council reviews every change, `verify` and main's post-merge run test it, and a revert is the way back, but nobody checks it by hand. The scripts that decide what `verify` runs (`build/verify-scope.mjs`, `build/gates.mjs`, `build/rust.mjs`) are the ones to watch.
- Everything 0012 recorded about accepted risks applies only while a delegate is configured, which none is.
- To go back, restore the previous `tiers.t2Paths` from git history. To add a delegate again, record a new decision.
