// Drone and camera metadata in JPEG files (REQ-GAP-23): EXIF (TIFF IFD0, the Exif and GPS IFDs)
// and XMP (DJI drone-dji:, senseFly/Pix4D Camera:, sensefly:), read from the first bytes of the
// file with bounds checks on every offset. XMP is matched by key, never parsed as a DOM.
//
// From them, a frame camera: the GPS position (EXIF altitude is above sea level by the EXIF
// standard; DJI AbsoluteAltitude likewise), the attitude (DJI gimbal yaw, pitch, roll in the local
// north-east-down frame, pitch −90° = nadir; else the senseFly/Pix4D Camera:Yaw/Pitch/Roll, read as
// heading and tilts from nadir [unverified]; else the DJI flight yaw with a nadir camera), and the
// camera (DJI calibrated focal length and optical centre or DewarpData, else the EXIF focal length
// with the focal-plane resolution or the 35 mm equivalent).

import { gwError, N_ } from '../i18n/index.js';
import { fromOpenCv } from './camera.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };

/** Read an IFD's entries: {tag: value} (numbers, arrays of numbers or strings). */
function readIfd(dv, tiff, off, le, out = {}, depth = 0) {
  if (depth > 4 || off < 0 || tiff + off + 2 > dv.byteLength) return out;
  const n = dv.getUint16(tiff + off, le);
  if (n > 512) return out;
  for (let i = 0; i < n; i++) {
    const e = tiff + off + 2 + 12 * i;
    if (e + 12 > dv.byteLength) break;
    const tag = dv.getUint16(e, le);
    const type = dv.getUint16(e + 2, le);
    const count = dv.getUint32(e + 4, le);
    const size = (TYPE_SIZE[type] ?? 0) * count;
    if (!size || count > 65536) continue;
    const at = size <= 4 ? e + 8 : tiff + dv.getUint32(e + 8, le);
    if (at < 0 || at + size > dv.byteLength) continue;
    let v;
    if (type === 2) {
      v = '';
      for (let k = 0; k < count; k++) {
        const c = dv.getUint8(at + k);
        if (!c) break;
        v += String.fromCharCode(c);
      }
      v = v.trim();
    } else {
      const vals = [];
      for (let k = 0; k < count; k++) {
        const p = at + k * TYPE_SIZE[type];
        if (type === 1 || type === 7) vals.push(dv.getUint8(p));
        else if (type === 3) vals.push(dv.getUint16(p, le));
        else if (type === 4) vals.push(dv.getUint32(p, le));
        else if (type === 9) vals.push(dv.getInt32(p, le));
        else if (type === 5) vals.push(dv.getUint32(p + 4, le) ? dv.getUint32(p, le) / dv.getUint32(p + 4, le) : NaN);
        else if (type === 10) vals.push(dv.getInt32(p + 4, le) ? dv.getInt32(p, le) / dv.getInt32(p + 4, le) : NaN);
        else if (type === 11) vals.push(dv.getFloat32(p, le));
        else if (type === 12) vals.push(dv.getFloat64(p, le));
      }
      v = count === 1 ? vals[0] : vals;
    }
    out[tag] = v;
  }
  return out;
}

/** The TIFF structure inside an Exif APP1: {ifd0, exif, gps}. */
export function parseTiffExif(u8, start = 0) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (start + 8 > dv.byteLength) return null;
  const bo = dv.getUint16(start);
  const le = bo === 0x4949;
  if (!le && bo !== 0x4d4d) return null;
  if (dv.getUint16(start + 2, le) !== 42) return null;
  const ifd0 = readIfd(dv, start, dv.getUint32(start + 4, le), le);
  const exif = typeof ifd0[0x8769] === 'number' ? readIfd(dv, start, ifd0[0x8769], le) : {};
  const gps = typeof ifd0[0x8825] === 'number' ? readIfd(dv, start, ifd0[0x8825], le) : {};
  return { ifd0, exif, gps };
}

const XMP_KEYS = ['GimbalYawDegree', 'GimbalPitchDegree', 'GimbalRollDegree', 'FlightYawDegree', 'FlightPitchDegree', 'FlightRollDegree', 'AbsoluteAltitude', 'RelativeAltitude', 'GpsLatitude', 'GpsLongitude', 'GpsLongtitude', 'CalibratedFocalLength', 'CalibratedOpticalCenterX', 'CalibratedOpticalCenterY', 'DewarpData', 'DewarpFlag', 'RtkFlag', 'RtkStdLon', 'RtkStdLat', 'RtkStdHgt', 'Yaw', 'Pitch', 'Roll', 'GPSXYAccuracy', 'GPSZAccuracy', 'Heading', 'PitchAngle', 'RollAngle', 'AltitudeWGS84', 'AltitudeAMSL', 'Latitude', 'Longitude'];
const XMP_NS = ['drone-dji', 'Camera', 'sensefly'];

/** XMP key–value pairs (attributes or simple elements) for the namespaces drones use. */
export function parseXmp(text) {
  const out = {};
  for (const ns of XMP_NS) {
    for (const k of XMP_KEYS) {
      const q = `${ns}:${k}`;
      const m = new RegExp(`${q}\\s*=\\s*"([^"]*)"`).exec(text) ?? new RegExp(`${q}\\s*=\\s*'([^']*)'`).exec(text) ?? new RegExp(`<${q}>([^<]*)</${q}>`).exec(text);
      if (m) out[q] = m[1].trim();
    }
  }
  return out;
}

/** EXIF + XMP of a JPEG's first bytes: {make, model, width, height, gps, focalMm, f35, fpRes, xmp, time}. */
export function readJpegMeta(u8) {
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) return null;
  const meta = { make: '', model: '', width: NaN, height: NaN, gps: null, focalMm: NaN, f35: NaN, fpRes: null, xmp: {}, time: '' };
  let o = 2;
  let found = false;
  while (o + 4 <= u8.length) {
    if (u8[o] !== 0xff) break;
    const m = u8[o + 1];
    if (m === 0xd9 || m === 0xda) break;
    const len = (u8[o + 2] << 8) | u8[o + 3];
    const seg = u8.subarray(o + 4, Math.min(u8.length, o + 2 + len));
    if (m === 0xe1 && seg.length > 6 && String.fromCharCode(...seg.subarray(0, 4)) === 'Exif') {
      const t = parseTiffExif(seg, 6);
      if (t) {
        found = true;
        const { ifd0, exif, gps } = t;
        meta.make = String(ifd0[0x010f] ?? '');
        meta.model = String(ifd0[0x0110] ?? '');
        meta.width = Number(exif[0xa002] ?? ifd0[0x0100]);
        meta.height = Number(exif[0xa003] ?? ifd0[0x0101]);
        meta.focalMm = Number(exif[0x920a]);
        meta.f35 = Number(exif[0xa405]);
        const unit = { 2: 25.4, 3: 10, 4: 1, 5: 0.001 }[exif[0xa210] ?? 2];
        if (exif[0xa20e] > 0 && unit) meta.fpRes = { x: exif[0xa20e] / unit, y: (exif[0xa20f] || exif[0xa20e]) / unit }; // pixels per mm
        meta.time = String(exif[0x9003] ?? ifd0[0x0132] ?? '');
        const dms = (v) => (Array.isArray(v) && v.length === 3 ? v[0] + v[1] / 60 + v[2] / 3600 : Number(v));
        if (gps[0x0002] !== undefined && gps[0x0004] !== undefined) {
          const lat = dms(gps[0x0002]) * (String(gps[0x0001]).toUpperCase() === 'S' ? -1 : 1);
          const lon = dms(gps[0x0004]) * (String(gps[0x0003]).toUpperCase() === 'W' ? -1 : 1);
          const alt = gps[0x0006] !== undefined ? Number(gps[0x0006]) * (Number(gps[0x0005]) === 1 ? -1 : 1) : NaN;
          if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) meta.gps = { lat, lon, alt, datum: String(gps[0x0012] ?? '') };
        }
      }
    }
    if (m === 0xe1 && seg.length > 29 && String.fromCharCode(...seg.subarray(0, 28)) === 'http://ns.adobe.com/xap/1.0/') {
      found = true;
      meta.xmp = { ...meta.xmp, ...parseXmp(new TextDecoder('utf-8').decode(seg.subarray(29))) };
    }
    o += 2 + len;
  }
  return found ? meta : null;
}

const xn = (x, k) => {
  const v = x[k];
  return v === undefined || v === '' ? NaN : Number(String(v).replace(/^\+/, ''));
};

/**
 * Camera, position (above sea level unless `hae`) and orientation of a drone image from its
 * metadata, or a reason why not. `camera` (a calibration file's) overrides the image's own.
 */
export function droneFrame(meta, camera = null) {
  if (!meta?.gps) throw gwError('no GPS position in the EXIF', null, 'E_EXIF_NO_GPS');
  const x = meta.xmp ?? {};
  const W = meta.width;
  const H = meta.height;
  const notes = [];
  // Position: DJI XMP latitude/longitude and absolute altitude when present (more digits than EXIF).
  const lat = Number.isFinite(xn(x, 'drone-dji:GpsLatitude')) ? xn(x, 'drone-dji:GpsLatitude') : meta.gps.lat;
  const lonX = Number.isFinite(xn(x, 'drone-dji:GpsLongitude')) ? xn(x, 'drone-dji:GpsLongitude') : xn(x, 'drone-dji:GpsLongtitude');
  const lon = Number.isFinite(lonX) ? lonX : meta.gps.lon;
  let alt = Number.isFinite(xn(x, 'drone-dji:AbsoluteAltitude')) ? xn(x, 'drone-dji:AbsoluteAltitude') : meta.gps.alt;
  let datum = 'MSL';
  if (Number.isFinite(xn(x, 'sensefly:AltitudeWGS84'))) {
    alt = xn(x, 'sensefly:AltitudeWGS84');
    datum = 'HAE';
  }
  if (!Number.isFinite(alt)) throw gwError('no GPS altitude in the EXIF or XMP', null, 'E_EXIF_NO_GPS');
  // Orientation.
  let orientation;
  let source;
  if (Number.isFinite(xn(x, 'drone-dji:GimbalPitchDegree'))) {
    orientation = { kind: 'gimbal', yaw: xn(x, 'drone-dji:GimbalYawDegree') || 0, pitch: xn(x, 'drone-dji:GimbalPitchDegree'), roll: xn(x, 'drone-dji:GimbalRollDegree') || 0 };
    source = 'DJI gimbal';
  } else if (Number.isFinite(xn(x, 'Camera:Yaw'))) {
    orientation = { kind: 'gimbal', yaw: xn(x, 'Camera:Yaw'), pitch: -90 + (xn(x, 'Camera:Pitch') || 0), roll: xn(x, 'Camera:Roll') || 0 };
    source = 'Camera:Yaw/Pitch/Roll';
  } else if (Number.isFinite(xn(x, 'drone-dji:FlightYawDegree'))) {
    orientation = { kind: 'gimbal', yaw: xn(x, 'drone-dji:FlightYawDegree'), pitch: -90, roll: 0 };
    source = 'DJI flight yaw, nadir camera assumed';
  } else if (Number.isFinite(xn(x, 'sensefly:Heading'))) {
    orientation = { kind: 'gimbal', yaw: xn(x, 'sensefly:Heading'), pitch: -90 + (xn(x, 'sensefly:PitchAngle') || 0), roll: xn(x, 'sensefly:RollAngle') || 0 };
    source = 'senseFly platform angles';
  } else {
    orientation = { kind: 'gimbal', yaw: 0, pitch: -90, roll: 0 };
    source = 'no attitude: nadir, north up assumed';
    notes.push(N_('the image has no attitude in its metadata'));
  }
  // Camera.
  let cam = camera;
  if (!cam) {
    const dw = String(x['drone-dji:DewarpData'] ?? '');
    const cf = xn(x, 'drone-dji:CalibratedFocalLength');
    const m = /;([-0-9.,eE+ ]+)$/.exec(dw);
    if (m) {
      const [fx, fy, cxo, cyo, k1, k2, p1, p2, k3] = m[1].split(',').map(Number);
      // DJI DewarpData: fx, fy, cx, cy as offsets from the image centre, then OpenCV k1 k2 p1 p2 k3.
      cam = fromOpenCv({ fx, fy, cx: W / 2 + cxo, cy: H / 2 + cyo, k1, k2, p1, p2, k3, width: W, height: H }, 'DJI DewarpData');
    } else if (cf > 0) {
      const cx = xn(x, 'drone-dji:CalibratedOpticalCenterX');
      const cy = xn(x, 'drone-dji:CalibratedOpticalCenterY');
      cam = { focalMm: cf * 0.001, pixelMm: 0.001, cx: Number.isFinite(cx) ? cx : W / 2, cy: Number.isFinite(cy) ? cy : H / 2, k: [0, 0, 0], p: [0, 0], aff: [0, 0], width: W, height: H, source: 'DJI calibrated focal length' };
    } else {
      const f = meta.focalMm;
      let pixel = meta.fpRes?.x > 0 ? 1 / meta.fpRes.x : NaN;
      if (!(pixel > 0) && meta.f35 > 0 && f > 0) pixel = ((f / meta.f35) * Math.hypot(36, 24)) / Math.hypot(W, H);
      if (!(f > 0 && pixel > 0 && W > 0 && H > 0)) throw gwError('the EXIF has no focal length with a focal-plane resolution or 35 mm equivalent', null, 'E_EXIF_NO_CAMERA');
      cam = { focalMm: f, pixelMm: pixel, cx: W / 2, cy: H / 2, k: [0, 0, 0], p: [0, 0], aff: [0, 0], width: W, height: H, source: meta.fpRes ? 'EXIF focal length and focal-plane resolution' : 'EXIF focal length and 35 mm equivalent' };
      notes.push(N_('no lens calibration: distortion not modelled'));
    }
  }
  // A priori σ: the XMP's GPS accuracy (senseFly) or RTK σ (DJI), else 5 m horizontal, 10 m
  // vertical; 2° attitude; the focal length 0.5 %.
  const sh = xn(x, 'Camera:GPSXYAccuracy') || (Number.isFinite(xn(x, 'drone-dji:RtkStdLat')) ? Math.hypot(xn(x, 'drone-dji:RtkStdLat'), xn(x, 'drone-dji:RtkStdLon')) / Math.SQRT2 : 5);
  const sv = xn(x, 'Camera:GPSZAccuracy') || xn(x, 'drone-dji:RtkStdHgt') || 10;
  const var7 = [sh * sh, sh * sh, sv * sv, 4, 4, 4, (0.005 * cam.focalMm) ** 2];
  const cov = Array.from({ length: 49 }, (_, k) => (k % 8 === 0 ? var7[k / 8] : 0));
  return { camera: cam, position: { lat, lon, alt, datum }, orientation, source, notes, cov };
}
