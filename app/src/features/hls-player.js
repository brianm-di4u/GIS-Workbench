// HLS streams with MISB KLV (REQ-GAP-49): the lazy js-streams block. An HLS session reads the
// master and media playlists through the logged fetch (allow-listed origins only, REQ-SEC-12),
// follows a live playlist's sliding window, decrypts AES-128 segments with WebCrypto when their
// key can be fetched, and sends each MPEG-TS segment to the decode worker: the file player's Rust
// demuxer reads its KLV (synchronous and asynchronous ST 0601) and the video index, and the
// H.264 access units come back as fMP4 samples (media/ts2mp4.js) for Media Source Extensions.
// Segments are placed on one media timeline: discontinuities are stitched end to end and each
// has its own KLV time anchor (features/fmv.js rebuildStates), so the map, footprints, HUD and
// KLV table follow the video exactly as for a file. MPEG-2 video plays through the app's own
// decoder for an on-demand stream (the segments become one transport stream); live MPEG-2,
// H.265 and fMP4 segments are refused by name.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, tc, gwError, msgOf } from '../i18n/index.js';
import { num } from '../i18n/format.js';
import { originOf } from '../ai/netlog.js';
import { parsePlaylist, pickVariant, liveStartIndex, reloadDelay, decryptSegment } from '../media/hls.js';
import { initSegment, fragment, withDurations, unwrap33 } from '../media/ts2mp4.js';

const TICKS = 90000;
const AHEAD_S = 30; // media appended ahead of the playhead
const BEHIND_S = 30; // and kept behind it
const LIVE_DVR_S = 300; // a live stream's segments kept for seeking back
const MAX_FRAMES = 30 * 3600 * 2; // two hours of 30 frames/s of metadata
const MPEG2_VOD_MAX = 1 << 30; // an on-demand MPEG-2 stream is assembled in memory up to 1 GiB
const wait = (ms, signal) =>
  new Promise((res) => {
    const id = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(id), res()), { once: true });
  });

export class HlsSession {
  constructor(app, url, { maxBandwidth = Infinity, name = null, variant = null } = {}) {
    this.app = app;
    this.url = url;
    this.name = name ?? (() => {
      try {
        const u = new URL(url);
        return `${u.host}${u.pathname}`;
      } catch {
        return url;
      }
    })();
    this.maxBandwidth = maxBandwidth;
    this.variantWanted = variant;
    this.ac = new AbortController();
    this.fetch = app.netlog.fetchFor(t('HLS: {host}', { host: originOf(url) ?? url }));
    this.segs = new Map(); // seq → segment state
    this.order = []; // segments with media, in timeline order
    this.keys = new Map(); // key URI → Promise<Uint8Array>
    this.inits = new Map(); // SPS+PPS key → init segment bytes
    this.discOff = new Map(); // discontinuity sequence → tick offset
    this.ref = null; // last decode time (ticks, unwrapped)
    this.pts0 = null;
    this.endT = 0; // timeline end (ticks from pts0) of the last placed segment
    this.lastDisc = null;
    this.clip = null;
    this.view = null;
    this.ms = null;
    this.sb = null;
    this.appendChain = Promise.resolve();
    this.lastInit = null;
    this.stats = { segments: 0, bytes: 0, missed: 0, discontinuities: 0, decrypted: 0, reloads: 0, failed: 0, appendMs: [], indexMs: [], timeline: [], presented: new Map(), rebuildMs: [] };
    this.disposed = false;
    this.error = null;
  }

  // ---- network ----

  async text(url) {
    const r = await this.fetch(url, { signal: this.ac.signal, cache: 'no-store' });
    if (!r.ok) throw gwError('{url}: HTTP {status}', { url: shortUrl(url), status: r.status }, 'E_HTTP');
    return r.text();
  }

  async bytes(url, range = null) {
    const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {};
    const r = await this.fetch(url, { signal: this.ac.signal, headers });
    if (!r.ok) throw gwError('{url}: HTTP {status}', { url: shortUrl(url), status: r.status }, 'E_HTTP');
    return new Uint8Array(await r.arrayBuffer());
  }

  /** The AES-128 key: fetched once through the logged fetch, so only from an allowed origin. */
  keyFor(uri) {
    if (!/^https?:/i.test(uri)) return Promise.reject(gwError('the AES-128 key at {uri} cannot be fetched (only http and https keys from an allowed origin), so the stream is not played', { uri: shortUrl(uri) }, 'E_HLS_KEY_UNREACHABLE'));
    if (!this.keys.has(uri)) {
      const p = this.bytes(uri).catch((e) => {
        this.keys.delete(uri);
        throw gwError('the AES-128 key at {uri} could not be fetched ({msg}), so the stream is not played', { uri: shortUrl(uri), msg: msgOf(e) }, 'E_HLS_KEY_UNREACHABLE');
      });
      this.keys.set(uri, p);
    }
    return this.keys.get(uri);
  }

  // ---- playlists ----

  async start(pane = null) {
    // Every request is the logged fetch's: an origin outside the allow-list is refused there by name.
    let pl = parsePlaylist(await this.text(this.url), this.url);
    this.master = null;
    if (pl.kind === 'master') {
      this.master = pl;
      this.variant = this.variantWanted ? pl.variants.find((v) => v.uri === this.variantWanted) ?? pickVariant(pl.variants, { maxBandwidth: this.maxBandwidth }) : pickVariant(pl.variants, { maxBandwidth: this.maxBandwidth });
      if (this.variant.codecs && !/avc1|avc3|mp4v/i.test(this.variant.codecs)) throw gwError('the stream offers only {codecs} video; H.264 and MPEG-2 are played', { codecs: this.variant.codecs }, 'E_HLS_CODEC');
      this.mediaUrl = this.variant.uri;
      pl = parsePlaylist(await this.text(this.mediaUrl), this.mediaUrl);
      if (pl.kind !== 'media') throw gwError('the variant playlist is a master playlist again', null, 'E_HLS_NESTED');
    } else this.mediaUrl = this.url;
    this.pl = pl;
    this.live = pl.live;
    this.seen(pl);
    const first = this.live ? liveStartIndex(pl) : 0;
    this.startSeq = pl.segments[first]?.seq ?? pl.mediaSequence;
    // The first segment decides the path: H.264 through MSE, MPEG-2 through the app's decoder.
    const s0 = this.segs.get(this.startSeq);
    if (!s0) throw gwError('the playlist lists no segments yet', null, 'E_HLS_EMPTY');
    const r0 = await this.load(s0);
    if (r0.codec === 'mp2v' || r0.codec === 'mp1v') return this.startMpeg2(r0, pane);
    if (r0.codec !== 'avc1') throw unsupportedCodec(r0.codec);
    this.place(s0, r0);
    this.makeClip(r0);
    this.view = await this.app.fmv.openClip(this.clip, pane);
    this.loop().catch((e) => this.fail(e));
    if (this.live && !this.view.metadataOnly) this.view.play();
    return this;
  }

  /** Remember when each segment first appeared in a playlist (the client side of live latency). */
  seen(pl) {
    const now = Date.now();
    for (const s of pl.segments) {
      if (this.segs.has(s.seq)) continue;
      this.segs.set(s.seq, { ...s, status: 'listed', listedAt: now });
    }
  }

  async reload() {
    const before = this.pl.segments.at(-1)?.seq ?? -1;
    const pl = parsePlaylist(await this.text(this.mediaUrl), this.mediaUrl);
    if (pl.kind !== 'media') throw gwError('the variant playlist is a master playlist again', null, 'E_HLS_NESTED');
    this.stats.reloads++;
    // A sliding window that moved past segments not yet fetched: they are gone (a gap in the video).
    for (const [seq, s] of this.segs) {
      if (seq < pl.mediaSequence && s.status === 'listed' && seq >= this.startSeq) {
        s.status = 'missed';
        this.stats.missed++;
      }
    }
    this.pl = pl;
    this.seen(pl);
    if (pl.endList) this.live = false;
    return (pl.segments.at(-1)?.seq ?? -1) !== before;
  }

  /** The next segment to fetch: the lowest listed one at or after the start. */
  next() {
    let best = null;
    for (const [seq, s] of this.segs) if (s.status === 'listed' && seq >= this.startSeq && (!best || seq < best.seq)) best = s;
    return best;
  }

  async loop() {
    let lastReload = performance.now();
    let changed = true;
    while (!this.disposed) {
      const due = this.live && performance.now() - lastReload >= reloadDelay(this.pl, changed);
      const s = due ? null : this.next();
      if (s) {
        try {
          const r = await this.load(s);
          if (r.codec !== 'avc1') throw unsupportedCodec(r.codec);
          this.place(s, r);
          this.grow(s, r);
        } catch (e) {
          if (this.disposed || e?.code === 'E_CANCELLED') return;
          if (e?.code?.startsWith?.('E_HLS_KEY') || e?.code === 'E_HLS_CODEC' || e?.code === 'E_HLS_DECRYPT' || e?.code === 'E_NET_NOT_ALLOWED') throw e;
          s.status = 'failed';
          this.stats.failed++;
          this.app.log('warn', `${this.name}: segment ${s.seq} skipped (${msgOf(e)})`);
        }
        continue;
      }
      if (!this.live) break;
      if (!due) await wait(Math.max(0, reloadDelay(this.pl, changed) - (performance.now() - lastReload)), this.ac.signal);
      if (this.disposed) return;
      try {
        changed = await this.reload();
      } catch (e) {
        if (this.disposed) return;
        this.app.log('warn', `${this.name}: playlist reload failed (${msgOf(e)})`);
        changed = false;
      }
      lastReload = performance.now();
    }
    if (!this.disposed) this.ended = true;
    this.pump();
  }

  /** Fetch, decrypt and index one segment in the decode worker. */
  async load(s) {
    s.status = 'loading';
    const t0 = performance.now();
    let b = await this.bytes(s.uri, s.byteRange);
    s.fetchedAt = Date.now();
    this.stats.bytes += b.byteLength;
    if (s.key) {
      const key = await this.keyFor(s.key.uri);
      b = await decryptSegment(b, key, s.key.ivBytes);
      this.stats.decrypted++;
    }
    s.raw = s.keepRaw ? b.slice() : null;
    const r = await this.app.pool.run('hlsseg', { bytes: b.buffer }, { kind: 'decode', transfer: [b.buffer], timeout: 120000, label: t('HLS segment {n}', { n: s.seq }) });
    this.stats.indexMs.push(Math.round(performance.now() - t0));
    s.status = 'loaded';
    return r;
  }

  // ---- the timeline ----

  /** Place a segment on the media timeline: unwrap, stitch a discontinuity, and make its fragment. */
  place(s, r) {
    if (!r.samples.length) throw gwError('segment {n} has no video access units', { n: s.seq }, 'E_HLS_SEGMENT');
    const raw0 = r.samples[0].dts;
    const d0 = unwrap33(raw0, this.ref);
    const shift = d0 - raw0;
    const newDisc = this.lastDisc !== null && s.disc !== this.lastDisc;
    if (this.pts0 === null) {
      this.pts0 = Math.min(...r.samples.map((x) => x.dts + shift));
      this.discOff.set(s.disc, 0);
    } else if (!this.discOff.has(s.disc)) {
      // A discontinuity: the new time stamps follow straight on from the end of what came before.
      this.discOff.set(s.disc, this.pts0 + this.endT - d0);
      this.stats.discontinuities++;
    }
    const off = this.discOff.get(s.disc);
    const T = (x) => x + shift + off - this.pts0; // raw ticks → timeline ticks
    const samples = withDurations(r.samples.map((x) => ({ ...x, dts: T(x.dts), pts: T(x.pts) })));
    if (samples[0].dts < 0) throw gwError('segment {n} starts before the stream (its time stamps go backwards without a discontinuity tag)', { n: s.seq }, 'E_HLS_TIMELINE');
    this.ref = d0 + (r.samples.at(-1).dts - raw0);
    this.lastDisc = s.disc;
    const end = samples.at(-1).dts + samples.at(-1).duration;
    // A segment that starts before the end of the one before (overlap in the same discontinuity) is
    // trimmed by MSE itself; the timeline end only moves forward.
    this.endT = Math.max(this.endT, end);
    const key = r.sps.map(hexOf).join('.') + '|' + r.pps.map(hexOf).join('.');
    if (!this.inits.has(key)) this.inits.set(key, initSegment({ sps: r.sps, pps: r.pps, info: r.info }));
    s.initKey = key;
    s.t0 = samples[0].dts / TICKS;
    s.t1 = end / TICKS;
    s.T = T;
    s.frag = new Blob([fragment({ seq: s.seq + 1, samples, data: r.data })]);
    s.samples = samples;
    s.newDisc = newDisc;
    s.mime = r.mime;
    s.status = 'ready';
    this.order.push(s);
    this.order.sort((a, b) => a.t0 - b.t0);
    this.stats.segments++;
    this.stats.timeline.push({ seq: s.seq, disc: s.disc, t0: s.t0, t1: s.t1, frames: samples.length, listedAt: s.listedAt, fetchedAt: s.fetchedAt });
    if (this.stats.timeline.length > 2000) this.stats.timeline.shift();
    return s;
  }

  /** The clip model a video panel and features/fmv.js use, from the first segment. */
  makeClip(r) {
    const s = this.order[0];
    const pres = s.samples.slice().sort((a, b) => a.pts - b.pts);
    const dts = pres.slice(1).map((a, i) => a.pts - pres[i].pts).filter((d) => d > 0).sort((a, b) => a - b);
    const fps = dts.length ? Math.round((TICKS / dts[dts.length >> 1]) * 1000) / 1000 : 30;
    this.clip = { name: this.name, stream: this, live: this.live, file: null, url: null, container: 'ts', codec: r.mime ?? 'avc1.42E01E', videoPid: r.idx?.video?.pid ?? r.streams?.find((x) => x.type === 0x1b)?.pid ?? 256, width: r.info?.width ?? r.idx?.video?.width ?? 0, height: r.info?.height ?? r.idx?.video?.height ?? 0, fps, pts0: 0, frames: [], aus: [], packets: [], index: { streams: r.idx?.streams ?? [], errors: [] }, seqOff: 0, duration: 0 };
    this.addMedia(s, r);
  }

  /** A segment's frames and KLV packets onto the clip (frame times and KLV times on the media timeline). */
  addMedia(s, r) {
    const c = this.clip;
    const T = s.T;
    const sei = new Map((r.idx?.video?.sei ?? []).map(([i, time]) => [r.idx.video.pts[i], time]));
    const pres = s.samples.map((x, d) => ({ x, d, raw: r.samples[d].pts })).sort((a, b) => a.x.pts - b.x.pts);
    for (const { x, raw } of pres) {
      const i = c.frames.length;
      c.aus.push({ pts: x.pts, off: null, size: x.size, key: x.key, d: c.aus.length });
      c.frames.push({ i, pts: x.pts, t: x.pts / TICKS, d: c.aus.length - 1, key: x.key, sei: sei.get(raw) ?? null, disc: s.disc, seq: s.seq });
    }
    const ref = r.samples[0].dts;
    for (const rec of r.idx?.klv ?? []) {
      const base = rec.pts ?? rec.muxDts ?? rec.muxPts;
      const tMux = base === null || base === undefined ? null : T(unwrap33(base, ref)) / TICKS;
      for (const p of rec.packets ?? []) if (p.kind === 'uas') c.packets.push({ rec, p, ok: p.ok === true, sync: rec.sync, tMux, disc: s.disc, seq: s.seq });
    }
    for (const e of r.idx?.errors ?? []) if (c.index.errors.length < 50) c.index.errors.push(e);
    c.duration = c.frames.length ? c.frames.at(-1).t + 1 / c.fps : 0;
    s.frames = pres.length;
  }

  /** A later segment: its media onto the clip, the states rebuilt, the panel's slider extended. */
  grow(s, r) {
    if (!this.clip) return;
    if (r.info && this.clip.width && (r.info.width !== this.clip.width || r.info.height !== this.clip.height)) this.app.log('info', `${this.name}: frame size changed to ${r.info.width}×${r.info.height} at segment ${s.seq}`);
    if (this.clip.frames.length < MAX_FRAMES) this.addMedia(s, r);
    const t0 = performance.now();
    this.app.fmv.rebuildStates(this.clip);
    this.stats.rebuildMs.push(Math.round(performance.now() - t0));
    if (this.stats.rebuildMs.length > 500) this.stats.rebuildMs.shift();
    const v = this.view;
    if (v && !v.disposed) {
      v.slider.max = String(Math.max(0, this.clip.frames.length - 1));
      if (!v.playing) v._setFrame(v.frame, 'stream');
    }
    this.dropOld();
    this.pump();
  }

  /** A live stream keeps LIVE_DVR_S of segments to seek back into; older fragments are dropped. */
  dropOld() {
    if (!this.live) return;
    const edge = this.order.at(-1)?.t1 ?? 0;
    for (const s of this.order) if (s.frag && s.t1 < edge - LIVE_DVR_S) s.frag = null;
  }

  // ---- Media Source Extensions ----

  /** VideoView calls this (shell/videoview.js): the Media Source on its video element. Returns the "player". */
  async attach(view) {
    this.view = view;
    const MS = globalThis.MediaSource ?? globalThis.ManagedMediaSource;
    if (!MS) throw gwError('Media Source Extensions are not available in this browser', null, 'E_NO_MSE');
    const mime = `video/mp4; codecs="${this.clip.codec}"`;
    if (!MS.isTypeSupported(mime)) throw gwError('the codec {codec} is not supported by Media Source Extensions here', { codec: this.clip.codec }, 'E_HLS_CODEC');
    const ms = new MS();
    this.ms = ms;
    const video = view.video;
    this.objectUrl = URL.createObjectURL(ms);
    video.src = this.objectUrl;
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(gwError('the Media Source did not open', null, 'E_NO_MSE')), 10000);
      ms.addEventListener('sourceopen', () => (clearTimeout(to), res()), { once: true });
    });
    this.sb = ms.addSourceBuffer(mime);
    this.sb.mode = 'segments';
    // On demand: the playlist's length; live: no end (so nothing takes the buffered end for the stream's end).
    if (!this.live && this.pl.segments.length) ms.duration = Math.max(this.pl.duration, 0.1);
    else if (this.live) ms.duration = Infinity;
    video.addEventListener('seeking', () => this.onSeek());
    video.addEventListener('timeupdate', () => this.pump());
    video.addEventListener('waiting', () => this.pump());
    this.watchPresented(video);
    this.pump();
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(gwError('the stream did not start within 15 s', null, 'E_HLS_START')), 15000);
      const ok = () => (clearTimeout(to), res());
      if (video.readyState >= 2) ok();
      else video.addEventListener('loadeddata', ok, { once: true });
      video.addEventListener('error', () => (clearTimeout(to), rej(gwError('the browser could not decode the stream ({code})', { code: video.error?.code ?? '?' }, 'E_HLS_DECODE'))), { once: true });
    });
    return { unload: () => this.dispose(), detachMediaElement: () => {}, destroy: () => this.dispose(), session: this };
  }

  /** The first presentation of each segment (the player side of live latency). */
  watchPresented(video) {
    if (!video.requestVideoFrameCallback) return;
    const cb = (now, meta) => {
      if (this.disposed) return;
      const tm = meta.mediaTime;
      const s = this.order.find((x) => tm >= x.t0 - 1e-3 && tm < x.t1);
      if (s && !this.stats.presented.has(s.seq)) this.stats.presented.set(s.seq, { at: Date.now(), mediaTime: tm, listedAt: s.listedAt, fetchedAt: s.fetchedAt });
      if (this.stats.presented.size > 2000) this.stats.presented.delete(this.stats.presented.keys().next().value);
      video.requestVideoFrameCallback(cb);
    };
    video.requestVideoFrameCallback(cb);
  }

  onSeek() {
    const v = this.view?.video;
    if (!v || this.disposed) return;
    const tm = v.currentTime;
    const have = this.order.filter((s) => s.frag);
    if (have.length && !have.some((s) => tm >= s.t0 - 0.05 && tm < s.t1)) {
      // Outside what is kept (a live stream's dropped past, a missed segment): the nearest kept media.
      const near = have.reduce((a, s) => (Math.abs(s.t0 - tm) < Math.abs(a.t0 - tm) ? s : a));
      if (Math.abs(near.t0 - tm) > 0.05) {
        v.currentTime = near.t0 + 0.001;
        if (tm < near.t0) this.app.toast(t('{name}: the stream is kept from {s} s; the earlier part has gone', { name: this.name, s: num(near.t0, 1) }), { kind: 'info' });
      }
    }
    this.pump();
  }

  /** Append the fragments around the playhead, remove those far from it. */
  pump() {
    if (!this.sb || this.disposed || this.pumping) return;
    this.pumping = true;
    this.appendChain = this.appendChain
      .then(() => this.pumpOnce())
      .catch((e) => this.app.log('warn', `${this.name}: ${msgOf(e)}`))
      .finally(() => (this.pumping = false));
  }

  async pumpOnce() {
    const v = this.view?.video;
    if (!v) return;
    const tm = v.currentTime;
    const lo = tm - BEHIND_S;
    const hi = tm + AHEAD_S;
    // Removal first, whole segments only.
    for (const s of this.order) {
      if (s.appended && (s.t1 < lo || s.t0 > hi + AHEAD_S)) {
        await this.op(() => this.sb.remove(s.t0, s.t1));
        s.appended = false;
      }
    }
    for (const s of this.order) {
      if (this.disposed) return;
      if (s.appended || !s.frag || s.t1 < lo || s.t0 > hi) continue;
      if (this.lastInit !== s.initKey) {
        await this.op(() => this.sb.appendBuffer(this.inits.get(s.initKey)));
        this.lastInit = s.initKey;
      }
      const buf = new Uint8Array(await s.frag.arrayBuffer());
      const t0 = performance.now();
      try {
        await this.op(() => this.sb.appendBuffer(buf));
      } catch (e) {
        if (e?.name !== 'QuotaExceededError') throw e;
        // The browser's buffer is full: drop everything behind the playhead and try once more.
        await this.op(() => this.sb.remove(0, Math.max(0, tm - 2)));
        for (const q of this.order) if (q.t1 < tm - 2) q.appended = false;
        await this.op(() => this.sb.appendBuffer(buf));
      }
      this.stats.appendMs.push(Math.round(performance.now() - t0));
      if (this.stats.appendMs.length > 500) this.stats.appendMs.shift();
      s.appended = true;
      s.appendedAt = Date.now();
    }
    if (this.ended && !this.live && this.ms?.readyState === 'open' && this.order.every((s) => s.appended || s.t1 < lo) && this.order.at(-1)?.appended) {
      try {
        this.ms.duration = Math.max(this.order.at(-1).t1, 0.1);
        this.ms.endOfStream();
      } catch {
        /* a later append reopens it */
      }
    }
    this.jumpLiveGap(v);
  }

  /** One SourceBuffer operation, resolved on updateend. */
  op(fn) {
    return new Promise((res, rej) => {
      const sb = this.sb;
      const done = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        res();
      };
      const fail = () => {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        rej(gwError('the browser refused a stream segment', null, 'E_HLS_APPEND'));
      };
      sb.addEventListener('updateend', done);
      sb.addEventListener('error', fail);
      try {
        fn();
      } catch (e) {
        sb.removeEventListener('updateend', done);
        sb.removeEventListener('error', fail);
        rej(e);
      }
    });
  }

  /** A live stream stalled at a hole (a missed segment) moves on to the next media. */
  jumpLiveGap(v) {
    if (v.paused || v.seeking || v.readyState >= 3) return;
    const b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) > v.currentTime && b.start(i) - v.currentTime < 3 * (this.pl.targetDuration || 2) + 1 && (i === 0 || b.end(i - 1) <= v.currentTime + 0.1)) {
        v.currentTime = b.start(i) + 0.001;
        return;
      }
    }
  }

  // ---- MPEG-2: the app's own decoder, on demand only ----

  async startMpeg2(r0, pane) {
    if (this.live) throw gwError('live MPEG-2 HLS is not played: the app decodes MPEG-2 from a whole transport stream, which a live stream never is. Ask for H.264, or record the stream and open the file', null, 'E_HLS_MPEG2_LIVE');
    const segs = this.pl.segments;
    if (new Set(segs.map((s) => s.disc)).size > 1) throw gwError('this MPEG-2 stream has discontinuities, which the app’s MPEG-2 player does not stitch; only H.264 streams are stitched', null, 'E_HLS_MPEG2_DISC');
    const parts = [];
    let total = 0;
    for (const s of segs) {
      if (this.disposed) throw gwError('the request was cancelled', null, 'E_CANCELLED');
      const st = this.segs.get(s.seq);
      let b = await this.bytes(s.uri, s.byteRange);
      if (s.key) b = await decryptSegment(b, await this.keyFor(s.key.uri), s.key.ivBytes);
      total += b.byteLength;
      if (total > MPEG2_VOD_MAX) throw gwError('this MPEG-2 stream is larger than {n} GB; only H.264 streams play without being assembled in memory', { n: MPEG2_VOD_MAX / 2 ** 30 }, 'E_HLS_MPEG2_SIZE');
      parts.push(b);
      st.status = 'loaded';
      this.stats.segments++;
      this.stats.bytes += b.byteLength;
    }
    const file = new File(parts, `${this.name.split('/').pop().replace(/\.m3u8$/i, '') || 'stream'}.ts`, { type: 'video/mp2t' });
    this.mpeg2 = true;
    this.clip = await this.app.fmv.open(file, pane);
    this.clip.hlsSource = this.url;
    return this;
  }

  // ---- end ----

  fail(e) {
    if (this.disposed) return;
    this.error = e;
    this.app.toast(t('{name}: the stream stopped: {msg}', { name: this.name, msg: msgOf(e) }), { kind: 'error', ms: 10000 });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.ac.abort();
    try {
      if (this.ms?.readyState === 'open') this.ms.endOfStream();
    } catch {
      /* closing */
    }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    for (const s of this.order) s.frag = null;
    this.app.streams?.sessions.delete(this);
  }

  /** What tests and the status line read: no URLs with credentials, no bytes. */
  summary() {
    const lat = [...this.stats.presented.entries()].map(([seq, p]) => ({ seq, shownAt: p.at, mediaTime: p.mediaTime, listedToShownMs: p.at - p.listedAt, fetchedToShownMs: p.at - p.fetchedAt }));
    return { name: this.name, live: !!this.live, ended: !!this.ended, variant: this.variant ? { bandwidth: this.variant.bandwidth, resolution: this.variant.resolution, codecs: this.variant.codecs } : null, targetDuration: this.pl?.targetDuration ?? null, segments: this.stats.segments, missed: this.stats.missed, failed: this.stats.failed, discontinuities: this.stats.discontinuities, decrypted: this.stats.decrypted, reloads: this.stats.reloads, bytes: this.stats.bytes, frames: this.clip?.frames?.length ?? 0, packets: this.clip?.packets?.length ?? 0, edge: this.order.at(-1)?.t1 ?? 0, latency: lat, appendMs: this.stats.appendMs.slice(), indexMs: this.stats.indexMs.slice(), rebuildMs: this.stats.rebuildMs.slice(), timeline: this.stats.timeline.slice(), mpeg2: !!this.mpeg2, error: this.error ? msgOf(this.error) : null };
  }
}

const hexOf = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
};

function shortUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return String(u).slice(0, 120);
  }
}

function unsupportedCodec(codec) {
  if (!codec) return gwError('the segment has no video stream', null, 'E_HLS_NO_VIDEO');
  if (codec === 'hvc1') return gwError('the stream is H.265 (HEVC) video; HLS streams are played as H.264 or MPEG-2 only', null, 'E_HLS_CODEC');
  return gwError('the stream’s video ({codec}) is not played; HLS streams are played as H.264 or MPEG-2', { codec }, 'E_HLS_CODEC');
}

/** The js-streams block's install: app.streams and the Open HLS Stream command. */
export function installHls(app) {
  const sessions = new Set();
  async function open(url, opts = {}) {
    const u = String(url ?? '').trim();
    if (!/^https?:\/\//i.test(u)) throw gwError('enter a stream address that starts with http:// or https://', null, 'E_HLS_URL');
    if (!app.network?.isOnline?.()) throw gwError('GIS Workbench is offline (status bar ▸ Offline). Go online to reach {origin}.', { origin: originOf(u) ?? u }, 'E_OFFLINE');
    const s = new HlsSession(app, u, opts);
    sessions.add(s);
    try {
      await s.start(opts.pane ?? null);
    } catch (e) {
      s.dispose();
      sessions.delete(s);
      throw e;
    }
    const sum = s.summary();
    app.toast(s.mpeg2 ? t('{name}: on-demand MPEG-2 stream of {n, plural, one {# segment} other {# segments}} opened with the app’s decoder', { name: s.name, n: sum.segments }) : s.live ? t('{name}: live stream playing ({n, plural, one {# segment} other {# segments}} so far)', { name: s.name, n: sum.segments }) : t('{name}: on-demand stream opened; its segments load in the background', { name: s.name }), { kind: 'info' });
    return s;
  }

  async function dialog() {
    const url = h('input', { type: 'url', class: 'inp', placeholder: t('https://…/stream.m3u8'), 'data-id': 'hls:url', autocomplete: 'off', spellcheck: 'false' });
    const bw = h('select', { 'data-id': 'hls:bandwidth' }, h('option', { value: 'max' }, t('Best available')), h('option', { value: '8000000' }, t('Up to 8 Mb/s')), h('option', { value: '3000000' }, t('Up to 3 Mb/s')), h('option', { value: '1000000' }, t('Up to 1 Mb/s')));
    const body = h('div', {}, field(t('Playlist address (.m3u8)'), url), field(t('Variant'), bw), h('p', { class: 'hint' }, t('The stream’s origin, and its key server for an AES-128 stream, must be in this file’s network allow-list (Add-Ins ▸ Network Allow-List). H.264 plays live or on demand; MPEG-2 plays on demand through the app’s decoder.')));
    const r = await modal({ title: t('Open HLS Stream'), body, buttons: [{ label: tc('verb', 'Open'), value: 'open', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 520, id: 'hls-open' });
    if (r !== 'open') return null;
    return open(url.value, { maxBandwidth: bw.value === 'max' ? Infinity : Number(bw.value), pane: app.activePane() });
  }

  app.streams = { sessions, open, dialog, HlsSession };
  app.commands.implement('fmv.hls', {
    run: async () => {
      try {
        await dialog();
      } catch (e) {
        app.toast(msgOf(e), { kind: e?.code === 'E_HLS_URL' ? 'warn' : 'error', ms: 9000 });
      }
    },
  });
  return app.streams;
}
