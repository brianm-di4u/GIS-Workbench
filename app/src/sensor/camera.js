// Camera calibrations and frame-model parameters (REQ-GAP-23). The core's frame camera
// (crates/gw-sensor/src/frame.rs) works in image millimetres with y up: x_d = x·(1 + k₁r² + k₂r⁴ +
// k₃r⁶) + p₁(r² + 2x²) + 2p₂xy, y_d likewise, column = cx + (x_d(1 + a₁) − y_d·a₂)/pixel, row =
// cy − y_d/pixel (corner-origin pixels). The readers convert each file's own convention to that:
//
//  - Agisoft Metashape camera calibration XML (<calibration>: f, cx, cy offsets from the image
//    centre, b1, b2, k1–k4, p1, p2 in pixels and normalised coordinates, y down): k_mm = K/f²…,
//    p = (P1/f, −P2/f), a = (b1/f, b2/f). K4 is not modelled and is reported when non-zero.
//  - OpenCV-style calibrations (fx, fy, cx, cy, k1, k2, p1, p2, k3, y down; DJI DewarpData, the
//    BAMBI calib.json): p = (p₂/f, −p₁/f), a₁ = fx/fy − 1; OpenCV JSON's cx, cy are pixel-centre
//    based (+ 0.5); DJI's DewarpData gives offsets from the image centre.
//  - Pix4D (.cam text and XML with the same keys: F, Px, Py, K1–K3 [R1–R3], T1, T2 in mm and
//    normalised coordinates) [unverified: no Pix4D sample; principal point read from the top-left
//    corner, y down, T as OpenCV p].
//  - The USGS camera calibration report (text): calibrated focal length, principal point (PPA or
//    PPBS, mm, y up), radial K0–K4 of Δr = K0·r + K1·r³ + … on distorted radii (or a radius /
//    distortion table) refitted to the core's form, decentring P1, P2, pixel size and array size.
//  - PAT-B camera record [unverified: no sample]: camera number, focal length, principal point
//    x₀ y₀ (mm), then optional radius (mm) / distortion (µm) pairs, ending with −99.

import { gwError } from '../i18n/index.js';

export const DEFAULT_CAMERA = { focalMm: 100, pixelMm: 0.0046, cx: null, cy: null, k: [0, 0, 0], p: [0, 0], aff: [0, 0] };

const num = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? NaN : Number(t);
};

/** Least squares for a small dense system (normal equations, Gaussian elimination). */
function lsq(rows, n) {
  const a = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  for (const [x, y] of rows) for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) a[i][j] += x[i] * x[j];
    a[i][n] += x[i] * y;
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    [a[c], a[p]] = [a[p], a[c]];
    if (Math.abs(a[c][c]) < 1e-300) throw gwError('camera calibration: the distortion fit is singular', null, 'E_CAMERA_FIT');
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= n; k++) a[r][k] -= f * a[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let c = n - 1; c >= 0; c--) {
    let s = a[c][n];
    for (let k = c + 1; k < n; k++) s -= a[c][k] * x[k];
    x[c] = s / a[c][c];
  }
  return x;
}

/**
 * Radial distortion given as a function of the distorted radius, ideal = distorted·(1 − d(r_d)/r_d),
 * refitted to the core's distorted = ideal·s·(1 + k₁r² + k₂r⁴ + k₃r⁶): returns {scale s, k}. The focal
 * length is multiplied by s (a K0 term).
 */
export function refitRadial(distortion, rmax) {
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    const rd = (rmax * i) / 60;
    const ri = rd - distortion(rd);
    if (!(ri > 0)) continue;
    rows.push([[1, ri * ri, ri ** 4, ri ** 6], rd / ri]);
  }
  const [a0, a1, a2, a3] = lsq(rows, 4);
  return { scale: a0, k: [a1 / a0 ** 3, a2 / a0 ** 5, a3 / a0 ** 7] };
}

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(xml);
  return m ? num(m[1]) : NaN;
};
const attr = (xml, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(xml);
  return m ? num(m[1]) : NaN;
};
const z = (v) => (Number.isFinite(v) ? v : 0);

/** Agisoft Metashape <calibration> XML. */
export function parseAgisoft(xml) {
  const W = tag(xml, 'width');
  const H = tag(xml, 'height');
  const f = tag(xml, 'f');
  if (!(W > 0 && H > 0 && f > 0)) throw gwError('Agisoft calibration: needs width, height and f', null, 'E_CAMERA_FILE');
  const pixel = 0.001; // a virtual 1 µm pixel: only f/pixel matters
  const fmm = f * pixel;
  const notes = [];
  if (z(tag(xml, 'k4')) !== 0) notes.push('k4 is not modelled');
  return {
    focalMm: fmm,
    pixelMm: pixel,
    cx: W / 2 + z(tag(xml, 'cx')),
    cy: H / 2 + z(tag(xml, 'cy')),
    k: [z(tag(xml, 'k1')) / fmm ** 2, z(tag(xml, 'k2')) / fmm ** 4, z(tag(xml, 'k3')) / fmm ** 6],
    p: [z(tag(xml, 'p1')) / fmm, -z(tag(xml, 'p2')) / fmm],
    aff: [z(tag(xml, 'b1')) / f, z(tag(xml, 'b2')) / f],
    width: W,
    height: H,
    source: 'Agisoft',
    notes,
  };
}

/** OpenCV-style intrinsics in pixels (y down): {fx, fy, cx, cy, k1, k2, p1, p2, k3, width, height}. */
export function fromOpenCv(c, source = 'OpenCV') {
  const f = c.fx;
  if (!(f > 0 && c.width > 0 && c.height > 0)) throw gwError('camera calibration: needs the focal length in pixels and the image size', null, 'E_CAMERA_FILE');
  const pixel = 0.001;
  const notes = [];
  // A different fy is an affinity: the core scales x (a₁) instead, so fy becomes the focal length.
  const fy = c.fy > 0 ? c.fy : f;
  return { focalMm: fy * pixel, pixelMm: pixel, cx: c.cx, cy: c.cy, k: [z(c.k1) / (fy * pixel) ** 2, z(c.k2) / (fy * pixel) ** 4, z(c.k3) / (fy * pixel) ** 6], p: [z(c.p2) / (fy * pixel), -z(c.p1) / (fy * pixel)], aff: [f / fy - 1, 0], width: c.width, height: c.height, source, notes };
}

/** Pix4D internal parameters (.cam text or XML with F, Px, Py, K1–K3, T1, T2 in mm). */
export function parsePix4d(text, { width, height } = {}) {
  const key = (names) => {
    for (const n of names) {
      const t = tag(text, n);
      if (Number.isFinite(t)) return t;
      const a = attr(text, n);
      if (Number.isFinite(a)) return a;
      const m = new RegExp(`^\\s*${n}\\s+([-+0-9.eE]+)\\s*$`, 'mi').exec(text);
      if (m) return num(m[1]);
    }
    return NaN;
  };
  const f = key(['F', 'focalLength', 'focal_length', 'focal']);
  const sw = key(['sensorWidth', 'sensor_width', 'SensorWidth']) || num(/sensor width of\s*([0-9.]+)/i.exec(text)?.[1]);
  const W = key(['imageWidth', 'image_width', 'width']) || width;
  const H = key(['imageHeight', 'image_height', 'height']) || height;
  if (!(f > 0 && sw > 0 && W > 0 && H > 0)) throw gwError('Pix4D calibration: needs the focal length (mm), the sensor width (mm) and the image size', null, 'E_CAMERA_FILE');
  const pixel = sw / W;
  const px = key(['Px', 'principalPointX', 'ppx', 'cx']);
  const py = key(['Py', 'principalPointY', 'ppy', 'cy']);
  const K = [key(['K1', 'R1']), key(['K2', 'R2']), key(['K3', 'R3'])].map(z);
  const T = [key(['T1']), key(['T2'])].map(z);
  return { focalMm: f, pixelMm: pixel, cx: Number.isFinite(px) ? px / pixel : W / 2, cy: Number.isFinite(py) ? py / pixel : H / 2, k: [K[0] / f ** 2, K[1] / f ** 4, K[2] / f ** 6], p: [T[1] / f, -T[0] / f], aff: [0, 0], width: W, height: H, source: 'Pix4D', notes: [] };
}

/** USGS camera calibration report (text). `size` {width, height} when the report does not give it. */
export function parseUsgsReport(text, size = {}) {
  const t = text.replace(/\r/g, '');
  const f = num(/calibrated\s+focal\s+length[^0-9-]*([-0-9.]+)/i.exec(t)?.[1]);
  if (!(f > 0)) throw gwError('USGS report: no calibrated focal length', null, 'E_CAMERA_FILE');
  // The principal point of best symmetry (PPBS) when given, else of autocollimation (PPA).
  const pp = /(?:PPBS|point of (?:best )?symmetry)[^\n]*?x[^\n0-9-]*([-0-9.]+)[^\n]*?y[^\n0-9-]*([-0-9.]+)/i.exec(t) ?? /(?:PPA|autocollimation)[^\n]*?x[^\n0-9-]*([-0-9.]+)[^\n]*?y[^\n0-9-]*([-0-9.]+)/i.exec(t);
  const pixUm = num(/pixel\s+size[^0-9]*([0-9.]+)\s*(?:µm|um|micro)/i.exec(t)?.[1]);
  const pixMm = num(/pixel\s+size[^0-9]*([0-9.]+)\s*mm/i.exec(t)?.[1]);
  const arr = /(\d{3,6})\s*(?:x|×|by)\s*(\d{3,6})\s*(?:pixels|pixel|px)/i.exec(t);
  const W = arr ? num(arr[1]) : size.width;
  const H = arr ? num(arr[2]) : size.height;
  const pixel = pixUm > 0 ? pixUm / 1000 : pixMm > 0 ? pixMm : size.pixelMm;
  if (!(pixel > 0 && W > 0 && H > 0)) throw gwError('USGS report: needs the pixel size and the array size (in the report or as options)', null, 'E_CAMERA_FILE');
  const K = [0, 0, 0, 0, 0];
  for (const m of t.matchAll(/\bK\s*([0-4])\s*[=:]\s*([-+0-9.]+(?:[eE][-+]?\d+)?)/g)) K[Number(m[1])] = num(m[2]);
  const P = [0, 0];
  for (const m of t.matchAll(/\bP\s*([12])\s*[=:]\s*([-+0-9.]+(?:[eE][-+]?\d+)?)/g)) P[Number(m[1]) - 1] = num(m[2]);
  const rmax = 0.5 * Math.hypot(W, H) * pixel;
  let radial = null;
  if (K.some((v) => v !== 0)) radial = (r) => K[0] * r + K[1] * r ** 3 + K[2] * r ** 5 + K[3] * r ** 7 + K[4] * r ** 9;
  else {
    // A table of radius (mm) and distortion (µm): fit Δr = K0 r + K1 r³ + K2 r⁵ + K3 r⁷.
    const tab = [...t.matchAll(/^\s*([0-9]+(?:\.[0-9]+)?)\s+([-+]?[0-9]+(?:\.[0-9]+)?)\s*$/gm)].map((m) => [num(m[1]), num(m[2]) / 1000]).filter(([r]) => r > 0 && r <= rmax * 1.2);
    if (tab.length >= 4) {
      const c = lsq(tab.map(([r, d]) => [[r, r ** 3, r ** 5, r ** 7], d]), 4);
      radial = (r) => c[0] * r + c[1] * r ** 3 + c[2] * r ** 5 + c[3] * r ** 7;
    }
  }
  const fit = radial ? refitRadial(radial, rmax) : { scale: 1, k: [0, 0, 0] };
  const x0 = pp ? num(pp[1]) : 0;
  const y0 = pp ? num(pp[2]) : 0;
  return { focalMm: f * fit.scale, pixelMm: pixel, cx: W / 2 + x0 / pixel, cy: H / 2 - y0 / pixel, k: fit.k, p: P, aff: [0, 0], width: W, height: H, source: 'USGS report', notes: [] };
}

/** PAT-B camera record (see the header). */
export function parsePatb(text, size = {}) {
  const nums = text.replace(/\r/g, '').split(/\s+/).filter(Boolean).map(Number);
  if (nums.length < 4 || nums.slice(0, 4).some((v) => !Number.isFinite(v))) throw gwError('PAT-B camera: needs the camera number, focal length and principal point', null, 'E_CAMERA_FILE');
  const [, f, x0, y0] = nums;
  const tab = [];
  for (let i = 4; i + 1 < nums.length && nums[i] !== -99; i += 2) tab.push([nums[i], nums[i + 1] / 1000]);
  const pixel = size.pixelMm;
  const W = size.width;
  const H = size.height;
  if (!(f > 0 && pixel > 0 && W > 0 && H > 0)) throw gwError('PAT-B camera: needs the pixel size and image size as options', null, 'E_CAMERA_FILE');
  let fit = { scale: 1, k: [0, 0, 0] };
  if (tab.length >= 4) {
    const c = lsq(tab.map(([r, d]) => [[r, r ** 3, r ** 5, r ** 7], d]), 4);
    fit = refitRadial((r) => c[0] * r + c[1] * r ** 3 + c[2] * r ** 5 + c[3] * r ** 7, 0.5 * Math.hypot(W, H) * pixel);
  }
  return { focalMm: f * fit.scale, pixelMm: pixel, cx: W / 2 + x0 / pixel, cy: H / 2 - y0 / pixel, k: fit.k, p: [0, 0], aff: [0, 0], width: W, height: H, source: 'PAT-B', notes: [] };
}

/** Recognise and read a camera calibration file by content (and name). */
export function parseCameraFile(text, name = '', size = {}) {
  const s = String(text);
  if (/<calibration[\s>]/i.test(s) && /<f>/i.test(s)) return parseAgisoft(s);
  if (/pix4d/i.test(s) || /\.cam$/i.test(name) || /^\s*F\s+[0-9.]+\s*$/m.test(s)) return parsePix4d(s, size);
  if (/calibrated\s+focal\s+length/i.test(s)) return parseUsgsReport(s, size);
  if (/"mtx"\s*:/.test(s)) {
    // OpenCV JSON (as the BAMBI flights' *_calib.json): {"mtx": 3 × 3, "dist": [k1, k2, p1, p2, k3]}.
    // OpenCV puts pixel centres on integers: + 0.5 to the corner origin.
    const j = JSON.parse(s);
    const [k1, k2, p1, p2, k3] = j.dist.flat();
    return fromOpenCv({ fx: j.mtx[0][0], fy: j.mtx[1][1], cx: j.mtx[0][2] + 0.5, cy: j.mtx[1][2] + 0.5, k1, k2, p1, p2, k3, width: size.width, height: size.height }, 'OpenCV JSON');
  }
  if (/\.(patb|cam|txt|dat)$/i.test(name) && /^\s*\d+\s+[0-9.]+\s+[-0-9.]+\s+[-0-9.]+/.test(s)) return parsePatb(s, size);
  throw gwError('{file} is not a camera calibration this build reads (USGS report, Agisoft or Pix4D XML, PAT-B, OpenCV JSON)', { file: name || 'the file' }, 'E_CAMERA_FILE');
}

const ORIENT = { opk: 0, gimbal: 1, enu: 2, ecef: 3, klv: 4 };

/** NED vector → ENU. */
const enuOf = ([n, e, d]) => [e, n, -d];

/**
 * The core's frame parameters (gw_sensor::frame::frame_from_params) from a camera, a perspective
 * centre {lat, lon, hae} and an orientation: {kind: 'opk', omega, phi, kappa} | {kind: 'gimbal',
 * yaw, pitch, roll} | {kind: 'axes', frame: 'ned' | 'ecef', icx, icy, icz} (image x and y axes and
 * the line of sight) | {kind: 'klv', platform: [h, p, r], sensor: [az, el, roll]}; `cov` 7 × 7.
 */
export function frameParams(camera, centre, o, cov = null) {
  const c = { ...DEFAULT_CAMERA, ...camera };
  const head = [c.focalMm, c.pixelMm, c.cx ?? c.width / 2, c.cy ?? c.height / 2, ...(c.k ?? [0, 0, 0]), ...(c.p ?? [0, 0]), ...(c.aff ?? [0, 0]), c.width, c.height, centre.lat, centre.lon, centre.hae];
  let kind;
  let v;
  if (o.kind === 'opk') [kind, v] = [ORIENT.opk, [o.omega ?? 0, o.phi ?? 0, o.kappa ?? 0]];
  else if (o.kind === 'gimbal') [kind, v] = [ORIENT.gimbal, [o.yaw ?? 0, o.pitch ?? -90, o.roll ?? 0]];
  else if (o.kind === 'klv') [kind, v] = [ORIENT.klv, [...o.platform, ...o.sensor]];
  else if (o.kind === 'axes') {
    // Camera x = image x (columns), y = −image y (rows grow down), z = −line of sight.
    const f = o.frame === 'ecef' ? (a) => a : enuOf;
    const [x, y, zz] = [f(o.icx), f(o.icy).map((q) => -q), f(o.icz).map((q) => -q)];
    [kind, v] = [o.frame === 'ecef' ? ORIENT.ecef : ORIENT.enu, [...x, ...y, ...zz]];
  } else throw gwError('frame: unknown orientation {kind}', { kind: String(o.kind) }, 'E_FRAME_ORIENT');
  return [kind, ...head, ...v, ...(cov ? [1, ...cov] : [0])];
}
