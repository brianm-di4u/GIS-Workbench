// NITF 2.1 chip writer (REQ-FMT-06, REQ-PRD-10): one uncompressed image segment (IC=NC,
// IMODE B, big-endian samples) with file and image security fields from the product marking,
// IGEOLO corners, the parent's RPC00B kept as it is plus ICHIPB mapping the chip onto the
// parent's full image, so the chip geolocates with the parent model (MIL-STD-2500C, STDI-0002).

const enc = new TextEncoder();
/** Headers and subheaders are byte strings: ASCII fields plus binary TRE fields (BANDSB floats). */
const bytes = (s) => {
  const o = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) o[i] = s.charCodeAt(i) & 255;
  return o;
};

/** Left-justified, space-padded ASCII field of exactly n bytes. */
export const A = (v, n) => String(v ?? '').replace(/[^\x20-\x7e]/g, ' ').slice(0, n).padEnd(n, ' ');
/** Right-justified, zero-filled integer field. */
export const N = (v, n) => {
  const s = String(Math.max(0, Math.round(v)));
  if (s.length > n) throw new Error(`${v} does not fit a ${n}-digit NITF field`);
  return s.padStart(n, '0');
};
const signed = (v, n, d) => {
  const s = Math.abs(v).toFixed(d).padStart(n - 1, '0');
  if (s.length > n - 1) throw new Error(`${v} does not fit a ${n}-character NITF field`);
  return (v < 0 ? '-' : '+') + s;
};
/** ±x.xxxxxxE±x (12 characters), the RPC00B coefficient form. */
const sci = (v) => {
  const [m, e] = (Number.isFinite(v) ? v : 0).toExponential(6).split('e');
  const mm = (m.startsWith('-') ? '' : '+') + m;
  const ee = Number(e);
  if (ee < -9) return '+0.000000E+0';
  if (ee > 9) throw new Error(`RPC coefficient ${v} is too large for RPC00B`);
  return `${mm}E${ee < 0 ? '-' : '+'}${Math.abs(ee)}`;
};

/** The 167-byte security group for a marking {level, codewords, control, release, system}. */
export function securityGroup(m = {}) {
  return [A(m.level ?? 'U', 1), A(m.system ?? '', 2), A(m.codewords ?? '', 11), A(m.control ?? '', 2), A(m.release ?? '', 20), A('', 2), A('', 8), A('', 4), A('', 1), A('', 8), A(m.text ?? '', 43), A('', 1), A('', 40), A('', 1), A('', 8), A('', 15)].join('');
}

/** RPC00B TRE body (1041 bytes) from a 92-value record (offsets/scales then 80 coefficients). */
export function rpc00b(r) {
  const head = [
    '1',
    (Number.isFinite(r[0]) && r[0] >= 0 ? r[0] : 0).toFixed(2).padStart(7, '0'),
    (Number.isFinite(r[1]) && r[1] >= 0 ? r[1] : 0).toFixed(2).padStart(7, '0'),
    N(r[2], 6),
    N(r[3], 5),
    signed(r[4], 8, 4),
    signed(r[5], 9, 4),
    signed(Math.round(r[6]), 5, 0),
    N(r[7], 6),
    N(r[8], 5),
    signed(r[9], 8, 4),
    signed(r[10], 9, 4),
    signed(Math.round(r[11]), 5, 0),
  ].join('');
  const body = head + r.slice(12, 92).map(sci).join('');
  if (body.length !== 1041) throw new Error(`RPC00B is ${body.length} bytes, not 1041`);
  return body;
}

/**
 * ICHIPB body (224 bytes). The four output corners are the chip's corner pixel centres
 * (corner-origin: (0.5, 0.5) … (h − 0.5, w − 0.5)); `toFull(row, col)` maps a chip coordinate
 * to the full image the RPC refers to (default: a window at (x0, y0) sampled every `step`).
 */
export function ichipb({ x0 = 0, y0 = 0, w, h, step = 1, fullW, fullH, toFull }) {
  const f = (v) => v.toFixed(3).padStart(12, '0');
  const op = [
    [0.5, 0.5],
    [0.5, w - 0.5],
    [h - 0.5, 0.5],
    [h - 0.5, w - 0.5],
  ];
  const map = toFull ?? ((r, c) => [y0 + (r - 0.5) * step + 0.5, x0 + (c - 0.5) * step + 0.5]);
  const fi = op.map(([r, c]) => map(r, c));
  const s = ['00', step.toFixed(5).padStart(10, '0'), '00', '00', ...op.flatMap(([r, c]) => [f(r), f(c)]), ...fi.flatMap(([r, c]) => [f(r), f(c)]), N(fullH, 8), N(fullW, 8)].join('');
  if (s.length !== 224) throw new Error(`ICHIPB is ${s.length} bytes, not 224`);
  return s;
}

/** ddmmssXdddmmssY for one corner (IGEOLO, ICORDS = G). */
export function dms(lat, lon) {
  const p = (v, deg) => {
    let t = Math.round(Math.abs(v) * 3600);
    const d = Math.floor(t / 3600);
    t -= d * 3600;
    return String(d).padStart(deg, '0') + String(Math.floor(t / 60)).padStart(2, '0') + String(t % 60).padStart(2, '0');
  };
  return `${p(lat, 2)}${lat < 0 ? 'S' : 'N'}${p(lon, 3)}${lon < 0 ? 'W' : 'E'}`;
}

/** USE00A body (107 bytes): mean GSD (inches), obliquity, sun elevation and azimuth (degrees). */
export function use00a({ angleToNorth = 0, gsdM = 0.5, obliquity = 0, roll = 0, sunEl, sunAz }) {
  const f = (v, n, d) => v.toFixed(d).padStart(n, '0').slice(-n);
  const s = [N(angleToNorth, 3), f(gsdM / 0.0254, 5, 1), ' ', '00000', '   ', ' ', '   ', f(obliquity, 5, 2), (roll < 0 ? '-' : '+') + f(Math.abs(roll), 5, 2), A('', 12), A('', 15), A('', 4), ' ', '   ', ' ', ' ', '00', '00000', '001', '000000', A('', 6), A('', 6), f(sunEl, 5, 1), f(sunAz, 5, 1)].join('');
  if (s.length !== 107) throw new Error(`USE00A is ${s.length} bytes, not 107`);
  return s;
}

const tre = (tag, body) => A(tag, 6) + N(body.length, 5) + body;

const nitfTime = (d) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

/**
 * Encode a NITF 2.1 file. img = {width, height, bands, type: 'u8'|'u16'|'i16'|'f32', planes
 * [TypedArray per band]}. opts: marking, title, iid1, iid2, idatim, isorce, icat, irep
 * ('MONO'|'RGB'|'MULTI'), abpp, corners [[lat, lon] UL, UR, LR, LL] (pixel centres), rpc (92),
 * chip {x0, y0, w, h, step, fullW, fullH}, ostaid, oname.
 */
/** One image segment: {sub (subheader text), data (Uint8Array), W, H}. */
function imageSegment(img, opts) {
  const { width: W, height: H, bands: nb, type } = img;
  // Over 9 bands: NBANDS 0 and XBANDS (MIL-STD-2500C), so hyperspectral chips write as NITF (TE 2.0.4 cross).
  if (nb < 1 || nb > 999) throw new Error('the NITF writer takes 1–999 bands');
  const nbpp = { u8: 8, u16: 16, i16: 16, f32: 32 }[type];
  if (!nbpp) throw new Error(`no NITF pixel type for ${type}`);
  const pvtype = { u8: 'INT', u16: 'INT', i16: 'SI', f32: 'R' }[type];
  // A JPEG 2000 / HTJ2K codestream (opts.codestream) is one block of the whole image (IC=C8).
  const block = (n) => (opts.codestream ? n : opts.block ? Math.min(n, opts.block) : n <= 8192 ? n : 1024);
  const bw = block(W);
  const bh = block(H);
  const nbpr = Math.ceil(W / bw);
  const nbpc = Math.ceil(H / bh);
  const irep = opts.irep ?? (nb === 1 ? 'MONO' : nb === 3 ? 'RGB' : 'MULTI');
  const bandRep = (b) => opts.irepband?.[b] ?? (irep === 'MONO' ? 'M' : irep === 'RGB' ? 'RGB'[b] ?? '' : '');
  const imode = opts.imode ?? 'B';
  const tres = [];
  if (opts.rpc?.length >= 92) tres.push(tre('RPC00B', rpc00b(opts.rpc)));
  if (opts.chip) tres.push(tre('ICHIPB', ichipb(opts.chip)));
  for (const [tag, body] of opts.tres ?? []) tres.push(tre(tag, body));
  const tx = tres.join('');
  const ixs = tx ? N(tx.length + 3, 5) + '000' + tx : '00000';
  const geo = opts.corners?.length === 4 ? 'G' + opts.corners.map(([la, lo]) => dms(la, lo)).join('') : ' ';
  // ILOC: row and column (5 characters each, signed allowed) relative to the attached segment.
  const loc = (v) => (v < 0 ? '-' + String(-v).padStart(4, '0') : String(v).padStart(5, '0'));
  const [lr, lc] = opts.iloc ?? [0, 0];
  const sub = [
    'IM',
    A(opts.iid1 ?? 'CHIP', 10),
    A(opts.idatim ?? nitfTime(new Date()), 14),
    A('', 17),
    A(opts.iid2 ?? '', 80),
    securityGroup(opts.marking),
    '0',
    A(opts.isorce ?? '', 42),
    N(H, 8),
    N(W, 8),
    A(pvtype, 3),
    A(irep, 8),
    A(opts.icat ?? 'VIS', 8),
    N(Math.min(opts.abpp ?? nbpp, nbpp), 2),
    'R',
    geo,
    '0',
    opts.codestream ? 'C8' + A(opts.comrat ?? 'N001', 4) : 'NC',
    nb <= 9 ? String(nb) : '0' + N(nb, 5),
    ...Array.from({ length: nb }, (_, b) => A(bandRep(b), 2) + A(opts.isubcat?.[b] ?? '', 6) + 'N' + A('', 3) + '0'),
    '0',
    imode,
    N(nbpr, 4),
    N(nbpc, 4),
    N(bw, 4),
    N(bh, 4),
    N(nbpp, 2),
    N(opts.idlvl ?? 1, 3),
    N(opts.ialvl ?? 0, 3),
    loc(lr) + loc(lc),
    '1.0 ',
    '00000',
    ixs,
  ].join('');
  if (opts.codestream) return { sub, data: opts.codestream, W, H };
  const bps = nbpp / 8;
  const data = new Uint8Array(nbpr * nbpc * nb * bw * bh * bps);
  const dv = new DataView(data.buffer);
  let p = 0;
  const put = (v) => {
    if (bps === 1) data[p] = v;
    else if (type === 'u16') dv.setUint16(p, v, false);
    else if (type === 'i16') dv.setInt16(p, v, false);
    else dv.setFloat32(p, v, false);
    p += bps;
  };
  if (imode === 'S') {
    // Band sequential: every block of band 1, then every block of band 2, …
    for (let b = 0; b < nb; b++)
      for (let by = 0; by < nbpc; by++)
        for (let bx = 0; bx < nbpr; bx++)
          for (let y = 0; y < bh; y++)
            for (let x = 0; x < bw; x++) {
              const sy = by * bh + y;
              const sx = bx * bw + x;
              if (sy >= H || sx >= W) p += bps;
              else put(img.planes[b][sy * W + sx]);
            }
    return { sub, data, W, H };
  }
  for (let by = 0; by < nbpc; by++)
    for (let bx = 0; bx < nbpr; bx++) {
      if (imode === 'R') {
        // Row interleaved: each row of the block once per band.
        for (let y = 0; y < bh; y++)
          for (let b = 0; b < nb; b++)
            for (let x = 0; x < bw; x++) {
              const sy = by * bh + y;
              const sx = bx * bw + x;
              if (sy >= H || sx >= W) p += bps;
              else put(img.planes[b][sy * W + sx]);
            }
        continue;
      }
      if (imode === 'P') {
        // Pixel interleaved (SICD I/Q): every band of a pixel together.
        for (let y = 0; y < bh; y++)
          for (let x = 0; x < bw; x++) {
            const sy = by * bh + y;
            const sx = bx * bw + x;
            for (let b = 0; b < nb; b++) {
              if (sy >= H || sx >= W) p += bps;
              else put(img.planes[b][sy * W + sx]);
            }
          }
        continue;
      }
      for (let b = 0; b < nb; b++) {
        const src = img.planes[b];
        for (let y = 0; y < bh; y++) {
          const sy = by * bh + y;
          for (let x = 0; x < bw; x++) {
            const sx = bx * bw + x;
            if (sy >= H || sx >= W) {
              p += bps;
              continue;
            }
            put(src[sy * W + sx]);
          }
        }
      }
    }
  return { sub, data, W, H };
}

/**
 * Encode a NITF 2.1 file. img = {width, height, bands, type: 'u8'|'u16'|'i16'|'f32', planes
 * [TypedArray per band]}. opts: marking, title, iid1, iid2, idatim, isorce, icat, irep
 * ('MONO'|'RGB'|'MULTI'), abpp, corners [[lat, lon] UL, UR, LR, LL] (pixel centres), rpc (92),
 * chip {x0, y0, w, h, step, fullW, fullH}, tres [[tag, body]], idlvl, ialvl, iloc [row, col],
 * codestream (a JPEG 2000 or HTJ2K codestream written as IC=C8; img.planes unused), comrat,
 * ostaid, oname.
 */
export function writeNitf(img, opts = {}) {
  // opts.des: data extension segments (SICD/SIDD XML_DATA_CONTENT for SAR products).
  return writeNitfSegments([{ img, opts }], opts);
}

/** Several image segments in one file (display levels, attachment levels and ILOC per segment). */
export function writeNitfSegments(list, opts = {}) {
  const segs = list.map(({ img, opts: o }) => imageSegment(img, { marking: opts.marking, ...o }));
  const n = segs.length;
  if (n < 1 || n > 999) throw new Error('1–999 image segments');
  const sec = securityGroup(opts.marking);
  // Data extension segments: [{desid, ver, user (user-defined subheader text), data (bytes)}].
  const des = (opts.des ?? []).map((d) => ({ sub: 'DE' + A(d.desid, 25) + N(d.ver ?? 1, 2) + securityGroup(opts.marking) + N((d.user ?? '').length, 4) + (d.user ?? ''), data: d.data instanceof Uint8Array ? d.data : enc.encode(d.data) }));
  const HL = 388 + 16 * n + 13 * des.length;
  const FL = HL + segs.reduce((s, g) => s + g.sub.length + g.data.length, 0) + des.reduce((s, d) => s + d.sub.length + d.data.length, 0);
  const W = Math.max(...segs.map((g) => g.W));
  const H = Math.max(...segs.map((g) => g.H));
  const clevel = W <= 2048 && H <= 2048 && FL < 50 * 2 ** 20 ? '03' : W <= 8192 && H <= 8192 && FL < 2 ** 30 ? '05' : W <= 65536 && H <= 65536 && FL < 2 ** 31 ? '06' : '07';
  const hdr = [
    'NITF02.10',
    clevel,
    'BF01',
    A(opts.ostaid ?? 'GISWB', 10),
    nitfTime(new Date()),
    A(opts.title ?? 'GIS Workbench chip', 80),
    sec,
    '00000',
    '00000',
    '0',
    '\0\0\0',
    A(opts.oname ?? '', 24),
    A('', 18),
    N(FL, 12),
    N(HL, 6),
    N(n, 3),
    ...segs.map((g) => N(g.sub.length, 6) + N(g.data.length, 10)),
    '000',
    '000',
    '000',
    N(des.length, 3),
    ...des.map((d) => N(d.sub.length, 4) + N(d.data.length, 9)),
    '000',
    '00000',
    '00000',
  ].join('');
  if (hdr.length !== HL) throw new Error(`file header is ${hdr.length} bytes, not ${HL}`);
  const out = new Uint8Array(FL);
  // The background colour bytes are binary zeros; everything else is ASCII.
  out.set(bytes(hdr), 0);
  let p = HL;
  for (const g of [...segs, ...des]) {
    out.set(bytes(g.sub), p);
    p += g.sub.length;
    out.set(g.data, p);
    p += g.data.length;
  }
  return out;
}

/** XML_DATA_CONTENT user subheader (773 bytes, STDI-0002 Appendix F) for a SICD/SIDD XML DES. */
export function xmlDesUser({ spec = 'SICD Volume 1 Design & Implementation Description Document', version = '1.4.0', ns = 'urn:SICD:1.4.0', date = '2024-05-01', corners = null } = {}) {
  const lpg = corners?.length === 4 ? [...corners, corners[0]].map(([la, lo]) => `${la >= 0 ? '+' : '-'}${Math.abs(la).toFixed(8).padStart(11, '0')}${lo >= 0 ? '+' : '-'}${Math.abs(lo).toFixed(8).padStart(12, '0')}`).join('').slice(0, 125) : '';
  return [A('99999', 5), A('XML', 8), A(new Date().toISOString().slice(0, 19) + 'Z', 20), A('GISWB', 40), A(spec, 60), A(version, 10), A(date, 20), A(ns, 120), A(lpg, 125), A('', 25), A('', 20), A('', 120), A('', 200)].join('');
}
