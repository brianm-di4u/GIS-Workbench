// RSM TREs (REQ-SNS-03, experimental; STDI-0002 Vol. 1 App. U): RSMIDA (identification and
// ground domain) and RSMPCA (one polynomial section) read from their fixed-width ASCII fields
// into the core's RSM polynomial record, and written back (for tests and conversions). Also an
// exact RSM form of an RPC00B (the RPC's cubic terms placed in RSM's x-fastest tensor order).

const num = (s) => {
  const t = s.trim();
  return t === '' ? NaN : Number(t);
};

/** RSMIDA → {domain, origin, axes, rows, cols, iid}. */
export function parseRsmida(t) {
  let o = 0;
  const take = (n) => {
    const v = t.slice(o, o + n);
    o += n;
    return v;
  };
  const iid = take(80).trim();
  take(40 + 40 + 40 + 40); // EDITION, ISID, SID, STID
  take(4 + 2 + 2 + 2 + 2 + 9); // date and time
  const nrg = num(take(8));
  const ncg = num(take(8));
  take(21 + 21); // TRG, TCG
  const grndd = take(1);
  const v = [];
  for (let i = 0; i < 12; i++) v.push(num(take(21)));
  const domain = grndd === 'R' ? 2 : grndd === 'H' ? 1 : 0;
  // Rectangular: origin XUOR… then rows of unit vectors (XUXR XUYR XUZR), (YU…), (ZU…).
  return { iid, rows: nrg, cols: ncg, domain, origin: domain === 2 ? v.slice(0, 3) : [0, 0, 0], axes: domain === 2 ? v.slice(3, 12) : [0, 0, 0, 0, 0, 0, 0, 0, 0] };
}

/** RSMPCA → {rsn, csn, off, scale, polys}. */
export function parseRsmpca(t) {
  let o = 0;
  const take = (n) => {
    const v = t.slice(o, o + n);
    o += n;
    return v;
  };
  take(80 + 40); // IID, EDITION
  const rsn = num(take(3));
  const csn = num(take(3));
  take(21 + 21); // RFEP, CFEP
  const off = [0, 0, 0, 0, 0].map(() => num(take(21)));
  const scale = [0, 0, 0, 0, 0].map(() => num(take(21)));
  const polys = [];
  for (let p = 0; p < 4; p++) {
    const px = num(take(1));
    const py = num(take(1));
    const pz = num(take(1));
    const n = num(take(3));
    const c = [];
    for (let i = 0; i < n; i++) c.push(num(take(21)));
    if (n !== (px + 1) * (py + 1) * (pz + 1)) throw new Error(`RSMPCA polynomial ${p + 1}: ${n} terms for powers ${px}${py}${pz}`);
    polys.push({ px, py, pz, c });
  }
  if (o > t.length) throw new Error('RSMPCA is shorter than its fields');
  return { rsn, csn, off, scale, polys };
}

/** The core record for one section from RSMIDA and RSMPCA text. */
export function rsmRecord(ida, pca) {
  const a = parseRsmida(ida);
  const p = parseRsmpca(pca);
  return { domain: a.domain, origin: a.origin, axes: a.axes, off: p.off, scale: p.scale, rows: a.rows, cols: a.cols, polys: p.polys, iid: a.iid };
}

const f21 = (v) => {
  const s = Number(v).toExponential(14).replace(/e([+-])(\d)$/, 'e$10$2');
  return (s.length > 21 ? Number(v).toExponential(12) : s).padStart(21, ' ').slice(0, 21);
};
const pad = (s, n) => String(s ?? '').padEnd(n, ' ').slice(0, n);

/** Write RSMIDA and RSMPCA text for a record (one section; geodetic unless domain = 2). */
export function rsmTres(r, { iid = 'GIS WORKBENCH', date = '20260101000000' } = {}) {
  const ida = [
    pad(iid, 80),
    pad('', 40),
    pad('', 40),
    pad('', 40),
    pad('', 40),
    date.slice(0, 4),
    date.slice(4, 6),
    date.slice(6, 8),
    date.slice(8, 10),
    date.slice(10, 12),
    pad(date.slice(12, 14), 9),
    String(r.rows).padStart(8, '0'),
    String(r.cols).padStart(8, '0'),
    pad('', 21),
    pad('', 21),
    r.domain === 2 ? 'R' : r.domain === 1 ? 'H' : 'G',
    ...(r.domain === 2 ? [...r.origin, ...r.axes].map(f21) : Array(12).fill(pad('', 21))),
    ...Array(24).fill(pad('', 21)),
    ...Array(3).fill(pad('', 21)),
    ...Array(6).fill(pad('', 8)),
    ...Array(12).fill(pad('', 21)),
    ...Array(9).fill(pad('', 21)),
  ].join('');
  const polys = r.polys.map((q) => `${q.px}${q.py}${q.pz}${String(q.c.length).padStart(3, '0')}${q.c.map(f21).join('')}`).join('');
  const pca = `${pad(iid, 80)}${pad('', 40)}001001${pad('', 21)}${pad('', 21)}${r.off.map(f21).join('')}${r.scale.map(f21).join('')}${polys}`;
  return { RSMIDA: ida, RSMPCA: pca };
}

// RPC00B term order (L = longitude, P = latitude, H = height): powers (L, P, H).
const RPC_TERMS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [2, 0, 0], [0, 2, 0], [0, 0, 2],
  [1, 1, 1], [3, 0, 0], [1, 2, 0], [1, 0, 2], [2, 1, 0], [0, 3, 0], [0, 1, 2], [2, 0, 1], [0, 2, 1], [0, 0, 3],
];

/** An RPC00B record (the core's 92 values: ERR_BIAS, ERR_RAND, offsets, scales, 4 × 20) as an exact RSM section. */
export function rsmFromRpc(rec, rows, cols) {
  const [lineOff, sampOff, latOff, lonOff, hOff, lineScale, sampScale, latScale, lonScale, hScale] = rec.slice(2, 12);
  const poly = (k) => {
    const c = new Array(64).fill(0);
    RPC_TERMS.forEach(([i, j, kz], t) => (c[kz * 16 + j * 4 + i] = rec[12 + 20 * k + t]));
    return { px: 3, py: 3, pz: 3, c };
  };
  const d2r = Math.PI / 180;
  return { domain: 0, origin: [0, 0, 0], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0], off: [lineOff, sampOff, lonOff * d2r, latOff * d2r, hOff], scale: [lineScale, sampScale, lonScale * d2r, latScale * d2r, hScale], rows, cols, polys: [poly(0), poly(1), poly(2), poly(3)] };
}
