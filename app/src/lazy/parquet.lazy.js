// Lazy GeoParquet block (REQ-CNV-02): hyparquet-writer (MIT) for Convert ▸ GeoParquet, and hyparquet
// (MIT) to open GeoParquet files (WKB geometry; Snappy, GZIP or uncompressed pages).

import { parquetWriteBuffer, geojsonToWkb } from 'hyparquet-writer';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { wkbToGeojson } from 'hyparquet/src/wkb.js';

(globalThis.__lib ??= {})['js-parquet'] = { parquetWriteBuffer, geojsonToWkb, parquetMetadata, parquetReadObjects, wkbToGeojson };
