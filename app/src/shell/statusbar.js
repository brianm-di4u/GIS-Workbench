// Two-row near-black status bar (REQ-UI-07, REQ-MEN-05). Row 1: cursor position,
// measurement, CRS, ground point. Row 2: CE, terrain source (green or red), LE, math model,
// vertical datum, GSD. Cells are user-selectable (right-click).

import { h } from './dom.js';
import { openMenu } from './menu.js';
import { N_, t, tr } from '../i18n/index.js';
import { int } from '../i18n/format.js';

/** [key, label (English source, shown with tr), row]. CE, LE and GSD are standard abbreviations. */
export const CELLS = [
  ['cursor', N_('Cursor position'), 1],
  ['measure', N_('Measurement'), 1],
  ['crs', N_('Coordinate system'), 1],
  ['ground', N_('Ground point'), 1],
  ['ce', 'CE', 2],
  ['terrain', N_('Terrain source'), 2],
  ['le', 'LE', 2],
  ['model', N_('Math model'), 2],
  ['vdatum', N_('Vertical datum'), 2],
  ['gsd', 'GSD', 2],
  ['dn', N_('Pixel value'), 2],
  ['klvtime', N_('KLV time basis'), 2],
];

export class StatusBar {
  constructor(app, { rows = 2, id = 'mp' } = {}) {
    this.app = app;
    this.el = h('div', { class: 'statusbar', role: 'status', 'aria-label': t('Status bar'), 'data-id': `status:${id}` });
    this.rows = [h('div', { class: 'status-row' }), h('div', { class: 'status-row' })];
    this.cells = {};
    const hidden = new Set(app.prefs.get('statusHidden') ?? []);
    for (const [key, label, row] of CELLS) {
      const c = h('div', { class: `status-cell sc-${key}`, title: tr(label), 'data-id': `status:${key}`, hidden: hidden.has(key) });
      this.cells[key] = c;
      this.rows[row - 1].appendChild(c);
    }
    this.el.append(...this.rows.slice(0, rows));
    // Job indicator (REQ-SHL-07): a ring with the count and overall progress while any job runs;
    // a click opens the Job Queue.
    this.jobs = h('button', { class: 'status-jobs', type: 'button', hidden: true, 'data-id': `status:jobs:${id}`, 'aria-label': t('Background jobs') }, h('span', { class: 'job-ring', 'aria-hidden': 'true' }), h('span', { class: 'job-text' }));
    this.jobs.addEventListener('click', () => app.commands.run('dock.jobs'));
    this.rows[0].appendChild(this.jobs);
    let pending = 0;
    app.pool?.on('job', () => {
      if (!pending) pending = setTimeout(() => ((pending = 0), this.updateJobs()), 200);
    });
    app.on?.('sidecar-jobs', () => {
      if (!pending) pending = setTimeout(() => ((pending = 0), this.updateJobs()), 200);
    });
    app.on?.('activity', () => {
      if (!pending) pending = setTimeout(() => ((pending = 0), this.updateJobs()), 200);
    });
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMenu(
        CELLS.map(([key, label]) => ({
          label: tr(label),
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
    this.set({ crs: 'Geographic | WGS_84 | HAE', vdatum: 'MSL(EGM96)', terrain: [t('Terrain Not Available'), 'bad'], model: t('Math Model: none'), ce: 'CE: –', le: 'LE: –' });
  }

  /** Show running jobs (tile reads excluded: they are too short to matter). */
  updateJobs() {
    // Sidecar conversions join the same indicator (REQ-SDC-06).
    const jobs = [...[...(this.app.pool?.jobs.values() ?? [])].filter((j) => j.op !== 'tile'), ...(this.app.sidecarJobs?.() ?? []), ...(this.app.aiTasks?.() ?? []), ...(this.app.activity ? [...this.app.activity.tracked.values()] : [])];
    this.jobs.hidden = !jobs.length;
    if (!jobs.length) return;
    const withP = jobs.filter((j) => Number.isFinite(j.progress) && j.progress > 0);
    const pct = withP.length ? Math.round((withP.reduce((a, j) => a + j.progress, 0) / withP.length) * 100) : null;
    this.jobs.style.setProperty('--p', pct === null ? '25' : String(pct));
    this.jobs.classList.toggle('indeterminate', pct === null);
    const n = jobs.length;
    const text = pct === null ? t('{n, plural, one {# job} other {# jobs}}', { n }) : t('{n, plural, one {# job} other {# jobs}} · {p} %', { n, p: int(pct) });
    this.jobs.lastChild.textContent = text;
    // WCAG 2.5.3: the accessible name holds the visible text. Found in Firefox, whose slower start
    // leaves a job running while axe scans; the fixed name failed in every browser with a job showing.
    this.jobs.setAttribute('aria-label', t('Background jobs: {jobs}', { jobs: text }));
    this.jobs.title = t('{jobs} — click for the Job Queue', { jobs: `${jobs.map((j) => j.label).slice(0, 5).join(', ')}${n > 5 ? '…' : ''}` });
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
      const label = tr(CELLS.find(([key]) => key === k)[1]);
      const tip = c.textContent ? t('{cell}: {value}', { cell: label, value: c.textContent }) : label;
      if (c.title !== tip) c.title = tip;
    }
  }
}
