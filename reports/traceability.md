# Traceability — R0, R1, R2, R3

Generated 2026-10-28T02:09:44.165Z. 348 requirements; 348 tested.

Last results from 2724 test results: 324 passing; 18 passing (file); 1 cited, no result in the reports; 5 failing. Must requirements without a passing result: 2.

| Requirement | P | Rel | Status | Last result | Tests | Code |
|---|---|---|---|---|---|---|
| REQ-ARC-01 | M | R1 | tested | passing (8✓ 0✗) | platform.spec.js |  |
| REQ-ARC-02 | M | R1 | tested | passing (4✓ 0✗) | platform.spec.js, gates.test.js | boot.js, gates.mjs |
| REQ-ARC-03 | M | R1 | tested | passing (1✓ 0✗) | gates.test.js | gates.mjs |
| REQ-ARC-04 | M | R1 | tested | passing (7✓ 0✗) | gates.test.js | boot.js, build.mjs, gates.mjs |
| REQ-ARC-05 | M | R1 | tested | passing (2✓ 0✗) | platform.spec.js | decode.worker.js, pool.js |
| REQ-ARC-06 | S | R1 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | panels.js, commands.js |
| REQ-ARC-07 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | open.js, nitf.js, decode.worker.js |
| REQ-ARC-08 | M | R1 | tested | passing (10✓ 0✗) | platform.spec.js | files.js, open.js, commands.js +1 |
| REQ-ARC-09 | M | R1 | tested | passing (4✓ 0✗) | platform.spec.js | files.js, commands.js, project.js |
| REQ-ARC-10 | M | R1 | tested | passing (2✓ 0✗) | platform.spec.js | files.js, files.js |
| REQ-ARC-11 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | files.js, journal.js |
| REQ-ARC-12 | M | R1 | tested | passing (3✓ 0✗) | store.test.js | store.js, enhance.js |
| REQ-ARC-13 | M | R1 | tested | passing (7✓ 0✗) | store.test.js | undo.js, commands.js |
| REQ-ARC-14 | M | R3 | tested | passing (16✓ 0✗) | packs.spec.js | files.js, packs.js, commands.js +7 |
| REQ-ARC-15 | C | R2 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | build.mjs |
| REQ-ARC-16 | S | R2 | tested | passing (18✓ 0✗) | c18-live.spec.js, nav.spec.js, r2-gaps.spec.js, r2-platform.spec.js, stream-pc.spec.js | ai.js, online.js, pointcloud.js +5 |
| REQ-ARC-17 | C | R2 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | registry.js, tools-auto.js, automation.js +4 |
| REQ-ARC-18 | C | R3 | tested | passing (2✓ 0✗) | r3-review-products.spec.js | registry.js, tools-auto.js |
| REQ-ARC-19 | C | R2 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | files.js, commands.js, selfsave.js |
| REQ-ARC-20 | M | R1 | tested | passing (file) | platform.spec.js |  |
| REQ-ARC-21 | S | R2 | tested | passing (2✓ 0✗) | r2-platform.spec.js | files.js |
| REQ-ARC-22 | M | R1 | tested | passing (2✓ 0✗) | platform.spec.js | renderer.js |
| REQ-SEC-01 | M | R1 | tested | passing (4✓ 0✗) | platform.spec.js, gates.test.js | gates.mjs |
| REQ-SEC-02 | M | R1 | tested | passing (72✓ 0✗) | c01-ingest.spec.js, samples.spec.js, fuzz.rs | geotiff.js, decode.worker.js, fuzz.rs +3 |
| REQ-SEC-03 | M | R1 | tested | passing (2✓ 0✗) | graphics.spec.js | graphics.js, dom.js |
| REQ-SEC-04 | M | R1 | tested | passing (6✓ 0✗) | r1-musts.spec.js | dialogs.js, navigation.js, marking.js +3 |
| REQ-SEC-05 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | dialogs.js, marking.js |
| REQ-SEC-06 | S | R1 | tested | passing (4✓ 0✗) | shoulds.spec.js | workspace-tools.js, commands.js, journal.js |
| REQ-SEC-07 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | dialogs.js, commands.js |
| REQ-SEC-08 | M | R1 | tested | passing (2✓ 0✗) | gates.test.js | dialogs.js, gates.mjs |
| REQ-SEC-09 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | icons.js |
| REQ-SEC-10 | M | R2 | tested | passing (2✓ 0✗) | r2-platform.spec.js | online.js, remote-edit.js |
| REQ-SEC-11 | S | R2 | tested | passing (4✓ 0✗) | r2-platform.spec.js | release.js, commands.js |
| REQ-SEC-12 | M | R2 | tested | passing (18✓ 0✗) | c18-live.spec.js, platform.spec.js, r2-platform.spec.js | netlog.js, panels.js, commands.js |
| REQ-UI-01 | M | R1 | tested | passing (10✓ 0✗) | r1-musts.spec.js | commands.js, mappane.js, workspace.js |
| REQ-UI-02 | M | R1 | tested | passing (14✓ 0✗) | nav.spec.js | navigation.js, views.js, commands.js +1 |
| REQ-UI-03 | M | R1 | tested | passing (3✓ 0✗) | c00-registry.spec.js, look.spec.js | app.js, commands.js, ribbon-data.js +1 |
| REQ-UI-04 | S | R1 | tested | passing (6✓ 0✗) | shoulds.spec.js | workspace-tools.js, commands.js, multiport.js +1 |
| REQ-UI-05 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | commands.js, docks.js |
| REQ-UI-06 | S | R1 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | dialogs.js, panels.js, 40-overlays.css |
| REQ-UI-07 | M | R1 | tested | passing (2✓ 0✗) | look.spec.js | readout.js, statusbar.js, 20-shell.css |
| REQ-UI-08 | M | R1 | tested | passing (6✓ 0✗) | r1-musts.spec.js | commands.js, pane.js |
| REQ-UI-09 | M | R1 | tested | passing (6✓ 0✗) | r1-musts.spec.js | dialogs.js, prefs-ui.js, keys.js +2 |
| REQ-UI-10 | S | R1 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | dialogs.js, navigation.js, commands.js |
| REQ-UI-11 | S | R1 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | app.js, dialogs.js, commands.js +1 |
| REQ-UI-12 | M | R1 | tested | passing (10✓ 0✗) | look.spec.js | navigation.js, commands.js, 10-base.css +1 |
| REQ-UI-13 | M | R1 | tested | passing (2✓ 0✗) | look.spec.js | panels.js, pane.js, 20-shell.css |
| REQ-UI-14 | S | R1 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | dialogs.js, 40-overlays.css |
| REQ-UI-15 | S | R1 | tested | passing (2✓ 0✗) | help.test.js | dialogs.js, commands.js |
| REQ-UI-16 | M | R1 | tested | passing (6✓ 0✗) | look.spec.js | 20-shell.css |
| REQ-UI-17 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | prefs-ui.js, commands.js, tokens.mjs |
| REQ-UI-18 | M | R1 | tested | passing (14✓ 0✗) | r1-musts.spec.js | panels.js, views.js, commands.js |
| REQ-UI-19 | S | R1 | tested | passing (4✓ 0✗) | shoulds.spec.js | workspace-tools.js, commands.js, mappane.js |
| REQ-UI-20 | S | R2 | tested | passing (4✓ 0✗) | r2-platform.spec.js | devices.js, commands.js |
| REQ-UI-21 | S | R2 | tested | passing (2✓ 0✗) | r2-platform.spec.js | devices.js |
| REQ-UI-22 | C | R2 | tested | passing (2✓ 0✗) | closeout-geo.spec.js | devices.js |
| REQ-UI-23 | C | R1 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | dom.js |
| REQ-UI-24 | C | R2 | tested | passing (4✓ 0✗) | closeout-ui.spec.js | workspace-tools.js, commands.js, ribbon.js |
| REQ-UI-25 | S | R1 | tested | passing (4✓ 0✗) | shoulds.spec.js | workspace-tools.js, commands.js |
| REQ-UI-26 | M | R1 | tested | passing (16✓ 0✗) | c18-live.spec.js, closeout-geo.spec.js, nav.spec.js | online.js, commands.js, mappane.js |
| REQ-IMG-01 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | renderer.js, shaders.js, pane.js |
| REQ-IMG-02 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | navigation.js, shaders.js, commands.js |
| REQ-IMG-03 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | tiles.js, pyramid.js |
| REQ-IMG-04 | M | R1 | tested | passing (3✓ 0✗) | chain.test.js | enhance.js, chain.js, commands.js |
| REQ-IMG-05 | M | R1 | tested | passing (7✓ 0✗) | c03-enhance.spec.js, chain.test.js | enhance.js, chain.js, commands.js |
| REQ-IMG-06 | M | R1 | tested | passing (27✓ 0✗) | c03-enhance.spec.js, imaging.spec.js, chain.test.js | enhance-tools.js, enhance.js, chain.js +2 |
| REQ-IMG-07 | M | R1 | tested | passing (7✓ 0✗) | c03-enhance.spec.js, chain.test.js | enhance.js, chain.js, commands.js |
| REQ-IMG-08 | M | R1 | tested | passing (20✓ 0✗) | c03-enhance.spec.js, imaging.spec.js, shoulds.spec.js, chain.test.js | enhance-tools.js, fusion.js, image-layer.js +4 |
| REQ-IMG-09 | M | R1 | tested | passing (10✓ 0✗) | c03-enhance.spec.js, imaging.spec.js, chain.test.js | enhance-tools.js, enhance.js, shaders.js +1 |
| REQ-IMG-10 | S | R1 | tested | passing (4✓ 0✗) | c03-enhance.spec.js, shoulds.spec.js | fusion.js, renderer.js, commands.js +1 |
| REQ-IMG-11 | M | R1 | tested | passing (16✓ 0✗) | c03-enhance.spec.js, r1-musts.spec.js | commands.js, pane.js |
| REQ-IMG-12 | M | R1 | tested | passing (12✓ 0✗) | c03-enhance.spec.js, r1-musts.spec.js | navigation.js, commands.js, pane.js |
| REQ-IMG-13 | M | R1 | tested | passing (8✓ 0✗) | c03-enhance.spec.js, nav.spec.js | navigation.js, views.js, commands.js |
| REQ-IMG-14 | M | R1 | tested | passing (8✓ 0✗) | c03-enhance.spec.js, nav.spec.js | views.js, commands.js, minipane.js +2 |
| REQ-IMG-15 | M | R1 | tested | passing (8✓ 0✗) | c03-enhance.spec.js, nav.spec.js | navigation.js, views.js, commands.js |
| REQ-IMG-16 | C | R2 | tested | cited, no result in the reports | c03-enhance.spec.js |  |
| REQ-IMG-17 | S | R1 | tested | passing (4✓ 0✗) | c03-enhance.spec.js, shoulds.spec.js | measure-extras.js, commands.js |
| REQ-IMG-18 | S | R2 | tested | passing (10✓ 0✗) | c03-enhance.spec.js, closeout-geo.spec.js, ootf.spec.js | ootf.js, commands.js |
| REQ-IMG-19 | M | R1 | tested | passing (8✓ 0✗) | c03-enhance.spec.js, r1-musts.spec.js | enhance-tools.js, enhance.js, commands.js |
| REQ-IMG-20 | S | R1 | tested | passing (4✓ 0✗) | c03-enhance.spec.js, shoulds.spec.js | workspace-tools.js, commands.js, mosaic.js +1 |
| REQ-IMG-21 | S | R1 | tested | passing (4✓ 0✗) | c03-enhance.spec.js, imaging.spec.js | analyze.js, commands.js |
| REQ-IMG-22 | M | R1 | tested | passing (16✓ 0✗) | c03-enhance.spec.js, nav.spec.js | navigation.js, views.js, commands.js |
| REQ-IMG-23 | S | R2 | tested | passing (6✓ 0✗) | c03-enhance.spec.js, r2-products.spec.js | symbology.js, commands.js |
| REQ-IMG-24 | M | R1 | tested | passing (14✓ 0✗) | c03-enhance.spec.js, compare.spec.js | compare.js, renderer.js, commands.js +1 |
| REQ-IMG-25 | S | R1 | tested | passing (6✓ 0✗) | compare.spec.js | compare.js, webm.js, commands.js |
| REQ-IMG-26 | M | R1 | tested | passing (30✓ 0✗) | graphics.spec.js | graphics.js, commands.js, tools.js |
| REQ-IMG-27 | M | R1 | tested | passing (8✓ 0✗) | graphics.spec.js | graphics.js, commands.js, tools.js |
| REQ-IMG-28 | M | R1 | tested | passing (6✓ 0✗) | products.spec.js | products.js, tokens.js, commands.js +1 |
| REQ-IMG-29 | M | R1 | tested | passing (6✓ 0✗) | graphics.spec.js | dialogs.js, graphics.js, commands.js |
| REQ-IMG-30 | S | R1 | tested | passing (14✓ 0✗) | graphics.spec.js, shoulds.spec.js | aoi.js, change.js, graphics.js +3 |
| REQ-IMG-31 | C | R2 | tested | passing (8✓ 0✗) | closeout-geo.spec.js | graphics.js, commands.js, tools.js |
| REQ-IMG-32 | S | R2 | tested | passing (4✓ 0✗) | r2-products.spec.js | symbology.js, milsymbol.lazy.js, commands.js +1 |
| REQ-IMG-33 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | dialogs.js, image-layer.js |
| REQ-MEN-01 | M | R1 | tested | passing (4✓ 0✗) | c20-accuracy.spec.js, r1-musts.spec.js | measure.js, panels.js, commands.js +2 |
| REQ-MEN-02 | M | R1 | tested | passing (12✓ 0✗) | measure.spec.js | measure.js, commands.js, tools.js +1 |
| REQ-MEN-03 | M | R1 | tested | passing (4✓ 0✗) | measure.spec.js | measure.js, commands.js |
| REQ-MEN-04 | M | R1 | tested | passing (6✓ 0✗) | measure.spec.js | measure.js, commands.js |
| REQ-MEN-05 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | readout.js, commands.js, statusbar.js |
| REQ-MEN-06 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | dialogs.js, measure.js, commands.js +2 |
| REQ-MEN-07 | M | R1 | tested | passing (2✓ 0✗) | measure.spec.js | measure.js, tools.js, error.rs +1 |
| REQ-MEN-08 | S | R1 | tested | passing (6✓ 0✗) | shoulds.spec.js, square.rs | measure-extras.js, commands.js, core.js +3 |
| REQ-MEN-09 | C | R2 | tested | passing (4✓ 0✗) | closeout-geo.spec.js | measure.js, commands.js |
| REQ-MEN-10 | M | R1 | tested | passing (4✓ 0✗) | measure.spec.js | measure.js, commands.js |
| REQ-MEN-11 | M | R2 | tested | passing (4✓ 0✗) | scn06-07.spec.js | triangulation.js, commands.js, core.js +2 |
| REQ-MEN-12 | M | R2 | tested | passing (16✓ 0✗) | scn05.spec.js | stereo.js, commands.js |
| REQ-GEO-01 | M | R1 | tested | passing (2✓ 0✗) | c20-accuracy.spec.js, geodesy.test.js, geodesy.test.js | dialogs.js, commands.js, lib.rs +2 |
| REQ-GEO-02 | M | R1 | tested | passing (file) | geodesy.test.js, geodesy.test.js | geoid.rs, traceability.mjs |
| REQ-GEO-03 | M | R1 | tested | passing (file) | geodesy.test.js, geodesy.test.js | dem.js, terrain.js, geoid.rs +1 |
| REQ-GEO-04 | M | R1 | tested | passing (2✓ 0✗) | geodesy.test.js, imaging.spec.js | open.js, crs.js |
| REQ-GEO-05 | M | R1 | tested | passing (4✓ 0✗) | geodesy.test.js, r1-musts.spec.js, geodesy.test.js | geodesic.rs |
| REQ-GEO-06 | M | R1 | tested | passing (2✓ 0✗) | geodesy.test.js, geodesy.test.js | grids.rs |
| REQ-GEO-07 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | navigation.js, commands.js, core.js +1 |
| REQ-GEO-08 | M | R1 | tested | passing (4✓ 0✗) | r1-musts.spec.js | dialogs.js, commands.js, coords.rs |
| REQ-GEO-09 | S | R2 | tested | passing (4✓ 0✗) | r2-products.spec.js | readout.js, crs.js |
| REQ-GEO-10 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | wgs84.rs |
| REQ-GEO-11 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | app.js, time.rs |
| REQ-GEO-12 | C | R3 | tested | passing (2✓ 0✗) | packs.spec.js | packs.js, open.js, crs.js +2 |
| REQ-SNS-01 | M | R1 | tested | passing (file) | rpc.test.js | lib.rs |
| REQ-SNS-02 | M | R1 | tested | passing (18✓ 0✗) | c20-accuracy.spec.js, imaging.spec.js | lib.rs, rpc.rs |
| REQ-SNS-03 | S | R2 | tested | passing (2✓ 0✗) | c20-accuracy.spec.js, sensors-r2.spec.js, rpc.test.js, frame_rsm.rs | frames.js, open.js, rsm.js +5 |
| REQ-SNS-04 | S | R2 | tested | passing (2✓ 0✗) | sensors-r2.spec.js, frame_rsm.rs | frames.js, core.js, lib.rs +3 |
| REQ-SNS-05 | M | R1 | tested | passing (4✓ 0✗) | register.spec.js | register.js, commands.js, gcp.rs +1 |
| REQ-SNS-06 | M | R1 | tested | passing (242✓ 0✗) | c20-accuracy.spec.js, r1-musts.spec.js | dialogs.js, readout.js, open.js +2 |
| REQ-SNS-07 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | lib.rs, terrain.rs |
| REQ-SNS-08 | M | R1 | tested | passing (2✓ 0✗) | r1-musts.spec.js | error.rs, lib.rs |
| REQ-SNS-09 | M | R1 | tested | passing (14✓ 0✗) | register.spec.js | register.js, open.js, image-layer.js +3 |
| REQ-SNS-10 | M | R2 | tested | passing (4✓ 0✗) | scn05.spec.js | stereo.js, triangulation.js, commands.js |
| REQ-SNS-11 | M | R2 | tested | passing (4✓ 0✗) | scn06-07.spec.js | triangulation.js, commands.js, core.js +6 |
| REQ-SNS-12 | S | R2 | tested | passing (2✓ 0✗) | sensors-r2.spec.js | frames.js |
| REQ-SNS-13 | M | R2 | tested | passing (4✓ 0✗) | scn06-07.spec.js | triangulation.js, commands.js, photo.js +3 |
| REQ-SNS-14 | S | R2 | tested | passing (4✓ 0✗) | sensors-r2.spec.js | frames.js, open.js, commands.js +3 |
| REQ-SNS-15 | M | R2 | tested | passing (4✓ 0✗) | scn06-07.spec.js, fx04.rs | triangulation.js, commands.js, core.js +7 |
| REQ-SNS-16 | S | R2 | tested | passing (2✓ 0✗) | scn06-07.spec.js, fx04.rs | triangulation.js, photo.js, lib.rs +3 |
| REQ-SNS-17 | M | R2 | tested | passing (4✓ 0✗) | scn09.spec.js, ortho.rs | ortho.js, commands.js, raster.js +4 |
| REQ-SNS-18 | S | R2 | tested | passing (8✓ 0✗) | scn09.spec.js | ortho.js, commands.js, raster.js +3 |
| REQ-SNS-19 | C | R2 | tested | passing (4✓ 0✗) | closeout-geo.spec.js | ortho.js, commands.js |
| REQ-SNS-20 | S | R3 | tested | passing (2✓ 0✗) | scn15.spec.js, klv_frame.rs | fmv.js, core.js, lib.rs +3 |
| REQ-SNS-21 | C | R2 | tested | passing (2✓ 0✗) | closeout-geo.spec.js | triangulation.js, photo.js, lib.rs +1 |
| REQ-SNS-22 | S | R3 | tested | passing (6✓ 0✗) | c20-accuracy.spec.js |  |
| REQ-STR-01 | M | R2 | tested | passing (4✓ 0✗) | scn05.spec.js | stereo.js, commands.js |
| REQ-STR-02 | S | R2 | tested | passing (8✓ 0✗) | stereo-extra.spec.js | stereo.js, commands.js |
| REQ-STR-03 | M | R2 | tested | passing (6✓ 0✗) | scn05.spec.js | stereo.js, commands.js, pane.js |
| REQ-STR-04 | M | R2 | tested | passing (20✓ 0✗) | perf-r2.spec.js, scn05.spec.js | stereo.js, renderer.js, commands.js +1 |
| REQ-STR-05 | S | R2 | tested | passing (10✓ 0✗) | stereo-extra.spec.js | stereo.js, renderer.js, commands.js |
| REQ-STR-06 | C | R3 | tested | passing (6✓ 0✗) | stereo-out.spec.js | stereo-out.js, renderer.js, commands.js |
| REQ-STR-08 | M | R2 | tested | passing (6✓ 0✗) | scn05.spec.js | devices.js, stereo.js, commands.js +1 |
| REQ-STR-09 | M | R2 | tested | passing (8✓ 0✗) | scn05.spec.js | stereo.js, commands.js, lib.rs |
| REQ-STR-10 | M | R2 | tested | passing (2✓ 0✗) | stereo-extra.spec.js | stereo.js, views.js |
| REQ-STR-11 | S | R2 | tested | passing (20✓ 0✗) | r2-gaps.spec.js, str3d.spec.js | scene3d.js, three.lazy.js, view3d.js +3 |
| REQ-STR-12 | S | R2 | tested | passing (6✓ 0✗) | str3d.spec.js | scene3d.js, view3d.js, commands.js |
| REQ-STR-13 | S | R2 | tested | passing (4✓ 0✗) | str3d.spec.js | scene3d.js, view3d.js, commands.js |
| REQ-STR-14 | S | R2 | tested | passing (4✓ 0✗) | str3d.spec.js | scene3d.js, webm.js, view3d.js +1 |
| REQ-STR-15 | C | R3 | tested | passing (10✓ 0✗) | c18-live.spec.js, r2-gaps.spec.js, tiles3d.spec.js | scene3d.js, tiles3d.js, view3d.js +1 |
| REQ-STR-16 | C | R2 | tested | passing (4✓ 0✗) | closeout-geo.spec.js | stereo.js, commands.js |
| REQ-DEM-01 | M | R1 | tested | passing (38✓ 0✗) | c01-ingest.spec.js, r1-musts.spec.js, samples.spec.js | terrain.js, commands.js, dted.rs |
| REQ-DEM-02 | M | R1 | tested | passing (2✓ 0✗) | surface.spec.js | dem.js, terrain.js, decode.worker.js |
| REQ-DEM-03 | S | R1 | tested | passing (6✓ 0✗) | closeout-geo.spec.js | terrain-folder.js, terrain.js, commands.js |
| REQ-DEM-04 | M | R2 | tested | passing (4✓ 0✗) | scn08.spec.js | terrain-extract.js, commands.js, photo.js +3 |
| REQ-DEM-05 | S | R2 | tested | passing (2✓ 0✗) | dem05.spec.js | dem-tools.js, terrain-extract.js, lib.rs +1 |
| REQ-DEM-06 | S | R2 | tested | passing (2✓ 0✗) | scn08.spec.js | terrain-extract.js |
| REQ-DEM-07 | S | R2 | tested | passing (4✓ 0✗) | scn08.spec.js | dem-tools.js, commands.js |
| REQ-DEM-08 | M | R2 | tested | passing (4✓ 0✗) | scn08.spec.js | dem-tools.js, terrain.js, commands.js +1 |
| REQ-DEM-09 | M | R2 | tested | passing (2✓ 0✗) | scn08.spec.js | dem-tools.js |
| REQ-DEM-10 | M | R1 | tested | passing (12✓ 0✗) | c22-accuracy-gaps.spec.js, surface.spec.js | dem.js, shaders.js, commands.js |
| REQ-DEM-11 | M | R2 | tested | passing (6✓ 0✗) | scn08.spec.js, surface.spec.js | dem-tools.js, dem.js, extract.js +3 |
| REQ-DEM-12 | M | R1 | tested | passing (4✓ 0✗) | measure.spec.js | measure.js, commands.js |
| REQ-DEM-13 | M | R2 | tested | passing (8✓ 0✗) | c21-viewshed.spec.js, scn18.spec.js, viewshed.rs | terrain-analysis.js, commands.js, terrain.js +4 |
| REQ-DEM-14 | M | R2 | tested | passing (4✓ 0✗) | scn18.spec.js | terrain-analysis.js, commands.js, terrain.js +4 |
| REQ-DEM-15 | S | R2 | tested | passing (8✓ 0✗) | closeout-geo.spec.js, scn18.spec.js | measure-extras.js, terrain-analysis.js, commands.js |
| REQ-DEM-16 | M | R2 | tested | passing (4✓ 0✗) | scn08.spec.js | dem-tools.js, commands.js |
| REQ-DEM-17 | M | R2 | tested | passing (4✓ 0✗) | scn08.spec.js | dem-tools.js, commands.js |
| REQ-DEM-18 | S | R2 | tested | passing (4✓ 0✗) | c21-viewshed.spec.js, scn18.spec.js | terrain-analysis.js, commands.js |
| REQ-SAR-01 | M | R3 | tested | passing (39✓ 0✗) | c01-ingest.spec.js, scn12.spec.js, fuzz.rs | open.js, nitf.js, sicd.js +5 |
| REQ-SAR-02 | M | R3 | tested | passing (4✓ 0✗) | scn12.spec.js | sar.js, open.js, commands.js +2 |
| REQ-SAR-03 | M | R3 | tested | passing (6✓ 0✗) | scn12.spec.js | sar.js, chain.js, commands.js +1 |
| REQ-SAR-04 | M | R3 | tested | passing (12✓ 0✗) | scn12.spec.js | sar.js, renderer.js, commands.js +1 |
| REQ-SAR-05 | M | R3 | tested | passing (2✓ 0✗) | c20-accuracy.spec.js, scn12.spec.js, sicd_oracle.rs | sar.js, open.js, core.js +4 |
| REQ-SAR-06 | M | R3 | tested | passing (2✓ 0✗) | scn12.spec.js | sar.js, sicd.js, sicd.rs |
| REQ-SAR-07 | S | R3 | tested | passing (4✓ 0✗) | scn12.spec.js | sar.js, chain.js, shaders.js +6 |
| REQ-SAR-08 | S | R3 | tested | passing (4✓ 0✗) | scn12.spec.js | sar.js, commands.js, sar.js +4 |
| REQ-SAR-09 | S | R3 | tested | passing (6✓ 0✗) | c22-accuracy-gaps.spec.js, scn12.spec.js | sar.js, commands.js, sar.js +6 |
| REQ-SAR-10 | S | R3 | tested | passing (4✓ 0✗) | scn12.spec.js | sar.js, commands.js, sar.js +4 |
| REQ-SAR-11 | C | R3 | tested | passing (6✓ 0✗) | scn12.spec.js | sar.js, commands.js, sar.js +5 |
| REQ-SAR-12 | S | R3 | tested | passing (2✓ 0✗) | scn12.spec.js, fuzz.rs | sar.js, open.js, nitf.js +4 |
| REQ-SAR-13 | C | R3 | tested | passing (4✓ 0✗) | scn12.spec.js | sar.js, commands.js, sar.js +2 |
| REQ-SAR-14 | C | R3 | tested | passing (2✓ 0✗) | scn12.spec.js | sar.js, sar.js, lib.rs +1 |
| REQ-MSI-01 | M | R3 | tested | passing (128✓ 0✗) | c01-ingest.spec.js, scn13.spec.js | spectral.js, geotiff-writer.js, open.js +5 |
| REQ-MSI-02 | S | R3 | tested | passing (2✓ 0✗) | packs.spec.js | packs.js, hdf5.js, decode.worker.js +2 |
| REQ-MSI-03 | M | R3 | tested | passing (16✓ 0✗) | scn13.spec.js | spectral.js, commands.js |
| REQ-MSI-04 | M | R3 | tested | passing (24✓ 0✗) | c22-accuracy-gaps.spec.js, c30-workflows.spec.js, scn13.spec.js | spectral.js, image-layer.js, bandmath.js +4 |
| REQ-MSI-05 | M | R3 | tested | passing (8✓ 0✗) | c22-accuracy-gaps.spec.js, scn13.spec.js | spectral.js, open.js, image-layer.js +8 |
| REQ-MSI-06 | S | R3 | tested | passing (2✓ 0✗) | scn13.spec.js | spectral.js, image-layer.js, spectral.js +4 |
| REQ-MSI-07 | M | R3 | tested | passing (12✓ 0✗) | imaging.spec.js, scn13.spec.js | analyze.js, spectral.js, commands.js +6 |
| REQ-MSI-08 | M | R3 | tested | failing (4✓ 2✗) | c22-accuracy-gaps.spec.js, scn13.spec.js | spectral-analysis.js, open.js, commands.js +8 |
| REQ-MSI-09 | M | R3 | tested | passing (12✓ 0✗) | scn13.spec.js | spectral-analysis.js, open.js, commands.js +6 |
| REQ-MSI-10 | M | R3 | tested | failing (4✓ 2✗) | c22-accuracy-gaps.spec.js, scn13.spec.js | spectral-analysis.js, open.js, commands.js +6 |
| REQ-MSI-11 | M | R3 | tested | passing (6✓ 0✗) | scn13.spec.js | spectral-analysis.js, open.js, commands.js +7 |
| REQ-MSI-12 | S | R3 | tested | passing (4✓ 0✗) | scn13.spec.js | spectral-analysis.js, open.js, commands.js +6 |
| REQ-MSI-13 | S | R3 | tested | passing (4✓ 0✗) | scn13.spec.js | spectral-analysis.js, commands.js, spectral.js +6 |
| REQ-MSI-14 | S | R3 | tested | passing (6✓ 0✗) | c22-accuracy-gaps.spec.js, scn13.spec.js | spectral-analysis.js, commands.js, spectral.js +5 |
| REQ-MSI-15 | S | R3 | tested | passing (4✓ 0✗) | scn13.spec.js | spectral-analysis.js, commands.js |
| REQ-MSI-16 | C | R3 | tested | passing (6✓ 0✗) | scn13.spec.js | spectral-analysis.js, commands.js, misc.rs |
| REQ-LDR-01 | M | R2 | tested | passing (92✓ 0✗) | c01-ingest.spec.js, scn14.spec.js, fuzz.rs, fx09.rs | files.js, pointcloud.js, las.js +10 |
| REQ-LDR-02 | M | R2 | tested | passing (6✓ 0✗) | c18-live.spec.js, scn14.spec.js, stream-pc.spec.js | pointcloud.js, copc.js, view3d.js +4 |
| REQ-LDR-03 | M | R2 | tested | passing (2✓ 0✗) | scn14.spec.js, fx09.rs | pointcloud.js, las.js, pointcloud.js +6 |
| REQ-LDR-04 | M | R2 | tested | passing (10✓ 0✗) | scn14.spec.js | pointcloud.js, three.lazy.js, view3d.js +6 |
| REQ-LDR-05 | M | R2 | tested | passing (20✓ 0✗) | scn14.spec.js | pointcloud.js, view3d.js, commands.js +3 |
| REQ-LDR-06 | M | R2 | tested | passing (2✓ 0✗) | scn14.spec.js | pointcloud.js, view3d.js, commands.js +3 |
| REQ-LDR-07 | M | R2 | tested | passing (8✓ 0✗) | c30-workflows.spec.js, scn14.spec.js | pointcloud.js, view3d.js, commands.js +4 |
| REQ-LDR-08 | M | R2 | tested | passing (14✓ 0✗) | c30-workflows.spec.js, scn14.spec.js, fx09.rs | pointcloud.js, commands.js, pointcloud.js +4 |
| REQ-LDR-09 | S | R2 | tested | passing (8✓ 0✗) | scn14.spec.js, fx09.rs | pointcloud.js, commands.js, pointcloud.js +4 |
| REQ-LDR-10 | S | R2 | tested | passing (8✓ 0✗) | scn14.spec.js, fx09.rs | pointcloud.js, commands.js, pointcloud.js +4 |
| REQ-LDR-11 | C | R2 | tested | passing (6✓ 0✗) | closeout-geo.spec.js | pointcloud.js, points-io.js, commands.js |
| REQ-LDR-13 | S | R3 | tested | passing (88✓ 0✗) | c01-ingest.spec.js |  |
| REQ-FMV-01 | M | R3 | tested | passing (66✓ 0✗) | c01-ingest.spec.js, scn15.spec.js, fuzz.rs, fmv.rs | files.js, fmv.js, commands.js +5 |
| REQ-FMV-02 | M | R3 | tested | passing (28✓ 0✗) | c30-workflows.spec.js, scn15.spec.js, fmv.rs | fmv.js, commands.js, lib.rs +2 |
| REQ-FMV-03 | M | R3 | tested | passing (2✓ 0✗) | scn15.spec.js | fmv.js, pane.js, videoview.js +1 |
| REQ-FMV-04 | M | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, commands.js |
| REQ-FMV-05 | M | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, mpegts.lazy.js, commands.js +3 |
| REQ-FMV-06 | M | R3 | tested | passing (2✓ 0✗) | scn15.spec.js | fmv.js |
| REQ-FMV-07 | M | R3 | tested | passing (2✓ 0✗) | scn15.spec.js | fmv.js, mappane.js, fx10.mjs |
| REQ-FMV-08 | S | R3 | tested | passing (12✓ 0✗) | scn15.spec.js | fmv.js, commands.js, videoview.js |
| REQ-FMV-09 | S | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, commands.js, photo.js +1 |
| REQ-FMV-10 | S | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, commands.js |
| REQ-FMV-11 | S | R3 | tested | passing (6✓ 0✗) | scn15.spec.js | fmv.js, commands.js, lib.rs +1 |
| REQ-FMV-12 | S | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, commands.js, videoview.js +1 |
| REQ-FMV-13 | C | R3 | tested | passing (8✓ 0✗) | scn15.spec.js | fmv.js, commands.js, videoview.js |
| REQ-FMV-14 | C | R3 | tested | passing (4✓ 0✗) | scn15.spec.js | fmv.js, commands.js |
| REQ-EXT-01 | M | R1 | tested | passing (10✓ 0✗) | extract.spec.js | extract.js, commands.js, 40-overlays.css +1 |
| REQ-EXT-02 | M | R1 | tested | passing (2✓ 0✗) | extract.spec.js | extract.js, lib.rs, traceability.mjs |
| REQ-EXT-03 | S | R2 | tested | passing (4✓ 0✗) | scn10.spec.js | attribution.js, commands.js |
| REQ-EXT-04 | M | R1 | tested | passing (2✓ 0✗) | extract.spec.js | extract.js, index.js |
| REQ-EXT-05 | M | R1 | tested | passing (4✓ 0✗) | extract.spec.js | extract.js, commands.js, core.js +3 |
| REQ-EXT-06 | M | R1 | tested | passing (10✓ 0✗) | extract.spec.js | extract.js, commands.js |
| REQ-EXT-07 | M | R2 | tested | passing (4✓ 0✗) | scn10.spec.js | extract-r2.js, commands.js |
| REQ-EXT-08 | M | R1 | tested | passing (file) | extract.spec.js | extract.js, geom.js, index.js |
| REQ-EXT-09 | M | R2 | tested | passing (6✓ 0✗) | scn10.spec.js | attribution.js, panels.js, commands.js +1 |
| REQ-EXT-10 | M | R2 | tested | passing (6✓ 0✗) | scn10.spec.js, scn17-gpkg.spec.js | attribution.js, commands.js, schema.js |
| REQ-EXT-11 | S | R2 | tested | passing (4✓ 0✗) | scn10.spec.js | attribution.js, commands.js |
| REQ-EXT-12 | M | R1 | tested | passing (16✓ 0✗) | extract.spec.js | extract.js, commands.js |
| REQ-EXT-13 | M | R2 | tested | passing (8✓ 0✗) | r2-gaps.spec.js, scn10.spec.js, validate.rs | attribution.js, extract-r2.js, commands.js +4 |
| REQ-EXT-14 | M | R2 | tested | passing (2✓ 0✗) | scn10.spec.js | extract-r2.js, mesh.js |
| REQ-EXT-15 | C | R2 | tested | passing (4✓ 0✗) | r2-gaps.spec.js | extract-r2.js, commands.js, mesh.js |
| REQ-EXT-16 | S | R2 | tested | passing (4✓ 0✗) | scn10.spec.js, buildings.rs | extract-r2.js, commands.js, lib.rs +2 |
| REQ-EXT-17 | S | R2 | tested | passing (8✓ 0✗) | scn10.spec.js | extract-r2.js, commands.js |
| REQ-EXT-18 | C | R3 | tested | passing (4✓ 0✗) | packs.spec.js | ai-sam.js, packs.js, commands.js +2 |
| REQ-EXT-19 | S | R3 | tested | passing (4✓ 0✗) | r3-review-products.spec.js | detections.js, commands.js, fxproducts.mjs |
| REQ-EXT-20 | C | R3 | tested | passing (6✓ 0✗) | r3-review-products.spec.js | observations.js, commands.js |
| REQ-EXT-21 | M | R1 | tested | passing (166✓ 0✗) | c01-ingest.spec.js, extract.spec.js, vector-io.test.js | extract.js, files.js, shapefile.js +2 |
| REQ-EXT-22 | M | R2 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, scn17-gpkg.spec.js, scn17.spec.js | attribution.js, sqlite.lazy.js, commands.js +3 |
| REQ-EXT-23 | M | R1 | tested | passing (4✓ 0✗) | extract.spec.js, graphics.spec.js, vector-io.test.js | extract.js, graphics.js, io.js |
| REQ-EXT-24 | S | R2 | tested | passing (4✓ 0✗) | scn17-gpkg.spec.js | attribution.js, commands.js, csv.js |
| REQ-EXT-25 | M | R2 | tested | passing (4✓ 0✗) | scn10.spec.js | extract-r2.js, commands.js, mesh.js |
| REQ-EXT-26 | C | R3 | tested | passing (8✓ 0✗) | c18-live.spec.js, remote-edit.spec.js | remote-edit.js, commands.js |
| REQ-EXT-27 | M | R2 | tested | passing (2✓ 0✗) | scn17-gpkg.spec.js | attribution.js, sqlite.lazy.js, gpkg.js |
| REQ-EXT-28 | C | R3 | tested | passing (4✓ 0✗) | scn13.spec.js | spectral-analysis.js, commands.js, spectral.js +4 |
| REQ-FMT-01 | M | R1 | tested | passing (187✓ 0✗) | c01-ingest.spec.js, samples.spec.js | nitf.js, nitf.rs |
| REQ-FMT-02 | M | R1 | tested | passing (file) | c01-ingest.spec.js, samples.spec.js | jp2.js, nitf.js, lib.rs |
| REQ-FMT-17 | S | R1 | tested | passing (2✓ 0✗) | shoulds.spec.js, htj2k.rs, fuzz.rs | j2k.rs, htj2k.rs, fuzz.rs |
| REQ-FMT-03 | M | R1 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, r1-musts.spec.js | tre.rs |
| REQ-FMT-04 | M | R1 | tested | passing (203✓ 0✗) | c01-ingest.spec.js, c20-accuracy.spec.js, imaging.spec.js | geotiff.js |
| REQ-FMT-05 | M | R1 | tested | passing (8✓ 0✗) | c01-ingest.spec.js, c31-products.spec.js, writers.test.js | geotiff-writer.js, geotiff.js |
| REQ-FMT-06 | M | R1 | tested | passing (file) | c01-ingest.spec.js, writers.test.js | nitf-writer.js |
| REQ-FMT-07 | M | R1 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, r1-musts.spec.js, samples.spec.js | dted.rs |
| REQ-FMT-08 | M | R3 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, scn12.spec.js | lib.rs, sicd.rs |
| REQ-FMT-09 | M | R3 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, scn13.spec.js | envi.js, lib.rs, envi.rs |
| REQ-FMT-10 | M | R2 | tested | passing (file) | c01-ingest.spec.js, scn14.spec.js, fuzz.rs | las.js, lib.rs, fuzz.rs |
| REQ-FMT-11 | M | R3 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, scn15.spec.js |  |
| REQ-FMT-12 | M | R1 | tested | passing (file) | c01-ingest.spec.js, scn17.spec.js | shapefile.js, io.js |
| REQ-FMT-13 | S | R1 | tested | passing (2✓ 0✗) | c01-ingest.spec.js, shoulds.spec.js | workspace-tools.js |
| REQ-FMT-14 | C | R3 | tested | passing (10✓ 0✗) | formats-r3.spec.js, fuzz.rs | mie.js, open.js, commands.js +6 |
| REQ-FMT-15 | M | R1 | tested | passing (file) | scn01-03.spec.js, scn17.spec.js | fx06.mjs |
| REQ-FMT-16 | M | R1 | tested | passing (849✓ 0✗) | c01-ingest.spec.js, samples.rs | samples.rs |
| REQ-FMT-18 | S | R3 | tested | passing (52✓ 0✗) | c01-ingest.spec.js, c20-accuracy.spec.js |  |
| REQ-FMT-19 | C | R3 | tested | passing (10✓ 0✗) | c01-ingest.spec.js |  |
| REQ-PRD-01 | M | R1 | tested | passing (20✓ 0✗) | c31-products.spec.js, pages.spec.js, products.spec.js | products.js, chip.js, offscreen.js +2 |
| REQ-PRD-02 | M | R1 | tested | passing (12✓ 0✗) | pages.spec.js | product-pages.js, template.js, tokens.js +1 |
| REQ-PRD-03 | M | R1 | tested | passing (6✓ 0✗) | pages.spec.js, writers.test.js | product-pages.js, pdf-writer.js, template.js +2 |
| REQ-PRD-04 | M | R1 | tested | passing (6✓ 0✗) | pages.spec.js | product-pages.js, template.js, commands.js |
| REQ-PRD-05 | S | R2 | tested | passing (4✓ 0✗) | r2-products.spec.js | finishing.js, pptx.lazy.js, commands.js |
| REQ-PRD-06 | S | R2 | tested | passing (4✓ 0✗) | r2-products.spec.js | finishing.js, commands.js |
| REQ-PRD-07 | S | R1 | tested | passing (4✓ 0✗) | pages.spec.js | product-pages.js, commands.js |
| REQ-PRD-08 | C | R2 | tested | passing (4✓ 0✗) | closeout-geo.spec.js | commands.js |
| REQ-PRD-09 | C | R3 | tested | failing (5✓ 1✗) | r3-review-products.spec.js | finishing.js, media.js, docx.js +3 |
| REQ-PRD-10 | M | R1 | tested | passing (14✓ 0✗) | c31-products.spec.js, products.spec.js, writers.test.js | products.js, geotiff-writer.js, nitf-writer.js +1 |
| REQ-PRD-11 | S | R1 | tested | passing (6✓ 0✗) | pages.spec.js | product-pages.js, report.js, commands.js |
| REQ-PRD-12 | C | R3 | tested | failing (5✓ 1✗) | r3-review-products.spec.js | finishing.js, media.js, gif.js +1 |
| REQ-PRF-01 | M | R1 | tested | passing (file) | platform.spec.js | main.js |
| REQ-PRF-02 | M | R1 | tested | passing (2✓ 0✗) | perf.spec.js, perf-swiftshader.mjs |  |
| REQ-PRF-03 | M | R1 | tested | passing (2✓ 0✗) | perf.spec.js |  |
| REQ-PRF-04 | M | R1 | tested | passing (2✓ 0✗) | perf.spec.js | readout.js, core.js |
| REQ-PRF-05 | M | R2 | tested | passing (2✓ 0✗) | scn14.spec.js |  |
| REQ-PRF-06 | S | R2 | tested | failing (1✓ 1✗) | perf-r2.spec.js | gpu-sgm.js, terrain-extract.js, analysis.worker.js |
| REQ-PRF-07 | S | R2 | tested | passing (2✓ 0✗) | scn18.spec.js | gpu-viewshed.js, terrain-analysis.js |
| REQ-PRF-08 | M | R1 | tested | passing (2✓ 0✗) | perf.spec.js | dialogs.js |
| REQ-WB-01 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js | whiteboard.js, commands.js, 50-feedback.css +1 |
| REQ-WB-02 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js | model.js, whiteboard.js, traceability.mjs |
| REQ-WB-03 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | model.js, whiteboard.js, traceability.mjs |
| REQ-WB-04 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | capture.js, whiteboard.js, renderer.js +1 |
| REQ-WB-05 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | capture.js, whiteboard.js, traceability.mjs |
| REQ-WB-06 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | whiteboard.js, traceability.mjs |
| REQ-WB-07 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | model.js, whiteboard.js, traceability.mjs |
| REQ-WB-08 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js | review.js, whiteboard.js, commands.js +1 |
| REQ-WB-09 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js | model.js, review.js, whiteboard.js +1 |
| REQ-WB-10 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | feedback.js, whiteboard.js, traceability.mjs |
| REQ-WB-11 | S | R0 | tested | passing (6✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js | model.js, review.js, commands.js +1 |
| REQ-WB-12 | S | R1 | tested | passing (file) | triage.test.js | model.js, review.js |
| REQ-WB-13 | S | R1 | tested | passing (2✓ 0✗) | shoulds.spec.js, triage.test.js | model.js, review.js |
| REQ-WB-14 | S | R0 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | tools-gis.js, feedback.js |
| REQ-WB-15 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | capture.js, files.js |
| REQ-AI-01 | M | R0 | tested | passing (6✓ 0✗) | feedback-ai.spec.js | ai-extras.js, ai.js, commands.js +1 |
| REQ-AI-02 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js | providers.js, ai.js, commands.js |
| REQ-AI-03 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | providers.js, ai.js |
| REQ-AI-04 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | assistant.js, ai.js |
| REQ-AI-05 | M | R0 | tested | passing (6✓ 0✗) | feedback-ai.spec.js, platform.spec.js | netlog.js, ai.js, commands.js +1 |
| REQ-AI-06 | M | R0 | tested | passing (7✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js, store.test.js | registry.js, store.js, ai.js +1 |
| REQ-AI-07 | M | R0 | tested | passing (2✓ 0✗) | feedback-ai.spec.js | assistant.js, providers.js, registry.js +1 |
| REQ-AI-08 | M | R1 | tested | passing (2✓ 0✗) | ai-tools.spec.js | tools-gis.js |
| REQ-AI-09 | S | R1 | tested | passing (4✓ 0✗) | shoulds.spec.js | ai-extras.js, commands.js |
| REQ-AI-10 | S | R1 | tested | passing (4✓ 0✗) | pages.spec.js | ai.js, product-pages.js, report.js +1 |
| REQ-AI-11 | S | R1 | tested | passing (2✓ 0✗) | shoulds.spec.js | ai-extras.js |
| REQ-AI-12 | C | R3 | tested | passing (2✓ 0✗) | r3-review-products.spec.js | detections.js |
| REQ-AI-13 | M | R0 | tested | passing (6✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js | prompt-helper.js, commands.js |
| REQ-AI-14 | S | R1 | tested | passing (10✓ 0✗) | shoulds.spec.js, mcp.test.js | mcp-client.js, ai-extras.js, commands.js |
| REQ-AI-15 | S | R1 | tested | passing (7✓ 0✗) | shoulds.spec.js, mcp.test.js | mcp-server.js, ai-extras.js, commands.js |
| REQ-AI-16 | C | R2 | tested | passing (2✓ 0✗) | closeout-ui.spec.js | assistant.js, providers.js |
| REQ-AI-17 | M | R0 | tested | passing (4✓ 0✗) | feedback-ai.spec.js, feedback-ai.test.js | assistant.js, registry.js |
| REQ-AI-18 | C | R3 | tested | passing (2✓ 0✗) | packs.spec.js | ai-sam.js, packs.js, ai.worker.js +1 |
| REQ-HOST-01 | M | R0 | tested | passing (10✓ 0✗) | platform.spec.js | dialogs.js, runmode.js, commands.js |
| REQ-HOST-02 | M | R0 | tested | passing (file) | platform.spec.js | open.js, commands.js, files.js |
| REQ-HOST-03 | M | R0 | tested | passing (2✓ 0✗) | embed.spec.js | files.js |
| REQ-HOST-04 | M | R1 | tested | passing (4✓ 0✗) | embed.spec.js | build.mjs |
| REQ-HOST-05 | S | R1 | tested | passing (2✓ 0✗) | embed.spec.js | build.mjs |
| REQ-HOST-06 | M | R0 | tested | passing (4✓ 0✗) | embed.spec.js | build.mjs |
| REQ-HOST-07 | M | R0 | tested | passing (2✓ 0✗) | embed.spec.js | journal.js |
| REQ-HOST-08 | S | R1 | tested | passing (2✓ 0✗) | embed.spec.js | build.mjs |
| REQ-HOST-09 | M | R0 | tested | passing (64✓ 0✗) | c19-nonfunctional.spec.js, helpers.js, platform.spec.js |  |
| REQ-RUST-01 | M | R0 | tested | passing (3✓ 0✗) | platform.spec.js, gates.test.js | boot.js, gates.mjs |
| REQ-RUST-02 | M | R0 | tested | passing (7✓ 0✗) | gates.test.js | gates.mjs |
| REQ-RUST-03 | M | R0 | tested | passing (file) | abi.test.js | abi.js, lib.rs |
| REQ-RUST-04 | M | R0 | tested | passing (2✓ 0✗) | platform.spec.js | abi.js, pool.js, worker-core.js +1 |
| REQ-RUST-05 | M | R0 | tested | passing (file) | abi.test.js | build.rs, build.rs, build.rs +5 |
| REQ-RUST-06 | M | R0 | tested | passing (file) | geodesy.test.js | rpc.rs |
| REQ-RUST-07 | M | R0 | tested | passing (file) | fuzz.rs | lib.rs, fuzz.rs, lib.rs |
| REQ-RUST-08 | M | R0 | tested | passing (1✓ 0✗) | gates.test.js | gates.mjs |
| REQ-RUST-09 | M | R0 | tested | passing (2✓ 0✗) | gates.test.js | gates.mjs, rust.mjs |
| REQ-RUST-10 | S | R0 | tested | passing (file) | rpc.test.js | core.js |
| REQ-RUST-11 | S | R1 | tested | passing (2✓ 0✗) | gates.test.js | gates.mjs, rust.mjs |
