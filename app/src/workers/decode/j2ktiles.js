// Tile-by-tile JPEG 2000 for the decode worker (NITF C8/M8 and JP2 files). A tiled codestream is
// indexed once (main header + tile-part offsets, from TLM when present); each tile is then decoded
// alone at full or a reduced resolution from the main header plus its own tile-parts through
// gw_j2k_decode_region, so a 1.4 G-sample WorldView strip shows without a whole-image decode and
// coarse levels never touch full-resolution data (TE archive: MVS / CORE3D full scenes).

/**
 * Tile-part index of the codestream at [base, end), read through readRange(off, len) → Uint8Array,
 * or null when it cannot be decoded tile by tile (one tile, PPM packet headers, subsampled
 * components, an offset or non-power-of-two tile grid: gw_j2k_decode_region's conditions).
 * → { head, parts: Map<tile, [off, len, psot0][]>, tx, ty, ntx, nty, xo, yo, levels }
 */
export async function j2kTileIndex(readRange, base, end) {
  let head = await readRange(base, Math.min(65536, end - base));
  let soc = -1;
  for (let k = 0; k + 3 < Math.min(head.length, 1024); k++) {
    if (head[k] === 0xff && head[k + 1] === 0x4f && head[k + 2] === 0xff && head[k + 3] === 0x51) {
      soc = k;
      break;
    }
  }
  if (soc < 0) return null;
  let dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const grow = async (need) => {
    if (head.length >= end - base || need > 16 << 20) return false;
    head = await readRange(base, Math.min(end - base, Math.max(head.length * 4, need)));
    dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    return true;
  };
  let i = soc + 2;
  const ix = { tlm: [], levels: 0 };
  for (;;) {
    if (i + 4 > head.length) {
      if (!(await grow(i + 4))) return null;
      continue;
    }
    const m = dv.getUint16(i);
    if (m === 0xff90) break;
    const l = dv.getUint16(i + 2);
    if (i + 2 + l > head.length) {
      if (!(await grow(i + 2 + l))) return null;
      continue;
    }
    if (m === 0xff60) return null; // PPM
    if (m === 0xff51) {
      const [xs, ys, xo, yo, tx, ty, txo, tyo] = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => dv.getUint32(i + 6 + 4 * k));
      const nc = dv.getUint16(i + 38);
      for (let c = 0; c < nc; c++) if (head[i + 41 + 3 * c] !== 1 || head[i + 42 + 3 * c] !== 1) return null;
      const pow2 = (v) => v > 0 && (v & (v - 1)) === 0;
      if (txo || tyo || !pow2(tx) || !pow2(ty)) return null;
      Object.assign(ix, { tx, ty, xo, yo, ntx: Math.ceil(xs / tx), nty: Math.ceil(ys / ty) });
    } else if (m === 0xff52) {
      ix.prog = head[i + 5]; // SGcod progression: 0 LRCP, 1 RLCP, 2 RPCL, 3 PCRL, 4 CPRL
      ix.levels = head[i + 9]; // SPcod: decomposition levels
    }
    else if (m === 0xff55) {
      // TLM: Ztlm, Stlm, then (Ttlm?, Ptlm) per tile-part.
      const st = (head[i + 5] >> 4) & 3;
      const sp = (head[i + 5] >> 6) & 1 ? 4 : 2;
      for (let o = i + 6; o + st + sp <= i + 2 + l; o += st + sp) ix.tlm.push([st === 0 ? null : st === 1 ? head[o] : dv.getUint16(o), sp === 4 ? dv.getUint32(o + st) : dv.getUint16(o + st), head[i + 4]]);
    }
    i += 2 + l;
  }
  if (!ix.tx || ix.ntx * ix.nty < 2) return null;
  ix.head = head.slice(soc, i);
  ix.parts = new Map();
  const add = (t, o, l, psot0) => (ix.parts.get(t) ?? ix.parts.set(t, []).get(t)).push([o, l, psot0]);
  const first = base + i;
  // TLM segments are ordered by Ztlm; without tile indices the tile-parts are in tile order.
  const tlm = ix.tlm.sort((a, b) => a[2] - b[2]);
  let pos = first;
  // Without tile indices (Stlm ST = 0) TLM maps parts to tiles only when each tile has one part.
  if (tlm.length && tlm.every((e) => e[1] >= 14) && (tlm[0][0] !== null || tlm.length === ix.ntx * ix.nty)) {
    tlm.forEach(([t, len], k) => {
      add(t ?? k, pos, len, false);
      pos += len;
    });
    // Spot-check the index against the file before trusting it.
    const probe = await readRange(tlm.length > 1 ? first + tlm[0][1] : first, 2);
    if (pos <= end && probe[0] === 0xff && probe[1] === 0x90) return withResolutionParts(ix);
    ix.parts = new Map();
  }
  pos = first;
  while (pos + 12 <= end) {
    const b = await readRange(pos, 12);
    if (b[0] !== 0xff || b[1] !== 0x90) break;
    const sdv = new DataView(b.buffer, b.byteOffset);
    const psot = sdv.getUint32(6);
    add(sdv.getUint16(4), pos, psot || end - pos - (end - pos >= 14 ? 2 : 0), !psot);
    if (!psot) break;
    pos += psot;
  }
  return ix.parts.size ? withResolutionParts(ix) : null;
}

/**
 * Resolution-first codestreams split into one tile-part per resolution (Maxar/Kakadu RLCP with
 * TNsot = NL + 1): a level-L tile then needs only its first NL + 1 − L parts — 1.7 KB instead of
 * ~500 KB for a WorldView-3 overview tile (gw-codec test wv3_reduced_tile_needs_only_its_resolution_tile_parts).
 */
function withResolutionParts(ix) {
  ix.resolutionParts = (ix.prog === 1 || ix.prog === 2) && ix.levels > 0 && [...ix.parts.values()].every((p) => p.length === ix.levels + 1);
  return ix;
}

/**
 * Reader over an index: read(L, x0, y0, w, h, bands, job) → typed planes of level L (0 = full
 * resolution) for the window, composed from the tiles it touches; decoded tiles are cached in
 * `cache` (an LRU with set(key, value, bytes)). lutBand maps a single palette band to RGB.
 */
export function j2kTileReader({ ix, readRange, cache, bundle, width, height, C, nodata, lutBand = null }) {
  async function tile(L, t) {
    const key = `j2k:${L}:${t}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const all = ix.parts.get(t);
    if (!all) return null;
    const parts = ix.resolutionParts && L > 0 ? all.slice(0, ix.levels + 1 - L) : all;
    const chunks = [ix.head];
    for (const [o, l, psot0] of parts) {
      const b = (await readRange(o, l)).slice();
      // A last tile-part with Psot = 0 runs to EOC; give it its length so EOC can follow it.
      if (psot0) new DataView(b.buffer, b.byteOffset).setUint32(6, l);
      chunks.push(b);
    }
    chunks.push(Uint8Array.of(0xff, 0xd9));
    const buf = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    chunks.reduce((o, c) => (buf.set(c, o), o + c.length), 0);
    const j2k = await bundle();
    const c = t % ix.ntx;
    const r = Math.floor(t / ix.ntx);
    const [p, n] = j2k.put(buf);
    let out;
    try {
      if (j2k.x.gw_j2k_decode_region(p, n, Math.max(0, c * ix.tx - ix.xo), Math.max(0, r * ix.ty - ix.yo), 1, 1, L) !== 0) throw new Error(`JPEG 2000 tile ${t}: ${j2k.lastError()}`);
      out = j2k.outBytes();
    } finally {
      j2k.free(p, n);
    }
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const [w, h, comps, bits] = [8, 12, 16, 20].map((o) => dv.getUint32(o, true));
    const N = w * h;
    const planes = [];
    for (let k = 0; k < comps; k++) planes.push(bits <= 8 ? out.subarray(24 + k * N, 24 + (k + 1) * N) : new Uint16Array(out.buffer, out.byteOffset + 24 + k * N * 2, N));
    const f = 2 ** L;
    const lx = Math.ceil((dv.getUint32(0, true) + ix.xo) / f) - Math.ceil(ix.xo / f);
    const ly = Math.ceil((dv.getUint32(4, true) + ix.yo) / f) - Math.ceil(ix.yo / f);
    const tl = { lx, ly, w, h, comps, planes };
    cache.set(key, tl, out.byteLength);
    return tl;
  }

  return async function read(L, x0, y0, w, h, bands, job) {
    const f = 2 ** L;
    const out = bands.map(() => new C(w * h).fill(nodata ?? 0));
    const X0 = x0 * f + ix.xo;
    const X1 = Math.min(width, (x0 + w) * f) - 1 + ix.xo;
    const Y0 = y0 * f + ix.yo;
    const Y1 = Math.min(height, (y0 + h) * f) - 1 + ix.yo;
    for (let r = Math.floor(Y0 / ix.ty); r <= Math.floor(Y1 / ix.ty); r++) {
      for (let c = Math.floor(X0 / ix.tx); c <= Math.floor(X1 / ix.tx); c++) {
        job?.checkCancel?.();
        const t = await tile(L, r * ix.ntx + c);
        if (!t) continue;
        const ya = Math.max(y0, t.ly);
        const yb = Math.min(y0 + h, t.ly + t.h);
        const xa = Math.max(x0, t.lx);
        const xb = Math.min(x0 + w, t.lx + t.w);
        for (let k = 0; k < bands.length; k++) {
          const src = t.planes[lutBand ? 0 : Math.min(bands[k], t.comps - 1)];
          const lut = lutBand ? lutBand[bands[k]] : null;
          const dst = out[k];
          for (let y = ya; y < yb; y++) {
            const so = (y - t.ly) * t.w - t.lx;
            const dofs = (y - y0) * w - x0;
            if (lut) for (let x = xa; x < xb; x++) dst[dofs + x] = lut[src[so + x]] ?? 0;
            else for (let x = xa; x < xb; x++) dst[dofs + x] = src[so + x];
          }
        }
      }
    }
    return out;
  };
}
