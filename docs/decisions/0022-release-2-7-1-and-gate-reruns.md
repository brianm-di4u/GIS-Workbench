# 0022: Release 2.7.1, and a gate e2e failure that passes alone

- **Date:** 2026-11-14
- **Class:** major
- **Issue:** #271
- **Status:** accepted

## Context

2.7.1 and Sidecar 0.4.0 needed the admin's written go, as `docs/POLICY.md` requires for every public release. The items to answer for this version, the gate results and the options are in the private record, `validation/2.7/release-decision-2.7.1.md` in the Docs repository.

The request also asked a standing question. A test in the release gate can fail once for a reason outside the build, such as a missed input during a test's setup, and then pass when re-run alone. Without a rule, each such failure would need a fresh gate run.

## Decision

Option A:

- Go for 2.7.1 and Sidecar 0.4.0, cut from the release PR's merge commit, with REG-075 in it. The legal items were answered for this version in the private record.
- From now on, a test that fails in a release gate's e2e run counts as passed if the same test passes when re-run alone on the same commit, and the validation report names the test, its first failure and the re-run's result.

## Consequences

- A one-off failure in the gate costs one re-run of that test, not a new gate run.
- The validation report must name every test that passed only on a re-run, so the reader of the report can judge it. A test that fails again when re-run alone is a failure.
- The rule covers only the same commit and that one test. A change to the code means a fresh gate run.
