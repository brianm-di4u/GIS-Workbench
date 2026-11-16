# 0027: Type checking for app/src, as a ratchet

- **Date:** 2026-11-16
- **Class:** design
- **Issue:** #324
- **Status:** accepted

## Context

`app/src` is 431 JavaScript modules with no type checker. A loose TypeScript check of main at `8ace54a` (version 5.6.3, `allowJs` and `checkJs` on, `strict` off) reported 1,730 errors in 232 files, and 199 files were clean. Nearly all the errors come from missing type information: properties set through `Object.assign`, and browser globals the checker has no types for. Of the roughly 45 read, none was a bug. Fixing all of them would be a large change with little evidence of bugs to find, and leaving the layer out means a misspelt property or a wrong argument count in new code is caught only by a test or a reviewer.

## Decision

The admin chose option A (`/decide A` on #324): a ratchet.

- `typescript` becomes a dev dependency (Apache-2.0, on the allowlist in `THIRD_PARTY.md`), and `verify` runs a `checkJs` pass over `app/src` with `strict` off.
- The number of errors in each file is recorded in a baseline. A file may not have more errors than its baseline, and a file not in the baseline, which includes every new file, must have none.
- A file's number may only go down. When a change removes errors, the baseline is lowered in the same change.
- The app stays JavaScript. Types are written as JSDoc where the checker needs them. Nothing is converted to `.ts`, and the build doesn't change.

## Consequences

- New code that sets properties dynamically has to declare them, usually with a JSDoc `@type` or `@typedef`. That is the cost of the check, and it falls on every change that adds a module.
- The baseline is a shared file that changes whenever an error is removed, so two changes that clean up the same file will conflict on it.
- The error count depends on the checker's version. Upgrading TypeScript means regenerating the baseline in that same change, and saying in the PR what moved.
- Raising a file's number is not allowed. If a real case needs it, that is a new decision.
- Turning on `strict`, or checking with no baseline, would each be a further decision.
