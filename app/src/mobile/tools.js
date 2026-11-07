// Lite: the interactive tools (tools/tools.js: navigation, graphics and mono mensuration) and the
// hooks the shared features call to show a panel or a cue. In Full these are features/panels.js
// (docks); here they open the mobile shell's sheets.

import { installTools } from '../tools/tools.js';
import { menRow } from '../tools/menlog.js';

export const name = 'lite-tools';

export function install(app) {
  installTools(app);
  app.menRowOf = menRow;
  app.panels = {
    show: (id) => app.shell?.showPanel(id),
    toggle: (id) => app.shell?.showPanel(id),
  };
  app.cue = (text) => {
    app.cueText = text;
    app.emit('cue');
  };
}
