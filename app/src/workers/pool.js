// Persistent pool of classic Blob-URL workers (REQ-ARC-05, Research/15 §6.3). Each worker's
// source is the shared worker core followed by its kind's code, both taken from verified
// inline blocks. Jobs have ids, priorities, progress, cancel and time-outs; buffers move as
// transferables; no SharedArrayBuffer. A worker that hangs is terminated and replaced; a
// trapped WASM instance is re-created inside the worker (REQ-RUST-04).

import { Emitter, newId } from '../core/util.js';

const PRI = { interactive: 0, normal: 1, background: 2 };
// CPU-bound kinds run one job per worker; the pool adds workers up to its size instead.
const CPU_KINDS = new Set(['analysis', 'pointcloud', 'ai']);

export class WorkerPool extends Emitter {
  constructor({ gw, modules, lazyModules = {}, size } = {}) {
    super();
    this.gw = gw;
    this.modules = modules; // { core: WebAssembly.Module, parse?: Promise<Module> }
    this.lazyModules = lazyModules; // name → () => Promise<Module>, compiled on a worker's first request
    this._lazy = new Map();
    this.size = size ?? Math.max(2, Math.min((navigator.hardwareConcurrency || 4) - 2, 6));
    this.workers = new Map(); // kind → [slot]
    this.urls = new Map();
    this.jobs = new Map();
    this.queue = [];
    this.history = [];
    this.slotOf = new Map(); // job id → worker slot id (for file affinity)
    this._spawning = new Map(); // kind → workers being started
  }

  async _url(kind) {
    if (!this.urls.has(kind)) {
      this.urls.set(
        kind,
        (async () => {
          const [core, body] = await Promise.all([this.gw.text('js-worker-core'), this.gw.text(`js-worker-${kind}`)]);
          return URL.createObjectURL(new Blob([core, '\n;\n', body], { type: 'text/javascript' }));
        })(),
      );
    }
    return this.urls.get(kind);
  }

  async _spawn(kind) {
    const url = await this._url(kind);
    const w = new Worker(url, { name: `gw-${kind}` });
    const slot = { kind, w, busy: 0, id: newId('wk'), ready: null };
    const mods = {};
    for (const [k, m] of Object.entries(this.modules)) mods[k] = await m;
    slot.ready = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${kind} worker did not start`)), 15000);
      const onMsg = (e) => {
        if (e.data?.type === 'ready') {
          clearTimeout(t);
          w.removeEventListener('message', onMsg);
          res();
        } else if (e.data?.type === 'init-error') {
          clearTimeout(t);
          rej(new Error(e.data.error));
        }
      };
      w.addEventListener('message', onMsg);
    });
    w.addEventListener('message', (e) => this._onMessage(slot, e.data));
    w.addEventListener('error', (e) => this._onCrash(slot, e.message || 'worker error'));
    w.postMessage({ type: 'init', modules: mods, kind });
    await slot.ready;
    return slot;
  }

  async _slots(kind) {
    if (!this.workers.has(kind)) this.workers.set(kind, []);
    const list = this.workers.get(kind);
    if (!list.length) list.push(await this._spawn(kind));
    return list;
  }

  /**
   * Run a job. opts: {kind='decode', priority, transfer, timeout, affinity (slot id), avoid (slot ids), onProgress, label}.
   * Resolves with the result; rejects with an Error that has .cancelled/.timedOut/.trapped flags.
   */
  run(op, args = {}, opts = {}) {
    const job = {
      id: newId('job'),
      op,
      args,
      kind: opts.kind ?? 'decode',
      priority: PRI[opts.priority ?? 'normal'] ?? 1,
      transfer: opts.transfer ?? [],
      timeout: opts.timeout ?? 120000,
      affinity: opts.affinity ?? null,
      avoid: opts.avoid ?? null,
      onProgress: opts.onProgress,
      label: opts.label ?? op,
      state: 'queued',
      created: performance.now(),
      progress: 0,
    };
    const p = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    job.promise = p;
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.queue.sort((a, b) => a.priority - b.priority || a.created - b.created);
    this.emit('job', job);
    this._pump();
    return Object.assign(p, { jobId: job.id, cancel: () => this.cancel(job.id) });
  }

  async _pump() {
    for (const job of [...this.queue]) {
      let slots;
      try {
        slots = await this._slots(job.kind);
      } catch (e) {
        this._finish(job, null, e);
        continue;
      }
      if (job.state !== 'queued') continue;
      let slot = job.affinity ? slots.find((s) => s.id === job.affinity) : null;
      if (job.affinity && !slot && job.op === 'close') {
        // Closing a file whose worker is gone: nothing left to close (do not reopen it to close it).
        this._finish(job, { closed: true }, null);
        continue;
      }
      if (job.affinity && !slot) {
        // The worker holding the file was restarted (a timed-out or crashed job): the app reopens
        // the file in a fresh worker (`recover`) and the job continues with the new handle, instead
        // of every later tile, statistic and export on that file failing (TE 2.0.4 cross).
        if (this.recover && job.args?.handle !== undefined && !job.recovered) {
          job.recovered = true;
          job.state = 'recovering';
          this.queue.splice(this.queue.indexOf(job), 1);
          Promise.resolve(this.recover(job.affinity, job.args.handle))
            .then((r) => {
              if (!r) throw new Error('the worker holding this file was restarted; reopen the file');
              job.args = { ...job.args, handle: r.handle };
              job.affinity = r.affinity;
              job.state = 'queued';
              this.queue.push(job);
              this._pump();
            })
            .catch((e) => this._finish(job, null, Object.assign(e instanceof Error ? e : new Error(String(e)), { lost: true })));
          continue;
        }
        this._finish(job, null, Object.assign(new Error('the worker holding this file was restarted; reopen the file'), { lost: true }));
        continue;
      }
      if (!slot) {
        // `avoid`: slot ids this job must not run on (a second AI runtime needs its own worker).
        const free = job.avoid?.length ? slots.filter((s) => !job.avoid.includes(s.id)) : slots;
        slot = free.length ? free.reduce((a, b) => (a.busy <= b.busy ? a : b)) : null;
        const spawning = this._spawning.get(job.kind) ?? 0;
        if (!slot && slots.length + spawning >= this.size) {
          this._finish(job, null, new Error(`no free ${job.kind} worker: the pool is full`));
          continue;
        }
        if ((!slot || slot.busy >= (CPU_KINDS.has(job.kind) ? 1 : 4)) && slots.length + spawning < this.size) {
          // Claim the job before awaiting the new worker: a concurrent pump must not post it too
          // (its buffers would already be transferred), nor start more workers than the pool size.
          job.state = 'dispatching';
          this._spawning.set(job.kind, spawning + 1);
          try {
            slots.push((slot = await this._spawn(job.kind)));
          } finally {
            this._spawning.set(job.kind, (this._spawning.get(job.kind) ?? 1) - 1);
          }
          if (job.state !== 'dispatching') continue; // cancelled meanwhile
        } else if (slot.busy >= (CPU_KINDS.has(job.kind) ? 1 : 4) && CPU_KINDS.has(job.kind)) continue; // wait for a free worker
      }
      this.queue.splice(this.queue.indexOf(job), 1);
      job.state = 'running';
      job.slot = slot;
      job.started = performance.now();
      slot.busy++;
      job.timer = setTimeout(() => this._timeout(job), job.timeout);
      slot.w.postMessage({ type: 'job', id: job.id, op: job.op, args: job.args }, job.transfer);
      this.emit('job', job);
    }
  }

  _onMessage(slot, m) {
    if (m?.type === 'need-lib') {
      // Verified data-pack libraries (REQ-ARC-14): `libs[name]()` resolves to the script bytes.
      const make = this.libs?.[m.name];
      if (!make) return slot.w.postMessage({ type: 'lib', name: m.name, error: `no data-pack library "${m.name}" is loaded` });
      Promise.resolve(make()).then(
        (code) => slot.w.postMessage({ type: 'lib', name: m.name, code }),
        (e) => slot.w.postMessage({ type: 'lib', name: m.name, error: String(e?.message || e) }),
      );
      return;
    }
    if (m?.type === 'need-module') {
      const make = this.lazyModules[m.name];
      if (!make) return slot.w.postMessage({ type: 'module', name: m.name, error: `no WASM bundle named "${m.name}"` });
      if (!this._lazy.has(m.name)) this._lazy.set(m.name, make());
      this._lazy.get(m.name).then(
        (module) => slot.w.postMessage({ type: 'module', name: m.name, module }),
        (e) => {
          this._lazy.delete(m.name);
          slot.w.postMessage({ type: 'module', name: m.name, error: String(e?.message || e) });
        },
      );
      return;
    }
    if (m?.type === 'range') {
      // A worker reads a remote file's bytes through the main thread (connectors/remote.js).
      const r = this.remote?.get(m.remoteId);
      if (!r) return slot.w.postMessage({ type: 'range-result', rid: m.rid, error: 'the remote file is no longer open' });
      r.read(m.start, m.end).then(
        (buf) => slot.w.postMessage({ type: 'range-result', rid: m.rid, buf }, [buf]),
        (e) => slot.w.postMessage({ type: 'range-result', rid: m.rid, error: String(e?.message || e) }),
      );
      return;
    }
    if (!m || !m.id) return;
    const job = this.jobs.get(m.id);
    if (!job) return;
    if (m.type === 'progress') {
      job.progress = m.progress;
      // Time remaining from the progress rate since the first report (REQ-ING-02).
      const now = performance.now();
      if (!job.p0 && m.progress > 0) job.p0 = { t: now, p: m.progress };
      else if (job.p0 && m.progress > job.p0.p) job.eta = ((now - job.p0.t) * (1 - m.progress)) / (m.progress - job.p0.p);
      job.onProgress?.(m.progress, m.partial);
      this.emit('job', job);
    } else if (m.type === 'result') this._finish(job, m.result);
    else if (m.type === 'error') this._finish(job, null, m.cancelled && job.timedOut ? job.timedOut : Object.assign(new Error(m.error), { trapped: !!m.trapped, code: m.code, cancelled: !!m.cancelled }));
  }

  _finish(job, result, error) {
    if (job.state === 'done' || job.state === 'failed') return;
    clearTimeout(job.timer);
    if (job.slot) job.slot.busy = Math.max(0, job.slot.busy - 1);
    job.state = error ? 'failed' : 'done';
    if (job.slot) {
      this.slotOf.set(job.id, job.slot.id);
      if (this.slotOf.size > 500) this.slotOf.delete(this.slotOf.keys().next().value);
    }
    job.error = error?.message;
    job.ended = performance.now();
    this.jobs.delete(job.id);
    const i = this.queue.indexOf(job);
    if (i >= 0) this.queue.splice(i, 1);
    // A failed open keeps its file so the progress dock can retry it (REQ-ING-02).
    this.history.unshift({ id: job.id, label: job.label, op: job.op, state: job.state, error: job.error, ms: job.ended - (job.started ?? job.created), trapped: error?.trapped, retry: error && job.op === 'open' && !error.cancelled ? job.args?.file ?? null : null });
    if (this.history.length > 200) this.history.length = 200;
    this.emit('job', job);
    if (error) job.reject(error);
    else job.resolve(result);
    this._pump();
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.state === 'queued' || job.state === 'dispatching') return this._finish(job, null, Object.assign(new Error('cancelled'), { cancelled: true }));
    job.slot?.w.postMessage({ type: 'cancel', id });
    // A job that ignores the cancel flag is ended by terminating its worker.
    setTimeout(() => {
      if (this.jobs.has(id)) this._kill(job.slot, Object.assign(new Error('cancelled (worker restarted)'), { cancelled: true }));
    }, 3000);
  }

  // A job past its time is asked to stop first: a slow read (a large file on a USB disk) stops at
  // its next cancel check and the worker, its open files and its other jobs carry on. Only a job
  // that ignores the request (a WASM loop) restarts the worker, which used to fail every tile on it
  // and every file opened there (TE 2.0.4 cross).
  _timeout(job) {
    const s = Math.round(job.timeout / 1000);
    job.timedOut = Object.assign(new Error(`${job.label} timed out after ${s} s`), { timedOut: true });
    job.slot?.w.postMessage({ type: 'cancel', id: job.id });
    setTimeout(() => {
      if (this.jobs.has(job.id)) this._kill(job.slot, Object.assign(new Error(`${job.label} timed out after ${s} s; the worker was restarted`), { timedOut: true }));
    }, 3000);
  }

  _onCrash(slot, msg) {
    this._kill(slot, new Error(`worker crashed: ${msg}`));
  }

  /** Terminate a worker, fail its running jobs, and replace it lazily. */
  _kill(slot, error) {
    if (!slot) return;
    slot.w.terminate();
    const list = this.workers.get(slot.kind) ?? [];
    const i = list.indexOf(slot);
    if (i >= 0) list.splice(i, 1);
    // Every job on that worker dies with it; files opened there must be reopened.
    for (const job of [...this.jobs.values()]) if (job.slot === slot) this._finish(job, null, error);
    this.emit('restart', { kind: slot.kind, reason: error.message });
  }

  /** The worker a finished job ran on: later jobs on that file must go to the same worker. */
  lastAffinity(jobId) {
    return this.slotOf.get(jobId) ?? null;
  }

  stats() {
    const out = {};
    for (const [k, list] of this.workers) out[k] = list.map((s) => ({ id: s.id, busy: s.busy }));
    return { size: this.size, workers: out, queued: this.queue.length, running: [...this.jobs.values()].filter((j) => j.state === 'running').length };
  }
}
