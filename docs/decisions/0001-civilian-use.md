# 0001: Civilian use only

- **Date:** 2026-11-05
- **Class:** major
- **Issue:** none, recorded at adoption
- **Status:** accepted

## Context

The product is an imagery analysis tool. Its scope needed a clear statement of who it is for.

## Decision

The admin chose civilian use only. The product is designed and intended for civilian use and should not be used for any military purpose. Military-leaning functions were removed in 2.6.0.

## Consequences

- No military functions in future work, and none come back.
- `build/check-policy.mjs` enforces this on tracked text.
- The statement is a notice, not a licence term.
- See [POLICY.md](../POLICY.md).
