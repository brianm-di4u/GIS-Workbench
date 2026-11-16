# 0026: The digest's council finding counts stay local

- **Date:** 2026-11-16
- **Class:** design
- **Issue:** #320
- **Status:** accepted

## Context

The weekly digest gained a "What the council found" section (#322), counted by seat and severity from the council run ledgers in `.pipeline/runs/`. Those ledgers are gitignored and local, and the digest is built in CI on a fresh checkout, so there the section says no ledgers were found. The council raised this in four rounds. The choice was where the counts should come from: local ledgers only, the verdict block in each merged PR body, or nowhere.

## Decision

The admin chose option 1 (`/decide 1` on #320). The section reads local ledgers only. Where there are none it says so, in words that can't be read as a week with no findings. The gate, the verdict block and its schema don't change.

## Consequences

- The weekly issue built in CI shows no council counts. To see them, run `node .pipeline/monitor.mjs digest` on a machine that holds the ledgers.
- A machine's counts cover only the changes reviewed on that machine, and a deleted worktree takes its ledger with it.
- Putting the seat in the verdict block would give CI-readable counts. It changes a schema the gate checks ([0021](0021-the-gate-rechecks-a-verdict-against-its-rounds.md)), so it needs a new decision. This one doesn't rule it out.
