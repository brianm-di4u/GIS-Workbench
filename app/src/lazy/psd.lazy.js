// Lazy Photoshop writer block (REQ-HUB-01): ag-psd (MIT) for File ▸ Send to ▸ Photoshop.

import { writePsd } from 'ag-psd';

(globalThis.__lib ??= {})['js-psd'] = { writePsd };
