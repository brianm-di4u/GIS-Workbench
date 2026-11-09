# 0008: The change hash binds to the PR's diff, not the merge base

- **Date:** 2026-11-08
- **Class:** design
- **Issue:** none; the admin approved it in chat on 2026-11-08
- **Status:** accepted

## Context

The change hash ties a council verdict, local evidence and an admin's `/approve` to one change. It was computed from each changed path's modes plus its blob IDs at the merge base and at the head. So whenever main changed a file the PR also touched, even far from the PR's lines, the merge base blob changed, the hash changed, and the verdict, the evidence and the approval were all void. Every feature touches `command-meta.js`, `ribbon-data.js`, `build/rust.mjs` or a Cargo file, so this hit PRs repeatedly (#90 twice and #93 once on 2026-11-08), and each time the council and `verify full` ran again for a change that had not changed.

## Decision

The hash binds to the PR's own diff. For each changed path it covers the path, the old and new modes, and for a text file the exact lines the PR adds and removes, in order, with whitespace kept and with hunk line numbers and context stripped, like `git patch-id --verbatim` but without its context lines, computed in `.pipeline/lib/git.mjs`. Where in the file the lines sit is not part of the hash. A binary file, or a submodule, keeps its old and new blob IDs. The records are sorted, then hashed with SHA-256.

The patch is read with fixed options (no renames, no external diff or text conversion, no context, one diff algorithm, attributes in the tree ignored), so a PR can't change how its own files are read. A machine's own git attributes can still mark a file binary, which switches that file to blob IDs; that can only void a match, never create one. A move is still a delete plus an add.

## Consequences

What stays strict:

- Any edit, addition or removal of a PR line, a whitespace-only edit, and any mode or path change voids the verdict, the evidence and the approval.
- The tier floors are unchanged: they classify the same changed paths as before.
- CI still runs on the merged result, so a green gate still means the merged tree passed.
- A conflict still blocks the merge. Resolving it by keeping the PR's lines keeps the hash.

What gets easier:

- A clean rebase, or a conflict resolved by keeping both sides, keeps the verdict, the evidence and the approval.

Residual risk:

- The approved lines can interact with new code on main in a way nobody reviewed. CI's run on the merged result and the tests are what catch that, not the hash.
- Position is not hashed, and that is what lets an append conflict resolved by keeping both sides keep the hash. So anyone who can push to the PR branch after an approval can keep the approval while moving the same added and removed lines to another place in the same file, or removing a different copy of a repeated line, with no rebase and no change to main. The council found this in round 1. Binding to context would close it, but then an append conflict, or main editing within a few lines of the PR, would void the approval, which is the cost this decision removes. The admin accepted the context-free hash; reviewing the head the admin approves, and CI and tests on the merged result, are what cover the gap. Tightening it later means hashing a small context around each hunk.
- Local evidence is looked up by the same hash, so after a rebase the local gate accepts evidence made before it. The CI gate does not: it reads the `verify` check run for the new head.

Rollout:

- Hashes from the old definition match nothing. A verdict or approval made before this lands fails as "different content", and evidence is looked up under a new name. Nothing crashes. One more round of `verify full` and the council is needed for each in-flight PR.
- Follow-up: #79, the gate does not verify that a verdict came from a real council run.
