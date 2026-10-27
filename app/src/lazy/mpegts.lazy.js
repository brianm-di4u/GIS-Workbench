// Lazy mpegts.js block (REQ-FMV-05): demuxes MPEG-TS in JavaScript and feeds H.264/H.265 to
// Media Source Extensions from a Blob URL (fetch loader; CSP `connect-src blob:`). Its worker
// mode stays off, so it never builds a worker from a URL.

import mpegts from 'mpegts.js';

(globalThis.__lib ??= {})['js-mpegts'] = { mpegts };
