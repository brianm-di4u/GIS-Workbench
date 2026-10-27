# T&E owner-decision log

Some questions are the owner's to answer. Each one is logged here and parked until the owner decides.

| OD | Raised (TE / IMP) | Question | Options | Recommendation | Decision | Date |
|---|---|---|---|---|---|---|
| OD-01 | Campaign design | The performance reference laptop (Iris Xe, 16 GB) is unavailable. Do PRF results from the dev machine (Intel Arc) plus SwiftShader count as sign-off? | (a) Log the PRF numbers, keep O-14 open. (b) Accept the dev machine. | (a) | (a): reference laptop unavailable; PRF sign-off stays open | 2026-10-26 |
| OD-02 | Campaign design | Fix authority during execution. | Log only / fix within scope / fix everything | — | Fix everything found, including out-of-scope improvements. The hard constraints in TE-improvements.md still apply. | 2026-10-26 |
| OD-03 | Campaign design | Corpus size budget. | 1 / 5 / 20 GB | — | ~20 GB | 2026-10-26 |
| OD-04 | Data | Tier-B sources need a free login: Copernicus Data Space, NASA Earthdata (EMIT), ASI PRISMA, DLR EnMAP and USGS EarthExplorer (SRTM DTED). Will the owner download them? | Download / skip | Download the EMIT and DTED items at least. They are the only real NetCDF HSI and full DTED L1/L2 cells. | | |
| OD-05 | Data | No free public sample exists for STANAG 4607, MIE4NITF, NGA RSM (403) or WorldView IMD. | Stay on synthetic fixtures / owner obtains samples | Stay on synthetic fixtures; flag them in the report. | | |
| OD-06 | Data | Licence terms on some sources: Maxar Open Data is CC BY-NC; SpaceNet is CC BY-SA; Capella's terms have a sanctions clause; OSM is ODbL. Corpus data is used for testing only and never redistributed with the app. | Accept for testing / exclude | Accept for internal testing; never bundle. | | |
| OD-07 | TE-024 / IMP-15 | Country- and world-scale vector files (0.5–1.4 GB) cannot be parsed whole within the WASM memory caps. They are now refused by name above 512 MB (256 MB zipped). Should a later release stream them, through a range-read SQLite VFS with per-layer, per-extent paging? | (a) Keep the guard; users clip with ogr2ogr. (b) Plan streaming GPKG/Shapefile reading as a new requirement. | (b) as a Should for the next release; (a) meanwhile | Open: the owner decides | 2026-10-27 |
