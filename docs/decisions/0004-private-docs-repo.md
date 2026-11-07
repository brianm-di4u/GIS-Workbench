# 0004: A private companion repo for requirements and test records

- **Date:** 2026-11-07
- **Class:** design
- **Issue:** none, recorded at adoption
- **Status:** accepted

## Context

The full requirements, plans, and test records are long and are not meant to be public. The public repo still needs to trace its tests to requirements.

## Decision

The admin chose a private companion repo. It holds the full requirements, the plans, the requirement matrix, and the test and validation records. This repo holds only a thin public scope statement ([PRD.md](../PRD.md)). `build/traceability.mjs` traces the requirements to tests.

## Consequences

- The public [PRD.md](../PRD.md) has no numbered acceptance criteria.
- Requirement coverage is read from the private matrix, not from this repo.
- Release validation reports are written in the private repo.
- Public docs paraphrase private ones briefly, and do not copy large passages.
