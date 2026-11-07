// Lazy HLS block (REQ-GAP-49; 2.5 group streams): the HLS client and its Media Source player
// (features/hls-player.js). The playlist parser and the TS → fMP4 transmuxer are DOM-free
// modules (media/hls.js, media/ts2mp4.js); the decode worker carries its own copy of the latter.

import { installHls } from '../features/hls-player.js';

(globalThis.__lib ??= {})['js-streams'] = { installHls };
