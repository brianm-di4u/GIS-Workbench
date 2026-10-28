// Two-row near-black status bar (REQ-UI-07, REQ-MEN-05). Row 1: cursor position,
// measurement, CRS, ground point. Row 2: CE, terrain source (green or red), LE, math model,
// vertical datum, GSD. Cells are user-selectable (right-click).

import { h } from './dom.js';
import { openMenu } from './menu.js';

export const CELLS = [
  ['cursor', 'Cursor position', 1],
  ['measure', 'Measurement', 1],
  ['crs', 'Coordinate system', 1],
  ['ground', 'Ground point', 1],
  ['ce', 'CE', 2],
  ['terrain', 'Terrain source', 2],
  ['le', 'LE', 2],
  ['model', 'Math model', 2],
  ['vdatum', 'Vertical datum', 2],
  ['gsd', 'GSD', 2],
  ['dn', 'Pixel value', 2],
  ['klvtime', 'KLV time basis', 2],
];

export class StatusBar {
  constructor(app, { rows = 2, id = 'mp' } = {}) {
    this.app = app;
    this.el = h('div', { class: 'statusbar', role: 'status', 'aria-label': 'Status bar', 'data-id': `status:${id}` });
    this.rows = [h('div', { class: 'status-row' }), h('div', { class: 'status-row' })];
    this.cells = {};
    const hidden = new Set(app.prefs.get('statusHidden') ?? []);
    for (const [key, label, row] of CELLS) {
      const c = h('div', { class: `status-cell sc-${key}`, title: label, 'data-id': `status:${key}`, hidden: hidden.has(key) });
      this.cells[key] = c;
      this.rows[row - 1].appendChild(c);
    }
    this.el.append(...this.rows.slice(0, rows));
    // Job indicator (REQ-SHL-07): a ring with the count and overall progress while any job runs;
    // a click opens the Job Queue.
    this.jobs = h('button', { class: 'status-jobs', type: 'button', hidden: true, 'data-id': `status:jobs:${id}`, 'aria-label': 'Background jobs' }, h('span', { class: 'job-ring', 'aria-hidden': 'true' }), h('span', { class: 'job-text' }));
    this.jobs.addEventListener('click', () => app.commands.run('dock.jobs'));
    this.rows[0].appendChild(this.jobs);
    let t = 0;
    app.pool?.on('job', () => {
      if (!t) t = setTimeout(() => ((t = 0), this.updateJobs()), 200);
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(
        CELLS.map(([key, label]) => ({
          label,
          checked: !this.cells[key].hidden,
          run: () => {
            this.cells[key].hidden = !this.cells[key].hidden;
            app.prefs.set('statusHidden', CELLS.map(([k]) => k).filter((k) => this.cells[k].hidden));
          },
        })),
        app,
        { x: e.clientX, y: e.clientY },
      );
    });
    this.set({ crs: 'Geographic | WGS_84 | HAE', vdatum: 'MSL(EGM96)', terrain: ['Terrain Not Available', 'bad'], model: 'Math Model: none', ce: 'CE: –', le: 'LE: –' });
  }

  /** Show running jobs (tile reads excluded: they are too short to matter). */
  updateJobs() {
    const jobs = [...(this.app.pool?.jobs.values() ?? [])].filter((j) => j.op !== 'tile');
    this.jobs.hidden = !jobs.length;
    if (!jobs.length) return;
    const withP = jobs.filter((j) => Number.isFinite(j.progress) && j.progress > 0);
    const pct = withP.length ? Math.round((withP.reduce((a, j) => a + j.progress, 0) / withP.length) * 100) : null;
    this.jobs.style.setProperty('--p', pct === null ? '25' : String(pct));
    this.jobs.classList.toggle('indeterminate', pct === null);
    const text = `${jobs.length} job${jobs.length > 1 ? 's' : ''}${pct === null ? '' : ` · ${pct} %`}`;
    this.jobs.lastChild.textContent = text;
    this.jobs.title = `${jobs.map((j) => j.label).slice(0, 5).join(', ')}${jobs.length > 5 ? '…' : ''} — click for the Job Queue`;
  }

  set(vals) {
    for (const [k, v] of Object.entries(vals)) {
      const c = this.cells[k];
      if (!c) continue;
      if (Array.isArray(v)) {
        if (c.textContent !== v[0]) c.textContent = v[0];
        c.classList.toggle('ok', v[1] === 'ok');
        c.classList.toggle('bad', v[1] === 'bad');
      } else if (c.textContent !== v) c.textContent = v;
      // A narrow cell ends in an ellipsis; its tooltip keeps the whole value (GUI-024).
      const label = CELLS.find(([key]) => key === k)[1];
      const tip = c.textContent ? `${label}: ${c.textContent}` : label;
      if (c.title !== tip) c.title = tip;
    }
  }
}
