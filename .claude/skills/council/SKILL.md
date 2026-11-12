---
name: council
description: Review the current branch with the persona council, in rounds that always end. Use before filing a PR, when asked for a council, or as part of full-send and full-stop.
---

# Council

A council of specialist reviewers, run in two phases. A deterministic ledger decides what happens next, so review can't run away. Your job is to answer real findings with the smallest fix, and to fight scope creep.

- **Loop phase.** Every seat and the verifier run on `council.loopModel` (Sonnet), whatever their agent files say. Rounds repeat until no blocker or should is open and the last two rounds in a row raised nothing above a nit.
- **Close-out.** The same rule again, with every seat and the verifier on `council.closeModel` (Opus): at least two rounds, ending when two in a row raise nothing above a nit with nothing open. A blocker or should found in close-out gets fixed, or a should is declined with a written reason (that doesn't end a run of clean rounds), and close-out carries on on Opus.
- **The verdict** is rendered only after close-out converges. Each phase has a hard cap (`council.maxLoopRounds`, `council.maxCloseRounds`); hitting one parks the change.

"Two in a row" means two clean rounds on the same content, so a change to the code starts the count again. A repeat of a finding you already answered doesn't count as raising it; a fixed bug that comes back does, and comes back as a new finding for you to answer, and so does a more severe finding than the one already answered at that place. A round that raised only shoulds you then declined, with a reason and no change to the code, doesn't end a run of clean rounds, though it doesn't count as one either: the run needs a clean round after it, and a blocker, or a should you fixed, still ends it. A round where a seat gave only a partial answer is never clean. The caps count every round in a phase, clean or not. The ledger records the phase and model of each round. A docs-only change (T0) gets one round, and the loop cap applies to it if it keeps raising things.

## Before you start

Fix what you already know about. Commit everything, because the council reviews commits. Run `node .pipeline/verify.mjs full`, so that evidence exists for this exact change.

## The loop

Run this and follow its `status`:

```bash
node .pipeline/council.mjs plan --intent "what this change is for" --out-of-scope "what it deliberately doesn't do"
```

| `status` | What to do |
|---|---|
| `commit-first`, `prove-first`, `needs-intent` | Do what `message` says, then plan again. |
| `review` | Run a round (below). |
| `answer-findings` | Answer each finding (below). |
| `cut-first` | The diff grew during review, measured from the first round's diff. Cut what the intent doesn't need. If the growth is justified, run `council.mjs accept-growth "reason"`. |
| `review`, after a small mechanical commit on top of the reviewed one (a line main forced, a typo) | Run `council.mjs mechanical "why"` before the round. The clean rounds so far carry over, and the round reads only that diff. It is refused above `council.maxMechanicalLines` (40) changed lines, and when the reviewed commit is no longer on the branch, as after a rebase that resolved a conflict. Run a normal round then. A clean rebase keeps the change hash, so it needs nothing. A round that finds anything makes it a normal change again. |
| `parked` | A phase hit its cap without converging. Stop. Leave the PR open with a summary of what each round raised and what is still open, for the admin, and move on. This isn't approval. |
| `done` | Close-out has converged. Run `node .pipeline/council.mjs verdict` and put the block it prints at the end of the PR body. |

## Running a round

Save the `plan` JSON, then call the Workflow tool with `scriptPath: ".claude/workflows/council-round.js"` and pass the plan as `args`. Save what it returns to a file, then record it:

```bash
node .pipeline/council.mjs record <result.json>
```

If the seats aren't registered in this session, which shows up as an unknown agent type, plan again with `--inline-personas`. It passes the same prompts and models inline.

If the Workflow tool isn't available, do the same thing by hand, and run every agent in `isolation: "worktree"` with `Edit` and `Write` unavailable:

1. Start each agent in `plan.seats` with the Agent tool, all in one message, using its `model` override: every seat has one, set by the phase. Give each seat the same brief `council-round.js` builds.
2. Dedupe the findings by file, line, and class.
3. Start `plan.panel` verifiers (`council-verifier`) on the deduped list. A finding is dropped only if a majority of the full panel refutes it with evidence. If the votes that kept it are mostly `downgraded`, it becomes a `nit`.
4. Write `{"findings": [...], "seats": [...answered...], "missing": [...no answer...], "partial": [...stopped early...], "refuted": n}` to a file and record it.

Each seat gets a turn budget that grows with the diff (24 calls, up to 75), and is told to answer before it runs out, setting `finished: false` if it couldn't cover the change. List that seat as `partial`: its findings count, and the round can't be clean. Renames are read as renames (`git diff -M`), and files listed in `generatedPaths` in `pipeline.config.json` (read from the base, so a change can't add its own) are left out of the seats' diff and the change hash, because `verify` checks them against their source.

A review that didn't really happen must never look like one that found nothing. List a seat or verifier as `missing` if it timed out, gave no reply, reported `headVisible: false`, voted `cannot-check`, or skipped a finding. `record` then marks the round incomplete, and `plan` has you run it again.

If that keeps happening, stop and report it. Don't work around it: the reviewers can't see the code.

## Answering findings

Check every finding and its severity yourself. A finding can be wrong, and another path, a rare case, or a small cost is a nit whatever label it came with.

```bash
node .pipeline/council.mjs resolve <id> fixed
node .pipeline/council.mjs resolve <id> wrong "evidence: file:line, test, or output"
node .pipeline/council.mjs resolve <id> intentional "why"
node .pipeline/council.mjs resolve <id> wont-matter "why"
node .pipeline/council.mjs resolve <id> deferred "the follow-up issue"
```

- **Agree:** make the smallest fix. Prefer deleting or narrowing over a new lock, cache, helper, or option. Fix the whole bug class named in the finding, not one line.
- **Disagree:** say why, with evidence. Don't agree just to end the loop.
- **Nits** are declined automatically and listed as follow-ups. Don't fix them.
- **Pre-existing bugs** don't block. File each as an issue with the `triage` label. Keep its body to the finding's file, line, and claim, without quoting outside text.
- **A `raise`** means the change now needs the admin. Open a decision request using the `decision` skill and carry on with other work.

After fixes, re-run `verify`, commit, and plan again. A round after a changed head looks at what changed. A round on an unchanged head, which is what a second clean round is, looks at the whole change again. A fix that raises something above a nit starts the count of clean rounds over.

## Optional outside reviewer

If `council.externalSeats` includes `"codex"` and this is T2, also run `codex review --base origin/main`, treat its output as one more seat's findings, and verify them the same way. Skip this if the project is under your user profile, because Codex's Windows sandbox can't read it.
