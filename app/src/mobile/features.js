// The feature modules GIS Workbench Lite installs (OD-2.23): the shared modules that implement the
// commands of data/lite-commands.json, and nothing that needs a desktop. A shared module may also
// register Full-only commands; Lite refuses those by name (shell/commands.js liteGap), and the
// mobile shell offers only Lite commands. tests/unit/profile.test.js checks that every Lite
// command is implemented by one of these modules.

import * as navigation from '../features/navigation.js';
import * as readout from '../features/readout.js';
import * as files from '../features/files.js';
import * as enhance from '../features/enhance.js';
import * as spectral from '../features/spectral.js';
import * as dialogs from '../features/dialogs.js';
import * as aoi from '../features/aoi.js';
import * as symbology from '../features/symbology.js';
import * as observations from '../features/observations.js';
import * as extract from '../features/extract.js';
import * as basemaps from '../features/basemaps.js';
import * as packs from '../features/packs.js';
import * as field from '../features/field-lazy.js';
import * as liteTools from './tools.js';

/** In install order: the tools (mensuration, graphics, undo) first, as panels.js does in Full. */
export const LITE_FEATURES = [liteTools, basemaps, navigation, readout, files, enhance, spectral, dialogs, aoi, symbology, observations, extract, packs, field];

