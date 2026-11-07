# 0006: When T1 PRs start merging without the admin

- **Date:** 2026-11-07
- **Class:** determination
- **Issue:** #10
- **Status:** accepted

## Context

At adoption, `pipeline.config.json` set `merge.t1` to `"human"`, so the admin merges every ordinary change. The admin had said this lasts for the first 10 T1 PRs, but no record said when or how it ends.

## Decision

Option A. The admin merges the first 10 T1 PRs. After the 10th, an agent may open a T2 PR that sets `merge.t1` to `"auto"`, but only if every revert of a T1 merge so far went through the clean `Revert-of` path. The admin approves that PR.

## Consequences

- Until then, every T1 PR waits at "T1: waiting for approval" until the admin approves it.
- The count is of merged T1 PRs on GitHub, not agents' reports.
- The switch itself is a T2 change, so the admin still sees it.
