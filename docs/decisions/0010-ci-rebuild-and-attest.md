# 0010: Rebuild and attest the release HTML in CI

- **Date:** 2026-11-09
- **Class:** security
- **Issue:** #31
- **Status:** accepted

## Context

Release assets are built on the admin's Windows PC. Nobody outside could check that the published HTML came from the tagged commit. Builds of one commit are byte-identical (#36), but Node's gzip writes an OS byte, so a Linux rebuild wouldn't match.

## Decision

Option A. At `cut`, a `windows-latest` job in `release.yml` builds the three HTML files from the release commit, attests them with `actions/attest-build-provenance`, and the draft job attaches their hashes as the asset `CI-SHA256SUMS`. Only that job gets `id-token: write` and `attestations: write`.

`CI-SHA256SUMS` is `sha256sum` output for `gis-workbench.html`, `gis-workbench-lite.html` and `gis-workbench-airgap.html`, uploaded by `github-actions[bot]`. `build/release/upload.mjs` refuses to upload, and `--check` fails, unless that asset is on the draft from that uploader and every staged HTML file matches it.

## Consequences

- A release can't be published from HTML that the workflow's rebuild doesn't reproduce. A stale `node_modules` or a skipped pack on the admin's PC is caught before upload.
- Anyone can run `gh attestation verify <file> --repo <owner>/<repo>` on the published HTML.
- `CI-SHA256SUMS` is never staged. Release tools that list a release's assets skip it.
- Each cut costs one Windows build, which fetches every pack input.
