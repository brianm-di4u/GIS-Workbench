# 0005: `dist/` is built, not tracked

- **Date:** 2026-11-07
- **Class:** design
- **Issue:** none, recorded at adoption
- **Status:** accepted

## Context

The build produces the single HTML files and their reports in `dist/`. They are large, and committing them would bloat history and make every review noisy.

## Decision

The admin chose not to track `dist/`. It is built from source. Releases hold the built files and their hashes.

## Consequences

- The source of truth is the source tree. Built files come from a release, or from a local build.
- A published release file is never replaced. A fix gets a new patch version.
- Release files are built on the admin's machine, and checked against `SHA256SUMS`.
