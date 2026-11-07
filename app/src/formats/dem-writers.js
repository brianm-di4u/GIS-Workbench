// DEM tile writers (REQ-DEM-16, REQ-FMT-07): DTED Level 1/2 cells and SRTM HGT tiles from a terrain
// grid {lon0, lat0, dlon, dlat, width, height} of heights H (row-major, north first). Pure functions:
// `app` supplies only app.core.undulation (EGM96) for heights above the ellipsoid.

/** Bilinear height at (lat, lon) of a terrain grid, NaN outside it. */
function sampler(g, H) {
  return (lat, lon) => {
    const fi = (lon - g.lon0) / g.dlon;
    const fj = (g.lat0 - lat) / g.dlat;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    if (i < 0 || j < 0 || i + 1 >= g.width || j + 1 >= g.height) return NaN;
    const a = fi - i;
    const b = fj - j;
    const v = (ii, jj) => H[jj * g.width + ii];
    return v(i, j) * (1 - a) * (1 - b) + v(i + 1, j) * a * (1 - b) + v(i, j + 1) * (1 - a) * b + v(i + 1, j + 1) * a * b;
  };
}

/**
 * One SRTM HGT tile (REQ-FMT-07): big-endian signed 16-bit metres above EGM96, rows north to south,
 * the cell's edges included (3601² at 1″, 1201² at 3″), voids −32768. Named by the south-west corner.
 */
export function hgtCell(app, g, H, vertical, la, lo, arcsec = 1) {
  const n = arcsec === 3 ? 1201 : 3601;
  const step = 1 / (n - 1);
  const out = new Uint8Array(n * n * 2);
  const dv = new DataView(out.buffer);
  const sample = sampler(g, H);
  for (let r = 0; r < n; r++) {
    const lat = la + 1 - r * step;
    for (let c = 0; c < n; c++) {
      const lon = lo + c * step;
      let v = sample(lat, lon);
      if (Number.isFinite(v) && vertical === 'hae') v -= app.core.undulation(lat, lon);
      dv.setInt16(2 * (r * n + c), Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round(v))) : -32768, false);
    }
  }
  return out;
}

/** One DTED cell (UHL, DSI, ACC, data records with checksums), MIL-PRF-89020B layout. */
export function dtedCell(app, g, H, vertical, la, lo, level) {
  const latN = level === 2 ? 3601 : 1201;
  const absLat = Math.abs(la + (la < 0 ? 0 : 0.5));
  const lonFactor = absLat < 50 ? 1 : absLat < 70 ? 2 : absLat < 75 ? 3 : absLat < 80 ? 4 : 6;
  const lonN = (latN - 1) / lonFactor + 1;
  const latInt = level === 2 ? 10 : 30; // tenths of arc seconds
  const lonInt = latInt * lonFactor;
  const sp = (s, n) => String(s).padEnd(n, ' ').slice(0, n);
  const dms = (v, lonP) => {
    const a = Math.abs(v);
    const d = Math.floor(a);
    const hem = lonP ? (v < 0 ? 'W' : 'E') : v < 0 ? 'S' : 'N';
    return `${String(d).padStart(3, '0')}0000${hem}`; // DDDMMSSH for both (MIL-PRF-89020B UHL)
  };
  const uhl = `UHL1${dms(lo, true)}${dms(la, false)}${String(lonInt).padStart(4, '0')}${String(latInt).padStart(4, '0')}NA  U  ${sp('GISWB', 12)}${String(lonN).padStart(4, '0')}${String(latN).padStart(4, '0')}0${sp('', 24)}`;
  const dsi = new Array(648).fill(' ');
  const put = (o, s) => [...s].forEach((ch, i) => (dsi[o + i] = ch));
  put(0, 'DSIU');
  put(59, `DTED${level}`);
  put(87, '01A');
  put(126, 'PRF89020B');
  put(141, 'E96WGS84');
  put(185, `${String(Math.abs(la)).padStart(2, '0')}0000.0${la < 0 ? 'S' : 'N'}${String(Math.abs(lo)).padStart(3, '0')}0000.0${lo < 0 ? 'W' : 'E'}`);
  put(273, `${String(latInt).padStart(4, '0')}${String(lonInt).padStart(4, '0')}`);
  put(281, `${String(latN).padStart(4, '0')}${String(lonN).padStart(4, '0')}`);
  put(289, '00');
  const acc = new Array(2700).fill(' ');
  'ACCNA  NA  NA  NA  '.split('').forEach((ch, i) => (acc[i] = ch));
  const recLen = 8 + 2 * latN + 4;
  const out = new Uint8Array(3428 + recLen * lonN);
  const enc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0) & 0xff));
  out.set(enc(uhl), 0);
  out.set(enc(dsi.join('')), 80);
  out.set(enc(acc.join('')), 728);
  const dv = new DataView(out.buffer);
  const sample = sampler(g, H);
  for (let c = 0; c < lonN; c++) {
    const o = 3428 + c * recLen;
    out[o] = 0xaa;
    out[o + 1] = (c >> 16) & 0xff;
    out[o + 2] = (c >> 8) & 0xff;
    out[o + 3] = c & 0xff;
    dv.setUint16(o + 4, c, false);
    dv.setUint16(o + 6, 0, false);
    const lon = lo + (c * lonInt) / 36000;
    for (let p = 0; p < latN; p++) {
      const lat = la + (p * latInt) / 36000;
      let v = sample(lat, lon);
      if (Number.isFinite(v) && vertical === 'hae') v -= app.core.undulation(lat, lon);
      const m = Number.isFinite(v) ? Math.round(v) : -32767;
      dv.setUint16(o + 8 + 2 * p, m < 0 ? 0x8000 | -m : m, false);
    }
    let sum = 0;
    for (let k = o; k < o + recLen - 4; k++) sum = (sum + out[k]) >>> 0;
    dv.setUint32(o + recLen - 4, sum, false);
  }
  return out;
}
