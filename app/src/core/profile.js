// Build profiles (OD-2.23, DN-63 docs/design/profiles.md). GIS Workbench (Full) has every
// command and the desktop GUI; GIS Workbench Lite has the commands of data/lite-commands.json and
// the mobile GUI. A command that the list does not name is Full only: new commands are Full only
// until someone adds them to the list, in a group with a reason.

import LITE from '../data/lite-commands.json';
import { N_ } from '../i18n/index.js';

export const PROFILES = ['full', 'lite'];

/** The Lite list: [{id, title, reason, commands}]. */
export const LITE_GROUPS = LITE.groups;

/** The store record types Lite shows (a project keeps the others untouched). */
export const LITE_RECORDS = new Set(LITE.records);

/** Names for the record types only Full shows, for Lite’s notice on opening a project (REQ-GAP-86). */
export const FULL_RECORD_NAMES = {
  tin: N_('TIN surfaces'),
  tinedit: N_('TIN edits'),
  pointcloud: N_('point clouds'),
  pcedit: N_('point cloud edits'),
  chip: N_('image chips'),
  template: N_('capture templates'),
  change: N_('change results'),
  detection: N_('detections'),
  demedit: N_('DEM edits'),
  demblock: N_('DEM edits'),
  bookmark: N_('bookmarks'),
  msiclass: N_('classifications'),
  fmvevent: N_('video events'),
  catalog: N_('catalogues'),
  airport: N_('airports'),
  obstruction: N_('obstruction surfaces'),
  tripoint: N_('triangulation points'),
  trisolution: N_('triangulation solutions'),
  aerosolution: N_('aerotriangulation solutions'),
  valsession: N_('validation sessions'),
  finishing: N_('finished products'),
};

/** Every command id that is also in Lite. */
export const LITE_COMMANDS = new Set(LITE.groups.flatMap((g) => g.commands));

/** The profiles a command belongs to: ['full'] or ['full', 'lite']. */
export function profilesOf(id) {
  return LITE_COMMANDS.has(id) ? ['full', 'lite'] : ['full'];
}

/** The running build's profile, from its manifest: 'lite' for the Lite file, else 'full' (Standard and Air-gapped). */
export function buildProfile(gw = globalThis.__gw) {
  return gw?.manifest?.build?.profile === 'lite' ? 'lite' : 'full';
}

/** Whether command `id` belongs to `profile`. */
export function inProfile(id, profile) {
  return profile !== 'lite' || LITE_COMMANDS.has(id);
}
