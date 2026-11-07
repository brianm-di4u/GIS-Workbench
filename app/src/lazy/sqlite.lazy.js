// Lazy SQLite (rtree-sql.js: sql.js built with the R*Tree module) for GeoPackage read and write
// (REQ-EXT-22, REQ-EXT-27). The WASM comes from its own verified block (wasm-sqlite).

import initSqlJs from 'rtree-sql.js/dist/sql-wasm.js';

(globalThis.__lib ??= {})['js-sqlite'] = { initSqlJs };
