// Aerial triangulation (REQ-GAP-22): the job record the photo bundle's solver takes
// (crates/gw-aero/src/aero.rs decode_job), the cameras of a block from its frame-model records
// (gw_sensor::frame::frame_from_params), the film camera and fiducials of a USGS calibration
// report, and the resection and fiducial jobs. Pure functions: no app state.

import { gwError } from '../i18n/index.js';
import { refitRadial } from '../sensor/camera.js';

/** Interior orientation parameters in the solver's order (symbols: not translated). */
export const IO_NAMES = ['f', 'x0', 'y0', 'k1', 'k2', 'k3', 'k4', 'p1', 'p2', 'b1', 'b2']; // i18n-ignore: parameter symbols
export const NIO = 11;
const ROBUST = { none: 0, huber: 1, cauchy: 2 };
const KIND = { tie: 0, gcp: 1, check: 2 };

/**
 * A camera's interior orientation from a frame-model record: [kind, f, pixel, cx, cy, k1, k2,
 * k3, p1, p2, a1, a2, width, height, (k4, projection when kind ≥ 8), lat, lon, hae, …].
 * Returns {projection, pixelMm, width, height, io[11]} with x0, y0 in mm from the format centre.
 */
export function cameraOfRecord(rec) {
  const ext = rec[0] >= 8;
  const [f, pix, cx, cy, k1, k2, k3, p1, p2, a1, a2, w, h] = rec.slice(1, 14);
  const k4 = ext ? rec[14] : 0;
  const projection = ext && rec[15] === 1 ? 'fisheye' : 'brown';
  return { projection, pixelMm: pix, width: w, height: h, io: [f, (cx - w / 2) * pix, -(cy - h / 2) * pix, k1, k2, k3, k4, p1, p2, a1, a2] };
}

/** A key that groups images taken with one camera (same record camera values, same film camera). */
export function cameraKey(cam, extra = '') {
  const r = (v) => (Number.isFinite(v) ? Number(v.toPrecision(9)) : v);
  return JSON.stringify([cam.projection, cam.film ? 1 : 0, r(cam.pixelMm), cam.width, cam.height, ...cam.io.map(r), extra]);
}

/**
 * The film camera and fiducials of a USGS calibration report (text): calibrated focal length,
 * the principal point of best symmetry (else of autocollimation), radial K0–K4 (Δr = K0·r +
 * K1·r³ + …, refitted to the solver's k1–k3 with the focal length scaled for K0), decentring
 * P1, P2, and the fiducial table ("Fiducial Marks" rows: id, x mm, y mm).
 */
export function parseFilmReport(text) {
  const t = String(text).replace(/\r/g, '');
  const f = Number(/calibrated\s+focal\s+length[^0-9-]*([-0-9.]+)/i.exec(t)?.[1]);
  if (!(f > 0)) throw gwError('USGS report: no calibrated focal length', null, 'E_CAMERA_FILE');
  const pp = /(?:PPBS|point of (?:best )?symmetry)[^\n]*?([-0-9.]+)\s*(?:mm)?\s+([-0-9.]+)/i.exec(t) ?? /(?:PPA|autocollimation)[^\n]*?([-0-9.]+)\s*(?:mm)?\s+([-0-9.]+)/i.exec(t);
  const K = [0, 0, 0, 0, 0];
  for (const m of t.matchAll(/\bK\s*([0-4])\s*[=:]\s*([-+0-9.]+(?:[eE][-+]?\d+)?)/g)) K[Number(m[1])] = Number(m[2]);
  const P = [0, 0];
  for (const m of t.matchAll(/\bP\s*([12])\s*[=:]\s*([-+0-9.]+(?:[eE][-+]?\d+)?)/g)) P[Number(m[1]) - 1] = Number(m[2]);
  const fit = K.some((v) => v !== 0) ? refitRadial((r) => K[0] * r + K[1] * r ** 3 + K[2] * r ** 5 + K[3] * r ** 7 + K[4] * r ** 9, 150) : { scale: 1, k: [0, 0, 0] };
  const fiducials = [];
  const at = t.search(/fiducial\s+marks/i);
  if (at >= 0) {
    for (const line of t.slice(at).split('\n').slice(1)) {
      const m = /^\s*(\d{1,2})\s+([-+]?\d+\.\d+)\s+([-+]?\d+\.\d+)\s*$/.exec(line);
      if (m) fiducials.push({ id: m[1], x: Number(m[2]), y: Number(m[3]) });
      else if (fiducials.length && line.trim()) break;
    }
  }
  return { focalMm: f * fit.scale, x0: pp ? Number(pp[1]) : 0, y0: pp ? Number(pp[2]) : 0, k: fit.k, p: P, fiducials, source: 'USGS report' };
}

const need = (ok, msg, args, code) => {
  if (!ok) throw gwError(msg, args, code);
};

/** One camera record of the job (gw_aero::aero::decode_camera). */
function cameraRecord(c) {
  const io = c.io.slice(0, NIO);
  need(io.length === NIO && io.every(Number.isFinite) && io[0] > 0, 'aerial triangulation: a camera needs its focal length and eleven interior orientation values', null, 'E_AERO_CAMERA');
  const free = Array.from({ length: NIO }, (_, q) => (c.free?.[q] ? 1 : 0));
  const sig = Array.from({ length: NIO }, (_, q) => c.sigma?.[q] ?? 0);
  const mount = [...(c.lever ?? [0, 0, 0]), ...(c.boresight ?? [0, 0, 0])];
  const mfree = Array.from({ length: 6 }, (_, q) => (c.mountFree?.[q] ? 1 : 0));
  const msig = Array.from({ length: 6 }, (_, q) => c.mountSigma?.[q] ?? 0);
  return [c.projection === 'fisheye' ? 1 : 0, c.film ? 1 : 0, c.film ? 0 : c.pixelMm, c.film ? 0 : c.width, c.film ? 0 : c.height, ...io, ...free, ...sig, ...mount, ...mfree, ...msig];
}

/**
 * The solver job. input = {cameras: [{projection, film, pixelMm, width, height, io, free, sigma,
 * lever, boresight (°), mountFree, mountSigma (m, °)}], images: [{camera, fixed, attitudeKnown,
 * gnss: [σE, σN, σU] | null, imu: [σ° × 3] | null, film: affine[6] | null, record | null}], points:
 * [{kind, known: {lat, lon, hae} | null, sigmaH, sigmaV}], obs: [{image, point, x, y, sigma}],
 * options: {maxIterations, robust, robustK, rejectK, maxReject, corrFlag}}.
 */
export function aeroJob({ cameras, images, points, obs, options = {} }) {
  need(cameras.length > 0 && cameras.length <= 64, 'aerial triangulation: 1 to 64 cameras', null, 'E_AERO_COUNTS');
  need(images.length > 0 && images.length <= 5000, 'aerial triangulation: 1 to 5000 images', null, 'E_AERO_COUNTS');
  const o = options;
  const job = [31, 1, cameras.length, images.length, points.length, obs.length, o.maxIterations ?? 60, ROBUST[o.robust ?? 'none'] ?? 0, o.robustK ?? 0, o.rejectK ?? 4, o.maxReject ?? 0, o.corrFlag ?? 0.9];
  for (const c of cameras) job.push(...cameraRecord(c));
  for (const im of images) {
    const rec = im.record ?? [];
    const g = im.gnss;
    const u = im.imu;
    const a = im.film;
    job.push(im.camera, im.fixed ? 1 : 0, im.attitudeKnown === false ? 0 : 1, g ? 1 : 0, g?.[0] ?? 0, g?.[1] ?? 0, g?.[2] ?? 0, u ? 1 : 0, u?.[0] ?? 0, u?.[1] ?? 0, u?.[2] ?? 0, a ? 1 : 0, ...(a ?? [0, 0, 0, 0, 0, 0]), rec.length, ...rec);
  }
  for (const p of points) job.push(KIND[p.kind] ?? 0, p.known?.lat ?? NaN, p.known?.lon ?? NaN, p.known?.hae ?? NaN, p.sigmaH || 0.5, p.sigmaV || 1);
  for (const m of obs) job.push(m.image, m.point, m.x, m.y, m.sigma ?? 0.5);
  return Float64Array.from(job);
}

/** The resection job (gw_aero::aero::resect_job): one camera, the film affine, the points. */
export function resectJob(camera, { film = null, robust = false, record = null, points }) {
  const rec = record ?? [];
  const job = [...cameraRecord(camera), film ? 1 : 0, ...(film ?? [0, 0, 0, 0, 0, 0]), robust ? 1 : 0, points.length, rec.length, ...rec];
  for (const p of points) job.push(p.lat, p.lon, p.hae, p.x, p.y, p.sigma ?? 0.5);
  return Float64Array.from(job);
}

/** The fiducial job: model 'affine' | 'similarity', [{col, row, x, y}]. */
export function fiducialJob(model, marks) {
  return Float64Array.from([model === 'similarity' ? 0 : 1, marks.length, ...marks.flatMap((m) => [m.col, m.row, m.x, m.y])]);
}

/** RMS of an array of numbers (NaN when empty). */
const rms = (v) => (v.length ? Math.sqrt(v.reduce((s, x) => s + x * x, 0) / v.length) : NaN);

/**
 * Numbers a report view and the tests share: residual RMS per axis (px) of the used
 * measurements, GNSS residual RMS (E, N, U m), IMU residual RMS (°), counts.
 */
export function summarize(rep) {
  const used = rep.residuals.filter((r) => r[4]);
  const g = rep.images.map((i) => i.gnss).filter(Boolean);
  const u = rep.images.map((i) => i.imu).filter(Boolean);
  return {
    residualRms: [rms(used.map((r) => r[0])), rms(used.map((r) => r[1]))],
    measurements: used.length,
    rejected: rep.rejected.length,
    gnssRms: g.length ? [0, 1, 2].map((k) => rms(g.map((v) => v[k]))) : null,
    imuRms: u.length ? [0, 1, 2].map((k) => rms(u.map((v) => v[k]))) : null,
    points: rep.points.filter(Boolean).length,
  };
}
