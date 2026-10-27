// SICD complex imagery in the decode worker (REQ-SAR-01/03/06, `Research/09` §3–§5). The NITF
// image segments (I/Q or amplitude/phase, big-endian, any PVTYPE) are read through the NITF
// source; this wrapper turns them into the derived bands every SAR view uses, so a view or remap
// change never re-reads the file and only the band shown is computed:
//   0 amplitude |z|      1 phase arg z (rad)      2 I      3 Q      4 power (dB)
//   5 β⁰ (dB)            6 σ⁰ (dB)                7 γ⁰ (dB)          8 RCS (dB m²)
// Calibrated bands are NaN when the Radiometric block cannot provide them (the UI disables them
// with the reason). The pyramid averages amplitude and power; phase, I and Q are decimated, since
// averaging complex samples is meaningless for display.

export const SAR_BANDS = ['amplitude', 'phase', 'I', 'Q', 'power', 'beta0', 'sigma0', 'gamma0', 'rcs'];

function poly2(p) {
  if (!p) return null;
  const { n1, n2, c } = p;
  return (x, y) => {
    let s = 0;
    let xi = 1;
    for (let i = 0; i < n1; i++) {
      let yj = 1;
      for (let j = 0; j < n2; j++) {
        s += c[i * n2 + j] * xi * yj;
        yj *= y;
      }
      xi *= x;
    }
    return s;
  };
}

const scale = (p, k) => (p ? { n1: p.n1, n2: p.n2, c: p.c.map((v) => v * k) } : null);

/**
 * Radiometric scale-factor polynomials, deriving the missing ones from any one present (sarpy's
 * rules): σ⁰ = β⁰·cos(slope), γ⁰ = β⁰·cos(slope)/sin(graze), RCS = β⁰·A_sp with A_sp =
 * 1/(Row.ImpRespBW·Col.ImpRespBW) for uniform weighting. Returns {beta0, sigma0, gamma0, rcs,
 * derived: {…: 'file'|'derived'}, reason} with polynomials in (xrow, ycol) metres.
 */
export function radiometry(m) {
  const r = m.radiometric;
  if (!r) return { reason: 'the SICD has no Radiometric block', derived: {} };
  const cs = Math.cos((m.slope * Math.PI) / 180);
  const sg = Math.sin((m.graze * Math.PI) / 180);
  const asp = m.rowBW > 0 && m.colBW > 0 ? 1 / (m.rowBW * m.colBW) : NaN;
  const uniform = (m.rowWgt ?? 'UNIFORM') === 'UNIFORM' && (m.colWgt ?? 'UNIFORM') === 'UNIFORM';
  let beta = r.beta0 ?? null;
  let from = 'beta0';
  if (!beta && r.sigma0 && Number.isFinite(cs) && cs > 0) [beta, from] = [scale(r.sigma0, 1 / cs), 'sigma0'];
  if (!beta && r.gamma0 && cs > 0 && sg > 0) [beta, from] = [scale(r.gamma0, sg / cs), 'gamma0'];
  if (!beta && r.rcs && Number.isFinite(asp)) [beta, from] = [scale(r.rcs, 1 / asp), 'rcs'];
  if (!beta) return { reason: 'the Radiometric block has no scale-factor polynomial', derived: {} };
  const out = {
    beta0: beta,
    sigma0: r.sigma0 ?? (Number.isFinite(cs) ? scale(beta, cs) : null),
    gamma0: r.gamma0 ?? (cs > 0 && sg > 0 ? scale(beta, cs / sg) : null),
    rcs: r.rcs ?? (Number.isFinite(asp) ? scale(beta, asp) : null),
    noise: r.noise ?? null,
    noiseType: r.noiseType ?? null,
    derived: {},
    reason: null,
    note: uniform ? null : 'RCS assumes uniform weighting (the window weights are not applied)',
  };
  for (const k of ['beta0', 'sigma0', 'gamma0', 'rcs']) out.derived[k] = r[k] ? 'file' : k === from ? 'file' : 'derived';
  return out;
}

/** Wrap a NITF (or merged multi-segment) source of a SICD as a source of the derived bands. */
export function sicdSource(base, meta) {
  const pt = meta.pixelType;
  const amp = meta.ampTable ?? null;
  if (pt === 'AMP8I_PHS8I' && !amp) throw new Error('AMP8I_PHS8I pixels need ImageData/AmpTable, which this SICD lacks');
  if (base.bands < 2) throw new Error(`a SICD image has two bands (I/Q or amplitude/phase); found ${base.bands}`);
  const rad = radiometry(meta);
  const polys = { 5: poly2(rad.beta0), 6: poly2(rad.sigma0), 7: poly2(rad.gamma0), 8: poly2(rad.rcs) };
  const fr = meta.firstRow ?? 0;
  const fc = meta.firstCol ?? 0;
  const { scpRow, scpCol, rowSS, colSS } = meta;
  const phaseTable = new Float32Array(256);
  for (let i = 0; i < 256; i++) phaseTable[i] = (2 * Math.PI * i) / 256;
  return {
    kind: 'sicd',
    sar: true,
    imageIndex: base.imageIndex,
    width: base.width,
    height: base.height,
    bands: SAR_BANDS.length,
    sampleType: 'f32',
    nodata: NaN,
    abpp: 32,
    parts: base.parts,
    pickBands: [1, 2, 3],
    radiometry: rad,
    // Coarse levels straight from the base's strided reads (TE-019); the radiometric polynomials
    // are evaluated at each sample's full-resolution position.
    hasLevel: (L) => !!base.hasLevel?.(L),
    async readLevel(L, x0, y0, w, h, bands, job) {
      const [a, b] = await base.readLevel(L, x0, y0, w, h, [0, 1], job);
      return derive(a, b, x0, y0, w, h, bands, 2 ** L);
    },
    async readWindow(x0, y0, w, h, bands, job) {
      const [a, b] = await base.readWindow(x0, y0, w, h, [0, 1], job);
      return derive(a, b, x0, y0, w, h, bands, 1);
    },
    /** Complex AOI chip as interleaved (re, im) f32, for CCD and sub-apertures (never filtered). */
    async readComplex(x0, y0, w, h, job) {
      const [a, b] = await base.readWindow(x0, y0, w, h, [0, 1], job);
      const n = w * h;
      const out = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) {
        if (pt === 'AMP8I_PHS8I') {
          const A = amp[a[i]];
          const p = phaseTable[b[i]];
          out[2 * i] = A * Math.cos(p);
          out[2 * i + 1] = A * Math.sin(p);
        } else {
          out[2 * i] = a[i];
          out[2 * i + 1] = b[i];
        }
      }
      return out;
    },
  };

  function derive(a, b, x0, y0, w, h, bands, sc) {
    const n = w * h;
    const half = sc > 1 ? sc >> 1 : 0;
    // Complex samples as (re, im).
    let re;
    let im;
    if (pt === 'AMP8I_PHS8I') {
      re = new Float32Array(n);
      im = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const A = amp[a[i]];
        const p = phaseTable[b[i]];
        re[i] = A * Math.cos(p);
        im[i] = A * Math.sin(p);
      }
    } else {
      re = a;
      im = b;
    }
    return bands.map((band) => {
      const o = new Float32Array(n);
      if (band === 2) for (let i = 0; i < n; i++) o[i] = re[i];
      else if (band === 3) for (let i = 0; i < n; i++) o[i] = im[i];
      else if (band === 0) for (let i = 0; i < n; i++) o[i] = Math.hypot(re[i], im[i]);
      else if (band === 1) for (let i = 0; i < n; i++) o[i] = Math.atan2(im[i], re[i]);
      else if (band === 4) for (let i = 0; i < n; i++) o[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-30);
      else {
        const sf = polys[band];
        if (!sf) {
          o.fill(NaN);
          return o;
        }
        for (let y = 0; y < h; y++) {
          const xrow = ((y0 + y) * sc + half + fr - scpRow) * rowSS;
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            const ycol = ((x0 + x) * sc + half + fc - scpCol) * colSS;
            o[i] = 10 * Math.log10(sf(xrow, ycol) * (re[i] * re[i] + im[i] * im[i]) + 1e-30);
          }
        }
      }
      return o;
    });
  }
}
