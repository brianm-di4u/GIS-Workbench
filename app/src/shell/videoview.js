// Video panel (REQ-FMV-05, 06, 08, 12; `Research/12` §10–13): an MPEG-TS clip played through
// mpegts.js + MSE in an image panel, with DVR controls (play, pause, frame step, rate, loop
// A–B, slider), a movable HUD, ST 0903 VMTI boxes, ST 0102 banners and, when paused, the exact
// decoded frame from WebCodecs. Every presented frame (requestVideoFrameCallback) moves the
// shared FMV time, so the map, HUD and slider update inside the same callback (AT-15.3).
// When the codec is not playable the panel stays usable as metadata only (REQ-FMV-05).

import { h } from './dom.js';

const RATES = [0.25, 0.5, 1, 2, 4];

// mpegts.js resumes a lazy-load pause at the byte after the last one read; a pause just as the last
// byte arrived asked for a range starting at the file size, which Chrome logs as a 416 (CX-082, Night
// Flight IR at 305 s). Such a request for a video's blob URL is answered empty, as a reached end.
const videoSizes = new Map(); // blob URL → bytes
function guardEndRanges() {
  if (guardEndRanges.done || !globalThis.fetch) return;
  guardEndRanges.done = true;
  const fetch0 = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const size = videoSizes.get(typeof input === 'string' ? input : input?.url);
    const from = size === undefined ? null : /bytes=(\d+)-/.exec(new Headers(init?.headers).get('Range') ?? '')?.[1];
    if (from != null && Number(from) >= size) return Promise.resolve(new Response(new Uint8Array(0), { status: 206, headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } }));
    return fetch0(input, init);
  };
}

export const HUD_BLOCKS = [
  { id: 'time', label: 'Time', x: 0.01, y: 0.02 },
  { id: 'sensor', label: 'Sensor', x: 0.66, y: 0.02 },
  { id: 'centre', label: 'Frame centre', x: 0.01, y: 0.8 },
  { id: 'geometry', label: 'Geometry', x: 0.66, y: 0.8 },
];

export class VideoView {
  constructor(app, pane, clip) {
    this.app = app;
    this.pane = pane;
    this.clip = clip;
    this.frame = 0;
    this.playing = false;
    this.decodeError = null; // media time where the decoder rejected the stream
    this.rate = 1;
    this.loop = { a: null, b: null, on: false };
    this.metadataOnly = false;
    this.still = null; // {frame, bitmap} shown while paused after a WebCodecs step
    this.measure = null; // {points: [...]} mensuration over the paused frame (REQ-FMV-13)
    this.el = h('div', { class: 'video-view', 'data-id': `video:${pane.id}` });
    this.video = h('video', { class: 'video-el', muted: true, playsinline: true, 'data-id': 'video-el', 'aria-label': `Video ${clip.name}` });
    this.video.muted = true;
    this.stillCanvas = h('canvas', { class: 'video-still', hidden: true });
    this.hud = h('canvas', { class: 'video-hud', 'data-id': 'video-hud' });
    this.msg = h('div', { class: 'video-msg', hidden: true, role: 'status' });
    this.stage = h('div', { class: 'video-stage' }, this.video, this.stillCanvas, this.hud, this.msg);
    this.slider = h('input', { type: 'range', min: '0', max: String(Math.max(0, clip.frames.length - 1)), value: '0', step: '1', class: 'video-slider', 'data-id': 'video-slider', 'aria-label': 'Frame' });
    this.timeLabel = h('span', { class: 'video-time', 'data-id': 'video-time' }, '');
    const btn = (id, label, title, fn) => {
      const b = h('button', { type: 'button', class: 'dvr-btn', 'data-id': `video-${id}`, title, 'aria-label': title }, label);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    this.playBtn = btn('play', '▶', 'Play / pause (Space)', () => this.toggle());
    this.rateSel = h('select', { class: 'dvr-rate', 'data-id': 'video-rate', 'aria-label': 'Playback rate' }, ...RATES.map((r) => h('option', { value: String(r), selected: r === 1 }, `${r}×`)));
    this.rateSel.addEventListener('change', () => this.setRate(Number(this.rateSel.value)));
    this.loopBtn = btn('loop', 'A–B', 'Loop between A and B', () => this.setLoop({ on: !this.loop.on }));
    this.controls = h(
      'div',
      { class: 'dvr', role: 'toolbar', 'aria-label': 'Video controls' },
      btn('start', '⏮', 'First frame', () => this.seekFrame(0)),
      btn('back', '◀|', 'Step back one frame (,)', () => this.step(-1)),
      this.playBtn,
      btn('fwd', '|▶', 'Step forward one frame (.)', () => this.step(1)),
      this.rateSel,
      btn('a', 'A', 'Set loop start at this frame', () => this.setLoop({ a: this.frame })),
      btn('b', 'B', 'Set loop end at this frame', () => this.setLoop({ b: this.frame })),
      this.loopBtn,
      this.slider,
      this.timeLabel,
    );
    this.el.append(this.stage, this.controls);
    pane.el.appendChild(this.el);
    // The panel's own pan/zoom grammar does not apply to video.
    for (const ev of ['pointerdown', 'wheel', 'dblclick']) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev !== 'wheel' });
    this.slider.addEventListener('input', () => this.seekFrame(Number(this.slider.value), 'slider'));
    this.el.addEventListener('keydown', (e) => {
      if (e.key === ' ') this.toggle();
      else if (e.key === '.' || e.key === 'ArrowRight') this.step(1);
      else if (e.key === ',' || e.key === 'ArrowLeft') this.step(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    this.el.tabIndex = 0;
    this._bindHud();
    this._resize = new ResizeObserver(() => this.drawHud());
    this._resize.observe(this.stage);
    this.video.addEventListener('ended', () => this._setPlaying(false));
    this.video.addEventListener('pause', () => this._setPlaying(false));
    this.video.addEventListener('play', () => this._setPlaying(true));
    // Holes of a few frames in a transport stream leave gaps in the buffered ranges that the
    // browser does not play across: Day Flight stalled for good at 87.5 s (TE 2.0.4 cross). While
    // playing, a stall just before a gap under a second jumps to the next range.
    this._gapTimer = setInterval(() => this._jumpGap(), 500);
    // A stretch the decoder rejects ends playback (Day Flight at 94 s): it stopped silently, and
    // the burn-in export waited for it for ever.
    this.video.addEventListener('error', () => this.video.error?.code === 3 && this._decodeFailed());
    this._vis = () => {
      if (document.hidden && this.playing) this.pause();
    };
    document.addEventListener('visibilitychange', this._vis);
  }

  static async create(app, pane, clip) {
    const v = new VideoView(app, pane, clip);
    await v._attach();
    v.seekFrame(0, 'open');
    return v;
  }

  async _attach() {
    const c = this.clip;
    const reason = await this.app.fmv.playable(c);
    if (reason) return this._metadataOnly(reason);
    try {
      const { mpegts } = await this.app.gw.runScript('js-mpegts');
      if (!mpegts.isSupported()) return this._metadataOnly('Media Source Extensions are not available in this browser');
      mpegts.LoggingControl.enableAll = false;
      // The buffer stays well inside the browser's MSE quota: loading runs at most 60 s ahead and
      // played video over 40 s old is dropped. With the defaults (load everything, drop only past
      // 3 min behind) a 60 fps, 4 Mb/s clip filled the quota at 87.5 s and playback, and the
      // burn-in export with it, stalled for good (TE 2.0.4 cross).
      // Both windows scale down for high-rate streams so ahead + behind stay near 120 MB: a 4K DJI
      // clip at 83 Mb/s filled the ~150 MB quota at 14.5 s with the fixed 60 s / 40 s (CX-085).
      // The file size bounds the loader's range requests: without it, a stream that ends part-way
      // (Day Flight.mpg) was asked for bytes past its end and Chrome logged a 416 (CX-082).
      const seconds = c.frames?.length && c.fps ? c.frames.length / c.fps : 0;
      const rate = seconds && c.file?.size ? c.file.size / seconds : 0; // bytes per second
      const win = (max, min) => (rate ? Math.max(min, Math.min(max, 60e6 / rate)) : max);
      const ahead = win(60, 3);
      const behind = win(40, 2);
      if (c.file?.size) {
        videoSizes.set(c.url, c.file.size);
        guardEndRanges();
      }
      this.player = mpegts.createPlayer({ type: 'mpegts', isLive: false, url: c.url, filesize: c.file?.size, hasAudio: false, hasVideo: true }, { enableWorker: false, lazyLoad: true, lazyLoadMaxDuration: ahead, lazyLoadRecoverDuration: ahead / 2, autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: behind, autoCleanupMinBackwardDuration: behind / 2, seekType: 'range', reuseRedirectedURL: true });
      this.player.attachMediaElement(this.video);
      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('the stream did not start within 15 s')), 15000);
        this.player.on(mpegts.Events.ERROR, (type, detail) => {
          clearTimeout(t);
          rej(new Error(`${type}: ${detail}`));
        });
        this.video.addEventListener('loadeddata', () => (clearTimeout(t), res()), { once: true });
        this.player.load();
      });
      this._watch();
    } catch (e) {
      this.player?.destroy();
      this.player = null;
      this._metadataOnly(`playback failed (${e.message})`);
    }
  }

  _metadataOnly(reason) {
    this.metadataOnly = true;
    this.video.hidden = true;
    this.msg.hidden = false;
    this.msg.textContent = `Video not playable: ${reason}. The KLV table, map, footprints and GMTI still work (metadata only).`;
    this.app.log('warn', `${this.clip.name}: ${this.msg.textContent}`);
  }

  // ---- time ----

  /** requestVideoFrameCallback loop: each presented frame drives the shared FMV time. */
  _watch() {
    const v = this.video;
    if (!v.requestVideoFrameCallback) {
      // Fallback for browsers without rVFC: time updates (coarser than one frame).
      v.addEventListener('timeupdate', () => this._presented(v.currentTime));
      return;
    }
    const cb = (now, meta) => {
      if (this.disposed) return;
      this._presented(meta.mediaTime, meta);
      this._rvfc = v.requestVideoFrameCallback(cb);
    };
    this._rvfc = v.requestVideoFrameCallback(cb);
  }

  _presented(mediaTime, meta = null) {
    const i = this.app.fmv.frameAt(this.clip, mediaTime);
    // While paused, a callback from an earlier seek must not undo a later seek or step.
    if (!this.playing && this._seekTarget !== null && this._seekTarget !== undefined) {
      if (i !== this._seekTarget) return;
      this._seekTarget = null;
    }
    if (this.loop.on && this.loop.b !== null && this.playing && i >= this.loop.b) {
      this.seekFrame(this.loop.a ?? 0, 'loop');
      this.play();
      return;
    }
    this._setFrame(i, 'video', meta);
  }

  _setFrame(i, source, meta = null) {
    this.frame = i;
    if (this.still && this.still.frame !== i) this._hideStill();
    this.slider.value = String(i);
    this.app.fmv.setFrame(this.clip, i, { source, view: this, mediaTime: meta?.mediaTime ?? null });
    const st = this.app.fmv.stateAt(this.clip, i);
    this.timeLabel.textContent = `${i + 1}/${this.clip.frames.length}  ${st?.utcText ?? ''}`;
    this.drawHud();
  }

  frameTime(i) {
    return this.clip.frames[Math.max(0, Math.min(this.clip.frames.length - 1, i))].t;
  }

  seekFrame(i, source = 'seek') {
    i = Math.max(0, Math.min(this.clip.frames.length - 1, Math.round(i)));
    if (!this.metadataOnly) {
      // Land inside the frame's display interval.
      this._seekTarget = this.playing ? null : i;
      this.video.currentTime = this.frameTime(i) + 0.25 / this.clip.fps;
    }
    this._setFrame(i, source);
  }

  async step(d) {
    this.pause();
    const i = Math.max(0, Math.min(this.clip.frames.length - 1, this.frame + d));
    this.seekFrame(i, 'step');
    // Exact frame from WebCodecs (REQ-FMV-05): shown over the video while paused.
    try {
      const bmp = await this.app.fmv.frameBitmap(this.clip, i);
      if (bmp && this.frame === i) this._showStill(i, bmp);
    } catch (e) {
      this.app.log('info', `frame step: ${e.message}`);
    }
  }

  _showStill(i, bmp) {
    const c = this.stillCanvas;
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    c.hidden = false;
    this.still = { frame: i, width: bmp.width, height: bmp.height };
  }

  _hideStill() {
    this.stillCanvas.hidden = true;
    this.still = null;
  }

  play() {
    if (this.metadataOnly) {
      // Metadata-only playback: a timer at the clip's frame rate.
      if (this._timer) return;
      this._setPlaying(true);
      const tick = () => {
        if (!this.playing) return;
        let n = this.frame + 1;
        if (this.loop.on && this.loop.b !== null && n > this.loop.b) n = this.loop.a ?? 0;
        if (n >= this.clip.frames.length) return this.pause();
        this._setFrame(n, 'timer');
        this._timer = setTimeout(tick, 1000 / (this.clip.fps * this.rate));
      };
      this._timer = setTimeout(tick, 1000 / (this.clip.fps * this.rate));
      return;
    }
    this._hideStill();
    this._seekTarget = null;
    this.video.playbackRate = this.rate;
    this.video.play().catch((e) => this.app.log('warn', `play: ${e.message}`));
  }

  pause() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this.metadataOnly) this.video.pause();
    this._setPlaying(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  _setPlaying(on) {
    this.playing = on;
    this.playBtn.textContent = on ? '❚❚' : '▶';
    this.app.emit('state');
  }

  setRate(r) {
    this.rate = r;
    this.rateSel.value = String(r);
    if (!this.metadataOnly) this.video.playbackRate = r;
  }

  setLoop({ a, b, on } = {}) {
    if (a !== undefined) this.loop.a = a;
    if (b !== undefined) this.loop.b = b;
    if (on !== undefined) this.loop.on = on;
    if (this.loop.a !== null && this.loop.b !== null && this.loop.a > this.loop.b) [this.loop.a, this.loop.b] = [this.loop.b, this.loop.a];
    this.loopBtn.classList.toggle('on', this.loop.on);
    this.loopBtn.setAttribute('aria-pressed', String(this.loop.on));
    this.app.emit('state');
  }

  // ---- HUD (REQ-FMV-08, REQ-FMV-12) ----

  /** The rectangle (CSS px, stage-relative) where the coded frame is displayed (object-fit: contain). */
  contentRect() {
    const r = this.stage.getBoundingClientRect();
    const vw = this.clip.width || this.video.videoWidth || 16;
    const vh = this.clip.height || this.video.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh);
    return { x: (r.width - vw * s) / 2, y: (r.height - vh * s) / 2, w: vw * s, h: vh * s, scale: s, vw, vh };
  }

  hudLayout() {
    const saved = this.app.prefs.get('fmvHud') ?? {};
    return HUD_BLOCKS.map((b) => ({ ...b, ...(saved[b.id] ?? {}) }));
  }

  drawHud() {
    const c = this.hud;
    const r = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * dpr));
    const H = Math.max(1, Math.round(r.height * dpr));
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, r.width, r.height);
    const st = this.app.fmv.stateAt(this.clip, this.frame);
    if (!st) return;
    const cr = this.contentRect();
    // VMTI boxes (coded-frame pixels → display through the content rect).
    const vm = st.vmti;
    if (vm && this.app.fmv.options.vmti) {
      const fx = cr.w / (vm.width || cr.vw);
      const fy = cr.h / (vm.height || cr.vh);
      g.lineWidth = 2;
      g.font = '11px monospace';
      for (const t of vm.targets) {
        if (!t.box) continue;
        const [x0, y0, x1, y1] = t.box;
        g.strokeStyle = '#00ff66';
        g.strokeRect(cr.x + x0 * fx, cr.y + y0 * fy, (x1 - x0) * fx, (y1 - y0) * fy);
        g.fillStyle = '#00ff66';
        g.fillText(`T${t.id}${t.confidence !== undefined ? ` ${t.confidence}%` : ''}`, cr.x + x0 * fx, cr.y + y0 * fy - 3);
      }
    }
    // Mensuration marks.
    if (this.measure?.points?.length) {
      g.strokeStyle = '#ffd400';
      g.fillStyle = '#ffd400';
      g.lineWidth = 2;
      g.beginPath();
      this.measure.points.forEach((p, k) => {
        const sx = cr.x + p.x * cr.scale;
        const sy = cr.y + p.y * cr.scale;
        if (k) g.lineTo(sx, sy);
        else g.moveTo(sx, sy);
        g.fillRect(sx - 3, sy - 3, 6, 6);
      });
      g.stroke();
      if (this.measure.text) {
        g.font = 'bold 12px monospace';
        const p = this.measure.points.at(-1);
        g.fillText(this.measure.text, cr.x + p.x * cr.scale + 8, cr.y + p.y * cr.scale - 8);
      }
    }
    if (!this.app.fmv.options.hud) return;
    g.font = '12px monospace';
    g.textBaseline = 'top';
    this._hudBoxes = [];
    for (const b of this.hudLayout()) {
      if (b.hidden) continue;
      const lines = this.app.fmv.hudLines(this.clip, st, b.id);
      if (!lines.length) continue;
      const x = b.x * r.width;
      const y = b.y * r.height;
      const w = Math.max(...lines.map((s) => g.measureText(s).width)) + 8;
      const hh = lines.length * 14 + 4;
      g.fillStyle = 'rgba(0,0,0,0.45)';
      g.fillRect(x, y, w, hh);
      g.fillStyle = st.stale ? '#ffb000' : '#ffffff';
      lines.forEach((s, k) => g.fillText(s, x + 4, y + 2 + k * 14));
      this._hudBoxes.push({ id: b.id, x, y, w, h: hh });
    }
  }

  /** HUD blocks drag while playing (GXP HUD editing); positions are kept as fractions. */
  _bindHud() {
    this.stage.addEventListener('pointerdown', (e) => {
      const r = this.stage.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      const box = (this._hudBoxes ?? []).find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
      if (!box) {
        if (this.app.fmv.measureMode && !this.playing) this.app.fmv.measureClick(this, x, y);
        return;
      }
      this.stage.setPointerCapture(e.pointerId);
      const dx = x - box.x;
      const dy = y - box.y;
      const move = (ev) => {
        const nx = Math.max(0, Math.min(0.95, (ev.clientX - r.left - dx) / r.width));
        const ny = Math.max(0, Math.min(0.95, (ev.clientY - r.top - dy) / r.height));
        const saved = { ...(this.app.prefs.get('fmvHud') ?? {}) };
        saved[box.id] = { ...(saved[box.id] ?? {}), x: nx, y: ny };
        this.app.prefs.set('fmvHud', saved);
        this.drawHud();
      };
      const up = () => {
        this.stage.removeEventListener('pointermove', move);
        this.stage.removeEventListener('pointerup', up);
      };
      this.stage.addEventListener('pointermove', move);
      this.stage.addEventListener('pointerup', up);
    });
  }

  /** Banners from ST 0102 and the panel's other markings (REQ-FMV-03). */
  updateBanners(text, colourVar, conflict) {
    for (const b of [this.pane.bannerTop, this.pane.bannerBottom]) {
      b.hidden = !text;
      b.textContent = conflict ? `${text}  ⚠ ${conflict}` : text;
      b.style.background = `var(${colourVar})`;
      b.dataset.conflict = conflict ? 'true' : 'false';
    }
  }

  /** The decoder rejected the stream (MEDIA_ERR_DECODE): playback stops there, by name. */
  _decodeFailed() {
    if (this.disposed || this.metadataOnly) return;
    this.decodeError = this.video.currentTime;
    this._setPlaying(false);
    this.app.toast(`${this.clip.name}: the video is damaged at ${this.decodeError.toFixed(1)} s and cannot be played past it; the KLV, map and footprints still work`, { kind: 'warn', ms: 8000 });
  }

  _jumpGap() {
    const v = this.video;
    if (this.metadataOnly || !this.player || v.paused || v.ended || v.seeking || v.readyState >= 3) {
      this._stallAt = null;
      return;
    }
    const t = v.currentTime;
    if (this._stallAt !== t) {
      this._stallAt = t; // stalled for one tick first: a normal wait for data is not a gap
      return;
    }
    // Stalled in the last half second (the final frames never arrive): that is the end, so the
    // element ends and the burn-in export with it (truck_vmti.ts hung at 148.1 of 148.2 s, TE 2.0.4).
    if (Number.isFinite(v.duration) && v.duration - t < 0.5) {
      v.currentTime = v.duration;
      this._stallAt = null;
      return;
    }
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) > t && b.start(i) - t < 1) {
        v.currentTime = b.start(i) + 0.001;
        this.app.log('info', `${this.clip.name}: skipped a ${(b.start(i) - t).toFixed(2)} s gap in the stream at ${t.toFixed(2)} s`);
        this._stallAt = null;
        return;
      }
    }
  }

  dispose() {
    this.disposed = true;
    clearInterval(this._gapTimer);
    this.pause();
    if (this._rvfc && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this._rvfc);
    this._resize.disconnect();
    document.removeEventListener('visibilitychange', this._vis);
    try {
      this.player?.unload();
      this.player?.detachMediaElement();
      this.player?.destroy();
    } catch {}
    this.el.remove();
  }
}
