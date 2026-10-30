// Motion imagery (SCN-15; REQ-FMV-01..14, REQ-SNS-20; `Research/12`): MPEG-TS clips indexed by
// the Rust demuxer in the decode worker, ST 0601 KLV decoded to per-frame platform/sensor state,
// footprints by the priority of §12.2 (full corners → offset corners → computed from the KLV
// frame model and the DEM or the frame-centre height → sensor/centre/LOS only), a visible
// per-clip time basis (MISP Time by default, D9), ST 0102 banners with conflict flags, ST 0903
// VMTI, a KLV table with raw values, frame capture (PNG + world file + JSON; NITF 2.1 with
// IGEOLO and a fitted RPC00B), an event log plotted on the map, and STANAG 4607 GMTI dwells and
// targets on the shared time slider.

import { minOf, maxOf, errorText } from '../core/util.js';
import { VideoView, HUD_BLOCKS } from '../shell/videoview.js';
import { modal, field } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { saveBlob, pickFiles } from '../storage/files.js';
import { bannerText, highest, bannerColorVar, rank, LEVELS, NOT_ACCREDITED } from '../security/marking.js';
import { writeNitf } from '../formats/nitf-writer.js';
import { screenOfGround, halo, poly } from '../tools/tools.js';

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

const CLASS_LEVEL = { 1: 'U', 2: 'R', 3: 'C', 4: 'S', 5: 'T' };
const ANGLE_FIELDS = new Set(['heading', 'az', 'sroll']);
const NUM_FIELDS = ['lat', 'lon', 'hae', 'heading', 'pitch', 'roll', 'az', 'el', 'sroll', 'hfov', 'vfov', 'slant', 'fcLat', 'fcLon', 'fcHae', 'targetWidth', 'speed'];
const STALE_S = 1;

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').replace('Z', '') : '–');
const unwrap = (a, b) => (b - a > 180 ? b - 360 : b - a < -180 ? b + 360 : b);
const wrap360 = (a) => ((a % 360) + 360) % 360;

/** The ST 0102 Security Local Set → a marking object (display aid only). */
export function securityMarking(set) {
  if (!set?.length) return null;
  const g = (t) => set.find((x) => x.t === t)?.v;
  const lvl = CLASS_LEVEL[g(1)] ?? null;
  return { level: lvl, raw: String(g(1) ?? ''), codewords: String(g(4) ?? ''), control: String(g(5) ?? ''), release: String(g(6) ?? ''), country: String(g(3) ?? ''), objectCountries: String(g(13) ?? ''), version: g(22) ?? null, source: 'ST 0102' };
}

/** ST 0903 VMTI Local Set → {width, height, frame, targets [{id, box, centroid, loc, confidence}]}. */
export function vmtiOf(set, fw = 0, fh = 0) {
  if (!set?.length) return null;
  const g = (t) => set.find((x) => x.t === t);
  const W = g(8)?.v ?? fw;
  const H = g(9)?.v ?? fh;
  const px = (n) => (Number.isFinite(n) && W ? { col: (n - 1) % W, row: Math.floor((n - 1) / W) } : null);
  const targets = (g(101)?.targets ?? []).map((t) => {
    const it = (k) => t.items.find((x) => x.t === k)?.v;
    const c = px(it(1));
    const tl = px(it(2));
    const br = px(it(3));
    return { id: t.id, centroid: c, box: tl && br ? [tl.col, tl.row, br.col + 1, br.row + 1] : null, loc: t.loc ?? null, confidence: it(5) };
  });
  return { width: W, height: H, frame: g(7)?.v ?? null, system: g(3)?.v ?? '', reported: g(6)?.v ?? targets.length, targets };
}

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
  const sec = m.get(48)?.set;
  if (sec) f.security = securityMarking(sec);
  const vm = m.get(74)?.set;
  if (vm) f.vmtiSet = vm;
  return f;
}

export async function install(app) {
  const C = app.commands;
  const S = app.store;
  const clips = new Map();
  const gmti = [];
  let nextClip = 1;
  const options = { hud: true, vmti: true, trailS: 5, footprintTrail: 0, gmtiWindowS: 2, gmtiColour: 'age', gmtiMinSpeed: 0, gmtiMinSnr: -128, gmtiClasses: null, useDem: true };
  const sync = { clip: null, frame: -1, mapFrame: -1, sliderFrame: -1, source: '', at: 0, mediaTime: null, history: [] };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
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
    const clip = { id: `clip${nextClip++}`, name, file, url: URL.createObjectURL(file), index: idx, aus, frames, fps, pts0, width: v.width ?? 0, height: v.height ?? 0, codec: v.codec, videoPid: v.pid, packets, offset: 0, basis: { kind: 'misp', source: 'default (D9)' }, fpCache: new Map(), models: new Map(), events: [], warnings: [] };
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
    const firstTimed = clip.packets.find((k) => k.ok && k.tMux !== null && packetFields(k.p).time !== undefined);
    const anchor = firstTimed ? { t: firstTimed.tMux, time: packetFields(firstTimed.p).time } : null;
    // ST 0604 SEI time stamps, when the frames carry them, map Precision Time to frames exactly.
    const seiFrames = clip.frames.filter((f) => f.sei !== null);
    for (const k of clip.packets) {
      const f = packetFields(k.p, u);
      k.fields = f;
      if (!k.ok) continue;
      const { vmtiSet, ...rest } = f;
      acc = { ...acc, ...rest };
      let t = k.sync ? k.tMux : null;
      if (t === null && f.time !== undefined) {
        if (seiFrames.length >= 2) t = seiTime(seiFrames, f.time);
        else if (anchor) t = anchor.t + (f.time - anchor.time) / 1e6;
      }
      if (t === null) t = k.tMux;
      if (t === null) continue;
      states.push({ t, packet: k, vmtiSet: vmtiSet ?? null, ...acc });
    }
    states.sort((a, b) => a.t - b.t);
    clip.states = states;
    clip.fpCache.clear();
    clip.leap = states.find((s) => s.leap !== undefined)?.leap ?? null;
    clip.security = highest(states.map((s) => s.security).filter(Boolean), null);
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
    const t = clip.states[0]?.time;
    if (t === undefined) return;
    clip.basisHint = null;
    if (t % 60e6 === 0) clip.basisHint = 'the first time stamp falls on a whole minute when read as UTC/POSIX: the encoder may write legacy UTC';
    for (const g of gmti) {
      const [a, b] = [utcOf(clip, t, 'misp'), utcOf(clip, t, 'utc')];
      const overlap = (u) => g.data.dwells.some((d) => d.utcMs >= u && d.utcMs <= u + clip.duration * 1000);
      if (!overlap(a) && overlap(b)) clip.basisHint = `GMTI ${g.name} overlaps the clip only under the legacy UTC reading`;
    }
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

  function basisLabel(clip) {
    if (metaSource(clip) === 'CSV') return 'Metadata time: CSV (taken as UTC)';
    if (clip.basis.kind === 'utc') return 'KLV time: legacy UTC (no conversion)';
    const t = clip.states[0]?.time ?? 0;
    const off = (utcOf(clip, t) - t / 1000) / 1000;
    return `KLV time: MISP→UTC ${off.toFixed(1)} s${clip.leap !== null ? ' (Item 136)' : ''}`;
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
    st.vmti = a.vmtiSet && Math.abs(t - a.t) < 1.5 / clip.fps ? vmtiOf(a.vmtiSet, clip.width, clip.height) : null;
    st.utcMs = st.time !== undefined ? utcOf(clip, st.time, clip.basis.kind, st.corr) : NaN;
    st.utcText = iso(st.utcMs);
    const fp = footprint(clip, i, st);
    st.footprint = fp.corners;
    st.footprintSource = fp.source;
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
    let out = { corners: null, source: 'none', centre: Number.isFinite(st.fcLat) ? [st.fcLat, st.fcLon] : null, check: null };
    if (st.corners) out = { ...out, corners: st.corners.map((x) => x.slice()), source: 'corners (Items 82–89)' };
    else if (st.offsets && Number.isFinite(st.fcLat)) out = { ...out, corners: st.offsets.map(([a, b]) => [st.fcLat + a, st.fcLon + b]), source: 'offset corners (Items 26–33)' };
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
        if (!out.corners && comp.every((p) => Number.isFinite(p[0]))) out = { ...out, corners: comp, source: dem?.coreId ? `computed (${metaSource(clip)} frame model + DEM)` : `computed (${metaSource(clip)} frame model at ${h0.toFixed(1)} m HAE)` };
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
    const f1 = (v, u = '') => (Number.isFinite(v) ? `${v.toFixed(1)}${u}` : '–');
    switch (block) {
      case 'time':
        return [`${st.utcText} UTC`, basisLabel(clip), `Frame ${st.frame + 1}${st.stale ? '  METADATA STALE' : ''}`];
      case 'sensor':
        return [`SNS ${ll(st.lat, st.lon)}`, `ALT ${f1(st.hae, ' m HAE')}${st.haeFromMsl ? ' (MSL, no geoid)' : ''}`, `HDG ${f1(st.heading, '°')}  ${st.designation ?? ''}`];
      case 'centre': {
        const c = st.centre;
        let mgrs = '';
        try {
          if (c) mgrs = app.core.mgrs(c[0], c[1], 5);
        } catch {}
        return [`CTR ${c ? ll(c[0], c[1]) : '–'}`, mgrs ? `MGRS ${mgrs}` : '', `FOOTPRINT ${st.footprintSource}`].filter(Boolean);
      }
      case 'geometry': {
        const gsd = Number.isFinite(st.slant) && Number.isFinite(st.hfov) && clip.width ? (2 * st.slant * Math.tan(((st.hfov / 2) * Math.PI) / 180)) / clip.width : NaN;
        return [`SLR ${f1(st.slant, ' m')}`, `AZ ${f1(st.az, '°')} EL ${f1(st.el, '°')}`, `HFOV ${f1(st.hfov, '°')}  GSD≈${Number.isFinite(gsd) ? gsd.toFixed(2) : '–'} m (estimated)`];
      }
      default:
        return [];
    }
  }

  async function playable(clip) {
    if (!clip.videoPid || !clip.frames.length) return 'the stream has no video';
    if (clip.codec === 'mp2v') return 'MPEG-2 (H.262) video is not played in browsers (REQ-FMV-15)';
    const codec = clip.codec.length > 4 ? clip.codec : clip.codec === 'avc1' ? 'avc1.42E01E' : 'hvc1.1.6.L93.B0';
    const mse = globalThis.MediaSource?.isTypeSupported?.(`video/mp4; codecs="${codec}"`);
    let wc = false;
    try {
      wc = !!(await globalThis.VideoDecoder?.isConfigSupported?.({ codec, codedWidth: clip.width || 640, codedHeight: clip.height || 360 }))?.supported;
    } catch {}
    clip.support = { codec, mse: !!mse, webcodecs: wc };
    if (!mse) return `the codec ${codec} is not supported by Media Source Extensions here`;
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
      throw new Error(`frame ${i + 1} was not decoded from its GOP`);
    }
    return best;
  }

  async function frameBitmap(clip, i) {
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
      if (!view || view.metadataOnly) throw new Error(`no decoded frame: ${e.message}`);
      how = 'video element';
      src = view.video;
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
    if (file.size > 2 ** 31) throw new Error(`${file.name}: BDAV (.m2ts) streams over 2 GB are not repacked; remux it to .ts (ffmpeg -i in.m2ts -c copy -map 0 out.ts)`);
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
    if (magic[0] === 0 && magic[1] === 0 && magic[2] === 1 && magic[3] === 0xba) throw new Error('an MPEG program stream (DVD/.mpeg), not MPEG-TS: it carries no KLV; remux it to TS (ffmpeg -i in.mpeg -c copy out.ts) to view it');
    file = await plainTs(file);
    const idx = await decodeJob('tsindex', { file });
    // TE-016: with no PAT/PMT nothing identifies the streams; the player then waited forever.
    if (!idx.streams?.length && !idx.video?.count && !idx.klv?.length) {
      throw new Error(`no programme tables (PAT/PMT) and no recognisable video or KLV in ${idx.packets ?? 0} transport packets: the stream is damaged or not MPEG-TS`);
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
    app.importLog.push({ file: file.name, errors: [], warnings: [...(bad ? [`${bad} KLV packet(s) failed the checksum and were not used`] : []), ...(clip.basisHint ? [`time basis: ${clip.basisHint}`] : []), ...idx.errors] });
    app.toast(`Opened ${file.name}: ${clip.frames.length} frames, ${clip.packets.length} KLV packets (${bad} bad) in ${ms} ms${p.video.metadataOnly ? ' — metadata only' : ''}`);
    updateStatus(clip);
    zoomMap(clip);
    app.emit('state');
    return clip;
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
    if (st) {
      const m = st.security;
      const others = highest((view?.pane.layers() ?? []).map((l) => l.info.marking).concat(app.project()?.marking ? [app.project().marking] : []), null);
      const shown = highest([m, others].filter(Boolean));
      const conflict = m && others && rank(m.level) !== rank(others.level) ? `KLV ST 0102 ${m.level ?? '?'} vs other markings ${others.level}` : null;
      view?.updateBanners(m || others ? bannerText(shown) : '', bannerColorVar(shown), conflict);
      clip.banner = { text: m || others ? bannerText(shown) : '', conflict, klv: m };
    }
    // GMTI and the map follow the same time.
    gmtiNow = Number.isFinite(st?.utcMs) ? st.utcMs : gmtiNow;
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

  // ---- map and panel overlays (REQ-FMV-07, REQ-FMV-10, REQ-FMV-11) ----

  const COL = { path: [0, 0.85, 1, 1], los: [1, 0.85, 0, 1], foot: [1, 0.2, 0.2, 1], footFill: [1, 0.2, 0.2, 0.18], centre: [1, 1, 0, 1], platform: [0, 1, 1, 1], event: [1, 0.3, 1, 1], vmti: [0, 1, 0.4, 1], dwell: [0.6, 0.6, 1, 0.35] };

  function marker(lat, lon, s, kind = 'square') {
    if (kind === 'cross') return [lon - s, lat, lon + s, lat, lon, lat - s, lon, lat + s];
    return [lon - s, lat - s, lon + s, lat - s, lon + s, lat + s, lon - s, lat - s, lon + s, lat + s, lon - s, lat + s];
  }

  function gmtiColour(t, age) {
    if (options.gmtiColour === 'velocity') return t.v === undefined ? [0.8, 0.8, 0.8, 1] : t.v < 0 ? [0.25, 0.55, 1, 1] : [1, 0.35, 0.25, 1];
    const a = Math.max(0, Math.min(1, age / Math.max(0.001, options.gmtiWindowS)));
    return [1, 1 - 0.8 * a, 0.1, 1 - 0.7 * a];
  }

  let gmtiNow = NaN;

  /** GMTI targets visible at `now` (UTC ms): dwells in (now − window, now], filtered (AT-15.5). */
  function gmtiVisible(now = gmtiNow) {
    const out = [];
    if (!Number.isFinite(now)) return out;
    for (const g of gmti) {
      if (g.visible === false) continue;
      for (const d of g.data.dwells) {
        const age = (now - d.utcMs) / 1000;
        if (age < 0 || age >= options.gmtiWindowS) continue;
        for (const t of d.targets) {
          if (Math.abs(t.v ?? 0) < options.gmtiMinSpeed) continue;
          if ((t.snr ?? 0) < options.gmtiMinSnr) continue;
          if (options.gmtiClasses && !options.gmtiClasses.includes(t.class)) continue;
          out.push({ ...t, dwell: d.dwell, utcMs: d.utcMs, age, source: g.name });
        }
      }
    }
    return out;
  }

  function dwellSector(d, steps = 24) {
    // Annular sector seen from the sensor: centre ± range half-extent, ± angle half-extent.
    const [sl, so] = d.sensor;
    const [cl, co] = d.centre;
    const inv = app.core.inverse(sl, so, cl, co);
    const r0 = inv.distance - d.rangeHalfKm * 1000;
    const r1 = inv.distance + d.rangeHalfKm * 1000;
    const az = inv.azi1;
    const pts = [];
    for (let k = 0; k <= steps; k++) {
      const a = az - d.angleHalfDeg + (2 * d.angleHalfDeg * k) / steps;
      const p = app.core.direct(sl, so, a, r1);
      pts.push([p.lat, p.lon]);
    }
    for (let k = steps; k >= 0; k--) {
      const a = az - d.angleHalfDeg + (2 * d.angleHalfDeg * k) / steps;
      const p = app.core.direct(sl, so, a, Math.max(0, r0));
      pts.push([p.lat, p.lon]);
    }
    return pts;
  }

  /** Draw on the workspace map (plate carrée, lon/lat). */
  function drawMap(r, m, vp, map) {
    const gl = r.gl;
    const s = 5 / Math.max(1e-6, map.view.zoom);
    const flat = (arr, mode, col) => arr.length && r.drawFlat(new Float32Array(arr), mode, col, m, vp.w, vp.h);
    const rec = { frame: null, clip: null, footprint: null, targets: [], vmti: [], events: 0 };
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
      for (const t of st.vmti?.targets ?? []) {
        if (t.loc) {
          flat(marker(t.loc[0], t.loc[1], s * 0.8), gl.TRIANGLES, COL.vmti);
          rec.vmti.push({ id: t.id, lat: t.loc[0], lon: t.loc[1] });
        }
      }
      if (clip === activeClip()) Object.assign(rec, { frame: i, clip: clip.id, footprint: st.footprint, source: st.footprintSource });
    }
    const evs = S.all('fmvevent');
    const ev = evs.filter((e) => Number.isFinite(e.lat)).flatMap((e) => marker(e.lat, e.lon, s));
    flat(ev, gl.TRIANGLES, COL.event);
    rec.events = evs.length;
    // GMTI platform tracks from Platform Location segments (all times).
    for (const g of gmti) {
      if (g.visible === false || !g.data.platform?.length) continue;
      const trk = g.data.platform.flatMap((p) => [p.lon, p.lat]);
      if (trk.length >= 4) flat(trk, gl.LINE_STRIP, COL.path);
      const last = g.data.platform[g.data.platform.length - 1];
      flat(marker(last.lat, last.lon, s, 'cross'), gl.LINES, COL.platform);
    }
    // GMTI: dwell areas (faint) and targets coloured by age or radial velocity; trails by window.
    if (Number.isFinite(gmtiNow)) {
      const shown = new Set();
      for (const g of gmti) {
        if (g.visible === false) continue;
        for (const d of g.data.dwells) {
          const age = (gmtiNow - d.utcMs) / 1000;
          if (age < 0 || age >= options.gmtiWindowS || shown.has(d)) continue;
          shown.add(d);
          if (age < 0.6) flat(dwellSector(d).flatMap(([la, lo]) => [lo, la]), gl.LINE_LOOP, COL.dwell);
        }
      }
      const vis = gmtiVisible();
      const buckets = new Map();
      for (const t of vis) {
        const c = gmtiColour(t, t.age);
        const k = c.map((x) => x.toFixed(2)).join(',');
        if (!buckets.has(k)) buckets.set(k, { c, v: [] });
        buckets.get(k).v.push(...marker(t.lat, t.lon, s * 0.7));
      }
      for (const b of buckets.values()) flat(b.v, gl.TRIANGLES, b.c);
      rec.targets = vis;
    }
    rec.now = gmtiNow;
    sync.mapFrame = rec.frame ?? -1;
    sync.history.push({ video: sync.frame, map: sync.mapFrame, slider: sync.sliderFrame, t: performance.now() });
    if (sync.history.length > 600) sync.history.splice(0, 300);
    api.lastMap = rec;
  }

  /** Draw on georeferenced image panels: footprint, LOS, sensor and GMTI targets. */
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
    for (const t of gmtiVisible()) {
      const q = scr(t.lat, t.lon, t.h ?? 0);
      if (!q) continue;
      const c = gmtiColour(t, t.age);
      g.fillStyle = `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3]})`;
      g.fillRect(q.x - 3, q.y - 3, 6, 6);
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
      if (it.targets) for (const t of it.targets) {
        out.push({ t: '', n: `VTarget ${t.id}`, v: t.loc ? `${t.loc[0].toFixed(6)}, ${t.loc[1].toFixed(6)}, ${t.loc[2].toFixed(1)} m` : '', h: '', depth: depth + 1 });
        flatItems(t.items, depth + 2, out);
      }
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
    if (!clip) throw new Error('open a video first');
    const head = h('div', { class: 'klv-head', 'data-id': 'klv-head' });
    const body = h('tbody');
    const table = h('table', { class: 'tbl klv-table', 'data-id': 'klv-table' }, h('thead', {}, h('tr', {}, ...['Tag', 'Name', 'Value', 'Units', 'Raw (hex)'].map((t) => h('th', {}, t)))), body);
    const render = (i) => {
      const { k, idx, rows } = klvRows(clip, i);
      const st = stateAt(clip, i);
      head.textContent = k ? `Packet ${idx + 1} of ${clip.packets.length} · checksum ${k.ok ? 'OK' : 'FAILED (not used)'} · UAS LS version ${k.fields?.version ?? '–'} · ${basisLabel(clip)} · footprint: ${st?.footprintSource}${st?.check?.flagged ? ` · ⚠ computed centre ${st.check.centreDiffM.toFixed(0)} m from Items 23/24` : ''}` : 'No KLV for this frame';
      body.replaceChildren(
        ...rows.map((x) =>
          h(
            'tr',
            { class: `${x.changed ? 'changed' : ''} ${x.unknown ? 'unknown' : ''}`.trim(), 'data-tag': String(x.t) },
            h('td', {}, String(x.t)),
            h('td', { style: `padding-left:${6 + x.depth * 14}px` }, `${x.n}${x.unknown ? ' (unknown item, kept)' : ''}`),
            h('td', {}, x.v === null || x.v === undefined ? (x.s ?? '') : typeof x.v === 'number' ? String(Math.round(x.v * 1e9) / 1e9) : String(x.v)),
            h('td', {}, x.u ?? ''),
            h('td', { class: 'mono' }, x.h ?? ''),
          ),
        ),
      );
    };
    klvDialog = { clip, render };
    render(clip.current ?? 0);
    const b = await modal({ title: `KLV — ${clip.name}`, body: h('div', {}, head, h('div', { class: 'klv-scroll' }, table), h('p', { class: 'hint' }, 'Changed items since the previous packet are highlighted. Unknown items are listed with their raw bytes (AC-15.1).')), buttons: ['Export CSV', 'Close'], width: 820, id: 'fmv-klv', modeless: true });
    klvDialog = null;
    if (b === 'Export CSV') await exportKlvCsv(clip);
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
   * footprint, ST 0102 security fields and an RPC00B fitted to the frame's model (the KLV frame
   * model when the footprint is computed, else a projective model through the footprint corners).
   */
  async function capture(clip = activeClip(), i = clip?.current ?? 0, { nitf = true, save = true } = {}) {
    if (!clip) throw new Error('open a video first');
    const st = stateAt(clip, i);
    if (!st?.footprint) throw new Error('this frame has no footprint: it cannot be georeferenced');
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
      timeBasis: basisLabel(clip),
      footprint: { type: 'Polygon', coordinates: [[...st.footprint, st.footprint[0]].map(([la, lo]) => [lo, la])] },
      footprintSource: st.footprintSource,
      worldFileNote: 'The world file is an affine fit to the four corners; for oblique frames the GeoJSON footprint is the authoritative georeference.',
      klv: klvSnapshot(clip, st),
      marking: clip.banner?.text ?? '',
      notAccredited: NOT_ACCREDITED,
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
      const computed = /^computed/.test(st.footprintSource);
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
      const marking = st.security ?? clip.security ?? null;
      const d = new Date(st.utcMs);
      const idatim = d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const bytes = writeNitf({ width: W, height: H, bands: 3, type: 'u8', planes }, { marking: marking ? { level: marking.level, codewords: marking.codewords, control: marking.control, release: marking.release } : undefined, title: `FMV frame ${i + 1} of ${clip.name}`.slice(0, 80), iid1: 'FMVFRAME', iid2: `${clip.name} frame ${i + 1}`.slice(0, 80), idatim, isorce: (st.designation ?? st.sensorName ?? 'FMV').slice(0, 42), icat: 'VIS', irep: 'RGB', corners, rpc: rpc ?? undefined });
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
    app.toast(`Captured frame ${i + 1}${out.nitf ? ` (NITF${out.rpcFit?.rmsPx !== undefined ? `, RPC fit ${out.rpcFit.rmsPx.toFixed(3)} px RMS` : ''})` : ''}`);
    return out;
  }

  // ---- event log (REQ-FMV-10) ----

  async function addEvent(clip = activeClip(), { text = '', tag = 'note', at = null, thumb = true } = {}) {
    if (!clip) throw new Error('open a video first');
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
    S.transact('Log event', (tx) => {
      id = tx.create('fmvevent', { clip: clip.name, frame: i + 1, pts: clip.frames[i].pts, timeRaw: st?.time ?? null, utc: Number.isFinite(st?.utcMs) ? new Date(st.utcMs).toISOString() : null, basis: basisLabel(clip), lat: pos?.[0] ?? null, lon: pos?.[1] ?? null, text, tag, thumbnail, created: new Date().toISOString() });
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
          h('tr', {}, h('td', {}, e.thumbnail ? h('img', { src: e.thumbnail, width: 64, alt: '' }) : ''), h('td', {}, e.utc ?? ''), h('td', {}, `${e.clip} #${e.frame}`), h('td', {}, e.tag), h('td', {}, e.text), h('td', {}, Number.isFinite(e.lat) ? app.core.format(e.lat, e.lon, 0, 6) : '')),
        ),
      );
    fill();
    const text = h('input', { type: 'text', placeholder: 'Event text', 'data-id': 'fmv-event-text' });
    const tag = h('select', {}, ...['note', 'vehicle', 'person', 'activity', 'target', 'other'].map((t) => h('option', { value: t }, t)));
    const b = await modal({ title: 'FMV Event Log', body: h('div', {}, field('Text', text), field('Tag', tag), h('table', { class: 'tbl', 'data-id': 'fmv-events' }, h('thead', {}, h('tr', {}, ...['', 'UTC', 'Frame', 'Tag', 'Text', 'Position'].map((t) => h('th', {}, t)))), list)), buttons: ['Log at this frame', 'Export CSV', 'Export GeoJSON', 'Export KML', 'Close'], width: 760, id: 'fmv-events' });
    if (b === 'Log at this frame') await addEvent(activeClip(), { text: text.value, tag: tag.value });
    else if (b?.startsWith('Export')) {
      const fmt = b.endsWith('CSV') ? 'csv' : b.endsWith('KML') ? 'kml' : 'geojson';
      await saveBlob(app, new Blob([eventsAs(fmt)], { type: 'text/plain' }), { name: `fmv_events.${fmt === 'geojson' ? 'geojson' : fmt}` });
    }
  }

  // ---- STANAG 4607 (REQ-FMV-11) ----

  /** STANAG 4607 segment names (Table 2) for messages about what a file holds. */
  const SEG_NAMES = { 1: 'mission', 2: 'dwell', 3: 'HRR', 5: 'job definition', 6: 'free text', 7: 'low reflectivity index', 8: 'group', 9: 'attached target', 10: 'test and status', 11: 'system-specific', 12: 'processing history', 13: 'platform location', 101: 'job request', 102: 'job acknowledge' };

  async function openGmti(file) {
    const data = await decodeJob('s4607', { file });
    data.platform ??= [];
    // Neither targets nor a platform track: say what the file holds instead of a silent no-op (TE-047).
    if (!data.dwells.length && !data.platform.length) {
      const segs = Object.entries(data.segments ?? {}).map(([t, n]) => `${n} ${SEG_NAMES[t] ?? `type ${t}`}`).join(', ');
      const text = data.texts?.[0]?.text?.replace(/\s+/g, ' ').trim();
      throw new Error(`no dwell or platform location segments to show (${data.packets} packet${data.packets === 1 ? '' : 's'}: ${segs || 'none'})${text ? `; free text: “${text.slice(0, 80)}”` : ''}`);
    }
    data.dwells.sort((a, b) => (a.utcMs ?? a.timeMs) - (b.utcMs ?? b.timeMs));
    for (const d of data.dwells) if (d.utcMs === null) d.utcMs = d.timeMs; // no mission segment: ms of day only
    for (const p of data.platform) p.utcMs ??= p.timeMs;
    const g = { id: `gmti${gmti.length + 1}`, name: file.name, data, visible: true };
    gmti.push(g);
    for (const c of clips.values()) basisHeuristic(c);
    if (!Number.isFinite(gmtiNow)) gmtiNow = (data.dwells[0] ?? data.platform[0]).utcMs;
    const nT = data.dwells.reduce((s, d) => s + d.targets.length, 0);
    app.importLog.push({ file: file.name, errors: data.errors, warnings: data.dwells.length ? [] : ['no dwell segments: platform track only'] });
    app.toast(`Opened ${file.name}: ${data.packets} packets, ${data.dwells.length} dwells, ${nT} target reports${data.platform.length ? `, ${data.platform.length} platform locations` : ''}${data.header ? ` (${data.header.classificationText})` : ''}`);
    app.renderer.invalidate();
    app.emit('state');
    return g;
  }

  /** Without video, GMTI plays on its own time: set the shared time directly (UTC ms). */
  function setTime(utcMs) {
    gmtiNow = utcMs;
    app.renderer.invalidate();
  }

  // ---- external metadata (REQ-FMV-14) and STANAG 4676 tracks (REQ-FMV-13) ----

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

  /** STANAG 4676 Edition B XML tracks: a tolerant element map (the schema is not public). */
  async function openTracks4676(file) {
    const doc = new DOMParser().parseFromString(await file.text(), 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error(`${file.name}: not well-formed XML`);
    const local = (el) => el.localName.toLowerCase();
    const tracks = [];
    for (const tr of [...doc.getElementsByTagName('*')].filter((e) => local(e) === 'track')) {
      const num = [...tr.getElementsByTagName('*')].find((e) => /tracknumber|trackid/.test(local(e)))?.textContent?.trim() ?? String(tracks.length + 1);
      const pts = [];
      const all = [...tr.getElementsByTagName('*')];
      const tp = all.filter((e) => local(e) === 'trackpoint');
      for (const p of tp.length ? tp : all.filter((e) => local(e) === 'item')) {
        const get = (re) => [...p.getElementsByTagName('*')].find((e) => re.test(local(e)))?.textContent?.trim();
        const lat = Number(get(/^(latitude|lat)$/));
        const lon = Number(get(/^(longitude|lon)$/));
        const time = Date.parse(get(/^(time|pointtime|timestamp)$/) ?? '');
        if (Number.isFinite(lat) && Number.isFinite(lon)) pts.push({ lat, lon, utcMs: time });
      }
      if (pts.length) tracks.push({ id: num, points: pts });
    }
    if (!tracks.length) throw new Error(`${file.name}: no track points found`);
    // Shown as a GMTI-like source: each point is a "target" at its time.
    const dwells = [];
    for (const t of tracks) for (const p of t.points) dwells.push({ dwell: dwells.length, utcMs: p.utcMs, sensor: [p.lat, p.lon, 0], centre: [p.lat, p.lon], rangeHalfKm: 0, angleHalfDeg: 0, targets: [{ lat: p.lat, lon: p.lon, track: t.id }] });
    dwells.sort((a, b) => a.utcMs - b.utcMs);
    const g = { id: `tracks${gmti.length + 1}`, name: file.name, data: { dwells, packets: 0, errors: [] }, visible: true, kind: '4676' };
    gmti.push(g);
    app.renderer.invalidate();
    return { tracks: tracks.length, points: dwells.length };
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
    if (!id) return app.toast('this frame has no KLV frame model (angles and FOV): mensuration is not available', { kind: 'error' });
    try {
      const g = app.core.i2g(id, x, y, Number.isFinite(st.fcHae) ? st.fcHae : 0);
      view.measure ??= { points: [] };
      if (view.measure.points.length >= 2) view.measure = { points: [] };
      view.measure.points.push({ x, y, lat: g.lat, lon: g.lon });
      const ps = view.measure.points;
      if (ps.length === 2) {
        const inv = app.core.inverse(ps[0].lat, ps[0].lon, ps[1].lat, ps[1].lon);
        const d = inv.distance;
        view.measure.text = `${d.toFixed(1)} m  ${wrap360(inv.azi1).toFixed(1)}° (from KLV frame model)`;
        view.measure.result = { distanceM: d, label: 'from KLV frame model' };
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
      const blob = await recordClip(v, clip, from, to, mimeType);
      // A stream damaged part-way stops playback: what was recorded is kept, and said so.
      if (v.decodeError !== null && blob.size > 0) app.toast(`Clip export stopped at ${v.decodeError.toFixed(1)} s, where the video is damaged`, { kind: 'warn', ms: 8000 });
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
    g.drawImage(v.video, 0, 0, W, H);
    rec.start(250);
    const started = new Promise((res) => {
      v.video.addEventListener('playing', res, { once: true });
      setTimeout(res, 3000);
    });
    v.play();
    await started;
    await new Promise((res) => {
      const tick = () => {
        g.drawImage(v.video, 0, 0, W, H);
        g.drawImage(v.hud, 0, 0, W, H);
        const left = v.video.duration - v.video.currentTime;
        if (v.frame >= to || v.video.ended || !v.playing || (Number.isFinite(left) && left < 0.05)) return res();
        requestAnimationFrame(tick);
      };
      tick();
    });
    v.pause();
    // A short clip can end before the recorder has a frame (a loaded machine: "the browser recorded
    // no video", FX-10 on Edge): the last frame is held until the recorder has delivered one.
    for (let i = 0; i < 10 && !parts.length; i++) {
      g.drawImage(v.video, 0, 0, W, H);
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
    const gm = [];
    const tracks = [];
    const rest = [];
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (/\.(ts|m2ts|mts|mpg|mpeg)$/.test(n)) video.push(f);
      else if (/\.(4607|gmti)$/.test(n)) gm.push(f);
      else if (/\.4676(\.xml)?$/.test(n)) tracks.push(f);
      else rest.push(f);
    }
    return { video, gmti: gm, tracks, rest };
  };
  app.openMotionFiles = async ({ video = [], gmti: gm = [], tracks = [] }, pane) => {
    for (const f of gm)
      await openGmti(f).catch((e) => {
        app.toast(`${f.name}: ${errorText(e)}`, { kind: 'error', ms: 8000 });
        app.importLog.push({ file: f.name, errors: [errorText(e)], warnings: [] });
      });
    for (const f of tracks) await openTracks4676(f).catch((e) => app.toast(`${f.name}: ${errorText(e)}`, { kind: 'error', ms: 8000 }));
    for (const f of video)
      await open(f, pane).catch((e) => {
        app.toast(`${f.name}: ${errorText(e)}`, { kind: 'error', ms: 8000 });
        app.importLog.push({ file: f.name, errors: [errorText(e)], warnings: [] });
      });
  };

  async function closeVideo(p = app.activePane()) {
    const v = p?.video;
    if (!v) return;
    v.dispose();
    p.video = null;
    for (const b of [p.bannerTop, p.bannerBottom]) b.hidden = true;
    if (![...(app.desktop?.multiports ?? [])].some((mp) => mp.panes.some((q) => q.video?.clip === v.clip))) {
      URL.revokeObjectURL(v.clip.url);
      clips.delete(v.clip.id);
    }
    p.invalidate();
    app.emit('state');
  }

  // ---- time basis dialog ----

  async function timeBasisDialog(clip = activeClip()) {
    if (!clip) throw new Error('open a video first');
    const sel = h('select', { 'data-id': 'fmv-basis' }, h('option', { value: 'misp', selected: clip.basis.kind === 'misp' }, 'MISP Time per ST 0603 (default, D9)'), h('option', { value: 'utc', selected: clip.basis.kind === 'utc' }, 'Legacy UTC / POSIX (no conversion)'));
    const off = h('input', { type: 'number', min: '-2', max: '2', step: '0.033', value: String(clip.offset), 'data-id': 'fmv-offset' });
    const hint = clip.basisHint ? h('p', { class: 'warn' }, `Heuristic: ${clip.basisHint}.`) : h('p', { class: 'hint' }, 'No heuristic suggests a legacy UTC encoder.');
    const b = await modal({ title: `Time Basis — ${clip.name}`, body: h('div', {}, field('Precision Time Stamp basis', sel), field('Metadata time offset (s, ±2)', off), hint, h('p', { class: 'hint' }, `${basisLabel(clip)}. MISP = UTC + (TAI − UTC) − 8.000082 s; TAI − UTC from Item 136 when present, else the leap-second table. Video ↔ KLV sync uses raw values and is unaffected.`)), buttons: ['Apply', 'Cancel'], id: 'fmv-basis' });
    if (b !== 'Apply') return;
    setBasis(clip, sel.value);
    setOffset(clip, Number(off.value) || 0);
  }

  // ---- commands ----

  const hasClip = () => !!activeClip();
  const hasVideoPane = () => !!app.activePane()?.video;
  const view = () => app.activePane()?.video ?? (active ? viewOf(active) : null);
  C.implement('fmv.open', { run: run(async () => app.openMotionFiles(app.splitMotionFiles(await pickFiles(app, { accept: ['.ts', '.m2ts', '.mpg', '.4607', '.gmti', '.xml'], description: 'Motion imagery and GMTI', multiple: true })), app.activePane())) });
  C.implement('fmv.close', { enabled: hasVideoPane, run: run(() => closeVideo()) });
  C.implement('fmv.play', { enabled: hasVideoPane, checked: () => !!view()?.playing, run: run(() => view()?.toggle()) });
  C.implement('fmv.stepback', { enabled: hasVideoPane, run: run(() => view()?.step(-1)) });
  C.implement('fmv.stepfwd', { enabled: hasVideoPane, run: run(() => view()?.step(1)) });
  C.implement('fmv.loop', { enabled: hasVideoPane, checked: () => !!view()?.loop.on, run: run(() => view()?.setLoop({ on: !view().loop.on })) });
  C.implement('fmv.klv', { enabled: hasClip, run: run(() => klvTable()) });
  C.implement('fmv.basis', { enabled: hasClip, run: run(() => timeBasisDialog()) });
  C.implement('fmv.hud', { enabled: hasVideoPane, checked: () => options.hud, run: run(() => ((options.hud = !options.hud), view()?.drawHud())) });
  C.implement('fmv.vmti', { enabled: hasVideoPane, checked: () => options.vmti, run: run(() => ((options.vmti = !options.vmti), view()?.drawHud(), app.renderer.invalidate())) });
  // MPEG-2 frames are decoded neither by WebCodecs nor by the video element (REQ-FMV-15): no capture.
  C.implement('fmv.capture', { enabled: () => hasClip() && activeClip().codec !== 'mp2v', run: run(() => capture()) });
  C.implement('fmv.event', { enabled: hasClip, run: run(() => eventLog()) });
  C.implement('fmv.gmti', { run: run(async () => { for (const f of await pickFiles(app, { accept: ['.4607', '.gmti'], description: 'STANAG 4607', multiple: true })) await openGmti(f); }) });
  C.implement('fmv.gmticolour', { enabled: () => gmti.length > 0, checked: () => options.gmtiColour === 'velocity', run: run(() => ((options.gmtiColour = options.gmtiColour === 'velocity' ? 'age' : 'velocity'), app.renderer.invalidate())) });
  C.implement('fmv.measure', { enabled: hasVideoPane, checked: () => api.measureMode, run: run(() => ((api.measureMode = !api.measureMode), view() && (view().measure = null), view()?.drawHud())) });
  C.implement('fmv.link', { checked: () => !!options.linkPanes, run: run(() => (options.linkPanes = !options.linkPanes)) });
  C.implement('fmv.csv', { enabled: hasClip, run: run(async () => { const [f] = await pickFiles(app, { accept: ['.csv'], description: 'Platform metadata CSV' }); if (f) app.toast(`${await importCsv(activeClip(), f)} metadata rows applied`); }) });
  C.implement('fmv.export', { enabled: () => hasVideoPane() && !viewOf(activeClip())?.metadataOnly, run: run(() => exportClip()) }); // metadata-only video (Lite, no MSE) cannot be recorded (GUI-022)

  const api = {
    clips,
    gmti,
    options,
    sync,
    open,
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
    openGmti,
    gmtiVisible,
    setTime,
    importCsv,
    openTracks4676,
    measureClick,
    measureMode: false,
    exportClip,
    timeBasisDialog,
    drawMap,
    viewOf,
    hudBlocks: HUD_BLOCKS,
    levels: LEVELS,
    lastMap: null,
  };
  app.fmv = api;
}
