# GIS Workbench

@.pipeline/AUTONOMY.md
@docs/POLICY.md

## Project

A single-file, offline, browser-based GIS for civilian use, with an optional native sidecar. Public scope is in [docs/PRD.md](docs/PRD.md), and decisions are in [docs/decisions/](docs/decisions/). Full requirements, plans, and test records are in the private repo, checked out beside this one at `../Docs`.

Layout: `app/` is the browser app, `crates/` is Rust compiled to WASM, `sidecar/` is the native sidecar, `build/` is the build and its gates, and `tests/` holds unit, golden, and browser tests.

## Commands

- `node .pipeline/verify.mjs fast`: quick checks, run often.
- `node .pipeline/verify.mjs full`: what CI runs, scoped to this branch. Must pass before a PR.
- `node .pipeline/verify.mjs e2e`: the full local gate, about 9 hours. Run it only before a release.
- `node .pipeline/gate.mjs classify`: this branch's change hash and tier.
- `node .pipeline/gate.mjs local`: check the gate for the current PR.
- `npm run build`: build `dist/`. `npx playwright test --project=ci tests/e2e/<spec>`: run one browser suite.

## Conventions

- `dist/` is built, not tracked. Tests use the built file, so rebuild after changing `app/` or `crates/`.
- Never hand-edit `app/src/i18n/catalog/`. English strings come from `t()` and `N_()`, and translations land in their own PRs.
- Keep large test output on E:. D: is failing; write nothing to it. Set `TE_OUT` for anything that writes gigabytes.
- Windows paths here contain spaces. Quote them.
