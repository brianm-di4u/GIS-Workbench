# 0024: A small T1 change skips the council's loop phase

- **Date:** 2026-11-15
- **Class:** design
- **Issue:** #277
- **Status:** accepted
- **Amends:** [0014](0014-no-delegate-approver.md) and [0015](0015-council-large-batches-and-clean-streaks.md), on the council's stopping rule

## Context

The council's stopping rule needs two clean loop rounds and then two clean close-out rounds, whatever the change's size. Across 52 council ledgers, changes of 150 lines or fewer took 107 rounds and found 12 shoulds. Only one of those shoulds came after round 2, and 15 of the 23 PRs never raised one. A 2-line model switch (#234) took four rounds. Large diffs are the opposite, and #273 addresses those.

## Decision

The admin chose option A (`/decide A` on #277). A T1 change of `council.maxMechanicalLines` (40) changed lines or fewer skips the loop phase. Its review is close-out alone: two clean rounds in a row on the close-out model. T0 keeps its single round. T2 keeps both phases at any size, and so does a change that a finding raised to T2.

`skipsLoop` in `.pipeline/lib/ledger.mjs` applies the rule in two places: the plan (`nextStep`) and the verdict (`buildVerdict`). The size is the change's strict line count when the plan or verdict is made. As with a mechanical change (0015), a binary file, or a diff git can't produce, is never small. If a small change grows past 40 lines during review, it returns to the full rule.

## Consequences

- Most small-change rounds go away, and once the loop is back on Sonnet, every small T1 change is reviewed on the stronger model.
- A should the loop would have caught has to be caught in close-out instead. Over this data that means about one PR in 23. Close-out still needs two clean rounds in a row, and any should resets it.
- The threshold shares its setting with the mechanical-change limit (0015). Changing `maxMechanicalLines` moves both, and that is a T2 change to `pipeline.config.json`.
- To go back, revert the commit. Ledgers recorded under the rule keep their close rounds. A verdict rendered later needs the loop rounds the old rule asks for.
