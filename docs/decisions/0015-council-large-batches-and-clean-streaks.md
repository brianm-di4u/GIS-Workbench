# 0015: The council copes with large batches, and a clean streak survives an answered should or a mechanical change

- **Date:** 2026-11-10
- **Class:** design
- **Issue:** [#174](https://github.com/brianm-di4u/GIS-Workbench/issues/174), [#184](https://github.com/brianm-di4u/GIS-Workbench/issues/184), and [#169](https://github.com/brianm-di4u/GIS-Workbench/issues/169) for `verify`
- **Status:** accepted on the admin's approval of the PR that carries it
- **Builds on:** [0014](0014-no-delegate-approver.md)
- **Narrows:** [0008](0008-change-hash-binds-to-the-diff.md), for generated files only

## Context

Decision 0014 asked for bigger PRs and a two-phase council. Two things went wrong on the first ones. On a batch of about 6,400 diff lines, 3,600 of them a generated file moved, the bug-hunter and architect seats hit their turn caps twice and never answered, so round 1 never completed (#174). And #178 needed three admin cap extensions: a late one-line mechanical fix restarted the count of clean rounds, and a should that was answered without any change to the code reset the streak, so close-out could not converge under its cap (#184). Separately, a worktree whose `node_modules` was older than the lockfile failed `verify full` in three stages after a long wait in the machine-wide queue, for a reason that was the environment and not the change (#169).

## Decision

- **Seat turns scale with the diff.** Each seat's brief gives it a budget of `16 + diff lines / 50` tool calls, at least 24 and at most 75, and tells it to stop exploring about five calls before the end and answer. The agent files' `maxTurns` is now a high ceiling (80, and 40 for the verifier), not the working limit. A seat that couldn't cover the change returns `finished: false` with the findings it has. Those findings are kept, and the round is recorded with that seat as `partial` and is never clean, since silence from a seat that didn't finish proves nothing.
- **Generated files are out of the reviewed diff, the diff size and the change hash.** `pipeline.config.json` lists them as `generatedPaths` (now `app/src/i18n/catalog/en.json`, which `verify` checks with `i18n.mjs extract --check`). The list is read from the merge base, so a change can't exempt its own files, and a missing or malformed list exempts nothing, and so does a path that only matches after case or trailing-dot folding. The tier floors still see the paths. This narrows 0008 for those files only: an edit to one doesn't void a verdict or an approval, and `verify` on the merged result, not the hash, is what holds it to its source.
- **Renames are reviewed as renames.** The seats' diff and the size count use `-M`. The change hash still reads a move as a delete plus an add (0008).
- **A should answered without a change doesn't reset the streak.** A round that raised only shoulds, all since declined with a written reason and none fixed, neither counts as a clean round nor ends a run of them, provided a clean round comes after it. A blocker never gets this, and a should that was fixed still ends the run, because the fix changes the content.
- **A mechanical change gets a diff-only confirmation.** `council.mjs mechanical "reason"` links the last reviewed content to the current one when no more than `council.maxMechanicalLines` (40) lines changed since the reviewed commit, which has to be on the branch. So it covers a small commit stacked on the reviewed one, not a rebase that resolved a conflict, which rewrites that commit and gets a normal round. A clean rebase keeps the change hash and needs nothing. The clean rounds so far carry over, and one clean round that reads only that diff is enough. A round that finds anything makes it a normal change again.
- **`verify` stops at once on a stale `node_modules`.** It compares `package-lock.json` with `node_modules/.package-lock.json` before it queues, names up to five packages that differ, and says to run `npm ci --ignore-scripts`. An optional, peer, or platform-limited package that is absent is not a difference.

## Consequences

- Fewer rounds are lost to a seat that ran out of turns, at the cost of a higher ceiling on what a stuck seat can spend. The budget in the brief is advice to the seat; only the ceiling is enforced.
- A declined should can now stand without a second look at it, as long as a later round is clean. The reason is still written down, the finding is still on the ledger, and the next clean round is a fresh independent look. If it was a real bug, nothing re-checks it beyond that. The author's honesty about "wrong" and "intentional" carries more weight.
- A series of small mechanical changes could add up. Each is bounded, each is read by a round, and `maxDiffGrowth` still measures growth from the first round.
- Generated files are trusted to match their source because `verify` checks it. If a generated file gets no such check, it should not be listed. Adding one is a T2 change to `pipeline.config.json`.
- The gate doesn't read the ledger, so none of this is enforced by it: the rules are kept by the author running `council.mjs`, as in 0014 (issue #79).
- `.claude/agents/**`, `.claude/workflows/**`, `.claude/skills/council/SKILL.md`, `.pipeline/council.mjs`, `.pipeline/lib/ledger.mjs`, `.pipeline/lib/git.mjs`, `.pipeline/lib/config.mjs` and `.pipeline/verify.mjs` now differ from dev-pipeline's, so the next `pipeline update` keeps them for a hand merge. These are candidates to go upstream (#140).
- To go back, revert the commit. Nothing else depends on it.
