// MPEG-1 and MPEG-2 video playback without the browser's media stack (FC-22, REQ-FMT-52,
// REQ-GAP-48): pictures are decoded by the Rust decoders in the `mpeg` bundle on a decode worker
// (workers/decode/mpv.js)
// and drawn on a canvas. The object behaves like the parts of an HTMLVideoElement the video
// panel uses (currentTime, play/pause, playbackRate, the play/pause/playing/seeked/ended events
// and requestVideoFrameCallback), so the panel's DVR controls, frame stepping, A–B loop, HUD,
// KLV sync and burn-in export work unchanged.
//
// Decoding runs ahead of the display clock by a few frames; a seek resets the decoder at the
// keyframe before the target (the one before that for an open-GOP B picture) and drops the
// pictures shown before the target, so every seek and step lands on the exact frame.

import { t } from '../i18n/index.js';

const AHEAD = 10; // decoded frames kept ahead of the clock
const BATCH = 6;

export class Mpeg1Media extends EventTarget {
  constructor(app, clip, canvas) {
    super();
    this.app = app;
    this.clip = clip;
    this.canvas = canvas;
    canvas.width = clip.width || 16;
    canvas.height = clip.height || 16;
    this.g = canvas.getContext('2d');
    this.time = 0;
    this.paused = true;
    this.ended = false;
    this.seeking = false;
    this.readyState = 0;
    this.playbackRate = 1;
    this.duration = clip.duration;
    this.error = null;
    this.videoWidth = clip.width;
    this.videoHeight = clip.height;
    this.buffered = { length: 0, start: () => 0, end: () => 0 };
    this.queue = []; // [{fi, t, bitmap}] in display order
    this.gen = 0;
    this.busy = false;
    this.eof = false;
    this.pending = null; // seek waiting for the decoder
    this.shown = -1;
    this.callbacks = new Map();
    this.nextCb = 1;
    this.fiOfAu = new Int32Array(clip.aus.length).fill(-1);
    clip.frames.forEach((f, k) => (this.fiOfAu[f.d] = k));
    this.stats = { decoded: 0, dropped: 0, stalls: 0, seeks: 0, lastSeekMs: null };
    this._tick = this._tick.bind(this);
  }

  get currentTime() {
    return this.time;
  }

  set currentTime(t) {
    this._seek(this.app.fmv.frameAt(this.clip, Math.max(0, Number(t) || 0)));
  }

  /** Job on the worker holding this clip's decoder session. */
  async _job(op, args, transfer = []) {
    const p = this.app.pool.run(op, args, { kind: 'decode', affinity: this.affinity ?? null, timeout: 60000, label: `${this.clip.codec === 'mp2v' ? 'MPEG-2' : 'MPEG-1'} ${op}`, transfer });
    const r = await p;
    if (!this.affinity) this.affinity = this.app.pool.lastAffinity(p.jobId);
    return r;
  }

  sessionArgs() {
    const c = this.clip;
    return { file: c.file, container: c.container, sid: c.container === 'es' ? 0 : c.videoPid, seqOff: c.seqOff ?? c.aus[0]?.off ?? 0, auPts: c.aus.map((a) => (a.pts === null ? NaN : a.pts)), codec: c.codec };
  }

  async open() {
    const r = await this._job('mpvopen', this.sessionArgs());
    this.session = r.session;
    this.info = r.info;
    this.readyState = 1;
  }

  /** Where the decoder starts for frame fi: {off, baseAu, minPts}. */
  seekPoint(fi) {
    return seekPoint(this.clip, fi);
  }

  _clear() {
    for (const f of this.queue) f.bitmap?.close?.();
    this.queue = [];
  }

  _seek(fi) {
    const c = this.clip;
    fi = Math.max(0, Math.min(c.frames.length - 1, fi));
    const target = c.frames[fi];
    this.ended = false;
    this.time = target.t;
    if (this.playing) this._clock = { t0: performance.now(), m0: target.t };
    // Already decoded ahead (stepping forward, a short jump): no reset.
    const k = this.queue.findIndex((f) => f.fi === fi);
    if (k >= 0 && !this.pending) {
      for (const f of this.queue.splice(0, k)) f.bitmap?.close?.();
      const f = this.queue.shift();
      this._show(f);
      this._seeked();
      this._pump();
      return;
    }
    if (fi === this.shown && !this.pending && !this.seeking) {
      this._seeked(true);
      return;
    }
    this.gen++;
    this._clear();
    this.eof = false;
    this.seeking = true;
    this.stats.seeks++;
    this.pending = { seek: this.seekPoint(fi), fi, t0: performance.now() };
    this.dispatchEvent(new Event('seeking'));
    this._pump();
  }

  _seeked(repeat = false) {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
    if (repeat) this._callbacks(this.clip.frames[this.shown]?.t ?? this.time);
  }

  async _pump() {
    if (this.busy || this.disposed || this.session === undefined) return;
    const seek = this.pending;
    if (!seek && (this.eof || this.queue.length >= AHEAD)) return;
    this.busy = true;
    const gen = this.gen;
    let r;
    try {
      r = await this._job('mpvrun', { session: this.session, seek: seek?.seek ?? null, count: seek ? 3 : BATCH });
    } catch (e) {
      this.busy = false;
      if (this.disposed) return;
      // The worker was restarted (a trap, a time-out): reopen the session and seek again.
      if (!this._reopened) {
        this._reopened = true;
        this.affinity = null;
        try {
          await this.open();
          this.pending = { seek: this.seekPoint(Math.max(0, this.shown)), fi: Math.max(0, this.shown), t0: performance.now() };
          this.gen++;
          return this._pump();
        } catch {}
      }
      this.error = { code: 3, message: e.message };
      this.app.log('warn', `${this.clip.name}: ${this.clip.codec === 'mp2v' ? 'MPEG-2' : 'MPEG-1'} decoding failed: ${e.message}`);
      this.dispatchEvent(new Event('error'));
      return;
    }
    this.busy = false;
    if (this.disposed || gen !== this.gen) {
      for (const f of r.frames) f.bitmap?.close?.();
      if (!this.disposed) this._pump();
      return;
    }
    if (seek && this.pending === seek) this.pending = null;
    for (const f of r.frames) {
      const fi = this.fiOfAu[f.au] ?? -1;
      if (fi < 0 || !f.bitmap) {
        f.bitmap?.close?.();
        continue;
      }
      this.stats.decoded++;
      this.queue.push({ fi, t: this.clip.frames[fi].t, bitmap: f.bitmap });
    }
    this.eof = r.eof;
    if (seek) {
      this.stats.lastSeekMs = performance.now() - seek.t0;
      const first = this.queue.shift();
      if (first) this._show(first);
      if (this.playing) this._clock = { t0: performance.now(), m0: this.time };
      this.readyState = 4;
      this._seeked();
    }
    this._pump();
  }

  _show(f) {
    this.g.drawImage(f.bitmap, 0, 0, this.canvas.width, this.canvas.height);
    f.bitmap.close?.();
    this.shown = f.fi;
    this.time = Math.max(this.playing ? this.time : 0, f.t);
    if (!this.playing) this.time = f.t;
    this._callbacks(f.t);
    if (this.playing && !this._playingSent) {
      this._playingSent = true;
      this.dispatchEvent(new Event('playing'));
    }
  }

  _callbacks(mediaTime) {
    const cbs = [...this.callbacks.values()];
    this.callbacks.clear();
    const now = performance.now();
    for (const cb of cbs) cb(now, { mediaTime, presentedFrames: this.stats.decoded, width: this.canvas.width, height: this.canvas.height });
  }

  requestVideoFrameCallback(cb) {
    const id = this.nextCb++;
    this.callbacks.set(id, cb);
    return id;
  }

  cancelVideoFrameCallback(id) {
    this.callbacks.delete(id);
  }

  get playing() {
    return !this.paused;
  }

  play() {
    if (!this.paused) return Promise.resolve();
    if (this.ended || this.shown >= this.clip.frames.length - 1) this._seek(0);
    this.paused = false;
    this._playingSent = false;
    this._clock = { t0: performance.now(), m0: this.time };
    this.dispatchEvent(new Event('play'));
    this._raf = requestAnimationFrame(this._tick);
    this._pump();
    return Promise.resolve();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    cancelAnimationFrame(this._raf);
    this.dispatchEvent(new Event('pause'));
  }

  _tick() {
    if (this.paused || this.disposed) return;
    const now = performance.now();
    const fps = this.clip.fps || 30;
    if (this.seeking || this.pending) {
      this._clock = { t0: now, m0: this.time };
    } else {
      const media = this._clock.m0 + ((now - this._clock.t0) / 1000) * this.playbackRate;
      let f = null;
      while (this.queue.length && this.queue[0].t <= media + 1e-6) {
        if (f) {
          f.bitmap?.close?.();
          this.stats.dropped++;
        }
        f = this.queue.shift();
      }
      if (f) {
        this._show(f);
        this.time = media;
      } else if (!this.queue.length) {
        if (this.eof && !this.busy) {
          // The last picture was shown: the end.
          this.time = this.clip.frames[this.shown]?.t ?? this.time;
          this.ended = true;
          this.paused = true;
          this.dispatchEvent(new Event('pause'));
          this.dispatchEvent(new Event('ended'));
          return;
        }
        // Waiting for the decoder: hold the clock one frame after the picture on screen.
        const last = this.clip.frames[this.shown]?.t ?? this.time;
        if (media > last + 1 / fps) {
          this.stats.stalls++;
          this._clock = { t0: now, m0: last + 1 / fps };
          this.readyState = 2;
        }
        this.time = Math.min(media, last + 1 / fps);
      } else {
        this.time = media;
        this.readyState = 4;
      }
    }
    this._pump();
    this._raf = requestAnimationFrame(this._tick);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    this._clear();
    if (this.session !== undefined) this.app.pool.run('mpvclose', { session: this.session }, { kind: 'decode', affinity: this.affinity ?? null, label: t('MPEG-1 close') }).catch(() => {});
  }
}

/**
 * Where decoding starts for frame fi of a clip: the packet of the keyframe at or before its
 * access unit whose presentation is not after the frame (an open-GOP B picture needs the keyframe
 * before), with `baseAu` the first access unit starting in that packet.
 */
export function seekPoint(clip, fi) {
  const target = clip.frames[fi];
  const aus = clip.aus;
  let k = target.d;
  while (k > 0 && !(aus[k].key && aus[k].pts !== null && aus[k].pts <= target.pts)) k--;
  let base = k;
  while (base > 0 && aus[base - 1].off === aus[k].off) base--;
  return { off: aus[k].off, baseAu: base, minPts: target.pts };
}
