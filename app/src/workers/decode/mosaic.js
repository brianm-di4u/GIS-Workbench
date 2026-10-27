// Merge NITF image segments into one logical image (REQ-IMG-20) where the attachment levels
// allow: every segment attaches, directly or through others, to the base segment (IALVL 0);
// ILOC places each one relative to the segment it is attached to; higher display levels (IDLVL)
// draw on top. All segments must share bands and sample type, and the base segment must sit at
// the mosaic origin (its sensor model then serves the whole mosaic).

/** Positions of the segments, or a reason why they cannot be merged. */
export function mosaicPlan(images, sources) {
  const segs = sources.map((src) => {
    const im = images.find((i) => i.index === src.imageIndex);
    const s = im?.ish ?? {};
    return { src, idlvl: s.IDLVL ?? 1, ialvl: s.IALVL ?? 0, iloc: s.ILOC ?? [0, 0] };
  });
  if (segs.length < 2) return { reason: 'the file has one image segment' };
  const t0 = segs[0].src;
  if (segs.some((g) => g.src.bands !== t0.bands || g.src.sampleType !== t0.sampleType)) return { reason: 'the segments differ in bands or sample type' };
  const byLvl = new Map(segs.map((g) => [g.idlvl, g]));
  const roots = segs.filter((g) => g.ialvl === 0);
  if (roots.length !== 1) return { reason: `${roots.length} segments are unattached (IALVL 0); the attachment levels do not form one image` };
  const pos = new Map();
  const place = (g, depth = 0) => {
    if (pos.has(g)) return pos.get(g);
    if (depth > segs.length) throw new Error('attachment loop');
    if (g.ialvl === 0) {
      pos.set(g, [0, 0]);
      return [0, 0];
    }
    const parent = byLvl.get(g.ialvl);
    if (!parent) throw new Error(`segment with IDLVL ${g.idlvl} attaches to missing level ${g.ialvl}`);
    const [px, py] = place(parent, depth + 1);
    const p = [px + g.iloc[1], py + g.iloc[0]];
    pos.set(g, p);
    return p;
  };
  try {
    for (const g of segs) place(g);
  } catch (e) {
    return { reason: e.message };
  }
  const xs = segs.map((g) => pos.get(g)[0]);
  const ys = segs.map((g) => pos.get(g)[1]);
  if (Math.min(...xs) < 0 || Math.min(...ys) < 0) return { reason: 'a segment lies left of or above the base segment' };
  const width = Math.max(...segs.map((g) => pos.get(g)[0] + g.src.width));
  const height = Math.max(...segs.map((g) => pos.get(g)[1] + g.src.height));
  return { width, height, parts: segs.map((g) => ({ src: g.src, x: pos.get(g)[0], y: pos.get(g)[1], idlvl: g.idlvl })).sort((a, b) => a.idlvl - b.idlvl), base: roots[0].src };
}

/** A source drawing the planned segments into one raster (later display levels on top). */
export function mosaicSource(plan) {
  const { base } = plan;
  return {
    kind: 'nitf-mosaic',
    imageIndex: base.imageIndex,
    width: plan.width,
    height: plan.height,
    bands: base.bands,
    sampleType: base.sampleType,
    nodata: base.nodata ?? 0,
    abpp: base.abpp,
    parts: plan.parts.map((p) => ({ imageIndex: p.src.imageIndex, x: p.x, y: p.y, width: p.src.width, height: p.src.height, idlvl: p.idlvl })),
    async readWindow(x0, y0, w, h, bands, job) {
      const C = { u8: Uint8Array, u16: Uint16Array, i16: Int16Array, f32: Float32Array }[base.sampleType] ?? Float32Array;
      const out = bands.map(() => new C(w * h).fill(base.nodata ?? 0));
      for (const p of plan.parts) {
        const xs = Math.max(x0, p.x);
        const ys = Math.max(y0, p.y);
        const xe = Math.min(x0 + w, p.x + p.src.width);
        const ye = Math.min(y0 + h, p.y + p.src.height);
        if (xe <= xs || ye <= ys) continue;
        const r = await p.src.readWindow(xs - p.x, ys - p.y, xe - xs, ye - ys, bands, job);
        const sw = xe - xs;
        for (let k = 0; k < bands.length; k++)
          for (let y = ys; y < ye; y++) out[k].set(r[k].subarray((y - ys) * sw, (y - ys + 1) * sw), (y - y0) * w + (xs - x0));
      }
      return out;
    },
  };
}
