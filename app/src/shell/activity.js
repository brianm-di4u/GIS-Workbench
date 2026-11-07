// The activity indicator (OD-2.27, REQ-ING-04): anything that can take more than 2 s says what is
// running, for how long, how far along when that is known, and offers Cancel when it can stop. It
// appears at 300 ms, in Full and in Lite, and is one element for the whole app.
//
// Worker jobs, AI tasks and sidecar jobs appear by themselves. Anything else takes one call:
//
//   await app.activity.track(t('Exporting…'), async (job) => { job.set(0.5); … });
//
// Work on the main thread cannot redraw while it runs, so it asks for a paint first:
//
//   const job = await app.activity.start(t('Writing the snapshot…'));
//   try { heavySyncWork(); } finally { job.end(); }
//
// Between stretches of such work, `await job.step(0.8, t('Grouping…'))` shows the new state first.
// With `{ cancel: true }` (or a function) the indicator offers Cancel; the work watches
// `job.cancelled` or `job.signal`. The moving bar runs on the compositor, so it keeps moving while
// the main thread is busy; the timer text waits for the next free moment. Pool jobs that are parts
// of reported work take `{ part: true }`, so one task reads as one task.

import { h } from './dom.js';
import { N_, t, tr } from '../i18n/index.js';
import { int } from '../i18n/format.js';

export const SHOW_AFTER_MS = 300;
const HOLD_MS = 500; // a job that ends is not replaced by a flicker when the next one starts
const TICK_MS = 250;

/** Worker operations too short or too frequent to report: reads behind the view, and clean-up. */
const QUIET_OPS = new Set(['tile', 'warpTile', 'tsTile', 'tsDecompress', 'mvtRender', 'pixels', 'mpvrun', 'close', 'mpvclose', 'retain']);
/** Worker operations whose call sites give no label. */
const OP_LABELS = {
  open: N_('Opening file…'),
  stats: N_('Computing image statistics…'),
  tsindex: N_('Indexing video…'),
  window: N_('Reading image data…'),
  patch: N_('Reading image data…'),
  spectral: N_('Reading spectra…'),
  cube: N_('Reading image cube…'),
};

/** Resolves once the browser has drawn; a hidden tab draws nothing, so it never waits long. */
export function nextPaint() {
  return new Promise((res) => {
    const timer = setTimeout(res, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => (clearTimeout(timer), res())));
  });
}

/** Elapsed time as the indicator shows it. */
export function elapsedText(ms) {
  const s = Math.floor(ms / 1000);
  return s < 60 ? t('{n} s', { n: int(s) }) : t('{m} min {s} s', { m: int(Math.floor(s / 60)), s: int(s % 60) });
}

export class Activity {
  constructor(app) {
    this.app = app;
    this.tracked = new Map();
    this.firstSeen = new Map(); // AI tasks and sidecar jobs report no start time
    this.nextId = 0;
    this.timer = 0;
    this.lastShown = 0;
    this.shownLabel = null;
    this.current = null;
    const wake = () => this.wake();
    app.pool?.on('job', wake);
    app.on?.('sidecar-jobs', wake);
  }

  /** Report work that is not a worker job. Returns {set(fraction, label?), step(…), end(), cancelled, signal}. */
  begin(label, { cancel = null, immediate = false } = {}) {
    const ac = new AbortController();
    const id = `activity-${++this.nextId}`;
    const job = {
      id,
      cancelled: false,
      signal: ac.signal,
      set: (progress, text) => {
        item.progress = progress;
        if (text) item.label = text;
      },
      /** `set`, then wait until it is on screen: for use before more main-thread work. */
      step: async (progress, text) => {
        job.set(progress, text);
        item.immediate = true;
        this.render();
        await nextPaint();
      },
      end: () => {
        if (this.tracked.delete(id)) this.changed();
      },
    };
    const item = {
      id,
      label,
      progress: NaN,
      started: performance.now(),
      immediate,
      cancel: cancel
        ? () => {
            job.cancelled = true;
            ac.abort();
            if (typeof cancel === 'function') cancel();
          }
        : null,
    };
    this.tracked.set(id, item);
    this.changed();
    return job;
  }

  /** Begin, show at once and wait for the paint: for work about to hold the main thread. */
  async start(label, opts = {}) {
    const job = this.begin(label, { ...opts, immediate: true });
    this.render();
    await nextPaint();
    return job;
  }

  /** Run `work(job)` with the indicator up; it ends however the work ends. */
  async track(label, work, opts = {}) {
    const job = opts.immediate ? await this.start(label, opts) : this.begin(label, opts);
    try {
      return await work(job);
    } finally {
      job.end();
    }
  }

  /** Everything running: reported work first, then AI tasks, sidecar jobs and worker jobs, oldest first. */
  items() {
    const app = this.app;
    const now = performance.now();
    const seen = new Set();
    const since = (key) => {
      seen.add(key);
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, now);
      return this.firstSeen.get(key);
    };
    const ai = (app.aiTasks?.() ?? []).map((k) => ({ id: k.id, label: k.label, progress: k.progress, started: since(k.id), cancel: k.cancel }));
    const sidecar = (app.sidecarJobs?.() ?? []).map((j) => ({ id: j.id, label: j.label, progress: j.progress, started: since(j.id), cancel: j.cancel }));
    for (const k of this.firstSeen.keys()) if (!seen.has(k)) this.firstSeen.delete(k);
    const pool = [...(app.pool?.jobs.values() ?? [])]
      .filter((j) => !QUIET_OPS.has(j.op) && !j.part)
      .sort((a, b) => a.created - b.created)
      .map((j) => ({ id: j.id, label: j.label && j.label !== j.op ? j.label : tr(OP_LABELS[j.op] ?? N_('Working…')), progress: j.progress, eta: j.eta, started: j.created, cancel: () => app.pool.cancel(j.id) }));
    return [...this.tracked.values(), ...ai, ...sidecar, ...pool];
  }

  changed() {
    this.app.emit?.('activity');
    this.wake();
  }

  wake() {
    if (!this.timer) this.timer = setInterval(() => this.render(), TICK_MS);
  }

  ensure() {
    if (this.el) return;
    this.labelEl = h('span', { class: 'activity-label' });
    this.timeEl = h('span', { class: 'activity-time', 'aria-hidden': 'true' });
    this.barEl = h('div', { class: 'activity-bar', role: 'progressbar' }, h('i'));
    this.cancelEl = h('button', { class: 'btn btn-small activity-cancel', type: 'button', 'data-id': 'activity:cancel', hidden: true }, t('Cancel'));
    this.cancelEl.addEventListener('click', () => this.current?.cancel?.());
    this.moreEl = h('button', { class: 'btn btn-small activity-more', type: 'button', 'data-id': 'activity:more', hidden: true });
    this.moreEl.addEventListener('click', () => this.app.commands?.run('dock.jobs'));
    this.el = h('div', { class: 'activity', role: 'status', 'data-id': 'activity', hidden: true }, h('div', { class: 'activity-row' }, this.labelEl, this.timeEl, this.moreEl, this.cancelEl), this.barEl);
    document.body.appendChild(this.el);
  }

  render() {
    const now = performance.now();
    const items = this.items();
    const due = items.filter((i) => i.immediate || now - i.started >= SHOW_AFTER_MS);
    if (!due.length) {
      if (this.el && !this.el.hidden && now - this.lastShown >= HOLD_MS) {
        this.el.hidden = true;
        this.current = null;
        this.shownLabel = null;
      }
      if (!items.length && (!this.el || this.el.hidden)) {
        clearInterval(this.timer);
        this.timer = 0;
      }
      return;
    }
    this.ensure();
    this.lastShown = now;
    const item = due[0];
    this.current = item;
    const known = Number.isFinite(item.progress) && item.progress > 0;
    const pct = known ? Math.min(100, Math.round(item.progress * 100)) : null;
    if (this.shownLabel !== item.label) {
      this.shownLabel = item.label;
      this.labelEl.textContent = item.label;
      this.barEl.setAttribute('aria-label', item.label);
    }
    const parts = [elapsedText(now - item.started)];
    if (known) parts.push(t('{pct} %', { pct: int(pct) }));
    if (item.eta > 1500) parts.push(item.eta > 90000 ? t('{n} min left', { n: int(Math.round(item.eta / 60000)) }) : t('{n} s left', { n: int(Math.round(item.eta / 1000)) }));
    this.timeEl.textContent = parts.join(' · ');
    this.el.classList.toggle('indeterminate', !known);
    this.barEl.style.setProperty('--p', known ? String(item.progress) : '0');
    if (known) this.barEl.setAttribute('aria-valuenow', String(pct));
    else this.barEl.removeAttribute('aria-valuenow');
    this.cancelEl.hidden = !item.cancel;
    const others = due.length - 1;
    // Full only: Lite has no Job Queue, so there it is a count and nothing to press.
    const queue = this.app.commands?.get?.('dock.jobs') && this.app.edition !== 'lite';
    this.moreEl.hidden = !others;
    this.moreEl.disabled = !queue;
    if (others) this.moreEl.textContent = t('{n} more', { n: int(others) });
    this.el.hidden = false;
  }
}
