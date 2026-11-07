// MIE4NITF (Motion Imagery Extensions for NITF, NGA.STND.0044; the TREs of STDI-0002-1 Appendix AF)
// for REQ-GAP-47: the TREs read from their raw bytes (MTIMSA's DT_MULTIPLIER, DT_SIZE, NUMBER_FRAMES,
// NUMBER_DT and every DT are big-endian binary integers, which the generic TRE catalogue reads as
// text), exact frame times in integer nanoseconds, and the collection model: camera sets (CAMSDA) with
// each camera placed in the set's mosaic by its display level, attachment level and ILOC, layers
// (MIMCSA: frame rates, required decoder), time intervals (TMINTA) and the file's temporal-block map
// (MTIMFA). Pure functions: used by the decode worker, the main thread and the chip writer.
//
// Frame time (Appendix AF equation 1 as NFX implements it, github.com/mdegan2020/NFX mieFrameTime):
//   T(n) = BASE_TIMESTAMP + DT_MULTIPLIER × Σ_{i=1..n} DT_i  (frames n = 1..NUMBER_FRAMES),
// with one DT applying to every frame (NUMBER_DT = 1) or one per frame (NUMBER_DT = NUMBER_FRAMES);
// NUMBER_DT = 0 is a single frame at BASE_TIMESTAMP. A segment that declares several frames but no
// DT is not conformant: its frames are spread at the nominal frame rate and a warning says so.

export const MIE_FILE_TAGS = ['CAMSDA', 'MIMCSA', 'MTIMFA', 'TMINTA'];

const dec = new TextDecoder('latin1');
const txt = (b, o, n) => dec.decode(b.subarray(o, o + n));
const trim = (s) => s.replace(/\0/g, ' ').trim();

class Reader {
  constructor(bytes, tag) {
    this.b = bytes;
    this.o = 0;
    this.tag = tag;
  }
  need(n) {
    if (this.o + n > this.b.length) throw new Error(`${this.tag}: ${this.b.length} bytes, needs ${this.o + n}`);
  }
  text(n) {
    this.need(n);
    const s = txt(this.b, this.o, n);
    this.o += n;
    return s;
  }
  /** BCS-N integer; blank, '-' or 'NaN' fields → null. */
  int(n) {
    const s = this.text(n).trim();
    if (!/^[+-]?\d+$/.test(s)) return null;
    return Number(s);
  }
  real(n) {
    const s = this.text(n).trim();
    const v = Number(s);
    return s && Number.isFinite(v) ? v : null;
  }
  /** Big-endian unsigned binary integer of n (1–8) bytes as a BigInt. */
  u(n) {
    this.need(n);
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(this.b[this.o + i]);
    this.o += n;
    return v;
  }
  get left() {
    return this.b.length - this.o;
  }
}

const NS_DAY = 86_400_000_000_000n;

/**
 * A MIE4NITF timestamp `YYYYMMDDhhmmss.sssssssss` (24 bytes, UTC; trailing '-' marks unknown
 * precision) → {ns: BigInt nanoseconds since 1970, digits: known fraction digits, text}, or null.
 */
export function parseStamp(s) {
  const t = String(s ?? '').trim();
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(?:\.([0-9]*)-*)?$/.exec(t);
  if (!m) return null;
  const [Y, Mo, D, h, mi, se] = m.slice(1, 7).map(Number);
  if (Mo < 1 || Mo > 12 || D < 1 || D > 31 || h > 23 || mi > 59 || se > 60) return null;
  const day = Date.UTC(Y, Mo - 1, D);
  if (new Date(day).getUTCDate() !== D) return null;
  const frac = (m[7] ?? '').slice(0, 9);
  const ns = (BigInt(day) / 1000n) * 1_000_000_000n + BigInt(h * 3600 + mi * 60 + se) * 1_000_000_000n + BigInt(frac.padEnd(9, '0') || '0');
  return { ns, digits: frac.length, text: t };
}

/** Nanoseconds since 1970 → the 24-byte MIE4NITF timestamp. */
export function stampOf(ns) {
  const n = BigInt(ns);
  const day = n / NS_DAY;
  const rest = n - day * NS_DAY;
  const d = new Date(Number(day) * 86_400_000);
  const p = (v, k = 2) => String(v).padStart(k, '0');
  const sec = rest / 1_000_000_000n;
  const frac = rest - sec * 1_000_000_000n;
  const s = Number(sec);
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(Math.floor(s / 3600))}${p(Math.floor(s / 60) % 60)}${p(s % 60)}.${p(frac, 9)}`;
}

/** Nanoseconds → ISO 8601 with nine fraction digits (exact) and the millisecond Date value. */
export function isoNs(ns) {
  const n = BigInt(ns);
  const ms = Number(n / 1_000_000n);
  const frac = String(n % 1_000_000_000n).padStart(9, '0');
  return `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}.${frac}Z`;
}
export const msOf = (ns) => Number(BigInt(ns) / 1000n) / 1000;

// ---- TREs -------------------------------------------------------------------------------------

/** MTIMSA (image subheader, Table AF-8): one temporal block of one camera. */
export function parseMTIMSA(bytes) {
  const r = new Reader(bytes, 'MTIMSA');
  const m = {
    segment: r.int(3),
    geocoordsStatic: r.int(2),
    layer: trim(r.text(36)),
    set: r.int(3),
    camera: trim(r.text(36)),
    interval: r.int(6),
    block: r.int(3),
    rate: r.real(13),
    refFrame: r.int(9),
    baseText: r.text(24),
    mult: r.u(8),
    dtSize: Number(r.u(1)),
    frames: Number(r.u(4)),
    numberDt: Number(r.u(4)),
  };
  m.base = parseStamp(m.baseText);
  if (m.dtSize < 1 || m.dtSize > 8) {
    if (m.numberDt > 0) throw new Error(`MTIMSA: DT_SIZE ${m.dtSize} is not 1–8`);
  }
  if (m.numberDt * Math.max(1, m.dtSize) > r.left) throw new Error(`MTIMSA: ${m.numberDt} DT values of ${m.dtSize} bytes overrun the ${bytes.length}-byte TRE`);
  m.dts = new Array(m.numberDt);
  for (let i = 0; i < m.numberDt; i++) m.dts[i] = r.u(m.dtSize);
  return m;
}

/**
 * Frame times of an MTIMSA block → {ns: BigInt[] (one per frame), note (non-conformance) | null}.
 * `rate` (frames/s) is the fallback when several frames carry no DT.
 */
export function frameTimes(m, rate = null) {
  if (!m.base) return { ns: [], note: 'BASE_TIMESTAMP is not a valid timestamp' };
  const N = Math.max(1, m.frames || 1);
  const out = new Array(N);
  const mult = m.mult > 0n ? m.mult : 1n;
  let note = null;
  if (m.numberDt === 0) {
    const fps = m.rate || rate;
    if (N > 1) note = fps ? `${N} frames but no DT: spread at the nominal ${fps} frames/s` : `${N} frames but no DT and no frame rate: spread 1 s apart`;
    const step = BigInt(Math.round(1e9 / (fps || 1)));
    for (let k = 0; k < N; k++) out[k] = m.base.ns + BigInt(k) * step;
  } else if (m.numberDt === 1) {
    for (let k = 0; k < N; k++) out[k] = m.base.ns + BigInt(k + 1) * m.dts[0] * mult;
  } else {
    if (m.numberDt !== N) note = `NUMBER_DT ${m.numberDt} differs from NUMBER_FRAMES ${N}`;
    let acc = m.base.ns;
    for (let k = 0; k < N; k++) {
      acc += (m.dts[Math.min(k, m.numberDt - 1)] ?? 0n) * mult;
      out[k] = acc;
    }
  }
  if (m.mult === 0n) note = 'DT_MULTIPLIER is 0: treated as 1 ns';
  return { ns: out, note };
}

/** CAMSDA (file header, Table AF-3): camera sets, each camera's layer and its place in the set. */
export function parseCAMSDA(bytes) {
  const r = new Reader(bytes, 'CAMSDA');
  const total = r.int(3);
  const inTre = r.int(3) ?? 0;
  const first = r.int(3) ?? 1;
  const sets = [];
  for (let s = 0; s < inTre; s++) {
    const n = r.int(3) ?? 0;
    const cameras = [];
    for (let c = 0; c < n; c++) {
      const id = trim(r.text(36));
      const desc = trim(r.text(80));
      const layer = trim(r.text(36));
      const idlvl = r.int(3);
      const ialvl = r.int(3);
      const iloc = [r.int(5) ?? 0, r.int(5) ?? 0];
      const nrows = r.int(8);
      const ncols = r.int(8);
      cameras.push({ id, desc, layer, idlvl, ialvl, iloc, nrows, ncols });
    }
    sets.push({ index: first + s, cameras });
  }
  return { total, first, sets };
}

/** MIMCSA (file header, Table AF-6): one motion-imagery layer (frame rates, required decoder). */
export function parseMIMCSA(bytes) {
  const r = new Reader(bytes, 'MIMCSA');
  return { layer: trim(r.text(36)), rate: r.real(13), minRate: r.real(13), maxRate: r.real(13), rset: r.int(2), decoder: trim(r.text(2)), profile: trim(r.text(36)), level: trim(r.text(6)) };
}

/** MTIMFA (file header, Table AF-7): which image segment of this file holds each temporal block. */
export function parseMTIMFA(bytes) {
  const r = new Reader(bytes, 'MTIMFA');
  const out = { layer: trim(r.text(36)), set: r.int(3), interval: r.int(6), cameras: [] };
  const n = r.int(3) ?? 0;
  for (let c = 0; c < n; c++) {
    const id = trim(r.text(36));
    const nb = r.int(3) ?? 0;
    const blocks = [];
    for (let b = 0; b < nb; b++) blocks.push({ start: parseStamp(r.text(24)), end: parseStamp(r.text(24)), segment: r.int(3) });
    out.cameras.push({ id, blocks });
  }
  return out;
}

/** TMINTA (file header, Table AF-9): the collection's time intervals. */
export function parseTMINTA(bytes) {
  const r = new Reader(bytes, 'TMINTA');
  const n = r.int(4) ?? 0;
  const out = [];
  for (let i = 0; i < n; i++) out.push({ index: r.int(6), start: parseStamp(r.text(24)), end: parseStamp(r.text(24)) });
  return out;
}

// ---- encoders (fixtures, chips) ----------------------------------------------------------------

const A = (v, n) => String(v ?? '').slice(0, n).padEnd(n, ' ');
const Z = (v, n) => (v === null || v === undefined ? ' '.repeat(n) : String(Math.round(v)).padStart(n, '0').slice(-n));
const ue13 = (v) => (Number.isFinite(v) ? v.toExponential(7).replace(/e([+-])(\d)$/, 'E$10$2').replace(/e([+-])(\d\d)$/, 'E$1$2').padStart(13, ' ').slice(-13) : A('', 13));
const be = (v, n) => {
  let x = BigInt(v);
  let s = '';
  for (let i = 0; i < n; i++) {
    s = String.fromCharCode(Number(x & 255n)) + s;
    x >>= 8n;
  }
  return s;
};
const loc = (v) => (v < 0 ? '-' + String(-v).padStart(4, '0') : String(v).padStart(5, '0'));

/** MTIMSA body (byte string): {segment, layer, set, camera, interval, block, rate, refFrame, base (ns), mult, dts: [BigInt|number], frames}. */
export function encodeMTIMSA(m) {
  const dts = (m.dts ?? []).map(BigInt);
  const max = dts.reduce((a, b) => (b > a ? b : a), 0n);
  let size = m.dtSize ?? 1;
  while (size < 8 && max >> BigInt(8 * size) > 0n) size++;
  return Z(m.segment, 3) + Z(m.geocoordsStatic ?? 0, 2) + A(m.layer, 36) + Z(m.set ?? 1, 3) + A(m.camera, 36) + Z(m.interval ?? 1, 6) + Z(m.block ?? 1, 3) + ue13(m.rate) + Z(m.refFrame ?? null, 9) + stampOf(m.base) + be(m.mult ?? 1n, 8) + be(size, 1) + be(m.frames ?? 1, 4) + be(dts.length, 4) + dts.map((d) => be(d, size)).join('');
}

/** CAMSDA body: sets [{cameras: [{id, desc, layer, idlvl, ialvl, iloc [row, col], nrows, ncols}]}]. */
export function encodeCAMSDA(sets, { total = sets.length, first = 1 } = {}) {
  return Z(total, 3) + Z(sets.length, 3) + Z(first, 3) + sets.map((s) => Z(s.cameras.length, 3) + s.cameras.map((c) => A(c.id, 36) + A(c.desc, 80) + A(c.layer, 36) + Z(c.idlvl, 3) + Z(c.ialvl, 3) + loc(c.iloc[0]) + loc(c.iloc[1]) + Z(c.nrows, 8) + Z(c.ncols, 8)).join('')).join('');
}

/** MIMCSA body (121 bytes). */
export function encodeMIMCSA(l) {
  const s = A(l.layer, 36) + ue13(l.rate) + ue13(l.minRate ?? l.rate) + ue13(l.maxRate ?? l.rate) + Z(l.rset ?? 0, 2) + A(l.decoder ?? 'NC', 2) + A(l.profile ?? '', 36) + A(l.level ?? '', 6);
  if (s.length !== 121) throw new Error(`MIMCSA is ${s.length} bytes`);
  return s;
}

/** MTIMFA body: {layer, set, interval, cameras: [{id, blocks: [{start ns, end ns, segment|null}]}]}. */
export function encodeMTIMFA(f) {
  return A(f.layer, 36) + Z(f.set, 3) + Z(f.interval, 6) + Z(f.cameras.length, 3) + f.cameras.map((c) => A(c.id, 36) + Z(c.blocks.length, 3) + c.blocks.map((b) => stampOf(b.start) + stampOf(b.end) + Z(b.segment, 3)).join('')).join('');
}

/** TMINTA body: [{index, start ns, end ns}]. */
export function encodeTMINTA(list) {
  return Z(list.length, 4) + list.map((i) => Z(i.index, 6) + stampOf(i.start) + stampOf(i.end)).join('');
}

// ---- the collection ----------------------------------------------------------------------------

/**
 * Place cameras by display level (IDLVL), attachment level (IALVL, 0 = unattached) and ILOC
 * (row, col relative to the camera attached to) → [{x, y}] in the set's pixel frame, the mosaic
 * origin at the top-left camera; or {reason} when the levels do not resolve.
 */
export function placeCameras(cams) {
  const byLvl = new Map(cams.map((c) => [c.idlvl, c]));
  const pos = new Map();
  const place = (c, depth = 0) => {
    if (pos.has(c)) return pos.get(c);
    if (depth > cams.length) throw new Error('camera attachment loop');
    let p;
    if (!c.ialvl) p = [c.iloc[1], c.iloc[0]];
    else {
      const parent = byLvl.get(c.ialvl);
      if (!parent) throw new Error(`camera ${c.id || c.idlvl} attaches to missing display level ${c.ialvl}`);
      const [px, py] = place(parent, depth + 1);
      p = [px + c.iloc[1], py + c.iloc[0]];
    }
    pos.set(c, p);
    return p;
  };
  try {
    for (const c of cams) place(c);
  } catch (e) {
    return { reason: e.message };
  }
  const x0 = Math.min(...cams.map((c) => pos.get(c)[0]));
  const y0 = Math.min(...cams.map((c) => pos.get(c)[1]));
  return { at: cams.map((c) => ({ x: pos.get(c)[0] - x0, y: pos.get(c)[1] - y0 })) };
}

/**
 * The MIE4NITF collection of one file.
 *   fileTres: [{tag, bytes}] from the file header (UDHD and XHD);
 *   segments: [{index (0-based image segment), mtimsa: bytes, width, height, bands, sampleType, ic, imode, corners}].
 * → {sequences, layers, cameraSets, intervals, mappings, warnings}. A sequence is one camera set
 * and layer: {id, set, layer, cameras [{id, desc, x, y, width, height, idlvl}], width, height,
 * bands, sampleType, rate, decoder, frames [{ns, ms, parts [{camera, seg, k}]}], gaps}.
 */
export function mieCollection({ fileTres = [], segments = [] }) {
  const warnings = [];
  const warn = (s) => warnings.includes(s) || warnings.push(s);
  const safe = (tag, fn, bytes) => {
    try {
      return fn(bytes);
    } catch (e) {
      warn(`${tag}: ${e.message}`);
      return null;
    }
  };
  const layers = new Map();
  let cameraSets = [];
  const mappings = [];
  let intervals = [];
  for (const t of fileTres) {
    if (t.tag === 'MIMCSA') {
      const l = safe('MIMCSA', parseMIMCSA, t.bytes);
      if (l) layers.set(l.layer, l);
    } else if (t.tag === 'CAMSDA') {
      const c = safe('CAMSDA', parseCAMSDA, t.bytes);
      if (c) cameraSets = cameraSets.concat(c.sets);
    } else if (t.tag === 'MTIMFA') {
      const f = safe('MTIMFA', parseMTIMFA, t.bytes);
      if (f) mappings.push(f);
    } else if (t.tag === 'TMINTA') {
      const i = safe('TMINTA', parseTMINTA, t.bytes);
      if (i) intervals = intervals.concat(i);
    }
  }
  // Blocks: one per segment with MTIMSA.
  const blocks = [];
  for (const s of segments) {
    const m = safe(`MTIMSA (image segment ${s.index + 1})`, parseMTIMSA, s.mtimsa);
    if (!m) continue;
    if (m.segment !== null && m.segment !== s.index + 1) warn(`image segment ${s.index + 1}: MTIMSA IMAGE_SEG_INDEX is ${m.segment}`);
    const layer = layers.get(m.layer);
    const ft = frameTimes(m, layer?.rate ?? null);
    if (ft.note) warn(`image segment ${s.index + 1}: ${ft.note}`);
    if (!ft.ns.length) continue;
    blocks.push({ seg: s, m, ns: ft.ns });
  }
  // Camera sets: from CAMSDA, else one set per (set index, camera) found in the MTIMSA records.
  const camInfo = new Map(); // camera id → {set, desc, layer, idlvl, ialvl, iloc, nrows, ncols}
  for (const set of cameraSets) for (const c of set.cameras) camInfo.set(c.id, { ...c, set: set.index });
  const groups = new Map(); // key → {set, layer, cameras: Map id → blocks[]}
  for (const b of blocks) {
    const ci = camInfo.get(b.m.camera);
    if (cameraSets.length && !ci && b.m.camera) warn(`camera ${b.m.camera} of image segment ${b.seg.index + 1} is not in CAMSDA`);
    const set = ci?.set ?? b.m.set ?? 1;
    const layer = b.m.layer || ci?.layer || '';
    // Without CAMSDA nothing places cameras relative to each other: each camera is its own sequence.
    const key = cameraSets.length && ci ? `${set}|${layer}|${b.seg.bands}|${b.seg.sampleType}` : `${set}|${layer}|${b.m.camera}|${b.seg.bands}|${b.seg.sampleType}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { set, layer, cameras: new Map() }));
    const cid = b.m.camera || `segment-camera-${set}`;
    (g.cameras.get(cid) ?? g.cameras.set(cid, []).get(cid)).push(b);
  }
  if (!cameraSets.length && new Set(blocks.map((b) => b.m.camera)).size > 1) warn('no CAMSDA camera-set definition: each camera opens as its own sequence');
  const sequences = [];
  for (const g of groups.values()) {
    const ids = [...g.cameras.keys()];
    const cams = ids.map((id) => {
      const ci = camInfo.get(id);
      const first = g.cameras.get(id)[0].seg;
      return { id, desc: ci?.desc ?? '', idlvl: ci?.idlvl ?? 1, ialvl: ci?.ialvl ?? 0, iloc: ci?.iloc ?? [0, 0], width: ci?.ncols || first.width, height: ci?.nrows || first.height };
    });
    let at = cams.map(() => ({ x: 0, y: 0 }));
    if (cams.length > 1) {
      const p = placeCameras(cams);
      if (p.reason) warn(`camera set ${g.set}: ${p.reason}; cameras drawn at the origin`);
      else at = p.at;
    }
    cams.forEach((c, i) => Object.assign(c, at[i]));
    cams.sort((a, b) => a.idlvl - b.idlvl); // higher display levels draw on top
    const camIndex = new Map(cams.map((c, i) => [c.id, i]));
    for (const [id, list] of g.cameras) {
      const c = cams[camIndex.get(id)];
      for (const b of list) if (b.seg.width !== c.width || b.seg.height !== c.height) warn(`camera ${id}: image segment ${b.seg.index + 1} is ${b.seg.width} × ${b.seg.height}, not the camera's ${c.width} × ${c.height}`);
    }
    // Per camera: frames in time order.
    const per = ids.map((id) => {
      const fr = [];
      for (const b of g.cameras.get(id)) b.ns.forEach((ns, k) => fr.push({ ns, seg: b.seg.index, k, ref: b.m.refFrame === null ? null : b.m.refFrame + k }));
      fr.sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : a.seg - b.seg || a.k - b.k));
      return { cam: camIndex.get(id), fr };
    });
    const layer = layers.get(g.layer) ?? null;
    const anyBlock = g.cameras.values().next().value[0];
    const rate = anyBlock.m.rate || layer?.rate || null;
    let frames;
    if (per.length === 1) frames = per[0].fr.map((f) => ({ ns: f.ns, parts: [{ camera: per[0].cam, seg: f.seg, k: f.k }] }));
    else if (per.every((p) => p.fr.every((f) => f.ref !== null))) {
      // Absolute frame numbers (REFERENCE_FRAME_NUM): the cameras' frames n form mosaic frame n.
      const byRef = new Map();
      for (const p of per) for (const f of p.fr) (byRef.get(f.ref) ?? byRef.set(f.ref, []).get(f.ref)).push({ camera: p.cam, seg: f.seg, k: f.k, ns: f.ns });
      frames = [...byRef.entries()].sort((a, b) => a[0] - b[0]).map(([, parts]) => ({ ns: parts.reduce((a, p) => (p.ns < a ? p.ns : a), parts[0].ns), parts: parts.map(({ camera, seg, k }) => ({ camera, seg, k })).sort((a, b) => a.camera - b.camera) }));
    } else {
      // By time: the camera with the most frames sets the timeline; each other camera shows its latest
      // frame at or before each instant (within half a frame period).
      const master = per.reduce((a, b) => (b.fr.length > a.fr.length ? b : a));
      const period = rate ? BigInt(Math.round(1e9 / rate)) : master.fr.length > 1 ? (master.fr.at(-1).ns - master.fr[0].ns) / BigInt(master.fr.length - 1) : 0n;
      const tol = period / 2n;
      frames = master.fr.map((f) => {
        const parts = [];
        for (const p of per) {
          if (p === master) {
            parts.push({ camera: p.cam, seg: f.seg, k: f.k });
            continue;
          }
          let best = null;
          for (const q of p.fr) {
            if (q.ns <= f.ns + tol) best = q;
            else break;
          }
          if (best) parts.push({ camera: p.cam, seg: best.seg, k: best.k });
        }
        return { ns: f.ns, parts: parts.sort((a, b) => a.camera - b.camera) };
      });
    }
    // MTIMFA: blocks of this set and layer held in other files of the collection (no segment here).
    const gaps = [];
    for (const f of mappings.filter((x) => x.set === g.set && (!x.layer || !g.layer || x.layer === g.layer))) {
      for (const c of f.cameras) {
        if (!g.cameras.has(c.id) && camIndex.size) warn(`MTIMFA lists camera ${c.id}, which has no image segment in camera set ${g.set}`);
        for (const b of c.blocks) {
          if (b.segment === null) {
            if (b.start) gaps.push({ camera: c.id, interval: f.interval, start: b.start.ns, end: b.end?.ns ?? null });
            continue;
          }
          const s = blocks.find((x) => x.seg.index + 1 === b.segment);
          if (!s) warn(`MTIMFA maps a temporal block of camera ${c.id} to image segment ${b.segment}, which has no MTIMSA`);
          else if (s.m.camera !== c.id) warn(`MTIMFA maps camera ${c.id} to image segment ${b.segment}, whose MTIMSA names camera ${s.m.camera}`);
          else if (b.start && s.ns[0] < b.start.ns) warn(`image segment ${b.segment} starts before its MTIMFA temporal block`);
        }
      }
    }
    const decoder = layer?.decoder || '';
    const ics = new Set([...g.cameras.values()].flat().map((b) => b.seg.ic));
    if (decoder && ![...ics].every((ic) => ic === decoder || (decoder === 'NC' && ic === 'NM') || (decoder === 'C8' && ic === 'M8'))) warn(`layer ${g.layer}: MIMCSA requires decoder ${decoder}, the image segments use ${[...ics].join(', ')}`);
    const width = Math.max(...cams.map((c) => c.x + c.width));
    const height = Math.max(...cams.map((c) => c.y + c.height));
    const area = cams.reduce((a, c) => a + c.width * c.height, 0);
    sequences.push({
      id: `${g.set}|${g.layer}|${sequences.length}`,
      set: g.set,
      layer: g.layer,
      layerInfo: layer,
      cameras: cams,
      width,
      height,
      gappy: cams.length > 1 && area < width * height,
      bands: anyBlock.seg.bands,
      sampleType: anyBlock.seg.sampleType,
      rate,
      decoder,
      frames,
      gaps,
    });
  }
  sequences.sort((a, b) => a.set - b.set || String(a.layer).localeCompare(String(b.layer)));
  return { sequences, layers: [...layers.values()], cameraSets, intervals, mappings, warnings, blocks: blocks.length };
}

/** Index of the frame shown at time `ns` (the latest at or before it; the first before the start). */
export function frameAt(frames, ns) {
  const t = BigInt(ns);
  let lo = 0;
  let hi = frames.length - 1;
  if (!frames.length || t <= BigInt(frames[0].ns)) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (BigInt(frames[mid].ns) <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
