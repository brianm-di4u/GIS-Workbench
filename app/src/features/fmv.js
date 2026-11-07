// Motion imagery (SCN-15; REQ-FMV-01..14, REQ-SNS-20; `Research/12`): MPEG-TS clips indexed by
// the Rust demuxer in the decode worker, ST 0601 KLV decoded to per-frame platform/sensor state,
// footprints by the priority of §12.2 (full corners → offset corners → computed from the KLV
// frame model and the DEM or the frame-centre height → sensor/centre/LOS only), a visible
// per-clip time basis (MISP Time by default, D9), a KLV table with raw values, frame capture (PNG + world file + JSON; NITF 2.1 with
// IGEOLO and a fitted RPC00B), and an event log plotted on the map.

import { minOf, maxOf, errorText } from '../core/util.js';
import { VideoView, HUD_BLOCKS } from '../shell/videoview.js';
import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { saveBlob, pickFiles } from '../storage/files.js';
import { writeNitf } from '../formats/nitf-writer.js';
import { screenOfGround, halo, poly } from '../tools/tools.js';
import { seekPoint } from '../shell/mpeg1media.js';
import { t, tr, N_, en, gwError, msgOf } from '../i18n/index.js';
import { num, length, height } from '../i18n/format.js';

export const name = 'fmv';

// TAI − UTC (s) from each date (IERS Bulletin C; frozen at 37 s after 2017 and from 2027, `05` §7).
const LEAPS = [
  [1972, 0, 10], [1972, 6, 11], [1973, 0, 12], [1974, 0, 13], [1975, 0, 14], [1976, 0, 15], [1977, 0, 16], [1978, 0, 17], [1979, 0, 18], [1980, 0, 19],
  [1981, 6, 20], [1982, 6, 21], [1983, 6, 22], [1985, 6, 23], [1988, 0, 24], [1990, 0, 25], [1991, 0, 26], [1992, 6, 27], [1993, 6, 28], [1994, 6, 29],
  [1996, 0, 30], [1997, 6, 31], [1999, 0, 32], [2006, 0, 33], [2009, 0, 34], [2012, 6, 35], [2015, 6, 36], [2017, 0, 37],
].map(([y, m, s]) => [Date.UTC(y, m, 1), s]);
export function taiMinusUtc(utcMs) {
  let v = 10;
  for (const [t, s] of LEAPS) if (utcMs >= t) v = s;
  return v;
}
export const MISP_TAI = 8.000082; // MISP = TAI − 8.000082 s (ST 0603.5)

const ANGLE_FIELDS = new Set(['heading', 'az', 'sroll']);
const NUM_FIELDS = ['lat', 'lon', 'hae', 'heading', 'pitch', 'roll', 'az', 'el', 'sroll', 'hfov', 'vfov', 'slant', 'fcLat', 'fcLon', 'fcHae', 'targetWidth', 'speed'];
const STALE_S = 1;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').replace('Z', '') : '–');
const unwrap = (a, b) => (b - a > 180 ? b - 360 : b - a < -180 ? b + 360 : b);
const wrap360 = (a) => ((a % 360) + 360) % 360;

/** One ST 0601 packet's items → the state fields it carries (Report-on-Change: missing items carry forward). */
export function packetFields(p, undulation = null) {
  const m = new Map();
  for (const it of p.items) m.set(it.t, it);
  const n = (t) => {
    const v = m.get(t)?.v;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const f = {};
  const set = (k, v) => {
    if (v !== null && v !== undefined) f[k] = v;
  };
  set('time', n(2));
  set('heading', n(5));
  set('pitch', n(90) ?? n(6));
  set('roll', n(91) ?? n(7));
  set('lat', n(13));
  set('lon', n(14));
  // Height: HAE items preferred (ST 0601: full-range and HAE forms win); MSL through the geoid.
  const msl = n(15);
  const hae = n(104) ?? n(75);
  if (hae !== null) set('hae', hae);
  else if (msl !== null && f.lat !== undefined && undulation) set('hae', msl + undulation(f.lat, f.lon));
  else if (msl !== null) Object.assign(f, { hae: msl, haeFromMsl: true });
  set('hfov', n(16));
  set('vfov', n(17));
  set('az', n(18));
  set('el', n(19));
  const sr = n(20);
  if (sr !== null) f.sroll = sr > 180 ? sr - 360 : sr;
  set('slant', n(21));
  set('targetWidth', n(96) ?? n(22));
  set('fcLat', n(23));
  set('fcLon', n(24));
  const fcHae = n(78);
  const fcMsl = n(25);
  if (fcHae !== null) set('fcHae', fcHae);
  else if (fcMsl !== null && f.fcLat !== undefined && undulation) set('fcHae', fcMsl + undulation(f.fcLat, f.fcLon));
  else if (fcMsl !== null) set('fcHae', fcMsl);
  set('speed', n(56));
  const full = [82, 84, 86, 88].map((t) => [n(t), n(t + 1)]);
  if (full.every(([a, b]) => a !== null && b !== null)) f.corners = full;
  const off = [26, 28, 30, 32].map((t) => [n(t), n(t + 1)]);
  if (off.every(([a, b]) => a !== null && b !== null)) f.offsets = off;
  for (const [k, t] of [['mission', 3], ['tail', 4], ['designation', 10], ['sensorName', 11]]) {
    const v = m.get(t)?.v;
    if (typeof v === 'string' && v) f[k] = v;
  }
  set('version', n(65));
  set('leap', n(136));
  set('corr', n(137));
  set('securityClass', m.get(48)?.set?.find((x) => x.t === 1)?.v);
  return f;
}

export async function install(app) {
  const C = app.commands;
  const S = app.store;
  const clips = new Map();
  let nextClip = 1;
  const options = { hud: true, trailS: 5, footprintTrail: 0, useDem: true };
  const sync = { clip: null, frame: -1, mapFrame: -1, sliderFrame: -1, source: '', at: 0, mediaTime: null, history: [] };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: e?.code === 'E_NO_VIDEO' ? 'warn' : 'error', ms: 8000 });
    }
  };
  /** A step to take first, not a failure (DN-62 L0): the command wrapper shows it as a warning. */
  const noVideo = () => gwError('open a video first', null, 'E_NO_VIDEO');
  /** errorText's plain-language reasons for damaged data, else the error in the UI language. */
  const errText = (e) => {
    const m = errorText(e);
    return m === String(e?.message ?? e ?? '') ? msgOf(e) : msgOf(m);
  };
  const decodeJob = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'decode', transfer, timeout: 300000, label: `${op}` });
  const und = () => {
    try {
      return app._geoidLoaded ? (lat, lon) => app.core.undulation(lat, lon) : null;
    } catch {
      return null;
    }
  };
  app.on('geoid', () => (app._geoidLoaded = true));

  // ---- clips ----

  function frameAt(clip, mediaTime) {
    const fr = clip.frames;
    let lo = 0;
    let hi = fr.length - 1;
    const t = mediaTime + 0.5 / clip.fps; // nearest frame start at or before
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (fr[mid].t <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Build the clip model from the demuxer's index (REQ-FMV-01, REQ-FMV-04). */
  function buildClip(file, idx, name) {
    const v = idx.video;
    const aus = v.pts.map((pts, i) => ({ pts, off: v.off[i], size: v.size[i], key: false, d: i }));
    for (const k of v.key) if (aus[k]) aus[k].key = true;
    const sei = new Map(v.sei.map(([i, t]) => [i, t]));
    const pres = aus.filter((a) => a.pts !== null).sort((a, b) => a.pts - b.pts);
    if (!pres.length && !idx.klv.length) throw new Error('no video access units and no KLV in this stream');
    const pts0 = pres[0]?.pts ?? idx.klv.find((k) => k.pts ?? k.muxPts)?.pts ?? 0;
    const dts = pres.slice(1, 200).map((a, i) => a.pts - pres[i].pts).filter((d) => d > 0).sort((a, b) => a - b);
    const fps = dts.length ? Math.round((90000 / dts[dts.length >> 1]) * 1000) / 1000 : 30;
    const frames = pres.map((a, i) => ({ i, pts: a.pts, t: (a.pts - pts0) / 90000, d: a.d, key: a.key, sei: sei.get(a.d) ?? null }));
    // KLV packets on the video timeline.
    const packets = [];
    for (const rec of idx.klv) {
      for (const p of rec.packets) {
        if (p.kind !== 'uas') continue;
        // Async KLV: the DTS of the preceding video PES (muxers interleave by DTS; the PTS of a
        // reordered frame leads by up to the reorder depth).
        const base = rec.pts ?? rec.muxDts ?? rec.muxPts;
        packets.push({ rec, p, ok: p.ok === true, sync: rec.sync, tMux: base === null || base === undefined ? null : (base - pts0) / 90000 });
      }
    }
    // container: 'ts', or 'ps' / 'es' for MPEG program streams and bare video streams (FC-22).
    const clip = { id: `clip${nextClip++}`, name, file, url: URL.createObjectURL(file), index: idx, container: idx.container ?? 'ts', seqOff: v.seqOff ?? aus[0]?.off ?? 0, aus, frames, fps, pts0, width: v.width ?? 0, height: v.height ?? 0, codec: v.codec, videoPid: v.pid, packets, offset: 0, basis: { kind: 'misp', source: 'default (D9)' }, fpCache: new Map(), models: new Map(), events: [], warnings: [] };
    clip.duration = frames.length ? frames.at(-1).t + 1 / fps : 0;
    rebuildStates(clip);
    basisHeuristic(clip);
    return clip;
  }

  /** Cumulative per-packet states (Report-on-Change) and their video-timeline times. */
  function rebuildStates(clip) {
    const u = und();
    let acc = {};
    const states = [];
    // Async KLV is placed by its Precision Time from the first timed packet (the anchor). A stream's
    // discontinuities (HLS, REQ-GAP-49: k.disc, f.disc) each have their own anchor and SEI frames;
    // a file is one group.
    const anchors = new Map();
    // ST 0604 SEI time stamps, when the frames carry them, map Precision Time to frames exactly.
    const seiBy = new Map();
    for (const f of clip.frames) if (f.sei !== null) (seiBy.get(f.disc ?? 0) ?? seiBy.set(f.disc ?? 0, []).get(f.disc ?? 0)).push(f);
    for (const k of clip.packets) {
      // Decoded once per packet while the geoid state stays (a live stream rebuilds per segment).
      const uk = u ? 'geoid' : 'none';
      const f = k.fields && k.fieldsU === uk ? k.fields : packetFields(k.p, u);
      k.fields = f;
      k.fieldsU = uk;
      if (!k.ok) continue;
      acc = { ...acc, ...f };
      const g = k.disc ?? 0;
      if (!anchors.has(g) && k.tMux !== null && f.time !== undefined) anchors.set(g, { t: k.tMux, time: f.time });
      const anchor = anchors.get(g) ?? null;
      const seiFrames = seiBy.get(g) ?? [];
      let t = k.sync ? k.tMux : null;
      if (t === null && f.time !== undefined) {
        if (seiFrames.length >= 2) t = seiTime(seiFrames, f.time);
        else if (anchor) t = anchor.t + (f.time - anchor.time) / 1e6;
      }
      if (t === null) t = k.tMux;
      if (t === null) continue;
      states.push({ t, packet: k, ...acc });
    }
    states.sort((a, b) => a.t - b.t);
    clip.states = states;
    clip.fpCache.clear();
    clip.leap = states.find((s) => s.leap !== undefined)?.leap ?? null;
  }

  function seiTime(seiFrames, time) {
    let k = 0;
    while (k < seiFrames.length - 2 && seiFrames[k + 1].sei < time) k++;
    const a = seiFrames[k];
    const b = seiFrames[k + 1];
    return a.t + ((time - a.sei) * (b.t - a.t)) / (b.sei - a.sei);
  }

  /** Heuristic (D9): a first time stamp on a whole UTC minute when read as POSIX suggests a legacy UTC encoder. */
  function basisHeuristic(clip) {
    const ts = clip.states[0]?.time;
    if (ts === undefined) return;
    clip.basisHint = null;
    if (ts % 60e6 === 0) clip.basisHint = t('the first time stamp falls on a whole minute when read as UTC/POSIX: the encoder may write legacy UTC');
  }

  /** Precision Time Stamp (µs) → UTC ms under the clip's basis (REQ-FMV-04). */
  function utcOf(clip, timeUs, kind = clip.basis.kind, corr = 0) {
    const ms = timeUs / 1000 + (corr ?? 0) / 1000;
    if (kind === 'utc') return ms;
    const leap = clip.leap ?? taiMinusUtc(ms - 29000);
    return ms - (leap - MISP_TAI) * 1000;
  }

  /** Where a clip's platform metadata came from, for labels: 'CSV' after fmv.csv, else 'KLV' (TE-050). */
  const metaSource = (clip) => (/^CSV\b/.test(clip?.metadataSource ?? '') ? 'CSV' : 'KLV');

  /** The clip's time basis: tx = t for the screen, en for files and project data. */
  function basisLabel(clip, tx = t) {
    if (metaSource(clip) === 'CSV') return tx(N_('Metadata time: CSV (taken as UTC)'));
    if (clip.basis.kind === 'utc') return tx(N_('KLV time: legacy UTC (no conversion)'));
    const t0 = clip.states[0]?.time ?? 0;
    const off = (utcOf(clip, t0) - t0 / 1000) / 1000;
    return clip.leap !== null ? tx(N_('KLV time: MISP→UTC {off, number, ::.0} s (Item 136)'), { off }) : tx(N_('KLV time: MISP→UTC {off, number, ::.0} s'), { off });
  }

  /** Interpolated state for frame i (REQ-FMV-06): linear between bracketing packets, angles unwrapped. */
  function stateAt(clip, i) {
    const fr = clip.frames[i];
    const ss = clip.states;
    if (!fr || !ss.length) return null;
    const t = fr.t + clip.offset;
    let lo = 0;
    let hi = ss.length - 1;
    if (t <= ss[0].t) hi = 0;
    else
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ss[mid].t <= t + 1e-9) lo = mid;
        else hi = mid - 1;
      }
    const a = ss[lo];
    const b = ss[Math.min(lo + 1, ss.length - 1)];
    let st;
    if (Math.abs(t - a.t) < 1e-6 || b === a || t < a.t) st = { ...a, stale: Math.abs(t - a.t) > STALE_S };
    else if (b.t - a.t > STALE_S) st = { ...a, stale: true };
    else {
      const w = (t - a.t) / (b.t - a.t);
      st = { ...a, stale: false, interpolated: true };
      for (const k of NUM_FIELDS) {
        if (typeof a[k] !== 'number' || typeof b[k] !== 'number') continue;
        const bv = ANGLE_FIELDS.has(k) ? unwrap(a[k], b[k]) : b[k];
        st[k] = a[k] + w * (bv - a[k]);
        if (ANGLE_FIELDS.has(k)) st[k] = wrap360(st[k]);
      }
      if (typeof a.time === 'number' && typeof b.time === 'number') st.time = a.time + w * (b.time - a.time);
      for (const key of ['corners', 'offsets']) {
        if (a[key] && b[key]) st[key] = a[key].map((c, q) => [c[0] + w * (b[key][q][0] - c[0]), c[1] + w * (b[key][q][1] - c[1])]);
      }
    }
    st.frame = i;
    st.utcMs = st.time !== undefined ? utcOf(clip, st.time, clip.basis.kind, st.corr) : NaN;
    st.utcText = iso(st.utcMs);
    const fp = footprint(clip, i, st);
    st.footprint = fp.corners;
    st.footprintSource = fp.source;
    st.footprintLabel = fp.label;
    st.footprintComputed = !!fp.computed;
    st.centre = fp.centre;
    st.check = fp.check;
    return st;
  }

  /** The KLV frame model of a state (REQ-SNS-20), or null without angles/FOV. */
  function frameModelOf(clip, st) {
    const need = ['lat', 'lon', 'hae', 'az', 'el', 'hfov'];
    if (!need.every((k) => Number.isFinite(st[k])) || !(clip.width > 0)) return null;
    return app.core.klvModel({ lat: st.lat, lon: st.lon, hae: st.hae, heading: st.heading ?? 0, pitch: st.pitch ?? 0, roll: st.roll ?? 0, az: st.az, el: st.el, sroll: st.sroll ?? 0, hfov: st.hfov, width: clip.width, height: clip.height }, `KLV frame model — ${clip.name}`);
  }

  /** Footprint priority (`Research/12` §12.2). */
  function footprint(clip, i, st) {
    const key = `${i}|${clip.offset}|${options.useDem && app.terrain?.dems?.length ? 'dem' : 'h'}`;
    const c = clip.fpCache.get(key);
    if (c) return c;
    const W = clip.width;
    const H = clip.height;
    // source: English (capture JSON, map record, tests); label: the UI language.
    const src = (s, pe, pt = pe) => ({ source: en(s, pe), label: t(s, pt) });
    let out = { corners: null, ...src(N_('none')), centre: Number.isFinite(st.fcLat) ? [st.fcLat, st.fcLon] : null, check: null };
    if (st.corners) out = { ...out, corners: st.corners.map((x) => x.slice()), ...src(N_('corners (Items 82–89)')) };
    else if (st.offsets && Number.isFinite(st.fcLat)) out = { ...out, corners: st.offsets.map(([a, b]) => [st.fcLat + a, st.fcLon + b]), ...src(N_('offset corners (Items 26–33)')) };
    const id = frameModelOf(clip, st);
    if (id) {
      try {
        const h0 = Number.isFinite(st.fcHae) ? st.fcHae : 0;
        const dem = options.useDem ? app.terrain?.dems?.[0] : null;
        const at = (x, y) => {
          if (dem?.coreId) {
            try {
              const r = app.core.rayDem(id, dem.coreId, x, y);
              if (Number.isFinite(r?.lat)) return [r.lat, r.lon];
            } catch {}
          }
          const g = app.core.i2g(id, x, y, h0);
          return [g.lat, g.lon];
        };
        const comp = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => at(x, y));
        const cc = at(W / 2, H / 2);
        if (!out.corners && comp.every((p) => Number.isFinite(p[0]))) out = { ...out, corners: comp, computed: true, ...(dem?.coreId ? src(N_('computed ({src} frame model + DEM)'), { src: metaSource(clip) }) : src(N_('computed ({src} frame model at {h} m HAE)'), { src: metaSource(clip), h: h0.toFixed(1) }, { src: metaSource(clip), h: num(h0, 1) })) };
        // Consistency check: the computed frame centre against Items 23/24 (default 50 m).
        if (Number.isFinite(st.fcLat) && Number.isFinite(cc[0])) {
          const d = app.core.inverse(st.fcLat, st.fcLon, cc[0], cc[1]).distance;
          out.check = { centreDiffM: d, flagged: d > 50 };
        }
        if (!out.centre) out.centre = cc;
      } finally {
        app.core.freeModel(id);
      }
    }
    clip.fpCache.set(key, out);
    if (clip.fpCache.size > 4000) clip.fpCache.delete(clip.fpCache.keys().next().value);
    return out;
  }

  function hudLines(clip, st, block) {
    const fmt = app.prefs.get('coordFormat') ?? 1;
    const ll = (la, lo) => (Number.isFinite(la) ? app.core.format(la, lo, fmt, fmt === 0 ? 5 : 1) : '–');
    const f1 = (v, u = '') => (Number.isFinite(v) ? `${num(v, 1)}${u}` : '–');
    switch (block) {
      case 'time':
        return [`${st.utcText} UTC`, basisLabel(clip), st.stale ? t('Frame {n}  METADATA STALE', { n: st.frame + 1 }) : t('Frame {n}', { n: st.frame + 1 })];
      case 'sensor':
        return [`SNS ${ll(st.lat, st.lon)}`, `ALT ${Number.isFinite(st.hae) ? `${height(st.hae, 1)} HAE` : '–'}${st.haeFromMsl ? ` ${t('(MSL, no geoid)')}` : ''}`, `HDG ${f1(st.heading, '°')}  ${st.designation ?? ''}`];
      case 'centre': {
        const c = st.centre;
        let mgrs = '';
        try {
          if (c) mgrs = app.core.mgrs(c[0], c[1], 5);
        } catch {}
        return [`CTR ${c ? ll(c[0], c[1]) : '–'}`, mgrs ? `MGRS ${mgrs}` : '', `FOOTPRINT ${st.footprintLabel ?? st.footprintSource}`].filter(Boolean);
      }
      case 'geometry': {
        const gsd = Number.isFinite(st.slant) && Number.isFinite(st.hfov) && clip.width ? (2 * st.slant * Math.tan(((st.hfov / 2) * Math.PI) / 180)) / clip.width : NaN;
        return [`SLR ${Number.isFinite(st.slant) ? length(st.slant, 1) : '–'}`, `AZ ${f1(st.az, '°')} EL ${f1(st.el, '°')}`, `HFOV ${f1(st.hfov, '°')}  GSD≈${Number.isFinite(gsd) ? length(gsd, 2) : '–'} ${t('(estimated)')}`];
      }
      default:
        return [];
    }
  }

  async function playable(clip) {
    if (!clip.videoPid || !clip.frames.length) return t('the stream has no video');
    // MPEG-1 and MPEG-2 video are decoded by the app itself (mpeg bundle; FC-22, REQ-GAP-48); no
    // browser codec needed. MPEG-2 falls back to the sidecar transcode only when the app's
    // decoder fails on the stream (clip.nativeFailed: a 4:2:2 profile, a damaged sequence).
    if (clip.codec === 'mp1v' || (clip.codec === 'mp2v' && !clip.nativeFailed)) {
      clip.support = { codec: clip.codec, native: true, mse: false, webcodecs: false };
      return null;
    }
    if (clip.codec === 'mp2v') return convertAction(clip) ? t('MPEG-2 (H.262) video is not decoded in the browser: it plays after the sidecar converts it to MPEG-TS (H.264 with the Windows sidecar; with the Linux one, H.264 if the OpenH264 module is installed, else MPEG-1) with every KLV stream kept (profile video-h264-klv, REQ-FMV-15)') : t('MPEG-2 (H.262) video is not decoded in the browser: it plays after the sidecar converts it to MPEG-TS (H.264 with the Windows sidecar; with the Linux one, H.264 if the OpenH264 module is installed, else MPEG-1) with every KLV stream kept (profile video-h264-klv, REQ-FMV-15); pair the GIS Workbench Sidecar to convert it');
    if (clip.codec === 'avc1' && clip.container !== 'ts') return t('H.264 video in an MPEG program stream is not played: remux it to MPEG-TS (the sidecar remux, or ffmpeg -i in.mpg -c copy out.ts)');
    const codec = clip.codec.length > 4 ? clip.codec : clip.codec === 'avc1' ? 'avc1.42E01E' : 'hvc1.1.6.L93.B0';
    const mse = globalThis.MediaSource?.isTypeSupported?.(`video/mp4; codecs="${codec}"`);
    let wc = false;
    try {
      wc = !!(await globalThis.VideoDecoder?.isConfigSupported?.({ codec, codedWidth: clip.width || 640, codedHeight: clip.height || 360 }))?.supported;
    } catch {}
    clip.support = { codec, mse: !!mse, webcodecs: wc };
    if (!mse) return t('the codec {codec} is not supported by Media Source Extensions here', { codec });
    return null;
  }

  // ---- exact frames through WebCodecs (REQ-FMV-05) ----

  async function decodeFrame(clip, i) {
    const fr = clip.frames[i];
    if (!fr || !globalThis.VideoDecoder) throw new Error('WebCodecs is not available');
    const d = fr.d;
    let k = d;
    while (k > 0 && !clip.aus[k].key) k--;
    const start = clip.aus[k].off;
    const end = d + 1 < clip.aus.length ? clip.aus[d + 1].off + 188 : clip.file.size;
    const r = await decodeJob('tspes', { file: clip.file, start, end, pid: clip.videoPid });
    const want = fr.pts;
    const ts = Math.round((want * 1e6) / 90000);
    // Keep only the frame nearest the target; close the rest at once (the decoder's frame pool is small).
    let best = null;
    let err = null;
    const dec = new VideoDecoder({
      output: (f) => {
        if (!best || Math.abs(f.timestamp - ts) < Math.abs(best.timestamp - ts)) {
          best?.close();
          best = f;
        } else f.close();
      },
      error: (e) => (err = e),
    });
    dec.configure({ codec: clip.support?.codec ?? clip.codec, optimizeForLatency: true });
    let o = 0;
    r.pes.forEach(([pts, , n], q) => {
      const chunk = new EncodedVideoChunk({ type: q === 0 ? 'key' : 'delta', timestamp: Math.round(((pts ?? 0) * 1e6) / 90000), data: r.data.subarray(o, o + n) });
      o += n;
      dec.decode(chunk);
    });
    await dec.flush();
    dec.close();
    if (err) throw err;
    if (!best || Math.abs(best.timestamp - ts) > 1000) {
      best?.close();
      throw gwError('frame {n} was not decoded from its GOP', { n: i + 1 });
    }
    return best;
  }

  /** Decoded by the app's own MPEG decoder (MPEG-1; MPEG-2 unless that decoder failed on it). */
  function nativeCodec(clip) {
    return clip?.codec === 'mp1v' || (clip?.codec === 'mp2v' && !clip.nativeFailed);
  }

  /** MPEG-2 (REQ-FMV-15, FC-22/23): the sidecar transcode, when the sidecar command exists. */
  function convertAction(clip) {
    if (clip?.codec !== 'mp2v' || !app.commands.get('sidecar.convert')?.implemented) return null;
    return { label: t('Convert with Sidecar'), run: () => app.commands.run('sidecar.convert', { files: [clip.file], profile: 'video-h264-klv', reason: 'MPEG-2 video' }) };
  }

  /** One exact MPEG-1 or MPEG-2 picture from the app's decoder (FC-22, REQ-GAP-48). */
  async function mpeg1Bitmap(clip, i) {
    const fr = clip.frames[i];
    if (!fr) throw gwError('no frame {n}', { n: i + 1 });
    const c = clip;
    const r = await decodeJob('mpvframe', { file: c.file, container: c.container, sid: c.container === 'es' ? 0 : c.videoPid, seqOff: c.seqOff, seek: seekPoint(c, i), au: fr.d, auPts: c.aus.map((a) => (a.pts === null ? NaN : a.pts)), codec: c.codec });
    const f = r.frames?.[0];
    if (!f?.bitmap) throw gwError('frame {n} was not decoded', { n: i + 1 });
    return f.bitmap;
  }

  async function frameBitmap(clip, i) {
    if (nativeCodec(clip)) return mpeg1Bitmap(clip, i);
    const f = await decodeFrame(clip, i);
    try {
      return await createImageBitmap(f);
    } finally {
      f.close();
    }
  }

  /** RGBA pixels of frame i at native size: WebCodecs, else the video element. */
  async function framePixels(clip, i, view = viewOf(clip)) {
    let src = null;
    let how = 'WebCodecs';
    try {
      src = await frameBitmap(clip, i);
    } catch (e) {
      if (!view || view.metadataOnly) throw gwError('no decoded frame: {msg}', { msg: msgOf(e) });
      how = 'video element';
      src = view.surface ?? view.video;
    }
    const W = src.width || src.videoWidth;
    const H = src.height || src.videoHeight;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    g.drawImage(src, 0, 0, W, H);
    src.close?.();
    return { canvas: c, width: W, height: H, how };
  }

  // ---- opening ----

  function viewOf(clip) {
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) if (p.video?.clip === clip) return p.video;
    return null;
  }

  function targetPane(pane) {
    const all = (app.desktop?.multiports ?? []).flatMap((mp) => mp.panes);
    if (pane && !pane.video && !pane.view3d && !pane.layers().length) return pane;
    return all.find((p) => !p.video && !p.view3d && !p.layers().length) ?? pane ?? app.activePane();
  }

  /**
   * BDAV transport streams (.m2ts / .mts: camcorders, Blu-ray) prefix every 188-byte packet with a
   * 4-byte arrival timestamp. They are repacked into plain 188-byte TS in memory, so the demuxer,
   * KLV and players see an ordinary stream; anything else is returned as it is.
   */
  async function plainTs(file) {
    const h = new Uint8Array(await file.slice(0, 192 * 4).arrayBuffer());
    const bdav = h.length >= 192 * 4 && [0, 1, 2, 3].every((k) => h[192 * k + 4] === 0x47) && !(h[0] === 0x47 && h[188] === 0x47);
    if (!bdav) return file;
    if (file.size > 2 ** 31) throw gwError('{file}: BDAV (.m2ts) streams over 2 GB are not repacked; remux it to .ts (ffmpeg -i in.m2ts -c copy -map 0 out.ts)', { file: file.name });
    const parts = [];
    const CH = 192 * 21845; // ~4 MiB of whole packets
    for (let off = 0; off + 192 <= file.size; off += CH) {
      const b = new Uint8Array(await file.slice(off, Math.min(file.size, off + CH)).arrayBuffer());
      const n = Math.floor(b.length / 192);
      const out = new Uint8Array(n * 188);
      for (let k = 0; k < n; k++) out.set(b.subarray(192 * k + 4, 192 * k + 192), 188 * k);
      parts.push(out);
    }
    return new File(parts, file.name.replace(/\.(m2ts|mts)$/i, '.ts'), { lastModified: file.lastModified });
  }

  async function open(file, pane = null) {
    const t0 = performance.now();
    const shown = file.name;
    const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    // MPEG program stream (pack header) or a bare MPEG video stream (sequence header): FC-22.
    const ps = magic[0] === 0 && magic[1] === 0 && magic[2] === 1 && (magic[3] === 0xba || magic[3] === 0xb3);
    let idx;
    if (ps) {
      idx = await decodeJob('psindex', { file });
      if (!idx.video?.count && !idx.klv?.length) {
        const p = { packs: idx.packs ?? 0, streams: idx.streams?.length ?? 0, codec: idx.video?.codec };
        throw p.codec ? gwError('no MPEG video pictures and no KLV in this program stream ({packs, plural, one {# pack} other {# packs}}, {streams, plural, one {# stream} other {# streams}}, video {codec}): it is damaged or holds audio only', p) : gwError('no MPEG video pictures and no KLV in this program stream ({packs, plural, one {# pack} other {# packs}}, {streams, plural, one {# stream} other {# streams}}): it is damaged or holds audio only', p);
      }
    } else {
      file = await plainTs(file);
      idx = await decodeJob('tsindex', { file });
      // TE-016: with no PAT/PMT nothing identifies the streams; the player then waited forever.
      if (!idx.streams?.length && !idx.video?.count && !idx.klv?.length) {
        throw gwError('no programme tables (PAT/PMT) and no recognisable video or KLV in {n, plural, one {# transport packet} other {# transport packets}}: the stream is damaged or not MPEG-TS', { n: idx.packets ?? 0 });
      }
    }
    const clip = buildClip(file, idx, shown);
    clips.set(clip.id, clip);
    const p = targetPane(pane);
    if (p.video) await closeVideo(p);
    p.video = await VideoView.create(app, p, clip);
    p.invalidate();
    active = clip;
    const ms = Math.round(performance.now() - t0);
    const bad = clip.packets.filter((k) => !k.ok).length;
    if (clip.codec === 'mp2v' && p.video.metadataOnly) app.toast(clip.packets.length ? t('{file}: MPEG-2 video is indexed with its KLV but plays only after the sidecar transcode (video-h264-klv: H.264 on Windows; on Linux, H.264 with the OpenH264 module, else MPEG-1)', { file: shown }) : t('{file}: MPEG-2 video is indexed but plays only after the sidecar transcode (video-h264-klv: H.264 on Windows; on Linux, H.264 with the OpenH264 module, else MPEG-1)', { file: shown }), { kind: 'warn', ms: 8000, action: convertAction(clip) ?? undefined });
    app.importLog.push({ file: file.name, errors: [], warnings: [...(bad ? [t('{n, plural, one {# KLV packet failed the checksum and was not used} other {# KLV packets failed the checksum and were not used}}', { n: bad })] : []), ...(clip.basisHint ? [t('time basis: {hint}', { hint: clip.basisHint })] : []), ...idx.errors] });
    const opened = { file: file.name, frames: clip.frames.length, packets: clip.packets.length, bad, ms };
    app.toast(p.video.metadataOnly ? t('Opened {file}: {frames, plural, one {# frame} other {# frames}}, {packets, plural, one {# KLV packet} other {# KLV packets}} ({bad} bad) in {ms} ms — metadata only', opened) : t('Opened {file}: {frames, plural, one {# frame} other {# frames}}, {packets, plural, one {# KLV packet} other {# KLV packets}} ({bad} bad) in {ms} ms', opened), { kind: 'info' });
    updateStatus(clip);
    zoomMap(clip);
    app.emit('state');
    return clip;
  }

  /** A clip built elsewhere (an HLS stream, REQ-GAP-49) shown in a video panel like an opened file. */
  async function openClip(clip, pane = null) {
    clip.id ??= `clip${nextClip++}`;
    clip.basis ??= { kind: 'misp', source: 'default (D9)' };
    clip.fpCache ??= new Map();
    clip.models ??= new Map();
    clip.events ??= [];
    clip.warnings ??= [];
    clip.offset ??= 0;
    rebuildStates(clip);
    basisHeuristic(clip);
    clips.set(clip.id, clip);
    const p = targetPane(pane);
    if (p.video) await closeVideo(p);
    p.video = await VideoView.create(app, p, clip);
    p.invalidate();
    active = clip;
    updateStatus(clip);
    zoomMap(clip);
    app.emit('state');
    return p.video;
  }

  function zoomMap(clip) {
    const pts = clip.states.flatMap((s) => [[s.lat, s.lon], ...(s.corners ?? [])]).filter((p) => Number.isFinite(p[0]));
    const map = app.desktop?.workspace?.map;
    if (!pts.length || !map) return;
    const lats = pts.map((p) => p[0]);
    const lons = pts.map((p) => p[1]);
    const r = map.el.getBoundingClientRect();
    const span = Math.max(maxOf(lons) - minOf(lons), maxOf(lats) - minOf(lats), 0.001);
    map.zoomTo((maxOf(lats) + minOf(lats)) / 2, (maxOf(lons) + minOf(lons)) / 2, Math.min(20000, (Math.max(200, r.width) * 0.6) / span));
  }

  let active = null;
  function activeClip() {
    const p = app.activePane();
    return p?.video?.clip ?? active;
  }

  /** The shared FMV time: called from the video's frame callback (AT-15.3). */
  function setFrame(clip, i, { source = '', view = null, mediaTime = null } = {}) {
    clip.current = i;
    active = clip;
    sync.clip = clip.id;
    sync.frame = i;
    sync.source = source;
    sync.mediaTime = mediaTime;
    sync.at = performance.now();
    sync.sliderFrame = view ? Number(view.slider.value) : i;
    const st = stateAt(clip, i);
    if (klvDialog?.clip === clip) klvDialog.render(i);
    app.renderer.invalidate();
    for (const mp of app.desktop?.multiports ?? []) for (const p of mp.panes) if (!p.video && p.layers().length) p.invalidate();
    // Linked video panes follow the active clip's UTC (REQ-FMV-13).
    if (options.linkPanes && source === 'video') linkOthers(clip, st);
  }

  function linkOthers(clip, st) {
    if (!Number.isFinite(st?.utcMs)) return;
    for (const mp of app.desktop?.multiports ?? []) {
      for (const p of mp.panes) {
        const v = p.video;
        if (!v || v.clip === clip || v.playing) continue;
        const j = frameForUtc(v.clip, st.utcMs);
        if (j !== null && j !== v.frame) v.seekFrame(j, 'link');
      }
    }
  }

  function frameForUtc(clip, utcMs) {
    let best = null;
    let bd = Infinity;
    for (let i = 0; i < clip.frames.length; i += Math.max(1, Math.floor(clip.frames.length / 400))) {
      const s = stateAt(clip, i);
      const d = Math.abs(s.utcMs - utcMs);
      if (d < bd) [best, bd] = [i, d];
    }
    return bd < 1000 ? best : null;
  }

  function updateStatus(clip) {
    for (const mp of app.desktop?.multiports ?? []) mp.status?.set({ klvtime: clip ? basisLabel(clip) + (clip.basisHint ? ' ⚠' : '') : '' });
  }

  function setBasis(clip, kind) {
    clip.basis = { kind, source: 'set by the analyst' };
    clip.fpCache.clear();
    updateStatus(clip);
    const v = viewOf(clip);
    if (v) v._setFrame(v.frame, 'basis');
  }

  function setOffset(clip, s) {
    clip.offset = Math.max(-2, Math.min(2, s));
    clip.fpCache.clear();
    const v = viewOf(clip);
    if (v) v._setFrame(v.frame, 'offset');
  }

  // ---- map and panel overlays (REQ-FMV-07, REQ-FMV-10) ----

  const COL = { path: [0, 0.85, 1, 1], los: [1, 0.85, 0, 1], foot: [1, 0.2, 0.2, 1], footFill: [1, 0.2, 0.2, 0.18], centre: [1, 1, 0, 1], platform: [0, 1, 1, 1], event: [1, 0.3, 1, 1] };

  function marker(lat, lon, s, kind = 'square') {
    if (kind === 'cross') return [lon - s, lat, lon + s, lat, lon, lat - s, lon, lat + s];
    return [lon - s, lat - s, lon + s, lat - s, lon + s, lat + s, lon - s, lat - s, lon + s, lat + s, lon - s, lat + s];
  }

  /** Draw on the workspace map (plate carrée, lon/lat). */
  function drawMap(r, m, vp, map) {
    const gl = r.gl;
    const s = 5 / Math.max(1e-6, map.view.zoom);
    const flat = (arr, mode, col) => arr.length && r.drawFlat(new Float32Array(arr), mode, col, m, vp.w, vp.h);
    const rec = { frame: null, clip: null, footprint: null, events: 0 };
    for (const clip of clips.values()) {
      if (clip.visible === false) continue;
      const path = [];
      for (const st of clip.states) if (Number.isFinite(st.lat)) path.push(st.lon, st.lat);
      if (path.length >= 4) flat(path, gl.LINE_STRIP, COL.path);
      const i = clip.current ?? 0;
      const st = stateAt(clip, i);
      if (!st) continue;
      if (Number.isFinite(st.lat)) {
        // Platform icon rotated by heading.
        const hd = (((st.heading ?? 0) * Math.PI) / 180);
        const tip = [st.lon + 2 * s * Math.sin(hd), st.lat + 2 * s * Math.cos(hd)];
        const l = [st.lon + s * Math.sin(hd - 2.5), st.lat + s * Math.cos(hd - 2.5)];
        const rr = [st.lon + s * Math.sin(hd + 2.5), st.lat + s * Math.cos(hd + 2.5)];
        flat([...tip, ...l, ...rr], gl.TRIANGLES, COL.platform);
        if (st.centre) flat([st.lon, st.lat, st.centre[1], st.centre[0]], gl.LINES, COL.los);
      }
      if (options.footprintTrail > 0) {
        for (let k = i % Math.round(options.footprintTrail * clip.fps); k < i; k += Math.round(options.footprintTrail * clip.fps)) {
          const f = stateAt(clip, k)?.footprint;
          if (f) flat(f.flatMap(([la, lo]) => [lo, la]), gl.LINE_LOOP, [1, 0.5, 0.5, 0.4]);
        }
      }
      if (st.footprint) {
        const v = st.footprint.flatMap(([la, lo]) => [lo, la]);
        flat(v, gl.TRIANGLE_FAN, COL.footFill);
        flat(v, gl.LINE_LOOP, st.stale ? [1, 0.6, 0, 1] : COL.foot);
      }
      if (st.centre) flat(marker(st.centre[0], st.centre[1], s, 'cross'), gl.LINES, COL.centre);
      if (clip === activeClip()) Object.assign(rec, { frame: i, clip: clip.id, footprint: st.footprint, source: st.footprintSource });
    }
    const evs = S.all('fmvevent');
    const ev = evs.filter((e) => Number.isFinite(e.lat)).flatMap((e) => marker(e.lat, e.lon, s));
    flat(ev, gl.TRIANGLES, COL.event);
    rec.events = evs.length;
    sync.mapFrame = rec.frame ?? -1;
    sync.history.push({ video: sync.frame, map: sync.mapFrame, slider: sync.sliderFrame, t: performance.now() });
    if (sync.history.length > 600) sync.history.splice(0, 300);
    api.lastMap = rec;
  }

  /** Draw on georeferenced image panels: footprint, LOS and sensor. */
  function drawPane(p, g) {
    if (p.video) return;
    const l = p.geoLayer?.();
    if (!l?.modelId) return;
    const clip = activeClip();
    const scr = (la, lo, hh = 0) => screenOfGround(p, la, lo, hh);
    g.save();
    if (clip) {
      const st = stateAt(clip, clip.current ?? 0);
      if (st?.footprint) {
        const pts = st.footprint.map(([la, lo]) => scr(la, lo, st.fcHae ?? 0));
        if (pts.every(Boolean)) {
          g.strokeStyle = '#ff3333';
          g.lineWidth = 2;
          halo(g, () => poly(g, pts, true));
        }
      }
    }
    g.restore();
  }

  const prevDraw = app.graphics?.drawPane;
  if (app.graphics) {
    app.graphics.drawPane = (p, g, w, hh) => {
      prevDraw?.(p, g, w, hh);
      drawPane(p, g);
    };
  }

  // ---- KLV table (REQ-FMV-02) ----

  let klvDialog = null;

  function packetAtFrame(clip, i) {
    const st = stateAt(clip, i);
    return st?.packet ?? null;
  }

  function flatItems(items, depth = 0, out = []) {
    for (const it of items) {
      out.push({ ...it, depth });
      if (it.set) flatItems(it.set, depth + 1, out);
    }
    return out;
  }

  function klvRows(clip, i) {
    const k = packetAtFrame(clip, i);
    if (!k) return { k: null, rows: [] };
    const idx = clip.packets.indexOf(k);
    const prev = clip.packets[idx - 1];
    const prevHex = new Map((prev?.p.items ?? []).map((x) => [x.t, x.h]));
    const rows = flatItems(k.p.items).map((x) => ({ ...x, changed: x.depth === 0 && prevHex.has(x.t) && prevHex.get(x.t) !== x.h }));
    return { k, idx, rows };
  }

  async function klvTable(clip = activeClip()) {
    if (!clip) throw noVideo();
    const head = h('div', { class: 'klv-head', 'data-id': 'klv-head' });
    const body = h('tbody');
    const table = h('table', { class: 'tbl klv-table', 'data-id': 'klv-table' }, h('thead', {}, h('tr', {}, ...[t('Tag'), t('Name'), t('Value'), t('Units'), t('Raw (hex)')].map((x) => h('th', {}, x)))), body);
    const render = (i) => {
      const { k, idx, rows } = klvRows(clip, i);
      const st = stateAt(clip, i);
      head.textContent = k
        ? [t('Packet {n} of {total}', { n: idx + 1, total: clip.packets.length }), k.ok ? t('checksum OK') : t('checksum FAILED (not used)'), t('UAS LS version {v}', { v: k.fields?.version ?? '–' }), basisLabel(clip), t('footprint: {source}', { source: st?.footprintLabel ?? st?.footprintSource }), ...(st?.check?.flagged ? [t('⚠ computed centre {d} from Items 23/24', { d: length(st.check.centreDiffM, 0) })] : [])].join(' · ')
        : t('No KLV for this frame');
      body.replaceChildren(
        ...rows.map((x) =>
          h(
            'tr',
            { class: `${x.changed ? 'changed' : ''} ${x.unknown ? 'unknown' : ''}`.trim(), 'data-tag': String(x.t) },
            h('td', {}, String(x.t)),
            h('td', { style: `padding-left:${6 + x.depth * 14}px` }, x.unknown ? t('{name} (unknown item, kept)', { name: x.n }) : x.n),
            h('td', {}, x.v === null || x.v === undefined ? (x.s ?? '') : typeof x.v === 'number' ? String(Math.round(x.v * 1e9) / 1e9) : String(x.v)),
            h('td', {}, x.u ?? ''),
            h('td', { class: 'mono' }, x.h ?? ''),
          ),
        ),
      );
    };
    klvDialog = { clip, render };
    render(clip.current ?? 0);
    const b = await modal({ title: t('KLV — {clip}', { clip: clip.name }), body: h('div', {}, head, h('div', { class: 'klv-scroll' }, table), h('p', { class: 'hint' }, t('Changed items since the previous packet are highlighted. Unknown items are listed with their raw bytes (AC-15.1).'))), buttons: [{ label: t('Export CSV'), value: 'csv', primary: true }, { label: t('Close'), value: 'close' }], width: 820, id: 'fmv-klv', modeless: true });
    klvDialog = null;
    if (b === 'csv') await exportKlvCsv(clip);
  }

  function klvCsv(clip) {
    const tags = [...new Set(clip.packets.flatMap((k) => k.p.items.map((x) => x.t)))].sort((a, b) => a - b);
    const names = new Map(clip.packets.flatMap((k) => k.p.items.map((x) => [x.t, x.n])));
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [['packet', 'checksum', 'time_raw_us', 'utc', 't_video_s', ...tags.map((t) => `${t} ${names.get(t)}`)].map(esc).join(',')];
    clip.packets.forEach((k, n) => {
      const m = new Map(k.p.items.map((x) => [x.t, x]));
      const t = k.fields?.time;
      lines.push([n + 1, k.ok ? 'ok' : 'failed', t ?? '', t !== undefined ? iso(utcOf(clip, t)) : '', k.tMux ?? '', ...tags.map((g) => (m.has(g) ? (m.get(g).v ?? m.get(g).h) : ''))].map(esc).join(','));
    });
    return lines.join('\n') + '\n';
  }

  async function exportKlvCsv(clip = activeClip()) {
    await saveBlob(app, new Blob([klvCsv(clip)], { type: 'text/csv' }), { name: `${clip.name.replace(/\.\w+$/, '')}_klv.csv`, types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
  }

  // ---- frame capture (REQ-FMV-09) ----

  /** Affine world file (pixel-centre convention) fitted to the four footprint corners. */
  function worldFile(corners, W, H) {
    const px = [[0, 0], [W, 0], [W, H], [0, H]];
    const fit = (vals) => {
      // Least squares v = a + b x + c y over the four corners.
      let [sx, sy, sxx, sxy, syy, sv, sxv, syv] = [0, 0, 0, 0, 0, 0, 0, 0];
      px.forEach(([x, y], k) => {
        sx += x;
        sy += y;
        sxx += x * x;
        sxy += x * y;
        syy += y * y;
        sv += vals[k];
        sxv += x * vals[k];
        syv += y * vals[k];
      });
      const M = [[4, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
      const rhs = [sv, sxv, syv];
      const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(M);
      return [0, 1, 2].map((c) => det(M.map((row, r) => row.map((v, j) => (j === c ? rhs[r] : v)))) / D);
    };
    const [a, b, c] = fit(corners.map((p) => p[1]));
    const [d, e, f] = fit(corners.map((p) => p[0]));
    return [b, e, c, f, a + b * 0.5 + c * 0.5, d + e * 0.5 + f * 0.5].map((v) => v.toPrecision(15)).join('\n') + '\n';
  }

  function klvSnapshot(clip, st) {
    return st?.packet ? flatItems(st.packet.p.items).map((x) => ({ tag: x.t, name: x.n, value: x.v ?? x.s ?? null, units: x.u ?? '', hex: x.h, depth: x.depth })) : [];
  }

  /**
   * Capture frame i: PNG + world file + JSON sidecar, and (nitf) NITF 2.1 with IGEOLO from the
   * footprint and an RPC00B fitted to the frame's model (the KLV frame
   * model when the footprint is computed, else a projective model through the footprint corners).
   */
  /**
   * A frame with no footprint (a clip without KLV, such as an old MPEG-1 program stream): the PNG
   * and its JSON are saved without a world file or NITF, and the reason is said.
   */
  async function captureUngeoreferenced(clip, i, st, { save = true } = {}) {
    const px = await framePixels(clip, i);
    const base = `${clip.name.replace(/\.\w+$/, '')}_f${String(i + 1).padStart(5, '0')}`;
    const png = await px.canvas.convertToBlob({ type: 'image/png' });
    const reason = clip.packets.length ? N_('the KLV for this frame gives no footprint') : N_('the clip carries no KLV');
    const meta = { clip: clip.name, frame: i + 1, pts: clip.frames[i].pts, videoTimeS: clip.frames[i].t, decodedWith: px.how, georeference: null, reason, utc: Number.isFinite(st?.utcMs) ? new Date(st.utcMs).toISOString() : null };
    const json = new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' });
    if (save) {
      await saveBlob(app, png, { name: `${base}.png`, types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }] });
      await saveBlob(app, json, { name: `${base}.json`, preferPicker: false });
    }
    app.toast(t('Captured frame {n} as PNG without a georeference: {reason} (no world file or NITF)', { n: i + 1, reason: tr(reason) }), { kind: 'warn', ms: 6000 });
    return { base, png, json, width: px.width, height: px.height, footprint: null, source: 'none', reason };
  }

  async function capture(clip = activeClip(), i = clip?.current ?? 0, { nitf = true, save = true } = {}) {
    if (!clip) throw noVideo();
    const st = stateAt(clip, i);
    if (!st?.footprint) return captureUngeoreferenced(clip, i, st, { save });
    const px = await framePixels(clip, i);
    const { width: W, height: H } = px;
    const base = `${clip.name.replace(/\.\w+$/, '')}_f${String(i + 1).padStart(5, '0')}`;
    const png = await px.canvas.convertToBlob({ type: 'image/png' });
    const pgw = worldFile(st.footprint, W, H);
    const meta = {
      clip: clip.name,
      frame: i + 1,
      pts: clip.frames[i].pts,
      videoTimeS: clip.frames[i].t,
      decodedWith: px.how,
      precisionTimeUs: st.time,
      utc: new Date(st.utcMs).toISOString(),
      timeBasis: basisLabel(clip, en),
      footprint: { type: 'Polygon', coordinates: [[...st.footprint, st.footprint[0]].map(([la, lo]) => [lo, la])] },
      footprintSource: st.footprintSource,
      worldFileNote: 'The world file is an affine fit to the four corners; for oblique frames the GeoJSON footprint is the authoritative georeference.',
      klv: klvSnapshot(clip, st),
    };
    const json = new Blob([JSON.stringify(meta, null, 1)], { type: 'application/json' });
    const out = { base, png, pgw: new Blob([pgw], { type: 'text/plain' }), json, width: W, height: H, footprint: st.footprint, source: st.footprintSource };
    if (nitf) {
      const rgba = px.canvas.getContext('2d').getImageData(0, 0, W, H).data;
      const planes = [0, 1, 2].map((b) => {
        const p = new Uint8Array(W * H);
        for (let k = 0; k < W * H; k++) p[k] = rgba[4 * k + b];
        return p;
      });
      // RPC fit over the footprint ± a margin and the frame-centre height ± 50 m.
      const lats = st.footprint.map((p) => p[0]);
      const lons = st.footprint.map((p) => p[1]);
      const padLa = (maxOf(lats) - minOf(lats)) * 0.05 + 1e-5;
      const padLo = (maxOf(lons) - minOf(lons)) * 0.05 + 1e-5;
      const h0 = Number.isFinite(st.fcHae) ? st.fcHae : 0;
      const tail = [minOf(lats) - padLa, maxOf(lats) + padLa, minOf(lons) - padLo, maxOf(lons) + padLo, h0 - 50, h0 + 50, W, H];
      const computed = st.footprintComputed;
      const job = computed
        ? [0, st.lat, st.lon, st.hae, st.heading ?? 0, st.pitch ?? 0, st.roll ?? 0, st.az, st.el, st.sroll ?? 0, st.hfov, ...tail]
        : [1, ...[[0, 0], [W, 0], [W, H], [0, H]].flatMap(([x, y], k) => [x, y, st.footprint[k][0], st.footprint[k][1]]), ...tail];
      let rpc = null;
      try {
        const f = await app.pool.run('fitrpcklv', { job: Float64Array.from(job) }, { kind: 'analysis', timeout: 120000 });
        rpc = f.record.slice();
        rpc[0] = -1;
        rpc[1] = -1;
        out.rpcFit = { rmsPx: f.rmsPx, maxPx: f.maxPx, model: computed ? 'KLV frame model' : 'projective model through the footprint corners' };
      } catch (e) {
        out.rpcFit = { error: e.message };
      }
      // IGEOLO takes pixel-centre corners: interpolate the footprint at the half-pixel positions.
      const bil = (u, v) => {
        const c = st.footprint;
        const top = [c[0][0] + u * (c[1][0] - c[0][0]), c[0][1] + u * (c[1][1] - c[0][1])];
        const bot = [c[3][0] + u * (c[2][0] - c[3][0]), c[3][1] + u * (c[2][1] - c[3][1])];
        return [top[0] + v * (bot[0] - top[0]), top[1] + v * (bot[1] - top[1])];
      };
      const e = [0.5 / W, 1 - 0.5 / W];
      const f = [0.5 / H, 1 - 0.5 / H];
      const corners = [bil(e[0], f[0]), bil(e[1], f[0]), bil(e[1], f[1]), bil(e[0], f[1])];
      const d = new Date(st.utcMs);
      const idatim = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      // ST 0102 class 1–5 in the one letter NITF has for it; anything else keeps the writer's default.
      const fsclas = { 1: 'U', 2: 'R', 3: 'C', 4: 'S', 5: 'T' }[st.securityClass];
      const bytes = writeNitf({ width: W, height: H, bands: 3, type: 'u8', planes }, { security: fsclas ? { file: { class: fsclas } } : undefined, title: `FMV frame ${i + 1} of ${clip.name}`.slice(0, 80), iid1: 'FMVFRAME', iid2: `${clip.name} frame ${i + 1}`.slice(0, 80), idatim, isorce: (st.designation ?? st.sensorName ?? 'FMV').slice(0, 42), icat: 'VIS', irep: 'RGB', corners, rpc: rpc ?? undefined });
      out.nitf = new Blob([bytes], { type: 'application/octet-stream' });
      out.nitfName = `${base}.ntf`;
      out.nitfCorners = corners;
    }
    if (save) {
      await saveBlob(app, out.png, { name: `${base}.png`, types: [{ description: 'PNG', accept: { 'image/png': ['.png'] } }] });
      await saveBlob(app, out.pgw, { name: `${base}.pgw`, preferPicker: false });
      await saveBlob(app, out.json, { name: `${base}.json`, preferPicker: false });
      if (out.nitf) await saveBlob(app, out.nitf, { name: out.nitfName, preferPicker: false });
    }
    app.toast(!out.nitf ? t('Captured frame {n}', { n: i + 1 }) : out.rpcFit?.rmsPx !== undefined ? t('Captured frame {n} (NITF, RPC fit {rms} px RMS)', { n: i + 1, rms: num(out.rpcFit.rmsPx, 3) }) : t('Captured frame {n} (NITF)', { n: i + 1 }), { kind: 'info' });
    return out;
  }

  // ---- event log (REQ-FMV-10) ----

  async function addEvent(clip = activeClip(), { text = '', tag = 'note', at = null, thumb = true } = {}) {
    if (!clip) throw noVideo();
    const i = clip.current ?? 0;
    const st = stateAt(clip, i);
    const pos = at ?? st?.centre ?? null;
    let thumbnail = null;
    if (thumb) {
      try {
        const px = await framePixels(clip, i);
        const c = new OffscreenCanvas(160, Math.round((160 * px.height) / px.width));
        c.getContext('2d').drawImage(px.canvas, 0, 0, c.width, c.height);
        const b = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
        thumbnail = await new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res(r.result);
          r.readAsDataURL(b);
        });
      } catch {}
    }
    let id;
    S.transact(t('Log event'), (tx) => {
      id = tx.create('fmvevent', { clip: clip.name, frame: i + 1, pts: clip.frames[i].pts, timeRaw: st?.time ?? null, utc: Number.isFinite(st?.utcMs) ? new Date(st.utcMs).toISOString() : null, basis: basisLabel(clip, en), lat: pos?.[0] ?? null, lon: pos?.[1] ?? null, text, tag, thumbnail, created: new Date().toISOString() });
    });
    app.renderer.invalidate();
    return S.get(id);
  }

  function eventsAs(fmt) {
    const evs = S.all('fmvevent');
    if (fmt === 'geojson') return JSON.stringify({ type: 'FeatureCollection', features: evs.map((e) => ({ type: 'Feature', geometry: Number.isFinite(e.lat) ? { type: 'Point', coordinates: [e.lon, e.lat] } : null, properties: { clip: e.clip, frame: e.frame, utc: e.utc, timeRaw: e.timeRaw, basis: e.basis, tag: e.tag, text: e.text } })) }, null, 1);
    if (fmt === 'kml') {
      const x = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
      return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>FMV event log</name>${evs.filter((e) => Number.isFinite(e.lat)).map((e) => `<Placemark><name>${x(e.tag)}: ${x(e.text)}</name><TimeStamp><when>${x(e.utc)}</when></TimeStamp><description>${x(e.clip)} frame ${e.frame}</description><Point><coordinates>${e.lon},${e.lat},0</coordinates></Point></Placemark>`).join('')}</Document></kml>\n`;
    }
    const esc = (v) => (/[",\n]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
    return ['utc,time_raw_us,basis,clip,frame,lat,lon,tag,text', ...evs.map((e) => [e.utc, e.timeRaw, e.basis, e.clip, e.frame, e.lat, e.lon, e.tag, e.text].map(esc).join(','))].join('\n') + '\n';
  }

  async function eventLog() {
    const list = h('tbody');
    const fill = () =>
      list.replaceChildren(
        ...S.all('fmvevent').map((e) =>
          h('tr', {}, h('td', {}, e.thumbnail ? h('img', { src: e.thumbnail, width: 64, alt: '' }) : ''), h('td', {}, e.utc ?? ''), h('td', {}, `${e.clip} #${e.frame}`), h('td', {}, tr(e.tag)), h('td', {}, e.text), h('td', {}, Number.isFinite(e.lat) ? app.core.format(e.lat, e.lon, 0, 6) : '')),
        ),
      );
    fill();
    const text = h('input', { type: 'text', placeholder: t('Event text'), 'data-id': 'fmv-event-text' });
    // Tags are stored and exported as these English values; the list shows them translated.
    const tag = h('select', {}, ...[N_('note'), N_('vehicle'), N_('person'), N_('activity'), N_('marker'), N_('other')].map((v) => h('option', { value: v }, tr(v))));
    const b = await modal({ title: t('FMV Event Log'), body: h('div', {}, field(t('Text'), text), field(t('Tag'), tag), h('table', { class: 'tbl', 'data-id': 'fmv-events' }, h('thead', {}, h('tr', {}, ...['', 'UTC', t('Frame'), t('Tag'), t('Text'), t('Position')].map((x) => h('th', {}, x)))), list)), buttons: [{ label: t('Log at this frame'), value: 'log', primary: true }, { label: t('Export CSV'), value: 'csv' }, { label: t('Export GeoJSON'), value: 'geojson' }, { label: t('Export KML'), value: 'kml' }, { label: t('Close'), value: 'close' }], width: 760, id: 'fmv-events' });
    if (b === 'log') await addEvent(activeClip(), { text: text.value, tag: tag.value });
    else if (b === 'csv' || b === 'geojson' || b === 'kml') {
      const fmt = b;
      await saveBlob(app, new Blob([eventsAs(fmt)], { type: 'text/plain' }), { name: `fmv_events.${fmt === 'geojson' ? 'geojson' : fmt}` });
    }
  }

  // ---- external metadata (REQ-FMV-14) ----

  /** CSV platform metadata for video without KLV: columns time (s or ISO), lat, lon, alt, heading, az, el, hfov, … */
  async function importCsv(clip, file) {
    const text = await file.text();
    const rows = text.split(/\r?\n/).filter((x) => x.trim());
    const head = rows.shift().split(',').map((x) => x.trim().toLowerCase());
    const col = (names) => head.findIndex((x) => names.includes(x));
    const C = { t: col(['time', 't', 'seconds', 'utc']), lat: col(['lat', 'latitude', 'sensor_lat']), lon: col(['lon', 'longitude', 'sensor_lon']), hae: col(['alt', 'hae', 'altitude', 'height']), heading: col(['heading', 'hdg']), pitch: col(['pitch']), roll: col(['roll']), az: col(['az', 'azimuth', 'rel_az']), el: col(['el', 'elevation', 'rel_el']), hfov: col(['hfov', 'fov']), fcLat: col(['fc_lat', 'center_lat', 'centre_lat']), fcLon: col(['fc_lon', 'center_lon', 'centre_lon']), fcHae: col(['fc_hae', 'center_hae', 'ground_hae']) };
    if (C.t < 0 || C.lat < 0 || C.lon < 0) throw new Error('the CSV needs time, lat and lon columns');
    let t0 = null;
    const states = rows.map((r) => {
      const v = r.split(',');
      const num = (k) => (C[k] >= 0 && v[C[k]] !== '' ? Number(v[C[k]]) : undefined);
      let tt = Number(v[C.t]);
      if (!Number.isFinite(tt)) tt = Date.parse(v[C.t]) / 1000;
      t0 ??= tt;
      const s = { t: tt - t0, time: tt * 1e6, packet: null };
      for (const k of ['lat', 'lon', 'hae', 'heading', 'pitch', 'roll', 'az', 'el', 'hfov', 'fcLat', 'fcLon', 'fcHae']) if (num(k) !== undefined) s[k] = num(k);
      return s;
    });
    clip.states = states.sort((a, b) => a.t - b.t);
    clip.basis = { kind: 'utc', source: 'CSV (times taken as UTC)' };
    clip.fpCache.clear();
    clip.metadataSource = `CSV ${file.name}`;
    updateStatus(clip);
    const v = viewOf(clip);
    if (v) v._setFrame(v.frame, 'csv');
    return states.length;
  }

  // ---- mensuration over paused video (REQ-FMV-13, COULD) ----

  function measureClick(view, sx, sy) {
    const clip = view.clip;
    const st = stateAt(clip, view.frame);
    const cr = view.contentRect();
    const x = (sx - cr.x) / cr.scale;
    const y = (sy - cr.y) / cr.scale;
    if (x < 0 || y < 0 || x > cr.vw || y > cr.vh) return;
    const id = frameModelOf(clip, st);
    if (!id) return app.toast(t('this frame has no KLV frame model (angles and FOV): mensuration is not available'), { kind: 'error' });
    try {
      const g = app.core.i2g(id, x, y, Number.isFinite(st.fcHae) ? st.fcHae : 0);
      view.measure ??= { points: [] };
      if (view.measure.points.length >= 2) view.measure = { points: [] };
      view.measure.points.push({ x, y, lat: g.lat, lon: g.lon });
      const ps = view.measure.points;
      if (ps.length === 2) {
        const inv = app.core.inverse(ps[0].lat, ps[0].lon, ps[1].lat, ps[1].lon);
        const d = inv.distance;
        view.measure.text = t('{d}  {az}° (from KLV frame model)', { d: length(d, 1), az: num(wrap360(inv.azi1), 1) });
        view.measure.result = { distanceM: d, label: N_('from KLV frame model') }; // English data (test hook); shown through tr()
      } else view.measure.text = app.core.format(g.lat, g.lon, 0, 6);
      view.drawHud();
    } finally {
      app.core.freeModel(id);
    }
  }

  // ---- burn-in clip export (REQ-FMV-13, COULD): WebM through MediaRecorder ----

  async function exportClip(clip = activeClip(), { from = 0, to = null, save = true } = {}) {
    const v = viewOf(clip);
    if (!v || v.metadataOnly) throw new Error('clip export needs a playing video');
    if (!globalThis.MediaRecorder) throw new Error('MediaRecorder is not available');
    to ??= clip.frames.length - 1;
    // MP4 (H.264) where the browser records it, which PowerPoint plays; WebM otherwise, and WebM
    // again when an MP4 recorder delivers nothing.
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].filter((t) => MediaRecorder.isTypeSupported(t));
    for (const mimeType of [...new Set([types[0], types.find((t) => /webm/.test(t))].filter(Boolean))]) {
      v.decodeError = null;
      v.stalledAt = null;
      const blob = await recordClip(v, clip, from, to, mimeType);
      // A stream damaged part-way stops playback: what was recorded is kept, and said so.
      if (v.decodeError !== null && blob.size > 0) app.toast(t('Clip export stopped at {s, number, ::.0} s, where the video is damaged', { s: v.decodeError }), { kind: 'warn', ms: 8000 });
      else if (v.stalledAt !== null && blob.size > 0) app.toast(t('Clip export stopped at {s, number, ::.0} s: playback did not advance (a damaged stream or timestamps out of order)', { s: v.stalledAt }), { kind: 'warn', ms: 8000 });
      if (v.stalledAt !== null && !blob.size) throw gwError('playback did not advance past {s, number, ::.0} s (a damaged stream or timestamps out of order), so no clip was recorded', { s: v.stalledAt });
      if (blob.size > 0) {
        if (save) await saveBlob(app, blob, { name: `${clip.name.replace(/\.\w+$/, '')}_burnin.${/mp4/.test(mimeType) ? 'mp4' : 'webm'}` });
        return blob;
      }
    }
    throw new Error('the browser recorded no video');
  }

  async function recordClip(v, clip, from, to, mimeType) {
    const W = clip.width || v.video.videoWidth;
    const H = clip.height || v.video.videoHeight;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(clip.fps), { mimeType });
    const parts = [];
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    const done = new Promise((res) => (rec.onstop = res));
    v.seekFrame(from);
    await new Promise((r) => setTimeout(r, 200));
    g.drawImage(v.surface, 0, 0, W, H);
    rec.start(250);
    const started = new Promise((res) => {
      v.video.addEventListener('playing', res, { once: true });
      setTimeout(res, 3000);
    });
    v.play();
    await started;
    // Playback that stops advancing (out-of-order PTS/DTS, a stream with no decodable frames) ends the
    // recording after 8 s instead of waiting for an end that never comes (CX-084: 20 min on 246 KB).
    // The clip's own length (its frames at its rate) also bounds it: a PTS jump past the 33-bit wrap
    // gave a media duration of 8.6 million seconds and frame numbers that never reach the last one.
    let last = -1;
    let moved = performance.now();
    const t0 = v.video.currentTime;
    const span = (to - from + 1) / (clip.fps || 30) + 1;
    await new Promise((res) => {
      const tick = () => {
        g.drawImage(v.surface, 0, 0, W, H);
        g.drawImage(v.hud, 0, 0, W, H);
        const t = v.video.currentTime;
        const left = v.video.duration - t;
        if (v.frame >= to || v.video.ended || !v.playing || (Number.isFinite(left) && left < 0.05) || t - t0 > span) return res();
        if (t !== last) (last = t), (moved = performance.now());
        else if (performance.now() - moved > 8000) {
          v.stalledAt = t;
          return res();
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
    v.pause();
    // A short clip can end before the recorder has a frame (a loaded machine: "the browser recorded
    // no video", FX-10 on Edge): the last frame is held until the recorder has delivered one.
    for (let i = 0; i < 10 && !parts.length; i++) {
      g.drawImage(v.surface, 0, 0, W, H);
      g.drawImage(v.hud, 0, 0, W, H);
      rec.requestData();
      await new Promise((r) => setTimeout(r, 150));
    }
    rec.stop();
    await done;
    return new Blob(parts, { type: mimeType.split(';')[0] });
  }

  // ---- file routing ----

  app.splitMotionFiles = (files) => {
    const video = [];
    const rest = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (/\.(ts|m2ts|mts|mpg|mpeg|vob|m1v|m2v|m2p|mpe)$/.test(n)) video.push(f);
      else rest.push(f);
    }
    return { video, rest };
  };
  app.openMotionFiles = async ({ video = [] }, pane) => {
    for (const f of video)
      await open(f, pane).catch((e) => {
        app.toast(t('{file}: {msg}', { file: f.name, msg: errText(e) }), { kind: 'error', ms: 8000 });
        app.importLog.push({ file: f.name, errors: [errText(e)], warnings: [] });
      });
  };

  async function closeVideo(p = app.activePane()) {
    const v = p?.video;
    if (!v) return;
    v.dispose();
    p.video = null;
    if (![...(app.desktop?.multiports ?? [])].some((mp) => mp.panes.some((q) => q.video?.clip === v.clip))) {
      URL.revokeObjectURL(v.clip.url);
      clips.delete(v.clip.id);
    }
    p.invalidate();
    app.emit('state');
  }

  // ---- time basis dialog ----

  async function timeBasisDialog(clip = activeClip()) {
    if (!clip) throw noVideo();
    const sel = h('select', { 'data-id': 'fmv-basis' }, h('option', { value: 'misp', selected: clip.basis.kind === 'misp' }, t('MISP Time per ST 0603 (default, D9)')), h('option', { value: 'utc', selected: clip.basis.kind === 'utc' }, t('Legacy UTC / POSIX (no conversion)')));
    const off = h('input', { type: 'number', min: '-2', max: '2', step: '0.033', value: String(clip.offset), 'data-id': 'fmv-offset' });
    const hint = clip.basisHint ? h('p', { class: 'warn' }, t('Heuristic: {hint}.', { hint: clip.basisHint })) : h('p', { class: 'hint' }, t('No heuristic suggests a legacy UTC encoder.'));
    const b = await modal({ title: t('Time Basis — {clip}', { clip: clip.name }), body: h('div', {}, field(t('Precision Time Stamp basis'), sel), field(t('Metadata time offset (s, ±2)'), off), hint, h('p', { class: 'hint' }, t('{basis}. MISP = UTC + (TAI − UTC) − 8.000082 s; TAI − UTC from Item 136 when present, else the leap-second table. Video ↔ KLV sync uses raw values and is unaffected.', { basis: basisLabel(clip) }))), buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'fmv-basis' });
    if (b !== 'apply') return;
    setBasis(clip, sel.value);
    setOffset(clip, Number(off.value) || 0);
  }

  // ---- commands ----

  const hasClip = () => !!activeClip();
  const hasVideoPane = () => !!app.activePane()?.video;
  const view = () => app.activePane()?.video ?? (active ? viewOf(active) : null);
  C.implement('fmv.open', { run: run(async () => app.openMotionFiles(app.splitMotionFiles(await pickFiles(app, { accept: ['.ts', '.m2ts', '.mpg', '.mpeg', '.vob', '.m1v', '.m2v'], description: t('Motion imagery'), multiple: true })), app.activePane())) });
  C.implement('fmv.close', { enabled: hasVideoPane, run: run(() => closeVideo()) });
  C.implement('fmv.play', { enabled: hasVideoPane, checked: () => !!view()?.playing, run: run(() => view()?.toggle()) });
  C.implement('fmv.stepback', { enabled: hasVideoPane, run: run(() => view()?.step(-1)) });
  C.implement('fmv.stepfwd', { enabled: hasVideoPane, run: run(() => view()?.step(1)) });
  C.implement('fmv.loop', { enabled: hasVideoPane, checked: () => !!view()?.loop.on, run: run(() => view()?.setLoop({ on: !view().loop.on })) });
  C.implement('fmv.klv', { enabled: hasClip, run: run(() => klvTable()) });
  C.implement('fmv.basis', { enabled: hasClip, run: run(() => timeBasisDialog()) });
  C.implement('fmv.hud', { enabled: hasVideoPane, checked: () => options.hud, run: run(() => ((options.hud = !options.hud), view()?.drawHud())) });
  // MPEG-2 frames come from the app's decoder (REQ-GAP-48); when it failed on the clip, neither
  // WebCodecs nor the video element decodes them (REQ-FMV-15): no capture.
  C.implement('fmv.capture', { enabled: () => hasClip() && (activeClip().codec !== 'mp2v' || nativeCodec(activeClip())), run: run(() => capture()) });
  C.implement('fmv.event', { enabled: hasClip, run: run(() => eventLog()) });
  C.implement('fmv.measure', { enabled: hasVideoPane, checked: () => api.measureMode, run: run(() => ((api.measureMode = !api.measureMode), view() && (view().measure = null), view()?.drawHud())) });
  C.implement('fmv.link', { checked: () => !!options.linkPanes, run: run(() => (options.linkPanes = !options.linkPanes)) });
  C.implement('fmv.csv', { enabled: hasClip, run: run(async () => { const [f] = await pickFiles(app, { accept: ['.csv'], description: t('Platform metadata CSV') }); if (f) app.toast(t('{n, plural, one {# metadata row applied} other {# metadata rows applied}}', { n: await importCsv(activeClip(), f) }), { kind: 'info' }); }) });
  C.implement('fmv.export', { enabled: () => hasVideoPane() && !viewOf(activeClip())?.metadataOnly, run: run(() => exportClip()) }); // metadata-only video (Lite, no MSE) cannot be recorded (GUI-022)

  const api = {
    clips,
    options,
    sync,
    open,
    openClip,
    rebuildStates,
    zoomMap,
    closeVideo,
    activeClip,
    frameAt,
    stateAt,
    setFrame,
    setBasis,
    setOffset,
    basisLabel,
    utcOf,
    hudLines,
    playable,
    convertAction,
    decodeFrame,
    frameBitmap,
    framePixels,
    klvTable,
    klvRows,
    klvCsv,
    capture,
    worldFile,
    addEvent,
    eventsAs,
    eventLog,
    importCsv,
    measureClick,
    measureMode: false,
    exportClip,
    timeBasisDialog,
    drawMap,
    viewOf,
    hudBlocks: HUD_BLOCKS,
    lastMap: null,
  };
  app.fmv = api;
}
