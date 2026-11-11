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

1. Create the `release` environment with the admin as required reviewer. Do it before this merges: a job that names a missing environment makes GitHub create it with no protection.
2. A tag ruleset on `v*`: no deletion, no force-update, creation only by the admin or the release workflow.
3. Turn on immutable releases.
4. Turn on the "Dependabot security updates" switch.
5. Add non-provider patterns to secret scanning.

## Consequences

- A cut or promote can't finish without the admin clicking approve, even if the owner check in `release.yml` is somehow satisfied by another run.
- If the environment isn't protected, the `environment:` lines do nothing but add a name to the run.
- The dependency review needs the repository's dependency graph on, which is the default for a public repository.
- A PR that adds a vulnerable development-only dependency now fails until the dependency is changed. The fix is to bump it or drop it; an exception means adding the advisory to the action's `allow-ghsas`, which is a reviewed change.
- To go back, revert the commits. The settings in the second list are separate and stay as the admin set them.
