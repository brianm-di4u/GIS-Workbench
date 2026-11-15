# 0023: Long sidecar-job tests run on one browser in the release gate

- **Date:** 2026-11-14
- **Class:** determination
- **Issue:** #274
- **Status:** accepted

## Context

The release gate e2e (`verify e2e`) for 2.7.1 took 8.66 hours: 1.31 for the browser pass and 7.35 for the sidecar pass, which ran the 93 sidecar tests on Chrome (221 minutes) and again on Edge (218 minutes). A dozen long tests made up most of it: the 10 GB FITS read, SfM on 77 photographs, SCN-82's two stages, TileDB, KEA and the HDF-EOS cases. These are sidecar jobs checked against GDAL, h5py or a reference. The browser only starts the job, so the Edge run repeats the same sidecar code on the same data. At 8 to 9 hours a run, one flaky test or a late fix costs most of a day.

## Decision

Option A. The long sidecar-job tests run on Chrome only (the `sidecar` project). Every test where the page does the work (UI, rendering, file handling in the page) still runs on both browsers.

- A test opts in with the tag `@sidecar-job` (`test(title, { tag: '@sidecar-job' }, …)`). The `sidecar-edge` project has `grepInvert: /@sidecar-job/`. There is no hand-kept list.
- A test qualifies when the page only starts a sidecar job, or there is no page at all, and the result is checked against a reference.
- Tagged when this was decided:
  - all of `26-plugindata.spec.js`, which opens no page;
  - SCN-63 Aukerman in `26-sfm.spec.js`;
  - all of `28-sfm-gcp.spec.js` (SCN-82). Its marking-dialog test reads the model made by the tagged stage-2 test in the same serial file, so it can only run where that does. Its page work runs in both browsers in `tests/e2e/28-sfm-mark.spec.js`, against a mocked sidecar: the click, the arrow keys and Enter, and the axe pass on both SfM dialogs (control and marking). Edge loses only the click on a full-size real photograph.

## Consequences

- The gate's sidecar pass drops by about 213 minutes, the Edge time of the tagged tests on 2.7.1. The gate goes from about 8.7 hours to about 5.1.
- Lost: the same sidecar job started from Edge's page, which is the same HTTP call to the same sidecar.
- A new long sidecar-job test should carry the tag. A test where the page does real work must not, even if it is slow.
- Running the timing-insensitive part outside the machine lock (option B) was not chosen.
