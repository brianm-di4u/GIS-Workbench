// SAR geocoding and terrain correction jobs (REQ-GAP-90, REG-085): a Sentinel-1 annotation (and an
// orbit file the user gives) → the `sargeo` bundle's orbit, image timing and parameter list. Pure
// functions, so the worker, the page and the tests share them. Times are seconds since 2000 (UTC) in
// the parsed XML; the bundle gets them relative to the product's first line, which keeps them to
// about a nanosecond.

export const C = 299792458;

/**
 * The orbit to use: the orbit file's when it covers the product with a minute to spare (POEORB or
 * RESORB, earth-fixed), else the annotation's own. Returns {source, t, p, v} (absolute times).
 * An orbit file for another satellite is refused: Sentinel-1A and -1C fly the same plane half an
 * orbit apart, so a file can cover the times and still be the wrong spacecraft.
 */
export function pickOrbit(ann, orbitFile = null) {
  const sat = (s) => String(s ?? '').replace(/^Sentinel-1/i, 'S1').toUpperCase();
  const t0 = ann.t0;
  const t1 = Number.isFinite(ann.t1) ? ann.t1 : t0;
  const f = orbitFile?.orbit;
  if (f?.t?.length >= 4 && f.t[0] <= t0 - 60 && f.t[f.t.length - 1] >= t1 + 60) {
    // Checked only for a file that would be used: one remembered from another scene, which does
    // not cover this one, still falls back to the annotation's orbit.
    if (orbitFile.mission && ann.missionId && sat(orbitFile.mission) !== sat(ann.missionId)) {
      const e = new Error(`the orbit file is for ${orbitFile.mission}, the image is ${ann.missionId}`);
      Object.assign(e, { code: 'E_SAR_ORBIT_MISSION', orbit: orbitFile.mission, image: ann.missionId });
      throw e;
    }
    // Only the scene's part: two minutes either side.
    const i0 = Math.max(0, f.t.findIndex((x) => x >= t0 - 120) - 1);
    const k = f.t.findIndex((x) => x > t1 + 120);
    const i1 = k < 0 ? f.t.length : k + 1;
    return { source: orbitFile.type || 'orbit file', t: f.t.slice(i0, i1), p: f.p.slice(3 * i0, 3 * i1), v: f.v.slice(3 * i0, 3 * i1) };
  }
  const a = ann.orbit;
  if (!(a?.t?.length >= 4)) return null;
  return { source: 'annotation', t: a.t, p: a.p, v: a.v };
}

/**
 * Image timing and range axis from an annotation: TOPS bursts as blocks (each burst's valid lines),
 * else one block for the whole image; slant range for SLC, the conversion records for GRD.
 * Times relative to `epoch`.
 */
export function imageGeometry(ann, epoch = ann.t0) {
  const dt = ann.azimuthTimeInterval;
  const bursts = (ann.bursts ?? []).filter((b) => Number.isFinite(b.t) && b.validLines);
  const blocks = bursts.length
    ? bursts.map((b) => ({ t0: b.t - epoch, firstLine: b.firstLine, valid: b.validLines }))
    : [{ t0: ann.t0 - epoch, firstLine: 0, valid: [0, ann.lines] }];
  let range;
  if (ann.productType === 'GRD') {
    const recs = (ann.conversion ?? []).filter((r) => Number.isFinite(r.t) && Number.isFinite(r.sr0) && r.srgr?.length && r.grsr?.length >= 2);
    if (!recs.length) return null;
    range = { kind: 'ground', dg: ann.rangeSpacing, recs: recs.map((r) => ({ t: r.t - epoch, r0: r.sr0, g0: r.gr0 ?? 0, grsr: r.grsr, srgr: r.srgr })) };
  } else {
    if (!(ann.rangeSamplingRate > 0) || !Number.isFinite(ann.slantRangeTime)) return null;
    range = { kind: 'slant', r0: (ann.slantRangeTime * C) / 2, dr: C / (2 * ann.rangeSamplingRate) };
  }
  if (!(dt > 0) || !(ann.azimuthSpacing > 0)) return null;
  return { dt, azSpacing: ann.azimuthSpacing, blocks, range };
}

/**
 * The radar window over a DEM: the lines and pixels of the annotation's geolocation grid nodes
 * within the DEM's bounds (with one grid cell of margin), clamped to the image. Null when the
 * DEM is outside the product.
 */
export function windowOver(ann, bounds) {
  const g = ann.grid;
  if (!g?.regular) return null;
  const nx = g.pixels.length;
  const ny = g.lines.length;
  const dLat = Math.abs(g.lat[nx] - g.lat[0]) || 0.1;
  const dLon = Math.abs(g.lon[1] - g.lon[0]) || 0.1;
  const m = Math.max(dLat, dLon) * 1.5;
  let [l0, l1, p0, p1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const la = g.lat[j * nx + i];
      const lo = g.lon[j * nx + i];
      if (la < bounds.south - m || la > bounds.north + m || lo < bounds.west - m || lo > bounds.east + m) continue;
      l0 = Math.min(l0, g.lines[j]);
      l1 = Math.max(l1, g.lines[j]);
      p0 = Math.min(p0, g.pixels[i]);
      p1 = Math.max(p1, g.pixels[i]);
    }
  if (!(l1 >= l0)) return null;
  const x0 = Math.max(0, Math.floor(p0));
  const y0 = Math.max(0, Math.floor(l0));
  return { x0, y0, w: Math.min(ann.samples, Math.ceil(p1) + 1) - x0, h: Math.min(ann.lines, Math.ceil(l1) + 1) - y0 };
}

/** β⁰ in dB (full resolution, w × h) → linear power averaged over kl × ks looks; NaN looks stay NaN. */
export function looks(db, w, h, kl, ks) {
  const nl = Math.floor(h / kl);
  const ns = Math.floor(w / ks);
  const out = new Float32Array(nl * ns);
  for (let r = 0; r < nl; r++)
    for (let c = 0; c < ns; c++) {
      let s = 0;
      let n = 0;
      for (let y = r * kl; y < r * kl + kl; y++)
        for (let x = c * ks; x < c * ks + ks; x++) {
          const v = db[y * w + x];
          if (Number.isFinite(v)) {
            s += 10 ** (v / 10);
            n++;
          }
        }
      out[r * ns + c] = n ? s / n : NaN;
    }
  return { beta: out, nl, ns };
}

/**
 * The bundle's parameter list (crates/bundles/sargeo). orbit {t, p, v} absolute, `epoch`
 * subtracted here; geom from imageGeometry; dem {width, height, lat0, lon0, dlat, dlon};
 * win {l0, s0, kl, ks, nl, ns}; opts {flatten, maskStride, maskStep, maskTol, look (1 right, -1 left,
 * 0 either; Sentinel-1 looks right)}.
 */
export function sargeoParams(orbit, epoch, geom, dem, win, opts) {
  const n = orbit.t.length;
  const out = [n, ...orbit.t.map((t) => t - epoch), ...orbit.p, ...orbit.v, geom.dt, geom.azSpacing, geom.blocks.length];
  for (const b of geom.blocks) out.push(b.t0, b.firstLine, b.valid[0], b.valid[1]);
  if (geom.range.kind === 'slant') out.push(0, geom.range.r0, geom.range.dr);
  else {
    out.push(1, geom.range.dg, geom.range.recs.length);
    for (const r of geom.range.recs) out.push(r.t, r.r0, r.g0, r.grsr.length, ...r.grsr, r.srgr.length, ...r.srgr);
  }
  out.push(dem.width, dem.height, dem.lat0, dem.lon0, dem.dlat, dem.dlon);
  out.push(win.l0, win.s0, win.kl, win.ks, win.nl, win.ns);
  out.push(opts.flatten ? 1 : 0, opts.maskStride ?? 0, opts.maskStep ?? 0, opts.maskTol ?? 0, opts.look ?? 0);
  return Float64Array.from(out);
}
