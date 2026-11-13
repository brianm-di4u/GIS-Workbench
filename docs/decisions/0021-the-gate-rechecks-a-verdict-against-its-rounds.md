# 0021: The gate rechecks a council verdict against the rounds it carries

- **Date:** 2026-11-13
- **Class:** security
- **Issue:** #255
- **Status:** accepted

## Context

The gate trusted the council verdict block in a PR body as written (#79). It checked that the JSON parsed and that `changeHash` matched, but nothing tied the open counts, the round count or the seats to a council run. Since decision 0006 set `merge.t1` to `"auto"`, that block is the only review a T1 change gets. The ledger stays gitignored on the machine that ran the council, and the agents run under the admin's account, so no key could sign a verdict that an agent couldn't also sign.

## Decision

Option A. `council.mjs verdict` puts a compact log of every round in the block: its number, phase, hash, the seats that answered and those missing, and what it raised. Each finding carries its id, severity, status and round. The gate rebuilds the ledger from that log and applies the council's own rules. It recomputes the round count and the open counts, checks that the last round reviewed this content, and checks that close-out converged on it. It refuses a verdict whose numbers disagree, whose rounds name no seats, or whose rounds claim to have raised fewer blocking findings than are recorded against them.

## Consequences

- An edited or invented summary, a round with no reviewers, and a verdict that never converged on this content are caught, and every verdict is auditable from its PR.
- It doesn't catch a set of rounds faked consistently from start to finish. That would need a review the agents can't write, such as a CI-run round (option B), which would take a secret, spending and a new workflow.
- The verdict block is schema 2 and grows by roughly 2–10 KB. A schema 1 verdict is refused, so an open PR renders its verdict again with `council.mjs verdict`.
- The council record, the reviewer evals and the gate all judge what a round result is with the ledger's own checks.
