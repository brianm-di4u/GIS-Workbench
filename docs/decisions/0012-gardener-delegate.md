# 0012: A delegate account, the Gardener, approves and decides within a grant

- **Date:** 2026-11-09
- **Class:** major
- **Issue:** none; the admin approved the plan in chat on 2026-11-09
- **Status:** accepted

## Context

Development is fast until it needs the admin. On 2026-11-09 six T2 PRs and four decision issues waited on the admin's `/approve` or `/decide`. The pipeline knows an approver only by GitHub login, and agents already post under the admin's login, so only the guard hook and policy kept them from approving. The admin wants a thread that holds delegated authority, so work keeps moving, and that also tends the platform so agents produce good work.

## Decision

A separate GitHub account, `gwb-gardener`, is a delegate in `pipeline.config.json`: it may `/approve` and `/rearm` and may `/decide` decisions of class design, security and determination. It is invited as a collaborator on this repo and the sandbox repo, and nothing else. A session running as that account is the Gardener. It writes no product code, opens no PRs and merges nothing; it files `garden` issues for workers.

**The admin keeps:**
- anything that defines the Gardener's own authority, which is a floor built into the pipeline: `pipeline.config.json`, `pipeline.lock.json`, `.pipeline/**`, the hooks, `.claude/settings*.json`, the gardener skill, and the `gate`, `decisions`, `post-merge`, `audit` and `release` workflows. This repo adds `docs/POLICY.md`, `docs/PRD.md`, `LICENSE*`, `THIRD_PARTY*` and `TRADEMARKS.md` under `tiers.adminOnlyPaths`. Config can add to the floor and never take from it;
- every change to a workflow or action, because `approveWorkflows` is left unset;
- decisions of class legal or major, and any the bot couldn't classify;
- every public release, betas included, and `release.yml` now refuses any actor but the repo owner on every job;
- PRD scope, policy, money, repository settings and secrets, the site repo, and a second breaker trip in one window;
- lifting a suspension of the Gardener.

**Enforcement.** The gate counts a delegate's command only when the change touches no admin-only path, the delegate neither wrote nor pushed to the PR nor edited its body after it opened, the class the bot recorded when a decision opened is in the grant, and the delegate isn't suspended. If two gardener-approved merges inside the breaker window are reverted or turn main red, the bot opens a `pipeline:delegate-suspended` issue, and only the admin's `/rearm` lifts it. After each merge the bot checks that `pipeline/gate` came from `gate.yml` on the default branch, and suspends the Gardener if not. The guard hook allows the command words only to a session whose own login is a configured delegate, and blocks `gh release` writes in that delegate's own session. Worker sessions, which act under the admin's login, are not stopped by it.

**Live at once.** There is no shadow period. The suspend rule is the safety net. Worker models are set in `models`: Sonnet by default, Opus for `complexity:high`, Haiku for `complexity:low`.

**Adoption.** This change runs `pipeline update` from dev-pipeline `8a31421`, adds `delegates`, `models` and `tiers.adminOnlyPaths`, creates the labels `admin-needed`, `garden`, `complexity:high`, `complexity:low` and the four `pipeline:delegate-*` labels, and documents the token, suspension and off-switch in `docs/RUNBOOK.md`. Seven files kept their local changes and were looked at by hand. `release.yml` gained the owner check. The others (`.pipeline/lib/git.mjs`, `.pipeline/verify.mjs`, `nightly.yml`, `app-setup/action.yml`, `dependabot.yml` and the `modernize` skill) needed no merge for the delegate. `.pipeline/lib/git.mjs` keeps this repo's diff-based change hash (decision 0008).

## Accepted risks

- **The `workflow` scope lets the Gardener's token change CI.** So the Gardener's limits hold against mistakes and stale judgement, not against a deliberate bypass or a successful prompt injection. The forged-gate check catches one such bypass after the merge, not before. Dropping the scope removes the risk, at the cost of workflow pushes staying with the admin. The mechanisms are for a draft security advisory, not this record.
- **Releases stay the admin's by policy, not by token.** Any agent with write access can create a release through the API, as today. The delegate's guard and the owner check in `release.yml` stop the Gardener's accidents. A worker session is held only by policy.
- **Shared blind spots.** A Fable Gardener reviewing Opus and Sonnet work can miss what they miss. The suspend rule and the revert rate are the check.
- **The worker gate is still soft.** Workers hold a token under the admin's login, and the Gardener's token file is readable by any session of the admin's Windows user. Moving workers to their own account, and the token to a separate OS user, are the later fixes.
- **Class decides who rules on a decision.** The bot records the class at open so the Gardener can't lower it, but a worker can mis-class at filing. The Gardener re-judges the class and escalates when it disagrees.
- **The hash residual from 0008 now covers Gardener approvals.** A change hash without context lets anyone who can push after an approval move the approved lines within a file and keep the approval. Workers push under the admin's login, so no delegate-touch marker fires. The Gardener reads the diff on the head it approves, which is the mitigation.
- **Unverified until the Gardener first runs:** that the clone's local settings override the user-level token for both `gh` and the guard hook. If they don't, the guard denies, which is the safe failure.

## Left to the admin's choice

The council raised two gaps in the grant. Neither is fixed here, because each changes the authority model the admin approved.

- **Enforcement files.** `tiers.adminOnlyPaths` lists the rule files (`docs/POLICY.md`, `docs/PRD.md`, `LICENSE*`, `THIRD_PARTY*`, `TRADEMARKS.md`) but not the files that enforce them or steer agents: `build/check-policy*`, `crates/deny.toml`, `build/origins.json`, `build/airgap.mjs`, `**/CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, the council's seats and round script (`.claude/agents/**`, `.claude/workflows/**`), and the `decision`, `release` and `full-send` skills. They are T2, so the Gardener may approve changes to them. Adding them sends more PRs to the admin.
- **Decision records.** `docs/decisions/**` is not admin-only. A record that cites no `/decide` is T2, and the Gardener may approve it, which then settles the question for every agent. Adding `docs/decisions/**` to `tiers.adminOnlyPaths` makes every record need the admin.

Both are one-line config changes, and the admin can make either at approval.

## Baseline

From 2026-11-07 to 2026-11-09, before the Gardener: 62 merges (T0 4, T1 30, T2 27, 1 revert), 39 admin approvals, approval wait from PR opening a median of 0.98 hours and a p90 of 7.6 hours, and a decision wait with a median of 1 hour.

## Review after one week

Has approval wait fallen to minutes? Is the revert and red-main rate no worse than the baseline? Were there no suspensions? Does the admin agree with at least nine of ten sampled rationale comments? Then widen the grant, hold it, or narrow it.

## Consequences

- Only `admin-needed` issues reach the admin. Routine T2 approvals and the three decision classes move to the Gardener.
- To turn it off, remove `delegates` from `pipeline.config.json`, as `docs/RUNBOOK.md` describes. With the key absent the pipeline behaves as it did before.
- Updates from dev-pipeline still keep this repo's local changes to `git.mjs`, `verify.mjs`, `release.yml`, `nightly.yml`, `app-setup/action.yml`, `dependabot.yml` and the `modernize` skill, so each needs a look by hand until the diff-based hash goes upstream.
