# 0016: GitHub hardening for releases and dependencies

- **Date:** 2026-11-10
- **Class:** security
- **Issue:** none; the admin approved the plan in chat on 2026-11-10
- **Status:** accepted on the admin's approval of the PR that carries it
- **Builds on:** [0010](0010-ci-rebuild-and-attest.md)

## Context

A release is the one irreversible thing this repository does, and the workflow that cuts one runs with the admin's login. Dependency changes arrive through PRs and Dependabot, and nothing checked them against known advisories before merge. Several protections can only be set in GitHub's settings, which agents may not change (`.pipeline/AUTONOMY.md`).

## Decision

**In the repository (this PR):**

- `release.yml`: the `attest` and `promote` jobs run in the `release` environment, so GitHub holds each for the admin's approval. Nothing else in the file changed. `attest` is the first job of a cut that signs, and `draft`, which creates the release, needs it, so a cut takes one approval and the draft can't be made without it. `promote` is a separate run and the moment a release goes public, so it takes its own. The build jobs need no approval.
- `dependency-review.yml`: on every pull request, `actions/dependency-review-action`, pinned by commit SHA, with read-only `contents`, fails on a high or critical vulnerability in a dependency the PR adds or changes, in runtime or development scope. Licences are warn-only: no allow or deny list is set, so a licence finding can't fail the run. `THIRD_PARTY.md` stays the authority on licences and sources.
- `.github/dependabot.yml`: each npm and cargo ecosystem gets a second group with `applies-to: security-updates`, so security fixes arrive batched like the routine ones.

**Left to the admin, in GitHub settings:**

1. Create the `release` environment with the admin as required reviewer, and limit its deployment branches to `main`. Do it before this merges: a job that names a missing environment makes GitHub create it with no protection. Without the branch limit, a dispatch from another branch runs that branch's copy of `release.yml`, which can leave the `environment:` line out.
2. A tag ruleset on `v*`: no deletion, no force-update, creation only by the admin or the release workflow.
3. Turn on immutable releases.
4. Turn on the "Dependabot security updates" switch.
5. Add non-provider patterns to secret scanning.
6. Decide whether the dependency review blocks a merge. Until then a red run is a signal and not a block, because the gate reads only the checks in `verify.checkNames`, which is `verify`. Two routes: make its check (the job id, `review`) a required status check in the branch ruleset, or add its name to `verify.checkNames` in `pipeline.config.json`, a T2 config change that needs no gate-script edit. Name the job first if `review` is too generic to hold.

## Consequences

- A cut or promote waits for an approval on the `release` environment, even if the owner check in `release.yml` is somehow satisfied by another run. That approval is only as strong as who can give it. Agents share the admin's GitHub account, and the guard hook protects `environments` settings but not approving a pending deployment (`actions/runs/<id>/pending_deployments`), so this stops a mistake and not a session that is told to approve. Closing that needs a reviewer identity agents can't use, or a guard rule and a line in `AUTONOMY.md`, which the admin decides.
- If the environment isn't protected, the `environment:` lines do nothing but add a name to the run.
- The dependency review needs the repository's dependency graph on, which is the default for a public repository.
- The dependency review blocks a merge only once item 6 is done. Before that it fails the check and nothing stops a merge, so an agent that merges through `full-send` should read it.
- A PR that adds a vulnerable development-only dependency now fails the check until the dependency is changed. The fix is to bump it or drop it; an exception means adding the advisory to the action's `allow-ghsas`, which is a reviewed change.
- To go back, revert the commits. The settings in the second list are separate and stay as the admin set them.
