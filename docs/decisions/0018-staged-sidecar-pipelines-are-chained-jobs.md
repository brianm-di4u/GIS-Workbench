# 0018: A staged sidecar pipeline is two jobs chained by a published output

- **Date:** 2026-11-12
- **Class:** design
- **Issue:** #155
- **Status:** accepted

## Context

Ground control points for UAV structure from motion (REG-075, #153) need the analyst to mark each point in the photographs, and the marking dialog shows candidate images by projecting the points through the block's sparse model. A sidecar job runs its profile from start to finish and publishes only its final products, so the sparse model never reaches the app. Either a run is split in two, or a job learns to pause for input. Whichever is chosen, other staged pipelines will copy it.

## Decision

Option A: two jobs chained by a published artefact.

- The first profile stops after the sparse model and publishes it (cameras, poses and sparse points) as an ordinary output.
- The app reads that output, projects the ground control points through it, and the analyst marks them in the photographs.
- A second profile takes the model, the GCP file with its marks, and the photographs, then georeferences the block and makes the products.

## Consequences

- No new job states or API: a staged pipeline is two profiles joined by an output of one that is an input of the next. A job still runs start to finish, holds no folder or memory while a person works, and can be retried on its own.
- The app holds the hand-over between the runs: it keeps the first job's output and gives it to the second.
- The cost is the published model (its size, and a format the app can read), and a second run's start-up, which re-reads the photographs.
- Pausing a job for input (option B) and marking from EXIF footprints before the run (option C) are not used. A later staged pipeline follows this pattern unless a new decision says otherwise.
