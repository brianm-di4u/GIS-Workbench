// Lazy pptxgenjs block (REQ-PRD-05): PowerPoint export of products and panel snapshots. The
// build removes the string-callback branch of JSZip's setImmediate polyfill (the only
// `new Function` in the bundle, never reached: JSZip passes functions), so the CSP needs no eval.

import PptxGenJS from 'pptxgenjs';

(globalThis.__lib ??= {})['js-pptx'] = { PptxGenJS };
