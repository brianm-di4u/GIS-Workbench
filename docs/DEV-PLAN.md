# Development plan

Agents keep this current. Each task here becomes a `ready` issue that autopilot can pick up.

## Milestones

### 2.7.0, "Core GIS in the file"

No work starts until the admin says go. All items are Full build only, unless the wave's own plan tags one for Lite. Effort sizes are estimates. New Rust goes in new lazy bundles.

- REQ-GAP-79: buffer, overlay, dissolve, and spatial join for vector data. Effort M.
- REQ-GAP-80: hydrology: sink fill, flow, watersheds, and stream networks. Effort M.
- REQ-GAP-81: point cloud profile selection, with edit and delete of the selected points. Effort S.
- REQ-GAP-82: automatic endmember extraction. Effort S.
- REQ-GAP-16: the rest of the row, the EGM2008 geoid at 1 arc-minute as a pack. Effort S.
- REQ-GAP-78: Annex 14 obstacle free and obstacle evaluation surfaces. Effort M.
- D20: assign a CRS to LAS and LAZ files. Effort S.
- REQ-PRF-01: the lazy-loading pass. Effort as planned.

Exit scenarios and spikes are written when the wave starts. The AI wave follows in 2.8.0.

## Test matrix

Requirement coverage is in the private matrix, in the companion repo ([0004](decisions/0004-private-docs-repo.md)). This table stays empty here.

| Criterion | Test | Evidence |
|---|---|---|

## Defect log

No defects are logged here yet.

| Date | Defect | Found by | Fixed in |
|---|---|---|---|
