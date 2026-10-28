// Lazy GeoParquet writer block (REQ-CNV-02): hyparquet-writer (MIT) for Convert ▸ GeoParquet.

import { parquetWriteBuffer, geojsonToWkb } from 'hyparquet-writer';

(globalThis.__lib ??= {})['js-parquet'] = { parquetWriteBuffer, geojsonToWkb };
