# 0020: The sidecar's bundle adjuster stays separate from gw-aero, with a cross-check

- **Date:** 2026-11-13
- **Class:** design
- **Issue:** none. Raised by the council on #246, and decided in the orchestrator session: "Keep separate, add the cross-check. I approve your recommendation as provided".
- **Status:** accepted

## Context

Structure from motion with ground control (#246) added a bundle adjuster to the sidecar, `sidecar/gwb-sfm/src/ba.rs`. The app already has one in `crates/gw-aero`. The council asked whether the sidecar should reuse gw-aero instead. That would make the sidecar depend on `crates/` for the first time, which is a pattern other changes would copy.

## Decision

Keep them separate. The sidecar doesn't depend on `crates/`, and `ba.rs` stays in `sidecar/gwb-sfm`. The reasons:

- `sidecar/**` is T2, and most of `crates/` is T1. A dependency would let a T1 change alter the shipped sidecar.
- The two are separate workspaces, each with its own toolchain pin, lockfile, `deny.toml` and licence handling.
- gw-aero is tuned for WASM size and depends on `gw-abi`.
- The overlap is small, about 700 lines against 3,300, and the two serve different inputs: COLMAP pixel models in a local frame, and Brown models in mm with geodetic control.

Instead, a cross-check solves one synthetic block with both adjusters, and each must match the same expected solution within stated tolerances. Any divergence in the maths then fails.

## Consequences

- No code is shared and no dependency is added. The block and its expected solution are a checked-in fixture under `tests/fixtures/ba-cross-check/`, and each workspace's own tests solve it. A change to either adjuster that moves the solution fails that workspace's CI.
- Changing either adjuster's maths on purpose means regenerating the expected solution. The other side's test then shows whether it still agrees.
- Revisit this only if a third consumer appears. Then extract a small pure-maths crate, with no `gw-abi`, into a location reviewed as T2.
