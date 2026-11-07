// Spectral-library text readers that need no DOM (unit-tested on their own).

/**
 * Library text as a string: UTF-8 when the bytes are valid UTF-8, else Windows-1252 (CX-095: 13 ECOSTRESS
 * mineral spectra write the middle dot of "Na2CO3·10H2O" as the single Latin-1 byte 0xB7, which UTF-8
 * decoding turned into U+FFFD).
 */
export function decodeLibraryText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1252').decode(b);
  }
}

/**
 * What a library spectrum measures, from its Y units and measurement lines (CX-094). ECOSTRESS carries
 * transmittance spectra (and misspells it: "Transmittence", "Transittance", "Tansmission") next to
 * reflectance; only reflectance is comparable with reflectance imagery.
 */
export function spectrumQuantity(yUnits = '', measurement = '') {
  const t = `${yUnits} ${measurement}`.toLowerCase();
  if (/transm|transit|tansm/.test(t)) return 'transmittance';
  if (/emissiv/.test(t)) return 'emissivity';
  if (/absorb/.test(t)) return 'absorbance';
  if (/reflect/.test(t)) return 'reflectance';
  return 'unknown';
}

/**
 * One ECOSTRESS / ASTER library spectrum (CX-089): "Key: value" header lines (Name, X Units, Y Units, …),
 * a blank line, then wavelength/value pairs, usually in descending wavelength. Returns null when the
 * text is not in that layout. Wavelengths come back in µm, ascending; reflectance in percent is scaled
 * to 0–1 like the other libraries. `quantity` says what was measured (CX-094) and `meta` keeps the
 * type, class and sample origin for the library browser (IMP-26).
 */
export function parseSpecLibText(text, source = '') {
  const lines = text.split(/\r?\n/);
  const head = {};
  let i = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    const m = /^([^:]+):\s*(.*)$/.exec(lines[i]);
    if (!m) return null;
    head[m[1].trim().toLowerCase()] = m[2].trim();
  }
  if (!('name' in head) || !('x units' in head)) return null;
  const pts = [];
  for (; i < lines.length; i++) {
    const c = lines[i].trim().split(/[\s,;]+/).map(Number);
    if (c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) pts.push([c[0], c[1]]);
  }
  if (pts.length < 2) return null;
  const nm = /nanomet|\bnm\b/i.test(head['x units']);
  const pct = /percent|%/i.test(head['y units'] ?? '');
  pts.sort((a, b) => a[0] - b[0]);
  const o = /^\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)/.exec(head.origin ?? '');
  return {
    name: head.name + (head['sample no.'] ? ` (${head['sample no.']})` : ''),
    wl: pts.map((p) => (nm ? p[0] / 1000 : p[0])),
    values: pts.map((p) => (p[1] < -1e30 ? NaN : pct ? p[1] / 100 : p[1])),
    source,
    quantity: spectrumQuantity(head['y units'], head.measurement),
    meta: {
      type: head.type ?? '',
      class: [head.class, head.subclass].filter((x) => x && x !== 'none').join(' / '),
      measurement: head.measurement ?? '',
      origin: o ? { lat: Number(o[1]), lon: Number(o[2]) } : null,
    },
  };
}

/**
 * A library spectrum resampled to bands with Gaussian response functions (centre, FWHM µm); bands the
 * spectrum does not reach are NaN. The same rule as gw-spectral `resample` (crates/gw-spectral/src/misc.rs),
 * run here so the browser can rank thousands of spectra without a worker round trip each.
 */
export function resampleSpectrum(wl, values, centres, fwhm = []) {
  return centres.map((cw, i) => {
    const f = Number.isFinite(fwhm[i]) && fwhm[i] > 0 ? fwhm[i] : 0.01;
    const s = f / 2.35482;
    let a = 0;
    let w = 0;
    // Wavelengths are ascending: start at the first one inside the 3-sigma window.
    let lo = 0;
    let hi = wl.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (wl[mid] < cw - 3 * s) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < wl.length && wl[k] <= cw + 3 * s; k++) {
      const v = values[k];
      if (!Number.isFinite(v)) continue;
      const g = Math.exp(-0.5 * ((wl[k] - cw) / s) ** 2);
      a += g * v;
      w += g;
    }
    return w > 0 ? a / w : NaN;
  });
}

/** Spectral angle (radians) over the bands both spectra have; NaN when fewer than three are shared. */
export function spectralAngle(a, b) {
  let d = 0;
  let x = 0;
  let y = 0;
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
    n++;
  }
  if (n < 3 || !(x > 0) || !(y > 0)) return NaN;
  return Math.acos(Math.min(1, Math.max(-1, d / Math.sqrt(x * y))));
}

/**
 * Library spectra ranked by spectral angle to a target sampled at `centres`. Only reflectance (and
 * spectra of unknown quantity) take part unless `quantities` says otherwise (CX-094); spectra that cover
 * under half of the target's bands are left out, since an angle over a few bands means little.
 */
export function rankLibrary(target, centres, fwhm, spectra, { quantities = ['reflectance', 'unknown'], limit = 50 } = {}) {
  const want = target.filter(Number.isFinite).length;
  const out = [];
  for (const s of spectra) {
    if (!s.wl || !quantities.includes(s.quantity ?? 'reflectance')) continue;
    if (s.wl[s.wl.length - 1] < Math.min(...centres) || s.wl[0] > Math.max(...centres)) continue;
    const r = resampleSpectrum(s.wl, s.values, centres, fwhm);
    const shared = r.filter((v, i) => Number.isFinite(v) && Number.isFinite(target[i])).length;
    if (shared < Math.max(3, want / 2)) continue;
    const angle = spectralAngle(target, r);
    if (Number.isFinite(angle)) out.push({ spectrum: s, angle, shared });
  }
  return out.sort((a, b) => a.angle - b.angle).slice(0, limit);
}
