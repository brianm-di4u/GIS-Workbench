// SENSRB (STDI-0002 Vol. 1 App. Z, General Electro-Optical Sensor Parameters) → a frame-camera
// model (REQ-GAP-23). The field layout follows GDAL's nitf_spec.xml; the appendix itself was not
// read, so the meanings used here are a reading of the field names [unverified]:
//  - module 2 (sensor array): detector counts, the array's physical size ROW/COLUMN_METRIC and the
//    FOCAL_LENGTH, in millimetres (LENGTH_UNIT SI) or inches (EE); or the fields of view;
//  - module 3 (calibration): principal-point offset from the array centre (CALIBRATION_UNIT mm or
//    px), Brown radial K1–K3 and decentring P1–P2 on image millimetres, affinity;
//  - module 6 (position): latitude, longitude, altitude (GEODETIC_TYPE G, ELEVATION_DATUM HAE/MSL)
//    or ECEF X, Y, Z (C);
//  - attitude: unit vectors (module 8: the image x and y axes and the line of sight, in NED or
//    ECEF), else a quaternion (module 9, the same axes as a rotation, q4 scalar), else Euler angles
//    (module 7: platform heading, pitch, roll and sensor azimuth, elevation, roll, the KLV order).
// Only modules 1–10 are read; point sets and time-stamped data are left alone.

import { gwError } from '../i18n/index.js';

const MODULES = [
  ['GENERAL_DATA', [['SENSOR', 25], ['SENSOR_URI', 32], ['PLATFORM', 25], ['PLATFORM_URI', 32], ['OPERATION_DOMAIN', 10], ['CONTENT_LEVEL', 1], ['GEODETIC_SYSTEM', 5], ['GEODETIC_TYPE', 1], ['ELEVATION_DATUM', 3], ['LENGTH_UNIT', 2], ['ANGULAR_UNIT', 3], ['START_DATE', 8], ['START_TIME', 14], ['END_DATE', 8], ['END_TIME', 14], ['GENERATION_COUNT', 2], ['GENERATION_DATE', 8], ['GENERATION_TIME', 10]]],
  ['SENSOR_ARRAY_DATA', [['DETECTION', 20], ['ROW_DETECTORS', 8], ['COLUMN_DETECTORS', 8], ['ROW_METRIC', 8], ['COLUMN_METRIC', 8], ['FOCAL_LENGTH', 8], ['ROW_FOV', 8], ['COLUMN_FOV', 8], ['CALIBRATED', 1]]],
  ['SENSOR_CALIBRATION_DATA', [['CALIBRATION_UNIT', 2], ['PRINCIPAL_POINT_OFFSET_X', 9], ['PRINCIPAL_POINT_OFFSET_Y', 9], ['RADIAL_DISTORT_1', 12], ['RADIAL_DISTORT_2', 12], ['RADIAL_DISTORT_3', 12], ['RADIAL_DISTORT_LIMIT', 9], ['DECENT_DISTORT_1', 12], ['DECENT_DISTORT_2', 12], ['AFFINITY_DISTORT_1', 12], ['AFFINITY_DISTORT_2', 12], ['CALIBRATION_DATE', 8]]],
  ['IMAGE_FORMATION_DATA', null],
  [null, [['REFERENCE_TIME', 12], ['REFERENCE_ROW', 8], ['REFERENCE_COLUMN', 8], ['LATITUDE_OR_X', 11], ['LONGITUDE_OR_Y', 12], ['ALTITUDE_OR_Z', 11], ['SENSOR_X_OFFSET', 8], ['SENSOR_Y_OFFSET', 8], ['SENSOR_Z_OFFSET', 8]]],
  ['ATTITUDE_EULER_ANGLES', [['SENSOR_ANGLE_MODEL', 1], ['SENSOR_ANGLE_1', 10], ['SENSOR_ANGLE_2', 9], ['SENSOR_ANGLE_3', 10], ['PLATFORM_RELATIVE', 1], ['PLATFORM_HEADING', 9], ['PLATFORM_PITCH', 9], ['PLATFORM_ROLL', 10]]],
  ['ATTITUDE_UNIT_VECTORS', [['ICX_NORTH_OR_X', 10], ['ICX_EAST_OR_Y', 10], ['ICX_DOWN_OR_Z', 10], ['ICY_NORTH_OR_X', 10], ['ICY_EAST_OR_Y', 10], ['ICY_DOWN_OR_Z', 10], ['ICZ_NORTH_OR_X', 10], ['ICZ_EAST_OR_Y', 10], ['ICZ_DOWN_OR_Z', 10]]],
  ['ATTITUDE_QUATERNION', [['ATTITUDE_Q1', 10], ['ATTITUDE_Q2', 10], ['ATTITUDE_Q3', 10], ['ATTITUDE_Q4', 10]]],
  ['SENSOR_VELOCITY_DATA', [['VELOCITY_NORTH_OR_X', 9], ['VELOCITY_EAST_OR_Y', 9], ['VELOCITY_DOWN_OR_Z', 9]]],
];
const FORMATION = [['METHOD', 15], ['MODE', 3], ['ROW_COUNT', 8], ['COLUMN_COUNT', 8], ['ROW_SET', 8], ['COLUMN_SET', 8], ['ROW_RATE', 10], ['COLUMN_RATE', 10], ['FIRST_PIXEL_ROW', 8], ['FIRST_PIXEL_COLUMN', 8], ['TRANSFORM_PARAMS', 1]];

/** SENSRB text → {FIELD: string} for modules 1–10 (flags as 'Y'/'N'). */
export function parseSensrb(text) {
  const f = {};
  let o = 0;
  const take = (n, name) => {
    if (o + n > text.length) throw gwError('SENSRB is shorter than its fields ({field})', { field: name }, 'E_SENSRB_SHORT');
    const v = text.slice(o, o + n);
    o += n;
    return v;
  };
  for (const [flag, fields] of MODULES) {
    if (flag) {
      f[flag] = take(1, flag);
      if (f[flag] !== 'Y') continue;
    }
    if (flag === 'IMAGE_FORMATION_DATA') {
      for (const [k, n] of FORMATION) f[k] = take(n, k);
      const np = Number(f.TRANSFORM_PARAMS);
      for (let i = 0; i < (Number.isInteger(np) ? np : 0); i++) take(12, 'TRANSFORM_PARAM');
      continue;
    }
    for (const [k, n] of fields) f[k] = take(n, k);
  }
  return f;
}

const n = (v) => {
  const t = String(v ?? '').trim();
  return t === '' ? NaN : Number(t);
};

/**
 * Camera, centre and orientation of a SENSRB (see the header). `size` is the image size
 * {width, height} from the subheader. Throws a gwError naming what is missing.
 */
export function sensrbFrame(f, size) {
  if (f.SENSOR_ARRAY_DATA !== 'Y') throw gwError('SENSRB has no sensor array data (focal length and detector size)', null, 'E_SENSRB_NO_ARRAY');
  const inch = String(f.LENGTH_UNIT ?? '').trim() === 'EE';
  const toMm = inch ? 25.4 : 1;
  const toM = inch ? 0.3048 : 1;
  const ang = String(f.ANGULAR_UNIT ?? 'DEG').trim().toUpperCase();
  const deg = (v) => (ang === 'RAD' ? (n(v) * 180) / Math.PI : ang === 'SMC' ? n(v) * 180 : n(v));
  const width = n(f.COLUMN_COUNT) || size?.width || n(f.COLUMN_DETECTORS);
  const height = n(f.ROW_COUNT) || size?.height || n(f.ROW_DETECTORS);
  const cols = n(f.COLUMN_DETECTORS) || width;
  let focal = n(f.FOCAL_LENGTH) * toMm;
  let pixel = (n(f.COLUMN_METRIC) * toMm) / cols;
  if (!(pixel > 0) && focal > 0 && n(f.COLUMN_FOV) > 0) pixel = (2 * focal * Math.tan((deg(f.COLUMN_FOV) * Math.PI) / 360)) / cols;
  if (!(focal > 0) && n(f.COLUMN_FOV) > 0) {
    pixel = 0.001;
    focal = (cols / 2 / Math.tan((deg(f.COLUMN_FOV) * Math.PI) / 360)) * pixel;
  }
  if (!(focal > 0 && pixel > 0)) throw gwError('SENSRB gives neither the focal length and array size nor the field of view', null, 'E_SENSRB_NO_ARRAY');
  const cam = { focalMm: focal, pixelMm: pixel, cx: cols / 2 - (n(f.FIRST_PIXEL_COLUMN) || 0), cy: (n(f.ROW_DETECTORS) || height) / 2 - (n(f.FIRST_PIXEL_ROW) || 0), k: [0, 0, 0], p: [0, 0], aff: [0, 0], width, height };
  if (f.SENSOR_CALIBRATION_DATA === 'Y') {
    const px = String(f.CALIBRATION_UNIT ?? '').trim().toLowerCase() === 'px';
    const off = (v) => (Number.isFinite(n(v)) ? (px ? n(v) : (n(v) * toMm) / pixel) : 0);
    // Offsets are in the image frame: x right, y up (the photogrammetric convention).
    cam.cx += off(f.PRINCIPAL_POINT_OFFSET_X);
    cam.cy -= off(f.PRINCIPAL_POINT_OFFSET_Y);
    const z = (v) => (Number.isFinite(n(v)) ? n(v) : 0);
    cam.k = [z(f.RADIAL_DISTORT_1), z(f.RADIAL_DISTORT_2), z(f.RADIAL_DISTORT_3)];
    cam.p = [z(f.DECENT_DISTORT_1), z(f.DECENT_DISTORT_2)];
    cam.aff = [z(f.AFFINITY_DISTORT_1), z(f.AFFINITY_DISTORT_2)];
  }
  const geocentric = String(f.GEODETIC_TYPE ?? 'G').trim() === 'C';
  const pos = [n(f.LATITUDE_OR_X), n(f.LONGITUDE_OR_Y), n(f.ALTITUDE_OR_Z)];
  if (!pos.every(Number.isFinite)) throw gwError('SENSRB has no sensor position', null, 'E_SENSRB_NO_POSITION');
  const position = geocentric ? { ecef: pos.map((v) => v * toM) } : { lat: deg(pos[0]), lon: deg(pos[1]), alt: pos[2] * toM, datum: String(f.ELEVATION_DATUM ?? 'HAE').trim().toUpperCase() || 'HAE' };
  let orientation = null;
  if (f.ATTITUDE_UNIT_VECTORS === 'Y') {
    const v = ['ICX', 'ICY', 'ICZ'].map((a) => ['NORTH_OR_X', 'EAST_OR_Y', 'DOWN_OR_Z'].map((b) => n(f[`${a}_${b}`])));
    if (v.flat().every(Number.isFinite)) orientation = { kind: 'axes', frame: geocentric ? 'ecef' : 'ned', icx: v[0], icy: v[1], icz: v[2], source: 'unit vectors' };
  }
  if (!orientation && f.ATTITUDE_QUATERNION === 'Y') {
    const q = [1, 2, 3, 4].map((i) => n(f[`ATTITUDE_Q${i}`]));
    if (q.every(Number.isFinite)) {
      const [x, y, zz, w] = q.map((c) => c / Math.hypot(...q));
      // Columns of the rotation = the image axes ICX, ICY, ICZ in the reference frame.
      const R = [[1 - 2 * (y * y + zz * zz), 2 * (x * y - zz * w), 2 * (x * zz + y * w)], [2 * (x * y + zz * w), 1 - 2 * (x * x + zz * zz), 2 * (y * zz - x * w)], [2 * (x * zz - y * w), 2 * (y * zz + x * w), 1 - 2 * (x * x + y * y)]];
      orientation = { kind: 'axes', frame: geocentric ? 'ecef' : 'ned', icx: R.map((r) => r[0]), icy: R.map((r) => r[1]), icz: R.map((r) => r[2]), source: 'quaternion' };
    }
  }
  if (!orientation && f.ATTITUDE_EULER_ANGLES === 'Y') {
    const rel = String(f.PLATFORM_RELATIVE ?? 'N').trim() === 'Y';
    const s = [deg(f.SENSOR_ANGLE_1), deg(f.SENSOR_ANGLE_2), deg(f.SENSOR_ANGLE_3)];
    const p = rel ? [deg(f.PLATFORM_HEADING), deg(f.PLATFORM_PITCH), deg(f.PLATFORM_ROLL)] : [0, 0, 0];
    if ([...s, ...p].every(Number.isFinite)) orientation = { kind: 'klv', platform: p, sensor: s, source: 'Euler angles' };
  }
  if (!orientation) throw gwError('SENSRB has no attitude (unit vectors, quaternion or Euler angles)', null, 'E_SENSRB_NO_ATTITUDE');
  return { camera: cam, position, orientation };
}
