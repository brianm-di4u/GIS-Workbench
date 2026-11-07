// 2.4 sensor group (REQ-GAP-18, REQ-GAP-19, REQ-GAP-23), the JavaScript readers and writers:
// the RSM TRE family round-trips through its fixed-width text (polynomial sections with their
// index, grids, set A and set B adjustable parameters, indirect and direct covariance); SENSRB,
// EXIF/XMP and camera calibration files read into the camera, position and orientation the core's
// frame model takes. The geometry itself (Rust) is checked by cargo tests and the e2e spec.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { parseRsm, rsmFlat, rsmRecord } from '../../app/src/sensor/rsm.js';
import { rsmTreList, rsmTreMap, rsmTres, rsmFromRpc, f21, writeSensrb } from '../../app/src/sensor/writers.js';
import { parseSensrb, sensrbFrame } from '../../app/src/sensor/sensrb.js';
import { readJpegMeta, droneFrame, parseXmp } from '../../app/src/sensor/exif.js';
import { parseCameraFile, parseUsgsReport, refitRadial, frameParams } from '../../app/src/sensor/camera.js';
import { splitTres } from '../../app/src/sensor/linescan.js';

const close = (a, b, tol = 1e-12) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));
const deepClose = (a, b, path = '') => {
  if (Array.isArray(a)) {
    expect(b?.length, path).toBe(a.length);
    a.forEach((v, i) => deepClose(v, b[i], `${path}[${i}]`));
  } else if (a && typeof a === 'object') for (const k of Object.keys(a)) deepClose(a[k], b?.[k], `${path}.${k}`);
  else if (typeof a === 'number') expect(Number.isNaN(a) ? Number.isNaN(b) : close(a, b), `${path}: ${a} vs ${b}`).toBe(true);
  else expect(b, path).toBe(a);
};

/** A deterministic pseudo-random sequence. */
const rnd = (() => {
  let s = 12345;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
})();

function sampleRsm() {
  const poly = (px, py, pz) => ({ px, py, pz, c: Array.from({ length: (px + 1) * (py + 1) * (pz + 1) }, (_, i) => (i === 0 ? 1 : rnd() * 10 ** Math.round(rnd() * 4 - 2))) });
  const sections = [];
  for (let i = 1; i <= 2; i++) for (let j = 1; j <= 2; j++) sections.push({ rsn: i, csn: j, rfep: 0.01 * i, cfep: 0.02 * j, off: [500 * i, 700 * j, -2.03, 0.602, 650], scale: [600, 800, 1.2e-5, 9.5e-6, 250], polys: [poly(3, 3, 2), poly(1, 1, 1), poly(3, 3, 2), poly(1, 1, 1)] });
  const plane = (k, nx, ny) => ({ x0: -2.0334 + k * 2e-6, y0: 0.6021 - k * 3e-6, nx, ny, row: Array.from({ length: nx * ny }, (_, i) => (i === 3 && k === 1 ? NaN : 12.345 + 100 * i + k)), col: Array.from({ length: nx * ny }, (_, i) => (i === 3 && k === 1 ? NaN : -40.5 + 77.125 * i)) });
  const grids = [1, 2].map((c) => ({ rsn: 1, csn: c, rfep: 0.003, cfep: 0.004, intord: 3, z0: 400, dz: 125, dx: 2e-6, dy: 3e-6, planes: [plane(0, 5, 4), plane(1, 5, 4), plane(2, 5, 4)] }));
  const ix = { r: Array.from({ length: 10 }, () => rnd() * 1e3), c: Array.from({ length: 10 }, () => rnd() * 1e3), rnis: 2, cnis: 2, rssiz: 1000, cssiz: 1500 };
  const frame = { origin: [-1e6, -5e6, 3.6e6], axes: [0.9, 0.1, 0, -0.1, 0.9, 0.3, 0.05, -0.3, 0.95] };
  return {
    iid: 'RSM TEST IMAGE',
    domain: 0,
    origin: [0, 0, 0],
    axes: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    rows: 2000,
    cols: 3000,
    minr: 0,
    minc: 0,
    grp: [-2.0333, 0.6022, 650],
    index: ix,
    sections,
    gindex: { ...ix, rnis: 1 },
    grids,
    applied: { frame: 0, ...frame, noff: [0, 0, 0], nscale: [1, 1, 1], terms: [[0, 0, 0, 0], [1, 0, 0, 0], [0, 1, 0, 0], [2, 0, 0, 0]], values: [0.5, -0.25, 1e-5, 0.3] },
    adjustable: { frame: 0, ...frame, noff: [0, 0, 0], nscale: [1, 1, 1], terms: [[0, 0, 0, 0], [1, 0, 0, 0], [2, 2, 0, 0]], values: [0, 0, 0] },
    cov: [4, 0.5, 0.1, 0.5, 9, -0.2, 0.1, -0.2, 2.25],
    unmodelled: [0.04, 0.001, 0.09],
    errorSource: 'RSMECA',
    notes: [],
  };
}

describe('RSM TREs (REQ-GAP-18)', () => {
  it('round-trips sections, index, grids, set A parameters and indirect covariance', () => {
    const r = sampleRsm();
    const list = rsmTreList(r);
    const tags = list.map((x) => x[0]);
    expect(tags).toEqual(['RSMIDA', 'RSMPIA', 'RSMPCA', 'RSMPCA', 'RSMPCA', 'RSMPCA', 'RSMGIA', 'RSMGGA', 'RSMGGA', 'RSMAPA', 'RSMECA']);
    const len = Object.fromEntries(list.map(([t, x]) => [t, x.length]));
    expect(len.RSMIDA).toBe(1628);
    expect(len.RSMPIA).toBe(591);
    expect(len.RSMGIA).toBe(591);
    for (const [t, x] of list) expect(x.length, t).toBeLessThanOrEqual(t === 'RSMPCA' ? 18546 : 99988);
    const back = parseRsm(rsmTreMap(list));
    // The applied set (RSMAPA) and the covariance's set (RSMECA) are defined differently here.
    expect(back.notes).toEqual(['the applied and adjustable parameter sets differ; both are used']);
    // RSMIDA keeps the geometry-relevant fields; values pass through 15 significant digits.
    for (const k of ['iid', 'domain', 'rows', 'cols', 'minr', 'minc', 'grp', 'index', 'sections', 'gindex', 'applied', 'adjustable', 'cov', 'unmodelled', 'errorSource']) deepClose(r[k], back[k], k);
    // Grid coordinates are stored to 0.001 px (FNUMRD 3); blank nodes stay blank.
    for (let g = 0; g < 2; g++)
      for (let k = 0; k < 3; k++) {
        const a = r.grids[g].planes[k];
        const b = back.grids[g].planes[k];
        expect([b.x0, b.y0, b.nx, b.ny]).toEqual([expect.closeTo(a.x0, 15), expect.closeTo(a.y0, 15), a.nx, a.ny]);
        a.row.forEach((v, i) => (Number.isNaN(v) ? expect(b.row[i]).toBeNaN() : expect(Math.abs(b.row[i] - v)).toBeLessThan(6e-4)));
        a.col.forEach((v, i) => (Number.isNaN(v) ? expect(b.col[i]).toBeNaN() : expect(Math.abs(b.col[i] - v)).toBeLessThan(6e-4)));
        expect(b.intord).toBeUndefined();
      }
    expect(back.grids[0].intord).toBe(3);
  });

  it('round-trips set B parameters (RSMAPB, RSMECB) and direct covariance (RSMDCA, RSMDCB)', () => {
    const r = sampleRsm();
    // Set B keeps a set all image-space or all ground-space.
    r.applied = { ...r.applied, terms: r.applied.terms.slice(0, 2), values: r.applied.values.slice(0, 2), frame: 1, origin: [0, 0, 0], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0], noff: [-2.03, 0.6, 650], nscale: [1e-5, 1e-5, 300] };
    r.adjustable = { frame: 0, origin: r.adjustable.origin, axes: r.adjustable.axes, noff: [0, 0, 0], nscale: [1000, 1000, 100], terms: [[2, 0, 0, 0], [2, 1, 0, 0], [2, 6, 0, 0]], values: [0, 0, 0] };
    for (const [setB, direct, want] of [
      [true, false, ['RSMAPB', 'RSMECB']],
      [true, true, ['RSMAPB', 'RSMDCB']],
    ]) {
      const list = rsmTreList(r, { setB, direct });
      expect(list.slice(-2).map((x) => x[0])).toEqual(want);
      const back = parseRsm(rsmTreMap(list));
      deepClose(r.applied, back.applied, 'applied');
      deepClose(r.cov, back.cov, 'cov');
      deepClose(r.adjustable.terms, back.adjustable.terms, 'terms');
      if (!direct) deepClose(r.unmodelled, back.unmodelled, 'unmodelled');
    }
    // Set A direct covariance for a set A parameter set.
    const a = sampleRsm();
    const list = rsmTreList(a, { direct: true });
    expect(list.at(-1)[0]).toBe('RSMDCA');
    const back = parseRsm(rsmTreMap(list));
    expect(back.errorSource).toBe('RSMDCA');
    deepClose(a.cov, back.cov, 'cov');
  });

  it('flattens to the core record and keeps the 2.2 one-section API', () => {
    const r = sampleRsm();
    const p = rsmFlat(r);
    expect(p[0]).toBe(2);
    expect(p[21]).toBe(0); // polynomial
    expect(p[22]).toBe(1); // with index
    const g = rsmFlat(r, { grid: true });
    expect(g[21]).toBe(1);
    expect(() => rsmFlat({ ...r, index: null })).toThrow(/section index/);
    // The 2.2 writer and reader.
    const rpc = Array.from({ length: 92 }, (_, i) => (i < 12 ? [1, 1, 500, 600, 34.5, -116.5, 650, 500, 600, 0.05, 0.05, 500][i] : (i - 12) % 20 === 0 ? 1 : 0));
    const one = rsmFromRpc(rpc, 1000, 1200);
    const t = rsmTres(one);
    expect(t.RSMIDA.length).toBe(1628);
    const rec = rsmRecord(t.RSMIDA, t.RSMPCA);
    expect([rec.rsn, rec.csn]).toEqual([1, 1]);
    deepClose(one.polys, rec.polys, 'polys');
  });

  it('refuses truncated and inconsistent TREs with a reason', () => {
    const r = sampleRsm();
    const m = rsmTreMap(rsmTreList(r));
    expect(() => parseRsm({ ...m, RSMPCA: [m.RSMPCA[0].slice(0, 400)] })).toThrow(/shorter than its fields/);
    expect(() => parseRsm({ ...m, RSMPCA: [], RSMGGA: [] })).toThrow(/no polynomial/);
    expect(() => parseRsm({ RSMPCA: m.RSMPCA })).toThrow(/RSMIDA/);
    expect(f21(-1.5)).toHaveLength(21);
    expect(f21(1e-300)).toHaveLength(21);
  });
});

describe('SENSRB (REQ-GAP-23)', () => {
  const sample = { width: 4000, height: 3000, focalMm: 50, pixelMm: 0.006, ppx: 0.012, ppy: -0.024, k: [1e-5, -2e-9, 0], p: [1e-6, -2e-6], lat: 34.5, lon: -116.5, hae: 2100, icx: [0, 1, 0], icy: [-1, 0, 0], icz: [0, 0, 1] };
  it('writes and reads a frame camera with unit vectors', () => {
    const t = writeSensrb(sample);
    const f = parseSensrb(t);
    expect(f.SENSOR_ARRAY_DATA).toBe('Y');
    const fr = sensrbFrame(f, { width: 4000, height: 3000 });
    expect(fr.camera.focalMm).toBeCloseTo(50, 6);
    expect(fr.camera.pixelMm).toBeCloseTo(0.006, 9);
    expect(fr.camera.cx).toBeCloseTo(2000 + 2, 6);
    expect(fr.camera.cy).toBeCloseTo(1500 + 4, 6);
    expect(fr.camera.k[1]).toBeCloseTo(-2e-9, 15);
    expect(fr.position).toMatchObject({ lat: 34.5, lon: -116.5, alt: 2100, datum: 'HAE' });
    expect(fr.orientation).toMatchObject({ kind: 'axes', frame: 'ned', icx: [0, 1, 0], icy: [-1, 0, 0], icz: [0, 0, 1] });
    // Nadir looking down (NED down), image x east, image y south: ENU → camera rows x = east,
    // y = north (−image y), z = up (−line of sight).
    const prm = frameParams(fr.camera, { lat: 34.5, lon: -116.5, hae: 2100 }, fr.orientation);
    expect(prm[0]).toBe(2);
    expect(prm.slice(17, 26)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1].map((v) => expect.closeTo(v, 12)));
  });
  it('says why the GDAL test SENSRB cannot give a model', () => {
    const p = 'C:/GIS Workbench/Research/samples/nitf-gdal-autotest-small/SENSRB_TRE.ntf';
    if (!existsSync(p)) return;
    const s = readFileSync(p).toString('latin1');
    const i = s.indexOf('SENSRB');
    const n = Number(s.slice(i + 6, i + 11));
    const f = parseSensrb(s.slice(i + 11, i + 11 + n));
    expect(f.GENERAL_DATA).toBe('Y');
    expect(() => sensrbFrame(f, { width: 10, height: 10 })).toThrow(/no sensor array data/);
  });
});

/** A minimal JPEG with an EXIF APP1 (GPS, focal length, focal-plane resolution) and an XMP APP1. */
function jpeg({ lat, lon, alt, focal, xres, w, h, xmp }) {
  const le = true;
  const entries = (list) => list; // [tag, type, count, value(s)]
  const ifd0 = entries([[0x010f, 2, 'DJI'], [0x0110, 2, 'FC6310'], [0x8769, 4, 0], [0x8825, 4, 0]]);
  const exif = entries([[0x920a, 5, [focal]], [0xa002, 4, w], [0xa003, 4, h], [0xa20e, 5, [xres]], [0xa20f, 5, [xres]], [0xa210, 3, 4]]);
  const dms = (v) => [Math.floor(v), Math.floor((v % 1) * 60), (((v % 1) * 60) % 1) * 60];
  const gps = entries([[0x0001, 2, lat < 0 ? 'S' : 'N'], [0x0002, 5, dms(Math.abs(lat))], [0x0003, 2, lon < 0 ? 'W' : 'E'], [0x0004, 5, dms(Math.abs(lon))], [0x0005, 1, 0], [0x0006, 5, [alt]]]);
  const buf = new Uint8Array(4096);
  const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49]);
  dv.setUint16(2, 42, le);
  dv.setUint32(4, 8, le);
  let heap = 600;
  const writeIfd = (at, list) => {
    dv.setUint16(at, list.length, le);
    list.forEach(([tag, type, v], i) => {
      const e = at + 2 + 12 * i;
      dv.setUint16(e, tag, le);
      dv.setUint16(e + 2, type, le);
      if (type === 2) {
        const s = `${v}\0`;
        dv.setUint32(e + 4, s.length, le);
        const o = s.length <= 4 ? e + 8 : heap;
        if (s.length > 4) {
          dv.setUint32(e + 8, heap, le);
          heap += s.length + 1;
        }
        for (let k = 0; k < s.length; k++) buf[o + k] = s.charCodeAt(k);
      } else if (type === 5) {
        dv.setUint32(e + 4, v.length, le);
        dv.setUint32(e + 8, heap, le);
        for (const x of v) {
          dv.setUint32(heap, Math.round(x * 1e6), le);
          dv.setUint32(heap + 4, 1e6, le);
          heap += 8;
        }
      } else {
        dv.setUint32(e + 4, 1, le);
        if (type === 3) dv.setUint16(e + 8, v, le);
        else if (type === 1) buf[e + 8] = v;
        else dv.setUint32(e + 8, v, le);
      }
    });
    dv.setUint32(at + 2 + 12 * list.length, 0, le);
  };
  ifd0[2][2] = 200;
  ifd0[3][2] = 400;
  writeIfd(8, ifd0);
  writeIfd(200, exif);
  writeIfd(400, gps);
  const tiff = buf.subarray(0, heap);
  const app1 = (payload) => {
    const n = payload.length + 2;
    return [0xff, 0xe1, n >> 8, n & 255, ...payload];
  };
  const x = new TextEncoder().encode(`http://ns.adobe.com/xap/1.0/\0${xmp}`);
  return Uint8Array.from([0xff, 0xd8, ...app1([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]), ...app1(x), 0xff, 0xd9]);
}

describe('drone EXIF/XMP (REQ-GAP-23)', () => {
  const xmp = '<x:xmpmeta><rdf:Description drone-dji:GimbalYawDegree="+45.20" drone-dji:GimbalPitchDegree="-89.90" drone-dji:GimbalRollDegree="+0.00" drone-dji:FlightYawDegree="+44.10" drone-dji:AbsoluteAltitude="+412.53" drone-dji:CalibratedFocalLength="3666.666504" drone-dji:CalibratedOpticalCenterX="2736.000000" drone-dji:CalibratedOpticalCenterY="1824.000000"/></x:xmpmeta>';
  it('reads EXIF GPS, the camera and DJI gimbal angles', () => {
    const m = readJpegMeta(jpeg({ lat: 41.3038, lon: -81.7505, alt: 346.2, focal: 8.8, xres: 416.6667, w: 5472, h: 3648, xmp }));
    expect(m.make).toBe('DJI');
    expect(m.gps.lat).toBeCloseTo(41.3038, 5);
    expect(m.gps.lon).toBeCloseTo(-81.7505, 5);
    expect(m.gps.alt).toBeCloseTo(346.2, 4);
    expect(m.focalMm).toBeCloseTo(8.8, 6);
    expect(m.fpRes.x).toBeCloseTo(416.6667, 3);
    const f = droneFrame(m);
    expect(f.source).toBe('DJI gimbal');
    expect(f.orientation).toEqual({ kind: 'gimbal', yaw: 45.2, pitch: -89.9, roll: 0 });
    expect(f.position).toMatchObject({ alt: 412.53, datum: 'MSL' });
    expect(f.camera.focalMm / f.camera.pixelMm).toBeCloseTo(3666.6665, 3);
    // Without the DJI calibration: the EXIF focal length and focal-plane resolution.
    const g = droneFrame({ ...m, xmp: parseXmp(xmp.replace(/drone-dji:Calibrated\w+="[^"]*"/g, '')) });
    expect(g.camera.focalMm).toBeCloseTo(8.8, 6);
    expect(g.camera.pixelMm).toBeCloseTo(1 / 416.6667, 8);
    expect(g.notes).toContain('no lens calibration: distortion not modelled');
    expect(() => droneFrame({ ...m, gps: null })).toThrow(/no GPS/);
  });
  it('reads DJI DewarpData as an OpenCV calibration', () => {
    const m = readJpegMeta(jpeg({ lat: 1, lon: 2, alt: 3, focal: 8.8, xres: 400, w: 5472, h: 3648, xmp: xmp.replace('/>', ' drone-dji:DewarpData="2018-09-04;3678.87,3671.42,10.25,27.37,-0.268652,0.110846,0.000182252,-0.000204188,-0.0274804"/>') }));
    const f = droneFrame(m);
    expect(f.camera.source).toBe('DJI DewarpData');
    expect(f.camera.cx).toBeCloseTo(2736 + 10.25, 9);
    expect(f.camera.cy).toBeCloseTo(1824 + 27.37, 9);
    expect(f.camera.focalMm / f.camera.pixelMm).toBeCloseTo(3671.42, 6);
    expect(f.camera.aff[0]).toBeCloseTo(3678.87 / 3671.42 - 1, 12);
  });
  it('reads the corpus senseFly XMP (Bellus, Aukerman, Seneca) when the corpus is present', () => {
    const first = (d) => {
      const f = readdirSync(d).find((n) => /\.jpe?g$/i.test(n));
      return readJpegMeta(new Uint8Array(readFileSync(`${d}/${f}`).subarray(0, 256 << 10)));
    };
    const B = 'D:/TE-corpus/frames-odm-bellus-gcp/images';
    if (existsSync(B)) {
      const m = first(B);
      expect(m.model).toBe('Canon PowerShot S110');
      const fr = droneFrame(m);
      expect(fr.source).toBe('Camera:Yaw/Pitch/Roll');
      expect(fr.camera.focalMm).toBeCloseTo(5.2, 6);
      expect(fr.camera.pixelMm).toBeCloseTo(1 / 537.475, 6);
      expect(fr.cov[0]).toBeCloseTo(Number(m.xmp['Camera:GPSXYAccuracy']) ** 2, 6);
    }
    // The Sony of Aukerman has no focal-plane resolution or 35 mm focal length: no camera.
    const A = 'D:/TE-corpus/frames-odm-aukerman/images';
    if (existsSync(A)) expect(() => droneFrame(first(A))).toThrow(/no focal length/);
    // Seneca: senseFly platform angles and the ellipsoidal altitude.
    const S = 'D:/TE-corpus/frames-odm-seneca/images';
    if (existsSync(S)) {
      const fr = droneFrame(first(S));
      expect(fr.source).toBe('senseFly platform angles');
      expect(fr.position.datum).toBe('HAE');
    }
  });
});

describe('camera calibration files (REQ-GAP-23)', () => {
  it('reads Agisoft XML', () => {
    const c = parseCameraFile('<?xml version="1.0"?><calibration><projection>frame</projection><width>6000</width><height>4000</height><f>3650.5</f><cx>12.5</cx><cy>-8.25</cy><b1>1.5</b1><b2>-0.5</b2><k1>-0.1</k1><k2>0.02</k2><k3>-0.001</k3><p1>0.0005</p1><p2>-0.0003</p2></calibration>', 'cam.xml');
    expect(c.source).toBe('Agisoft');
    expect(c.focalMm / c.pixelMm).toBeCloseTo(3650.5, 9);
    expect([c.cx, c.cy]).toEqual([3012.5, 1991.75]);
    const f = c.focalMm;
    expect(c.k[0] * f * f).toBeCloseTo(-0.1, 12);
    expect(c.p).toEqual([expect.closeTo(0.0005 / f, 12), expect.closeTo(0.0003 / f, 12)]);
    expect(c.aff).toEqual([expect.closeTo(1.5 / 3650.5, 14), expect.closeTo(-0.5 / 3650.5, 14)]);
  });
  it('reads a Pix4D .cam and the same keys as XML', () => {
    const cam = '#Focal Length mm assuming a sensor width of 12.83332x8.55554mm\nF 10.5000\n#Principal Point mm\nPx 6.4060\nPy 4.2740\n#Symmetrical Lens Distortion Coeffs\nK1 -0.0013\nK2 0.0010\nK3 -0.0005\n#Tangential Lens Distortion Coeffs\nT1 0.0002\nT2 -0.0003\n';
    const c = parseCameraFile(cam, 'x_pix4d_calibrated_internal_camera_parameters.cam', { width: 5472, height: 3648 });
    expect(c.source).toBe('Pix4D');
    expect(c.pixelMm).toBeCloseTo(12.83332 / 5472, 12);
    expect(c.cx).toBeCloseTo(6.406 / c.pixelMm, 9);
    const x = parseCameraFile('<pix4dCamera><focalLength>10.5</focalLength><sensorWidth>12.83332</sensorWidth><imageWidth>5472</imageWidth><imageHeight>3648</imageHeight><Px>6.406</Px><Py>4.274</Py><K1>-0.0013</K1><T1>0.0002</T1></pix4dCamera>', 'cam.xml');
    expect(x.cx).toBeCloseTo(c.cx, 9);
    expect(x.k[0]).toBeCloseTo(c.k[0], 15);
  });
  it('reads a USGS calibration report and refits its radial distortion to the core form', () => {
    const rep = `U.S. GEOLOGICAL SURVEY  REPORT OF CALIBRATION of Aerial Mapping Camera
Camera type: DMC   Array 7680 x 13824 pixels   Pixel size 12.0 um
Calibrated Focal Length: 120.000 mm
Principal point of autocollimation (PPA): x = 0.010 y = -0.020 mm
Radial distortion: K0 = -1.2e-5  K1 = 3.1e-8  K2 = -2.5e-12  K3 = 0.0
Decentering: P1 = 1.5e-7  P2 = -2.0e-7
`;
    const c = parseUsgsReport(rep);
    expect([c.width, c.height]).toEqual([7680, 13824]);
    expect(c.pixelMm).toBeCloseTo(0.012, 12);
    expect(c.cx).toBeCloseTo(3840 + 0.01 / 0.012, 9);
    expect(c.cy).toBeCloseTo(6912 + 0.02 / 0.012, 9);
    expect(c.p).toEqual([1.5e-7, -2e-7]);
    // Δr of the report vs the refitted core model: distorted = ideal·(1 + k₁r² + …) at f·scale.
    const d = (r) => -1.2e-5 * r + 3.1e-8 * r ** 3 - 2.5e-12 * r ** 5;
    const scale = c.focalMm / 120;
    let worst = 0;
    for (let rd = 1; rd < 95; rd += 2) {
      const ri = (rd - d(rd)) * scale; // ideal radius at the refitted focal length
      const back = ri * (1 + c.k[0] * ri ** 2 + c.k[1] * ri ** 4 + c.k[2] * ri ** 6);
      worst = Math.max(worst, Math.abs(back - rd));
    }
    expect(worst).toBeLessThan(1e-4); // 0.1 µm over the 92 mm image half-diagonal
    const fit = refitRadial(() => 0, 50);
    expect(fit.scale).toBeCloseTo(1, 12);
  });
  it('reads a PAT-B camera record and an OpenCV JSON', () => {
    const c = parseCameraFile('101 153.124 -0.004 0.006\n10 2.0\n20 3.5\n30 3.0\n40 -1.0\n50 -6.0\n-99\n', 'camera.patb', { width: 11500, height: 7500, pixelMm: 0.009 });
    expect(c.source).toBe('PAT-B');
    expect(c.cx).toBeCloseTo(5750 - 0.004 / 0.009, 9);
    const j = 'D:/TE-corpus/fmv-bambi-flights/flight_258/W_calib.json';
    const text = existsSync(j) ? readFileSync(j, 'utf8') : '{"mtx": [[2985.57, 0.0, 1933.89], [0.0, 2916.53, 1082.46], [0.0, 0.0, 1.0]], "dist": [0.139, -0.266, -0.00085, -0.00125, 0.0]}';
    const o = parseCameraFile(text, 'W_calib.json', { width: 3840, height: 2160 });
    expect(o.source).toBe('OpenCV JSON');
    expect(o.focalMm / o.pixelMm).toBeCloseTo(JSON.parse(text).mtx[1][1], 6);
    expect(() => parseCameraFile('hello', 'x.txt')).toThrow(/not a camera calibration/);
  });
});

describe('NITF TRE areas (REQ-GAP-19)', () => {
  it('splits a TRE_OVERFLOW area into tags with file offsets', () => {
    const a = `CSEPHA00005abcdeCSSFAA00003xyz`;
    expect(splitTres(a, 1000)).toEqual([{ tag: 'CSEPHA', offset: 1011, length: 5 }, { tag: 'CSSFAA', offset: 1027, length: 3 }]);
    expect(splitTres('CSEPHA00099short')).toEqual([]);
  });
});
