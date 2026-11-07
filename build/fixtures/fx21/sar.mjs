// FX-21 sar group (SDP-2.1 §4 P9): synthetic BPF in every coordinate type and compression, a small
// CPHD 1.0 with PVP and a support array, a UAVSAR .ann with .grd/.mlc/.slc, a swath NetCDF-4 with
// latitude/longitude arrays and a Sentinel-1 SAFE skeleton. Each format is written here by its own
// code (not the app's writers), so the app's readers and writers are checked against an independent
// encoder; truth values go to sar_truth.json.
//
//   node build/fixtures/fxformats21.mjs --only=sar

import { writeFileSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import h5wasm from 'h5wasm/node';

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

/** WGS 84 geodetic → ECEF. */
export function ecef(lat, lon, h) {
  const N = A / Math.sqrt(1 - E2 * Math.sin(lat * RAD) ** 2);
  return [(N + h) * Math.cos(lat * RAD) * Math.cos(lon * RAD), (N + h) * Math.cos(lat * RAD) * Math.sin(lon * RAD), (N * (1 - E2) + h) * Math.sin(lat * RAD)];
}

/** WGS 84 geodetic → UTM zone (northern), Krüger series to the 6th order. */
export function utm(lat, lon, zone) {
  const n = F / (2 - F);
  const A1 = (A / (1 + n)) * (1 + n * n / 4 + n ** 4 / 64);
  const al = [n / 2 - (2 / 3) * n * n + (5 / 16) * n ** 3, (13 / 48) * n * n - (3 / 5) * n ** 3, (61 / 240) * n ** 3];
  const l0 = (zone * 6 - 183) * RAD;
  const p = lat * RAD;
  const l = lon * RAD - l0;
  const e = Math.sqrt(E2);
  const t = Math.sinh(Math.atanh(Math.sin(p)) - e * Math.atanh(e * Math.sin(p)));
  const xi = Math.atan2(t, Math.cos(l));
  const eta = Math.atanh(Math.sin(l) / Math.sqrt(1 + t * t));
  let x = eta;
  let y = xi;
  for (let j = 1; j <= 3; j++) {
    x += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + 0.9996 * A1 * x, 0.9996 * A1 * y];
}

// ---------------------------------------------------------------- BPF
const BPF_LAT = 36.1147;
const BPF_LON = -115.1728;
const BPF_N = 400;

function bpfCloud() {
  // A 60 m × 40 m patch with a tilted plane, intensities, classes and GPS times.
  const pts = [];
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let k = 0; k < BPF_N; k++) {
    const e = rnd() * 60 - 30;
    const nn = rnd() * 40 - 20;
    const h = 610 + 0.05 * e + 0.02 * nn + (k % 7) * 0.3;
    const lat = BPF_LAT + nn / 110950;
    const lon = BPF_LON + e / 90060;
    pts.push({ lat, lon, h, intensity: 100 + (k * 37) % 900, cls: [2, 5, 6][k % 3], time: 1.4e9 + k * 0.001, ret: 1 + (k % 2), nret: 2 });
  }
  return pts;
}

function writeBpfFixture(pts, { coordType, coordId, coords, compression, interleave }) {
  const dims = [
    ['X', coords.map((c) => c[0])],
    ['Y', coords.map((c) => c[1])],
    ['Z', coords.map((c) => c[2])],
    ['GpsTime', pts.map((p) => p.time)],
    ['Intensity', pts.map((p) => p.intensity)],
    ['Classification', pts.map((p) => p.cls)],
    ['ReturnNumber', pts.map((p) => p.ret)],
    ['NumberOfReturns', pts.map((p) => p.nret)],
  ];
  const nd = dims.length;
  const n = pts.length;
  const len = 176 + 56 * nd;
  const head = Buffer.alloc(len);
  head.write('BPF!0003', 0, 'latin1');
  head.writeInt32LE(len, 8);
  head.writeUInt8(nd, 12);
  head.writeUInt8(interleave, 13);
  head.writeUInt8(compression === 'zlib' ? 3 : 0, 14);
  head.writeInt32LE(n, 16);
  head.writeInt32LE(coordType, 20);
  head.writeInt32LE(coordId, 24);
  for (let k = 0; k < 16; k++) head.writeDoubleLE(k % 5 === 0 ? 1 : 0, 32 + 8 * k);
  head.writeDoubleLE(Math.min(...pts.map((p) => p.time)), 160);
  head.writeDoubleLE(Math.max(...pts.map((p) => p.time)), 168);
  const off = dims.map(([l, v]) => (['X', 'Y', 'Z', 'GpsTime'].includes(l) ? Math.floor(Math.min(...v)) : 0));
  dims.forEach(([l, v], d) => {
    head.writeDoubleLE(off[d], 176 + 8 * d);
    head.writeDoubleLE(Math.min(...v), 176 + 8 * (nd + d));
    head.writeDoubleLE(Math.max(...v), 176 + 8 * (2 * nd + d));
    head.write(l, 176 + 24 * nd + 32 * d, 'latin1');
  });
  const body = Buffer.alloc(4 * n * nd);
  const f = Buffer.alloc(4);
  dims.forEach(([, v], d) => {
    for (let k = 0; k < n; k++) {
      const x = v[k] - off[d];
      if (interleave === 0) body.writeFloatLE(x, 4 * (d * n + k));
      else if (interleave === 1) body.writeFloatLE(x, 4 * (k * nd + d));
      else {
        f.writeFloatLE(x, 0);
        for (let b = 0; b < 4; b++) body[(d * 4 + b) * n + k] = f[b];
      }
    }
  });
  if (compression !== 'zlib') return Buffer.concat([head, body]);
  // PDAL's layout: (uncompressed size, compressed size, zlib stream) blocks; two blocks here.
  const half = Math.floor(body.length / 2);
  const parts = [head];
  for (const raw of [body.subarray(0, half), body.subarray(half)]) {
    const z = deflateSync(raw);
    const bh = Buffer.alloc(8);
    bh.writeUInt32LE(raw.length, 0);
    bh.writeUInt32LE(z.length, 4);
    parts.push(bh, z);
  }
  return Buffer.concat(parts);
}

function bpfFixtures(out, truth) {
  const pts = bpfCloud();
  const zone = 11;
  const o = ecef(BPF_LAT, BPF_LON, 0);
  const [sl, cl, so, co] = [Math.sin(BPF_LAT * RAD), Math.cos(BPF_LAT * RAD), Math.sin(BPF_LON * RAD), Math.cos(BPF_LON * RAD)];
  const enu = (p) => {
    const e = ecef(p.lat, p.lon, p.h);
    const [dx, dy, dz] = [e[0] - o[0], e[1] - o[1], e[2] - o[2]];
    return [-so * dx + co * dy, -sl * co * dx - sl * so * dy + cl * dz, cl * co * dx + cl * so * dy + sl * dz];
  };
  const frames = {
    utm: { coordType: 1, coordId: zone, coords: pts.map((p) => [...utm(p.lat, p.lon, zone), p.h]) },
    tcr: { coordType: 2, coordId: 1, coords: pts.map((p) => ecef(p.lat, p.lon, p.h)) },
    enu: { coordType: 3, coordId: 0, coords: pts.map(enu) },
    cart: { coordType: 0, coordId: 0, coords: pts.map((p) => [...utm(p.lat, p.lon, zone), p.h]) },
  };
  const files = [];
  for (const [name, fr] of Object.entries(frames)) {
    for (const compression of ['none', 'zlib']) {
      const f = `bpf-${name}-${compression}.bpf`;
      writeFileSync(join(out, f), writeBpfFixture(pts, { ...fr, compression, interleave: 0 }));
      files.push(f);
    }
  }
  for (const [il, nm] of [[1, 'point'], [2, 'byte']]) {
    const f = `bpf-utm-zlib-${nm}.bpf`;
    writeFileSync(join(out, f), writeBpfFixture(pts, { ...frames.utm, compression: 'zlib', interleave: il }));
    files.push(f);
  }
  truth.bpf = { n: BPF_N, origin: { lat: BPF_LAT, lon: BPF_LON }, zone, points: pts.slice(0, 5).map((p) => ({ lat: p.lat, lon: p.lon, h: p.h, intensity: p.intensity, cls: p.cls })), utmFirst: frames.utm.coords[0], ecefFirst: frames.tcr.coords[0], enuFirst: frames.enu.coords[0] };
  return files;
}

// ---------------------------------------------------------------- CPHD 1.0.1
const C = 299792458;
const v3sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const v3add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const v3mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a) => Math.sqrt(dot(a, a));
const unit = (a) => v3mul(a, 1 / nrm(a));

/** ECEF → [lat, lon, h] (Bowring iterations). */
function geodetic(p) {
  const r = Math.hypot(p[0], p[1]);
  let lat = Math.atan2(p[2], r * (1 - E2));
  let h = 0;
  for (let k = 0; k < 8; k++) {
    const N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
    h = r / Math.cos(lat) - N;
    lat = Math.atan2(p[2], r * (1 - (E2 * N) / (N + h)));
  }
  return [lat / RAD, Math.atan2(p[1], p[0]) / RAD, h];
}

/**
 * A spotlight collect over Las Vegas: 64 vectors × 80 CI4 samples, FX domain 9.5–9.8 GHz, one channel,
 * a 3 × 3 IAZ support array; PVPs and ReferenceGeometry computed from the geometry (CPHD 1.0.1 §6.5) so
 * sarkit's cphdcheck finds the file consistent.
 */
function cphdFixture(out, truth) {
  const lat0 = 36.1147;
  const lon0 = -115.1728;
  const h0 = 610;
  const iarp = ecef(lat0, lon0, h0);
  const [sl, cl, so, co] = [Math.sin(lat0 * RAD), Math.cos(lat0 * RAD), Math.sin(lon0 * RAD), Math.cos(lon0 * RAD)];
  const east = [-so, co, 0];
  const north = [-sl * co, -sl * so, cl];
  const up = [cl * co, cl * so, sl];
  const nv = 64;
  const ns = 80;
  const fx1 = 9.5e9;
  const fx2 = 9.8e9;
  const scss = (fx2 - fx1) / (ns - 1);
  const prf = 100;
  // The platform: 600 km up, 400 km to the east, flying north at 7.5 km/s; it looks west (left of track).
  const p0 = v3add(v3add(iarp, v3mul(up, 600e3)), v3add(v3mul(east, 400e3), v3mul(north, -7.5e3 * (nv / prf / 2))));
  const vel = v3mul(north, 7500);
  const rec = 28 * 8;
  const pvp = Buffer.alloc(nv * rec);
  const pvps = [];
  for (let v = 0; v < nv; v++) {
    const tx = v / prf;
    const txPos = v3add(p0, v3mul(vel, tx));
    const r1 = nrm(v3sub(txPos, iarp));
    const rcvTime = tx + (2 * r1) / C;
    const rcvPos = v3add(p0, v3mul(vel, rcvTime));
    const rdot = (dot(vel, unit(v3sub(txPos, iarp))) + dot(vel, unit(v3sub(rcvPos, iarp)))) / 2;
    const vals = [tx, ...txPos, ...vel, rcvTime, ...rcvPos, ...vel, ...iarp, (-2 / C) * rdot, 0, 0, fx1, fx2, -1e-7, 1e-7, 0, fx1, scss];
    vals.forEach((x, k) => pvp.writeDoubleBE(x, v * rec + 8 * k));
    pvp.writeBigInt64BE(1n, v * rec + 27 * 8);
    pvps.push({ tx, txPos, rcvTime, rcvPos });
  }
  // ReferenceGeometry from the middle vector (§6.5).
  const ref = nv / 2;
  const { tx: txc, txPos: xmt, rcvTime: trc, rcvPos: rcv } = pvps[ref];
  const srp = iarp;
  const rx = nrm(v3sub(xmt, srp));
  const rr = nrm(v3sub(rcv, srp));
  const tRef = txc + (rx / (rx + rr)) * (trc - txc);
  const arp = v3mul(v3add(xmt, rcv), 0.5);
  const varp = vel;
  const rArp = nrm(v3sub(arp, srp));
  const uarp = unit(v3sub(arp, srp));
  const rdot = dot(uarp, varp);
  const ea = Math.acos(Math.min(1, dot(unit(arp), unit(srp))));
  const look = dot(cross(unit(arp), unit(varp)), uarp) < 0 ? 1 : -1;
  const dca = Math.acos(-rdot / nrm(varp));
  const ugpy = unit(cross(up, uarp));
  const ugpx = cross(ugpy, up);
  const graz = Math.acos(dot(uarp, ugpx));
  const azim = Math.atan2(dot(ugpx, east), dot(ugpx, north));
  const uspn = unit(v3mul(cross(uarp, unit(varp)), look));
  const twst = -Math.asin(dot(uspn, ugpy));
  const slope = Math.acos(dot(up, uspn));
  const lo = Math.atan2(dot(v3mul(uspn, -1), east), dot(v3mul(uspn, -1), north));
  // Dwell: the reference times of the first and last vectors bound the centre of dwell ± half the dwell.
  const trefOf = (q) => q.tx + (nrm(v3sub(q.txPos, srp)) / (nrm(v3sub(q.txPos, srp)) + nrm(v3sub(q.rcvPos, srp)))) * (q.rcvTime - q.tx);
  const [ta, tb] = [trefOf(pvps[0]), trefOf(pvps[nv - 1])];
  const cod = (ta + tb) / 2;
  const dwell = (tb - ta) * 0.999;
  const deg = (x) => x / RAD;
  const e = (x) => x.toExponential(16).replace('e+', 'E').replace('e-', 'E-');
  const xyz = (v) => `<X>${e(v[0])}</X><Y>${e(v[1])}</Y><Z>${e(v[2])}</Z>`;
  // Image area: ±30 m on the east/north plane through the IARP; corners on the plane, as lat/lon.
  const corner = (x, y) => geodetic(v3add(iarp, v3add(v3mul(east, x), v3mul(north, y))));
  const cs = [[-30, -30], [-30, 30], [30, 30], [30, -30]].map(([x, y]) => corner(x, y));
  const t1 = 0;
  const t2 = (nv - 1) / prf;
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<CPHD xmlns="http://api.nsgreg.nga.mil/schema/cphd/1.0.1"><CollectionID><CollectorName>FX-21 synthetic</CollectorName><CoreName>FX21_SAR_SPOT_0001</CoreName><CollectType>MONOSTATIC</CollectType><RadarMode><ModeType>SPOTLIGHT</ModeType></RadarMode><Classification>UNCLASSIFIED</Classification><ReleaseInfo>UNRESTRICTED</ReleaseInfo></CollectionID><Global><DomainType>FX</DomainType><SGN>-1</SGN><Timeline><CollectionStart>2026-10-01T18:00:00.000000Z</CollectionStart><TxTime1>${e(t1)}</TxTime1><TxTime2>${e(t2)}</TxTime2></Timeline><FxBand><FxMin>${e(fx1)}</FxMin><FxMax>${e(fx2)}</FxMax></FxBand><TOASwath><TOAMin>${e(-1e-7)}</TOAMin><TOAMax>${e(1e-7)}</TOAMax></TOASwath></Global><SceneCoordinates><EarthModel>WGS_84</EarthModel><IARP><ECF>${xyz(iarp)}</ECF><LLH><Lat>${e(lat0)}</Lat><Lon>${e(lon0)}</Lon><HAE>${e(h0)}</HAE></LLH></IARP><ReferenceSurface><Planar><uIAX>${xyz(east)}</uIAX><uIAY>${xyz(north)}</uIAY></Planar></ReferenceSurface><ImageArea><X1Y1><X>-30</X><Y>-30</Y></X1Y1><X2Y2><X>30</X><Y>30</Y></X2Y2></ImageArea><ImageAreaCornerPoints>${cs.map((c, i) => `<IACP index="${i + 1}"><Lat>${e(c[0])}</Lat><Lon>${e(c[1])}</Lon></IACP>`).join('')}</ImageAreaCornerPoints></SceneCoordinates><Data><SignalArrayFormat>CI4</SignalArrayFormat><NumBytesPVP>${rec}</NumBytesPVP><NumCPHDChannels>1</NumCPHDChannels><Channel><Identifier>VV</Identifier><NumVectors>${nv}</NumVectors><NumSamples>${ns}</NumSamples><SignalArrayByteOffset>0</SignalArrayByteOffset><PVPArrayByteOffset>0</PVPArrayByteOffset></Channel><NumSupportArrays>1</NumSupportArrays><SupportArray><Identifier>IAZ</Identifier><NumRows>3</NumRows><NumCols>3</NumCols><BytesPerElement>4</BytesPerElement><ArrayByteOffset>0</ArrayByteOffset></SupportArray></Data><Channel><RefChId>VV</RefChId><FXFixedCPHD>true</FXFixedCPHD><TOAFixedCPHD>true</TOAFixedCPHD><SRPFixedCPHD>true</SRPFixedCPHD><Parameters><Identifier>VV</Identifier><RefVectorIndex>${ref}</RefVectorIndex><FXFixed>true</FXFixed><TOAFixed>true</TOAFixed><SRPFixed>true</SRPFixed><SignalNormal>true</SignalNormal><Polarization><TxPol>V</TxPol><RcvPol>V</RcvPol></Polarization><FxC>${e((fx1 + fx2) / 2)}</FxC><FxBW>${e(fx2 - fx1)}</FxBW><TOASaved>${e(2e-7)}</TOASaved><DwellTimes><CODId>COD</CODId><DwellId>DWELL</DwellId></DwellTimes></Parameters></Channel><PVP>${[['TxTime', 0, 1], ['TxPos', 1, 3], ['TxVel', 4, 3], ['RcvTime', 7, 1], ['RcvPos', 8, 3], ['RcvVel', 11, 3], ['SRPPos', 14, 3], ['aFDOP', 17, 1], ['aFRR1', 18, 1], ['aFRR2', 19, 1], ['FX1', 20, 1], ['FX2', 21, 1], ['TOA1', 22, 1], ['TOA2', 23, 1], ['TDTropoSRP', 24, 1], ['SC0', 25, 1], ['SCSS', 26, 1], ['SIGNAL', 27, 1]].map(([n, o, s]) => `<${n}><Offset>${o}</Offset><Size>${s}</Size><Format>${s === 3 ? 'X=F8;Y=F8;Z=F8;' : n === 'SIGNAL' ? 'I8' : 'F8'}</Format></${n}>`).join('')}</PVP><SupportArray><IAZArray><Identifier>IAZ</Identifier><ElementFormat>IAZ=F4;</ElementFormat><X0>-30</X0><Y0>-30</Y0><XSS>30</XSS><YSS>30</YSS></IAZArray></SupportArray><Dwell><NumCODTimes>1</NumCODTimes><CODTime><Identifier>COD</Identifier><CODTimePoly order1="0" order2="0"><Coef exponent1="0" exponent2="0">${e(cod)}</Coef></CODTimePoly></CODTime><NumDwellTimes>1</NumDwellTimes><DwellTime><Identifier>DWELL</Identifier><DwellTimePoly order1="0" order2="0"><Coef exponent1="0" exponent2="0">${e(dwell)}</Coef></DwellTimePoly></DwellTime></Dwell><ReferenceGeometry><SRP><ECF>${xyz(srp)}</ECF><IAC><X>0</X><Y>0</Y><Z>0</Z></IAC></SRP><ReferenceTime>${e(tRef)}</ReferenceTime><SRPCODTime>${e(cod)}</SRPCODTime><SRPDwellTime>${e(dwell)}</SRPDwellTime><Monostatic><ARPPos>${xyz(arp)}</ARPPos><ARPVel>${xyz(varp)}</ARPVel><SideOfTrack>${look > 0 ? 'L' : 'R'}</SideOfTrack><SlantRange>${e(rArp)}</SlantRange><GroundRange>${e(nrm(srp) * ea)}</GroundRange><DopplerConeAngle>${e(deg(dca))}</DopplerConeAngle><GrazeAngle>${e(deg(graz))}</GrazeAngle><IncidenceAngle>${e(90 - deg(graz))}</IncidenceAngle><AzimuthAngle>${e(((deg(azim) % 360) + 360) % 360)}</AzimuthAngle><TwistAngle>${e(deg(twst))}</TwistAngle><SlopeAngle>${e(deg(slope))}</SlopeAngle><LayoverAngle>${e(((deg(lo) % 360) + 360) % 360)}</LayoverAngle></Monostatic></ReferenceGeometry></CPHD>`;
  const xb = Buffer.from(xml, 'utf8');
  const support = Buffer.alloc(9 * 4);
  for (let k = 0; k < 9; k++) support.writeFloatBE(h0 + k, 4 * k);
  const sig = Buffer.alloc(nv * ns * 4);
  for (let v = 0; v < nv; v++)
    for (let s = 0; s < ns; s++) {
      // A point target off the scene centre: a linear phase in samples and vectors.
      const ph = 0.37 * s + 0.11 * v;
      sig.writeInt16BE(Math.round(800 * Math.cos(ph)), 4 * (v * ns + s));
      sig.writeInt16BE(Math.round(800 * Math.sin(ph)), 4 * (v * ns + s) + 2);
    }
  const al = (x) => Math.ceil(x / 8) * 8;
  const xo = 1024;
  const sup = al(xo + xb.length + 2);
  const po = al(sup + support.length);
  const go = al(po + pvp.length);
  const head = `CPHD/1.0.1\nXML_BLOCK_SIZE := ${xb.length}\nXML_BLOCK_BYTE_OFFSET := ${xo}\nSUPPORT_BLOCK_SIZE := ${support.length}\nSUPPORT_BLOCK_BYTE_OFFSET := ${sup}\nPVP_BLOCK_SIZE := ${pvp.length}\nPVP_BLOCK_BYTE_OFFSET := ${po}\nSIGNAL_BLOCK_SIZE := ${sig.length}\nSIGNAL_BLOCK_BYTE_OFFSET := ${go}\nCLASSIFICATION := UNCLASSIFIED\nRELEASE_INFO := UNRESTRICTED\n\f\n`;
  const file = Buffer.alloc(go + sig.length);
  file.write(head, 0, 'latin1');
  xb.copy(file, xo);
  file.write('\f\n', xo + xb.length, 'latin1');
  support.copy(file, sup);
  pvp.copy(file, po);
  sig.copy(file, go);
  writeFileSync(join(out, 'cphd-1.0.1-spot.cphd'), file);
  truth.cphd = { nv, ns, format: 'CI4', fx: [fx1, fx2], iacp: cs.map((c) => [c[0], c[1]]), iarp: [lat0, lon0, h0], first: [800, 0], refTime: tRef, graze: deg(graz), side: look > 0 ? 'L' : 'R' };
  return ['cphd-1.0.1-spot.cphd'];
}

// ---------------------------------------------------------------- UAVSAR
/**
 * A PolSAR job in the UAVSAR layout: an .ann annotation; GRD HHHH (REAL*4) and HHVV (COMPLEX) on a
 * 0.0002° equiangular grid; MLC HHHH and an SLC HH in slant range; and a .dat that is refused by name.
 * Values follow from (row, col), so a reader's window can be checked anywhere.
 */
function uavsarFixtures(out, truth) {
  const stem = 'FXTest_00001_21001_001_261001_L090';
  const grd = { rows: 40, cols: 64, lat: 36.2, lon: -115.3, d: 0.0002 };
  const mlc = { rows: 30, cols: 20 };
  const slc = { rows: 60, cols: 40 };
  const real = (r, c) => 0.01 * (1 + r) + 0.001 * c;
  const write = (name, rows, cols, complex) => {
    const b = Buffer.alloc(rows * cols * (complex ? 8 : 4));
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (complex) {
          b.writeFloatLE(real(r, c), 8 * i);
          b.writeFloatLE(-0.5 * real(r, c), 8 * i + 4);
        } else b.writeFloatLE(real(r, c), 4 * i);
      }
    writeFileSync(join(out, name), b);
    return name;
  };
  const files = [
    write(`${stem}HHHH_CX_01.grd`, grd.rows, grd.cols, false),
    write(`${stem}HHVV_CX_01.grd`, grd.rows, grd.cols, true),
    write(`${stem}HHHH_CX_01.mlc`, mlc.rows, mlc.cols, false),
    write(`${stem}HH_CX_01.slc`, slc.rows, slc.cols, true),
  ];
  writeFileSync(join(out, `${stem}_CX_01.dat`), Buffer.alloc(mlc.rows * mlc.cols * 10));
  files.push(`${stem}_CX_01.dat`);
  const L = (k, u, v, c = '') => `${k.padEnd(50)}(${u})`.padEnd(64) + `= ${String(v).padEnd(22)}${c ? `; ${c}` : ''}`;
  const lines = [
    '; FX-21 synthetic UAVSAR PolSAR annotation (GIS Workbench build/fixtures/fx21/sar.mjs)',
    L('UAVSAR PolSAR Annotation File Version Number', '-', '2.0'),
    'Site Description = FX-21 synthetic, Las Vegas',
    `slcHH   = ${stem}HH_CX_01.slc                ; File Size ${slc.rows * slc.cols * 8} bytes`,
    `mlcHHHH = ${stem}HHHH_CX_01.mlc              ; File Size ${mlc.rows * mlc.cols * 4} bytes`,
    `dat     = ${stem}_CX_01.dat`,
    `grdHHHH = ${stem}HHHH_CX_01.grd              ; File Size ${grd.rows * grd.cols * 4} bytes`,
    `grdHHVV = ${stem}HHVV_CX_01.grd`,
    ...[['slc_mag', slc, 8, 'COMPLEX_MAGNITUDE', 'SCX'], ['mlc_pwr', mlc, 4, 'REAL*4', 'SCX'], ['mlc_mag', mlc, 8, 'COMPLEX_MAGNITUDE', 'SCX'], ['dat', mlc, 10, 'COMPRESSED_STOKES', 'SCX'], ['grd_pwr', grd, 4, 'REAL*4', 'EQA'], ['grd_mag', grd, 8, 'COMPLEX_MAGNITUDE', 'EQA']].flatMap(([l, g, vs, fm, pj]) => [
      L(`${l}.set_rows`, 'pixels', g.rows),
      L(`${l}.set_cols`, 'pixels', g.cols),
      L(`${l}.set_proj`, '&', pj),
      L(`${l}.val_size`, 'bytes', vs),
      L(`${l}.val_frmt`, '&', fm),
      ...(pj === 'EQA' ? [L(`${l}.row_addr`, 'deg', grd.lat, 'Center Latitude of Upper Left Pixel'), L(`${l}.col_addr`, 'deg', grd.lon), L(`${l}.row_mult`, 'deg/pixel', -grd.d), L(`${l}.col_mult`, 'deg/pixel', grd.d)] : [L(`${l}.row_mult`, 'm/pixel', 7.2), L(`${l}.col_mult`, 'm/pixel', 5)]),
    ]),
    L('set_hddr', 'bytes', 0),
    L('val_endi', '&', 'LITTLE ENDIAN'),
    L('Acquisition Mode', '&', 'PolSAR'),
    L('Start Time of Acquisition', '&', '1-Oct-2026 18:00:00 UTC'),
    L('Stop Time of Acquisition', '&', '1-Oct-2026 18:05:00 UTC'),
    L('Look Direction', '&', 'Left'),
    L('Center Wavelength', 'cm', 23.84),
    L('Approximate Upper Left Latitude', 'deg', grd.lat),
    L('Approximate Upper Left Longitude', 'deg', grd.lon),
    L('Approximate Upper Right Latitude', 'deg', grd.lat),
    L('Approximate Upper Right Longitude', 'deg', grd.lon + grd.cols * grd.d),
    L('Approximate Lower Right Latitude', 'deg', grd.lat - grd.rows * grd.d),
    L('Approximate Lower Right Longitude', 'deg', grd.lon + grd.cols * grd.d),
    L('Approximate Lower Left Latitude', 'deg', grd.lat - grd.rows * grd.d),
    L('Approximate Lower Left Longitude', 'deg', grd.lon),
    L('GRD Data Units', '&', 'linear power'),
  ];
  writeFileSync(join(out, `${stem}_CX_01.ann`), `${lines.join('\r\n')}\r\n`);
  files.push(`${stem}_CX_01.ann`);
  truth.uavsar = { stem, grd, mlc, slc, sample: { r: 7, c: 11, value: real(7, 11) }, gt: [grd.lon - grd.d / 2, grd.d, 0, grd.lat + grd.d / 2, 0, -grd.d] };
  return files;
}

// ---------------------------------------------------------------- swath geolocation arrays
/** Latitude/longitude of a curved pushbroom swath at pixel (x, y) centres: rotated, with scan curvature. */
export function swathLatLon(x, y, { lat0, lon0 }) {
  const fx = x + 0.5;
  const fy = y + 0.5;
  const lat = lat0 + 0.009 * fy - 0.0021 * fx + 8e-7 * fx * fx;
  const lon = lon0 + 0.0113 * fx + 0.0032 * fy + 1.5e-6 * fx * fy;
  return [lat, ((lon + 540) % 360) - 180];
}

async function swathFixtures(out, truth) {
  await h5wasm.ready;
  const W = 96;
  const H = 128;
  const NB = 4;
  const files = [];
  const write = (name, fill) => {
    const tmp = join(out, `${name}.tmp`);
    const f = new h5wasm.File(tmp, 'w');
    fill(f);
    f.close();
    writeFileSync(join(out, name), readFileSync(tmp));
    unlinkSync(tmp);
    files.push(name);
  };
  const cases = { 'swath-vegas.nc': { lat0: 36.0, lon0: -115.6, sub: 1 }, 'swath-antimeridian.nc': { lat0: -16.5, lon0: 179.4, sub: 1 }, 'swath-subsampled.nc': { lat0: 36.0, lon0: -115.6, sub: 4 } };
  truth.swath = { W, H, NB, cases: {} };
  for (const [name, c] of Object.entries(cases)) {
    const lw = W / c.sub;
    const lh = H / c.sub;
    const lat = new Float32Array(lw * lh);
    const lon = new Float32Array(lw * lh);
    for (let r = 0; r < lh; r++)
      for (let q = 0; q < lw; q++) {
        // A subsampled array holds the position of the centre of each sub × sub block.
        const [a, o] = swathLatLon((q + 0.5) * c.sub - 0.5, (r + 0.5) * c.sub - 0.5, c);
        lat[r * lw + q] = a;
        lon[r * lw + q] = o;
      }
    // A fill value at one node, as real swaths have at their edges.
    lat[3 * lw + 2] = -999;
    lon[3 * lw + 2] = -999;
    write(name, (f) => {
      f.create_attribute('title', `GIS Workbench FX-21 synthetic swath (${name})`);
      f.create_attribute('Conventions', 'CF-1.8');
      const g = f.create_group('geophysical_data');
      const cube = new Float32Array(H * W * NB);
      for (let r = 0; r < H; r++) for (let q = 0; q < W; q++) for (let b = 0; b < NB; b++) cube[(r * W + q) * NB + b] = 0.01 * (b + 1) + 1e-4 * r + 1e-5 * q;
      g.create_dataset({ name: 'Rrs', data: cube, shape: [H, W, NB], dtype: '<f4' });
      const n = f.create_group('navigation_data');
      for (const [k, v] of [['latitude', lat], ['longitude', lon]]) {
        const ds = n.create_dataset({ name: k, data: v, shape: [lh, lw], dtype: '<f4' });
        ds.create_attribute('_FillValue', -999, null, '<f4');
        ds.create_attribute('units', k === 'latitude' ? 'degrees_north' : 'degrees_east');
      }
    });
    truth.swath.cases[name] = { ...c, probes: [[10, 20], [50.5, 64.25], [95, 127], [0, 0]].map(([x, y]) => ({ x: x + 0.5, y: y + 0.5, ll: swathLatLon(x, y, c) })) };
  }
  return files;
}

// ---------------------------------------------------------------- Sentinel-1 SAFE skeleton
/** A little-endian TIFF of CInt16 samples (SampleFormat 5, 32 bits), one strip, no georeferencing. */
function cint16Tiff(w, h, value) {
  const tags = [[256, 3, w], [257, 3, h], [258, 3, 32], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 3, h], [279, 4, w * h * 4], [284, 3, 1], [339, 3, 5]];
  const ifd = 8;
  const data = ifd + 2 + tags.length * 12 + 4;
  const b = Buffer.alloc(data + w * h * 4);
  b.write('II', 0, 'latin1');
  b.writeUInt16LE(42, 2);
  b.writeUInt32LE(ifd, 4);
  b.writeUInt16LE(tags.length, ifd);
  tags.forEach(([t, ty, v], k) => {
    const o = ifd + 2 + 12 * k;
    b.writeUInt16LE(t, o);
    b.writeUInt16LE(ty, o + 2);
    b.writeUInt32LE(1, o + 4);
    if (ty === 3) b.writeUInt16LE(t === 273 ? 0 : v, o + 8);
    else b.writeUInt32LE(t === 273 ? data : v, o + 8);
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [re, im] = value(x, y);
      b.writeInt16LE(re, data + 4 * (y * w + x));
      b.writeInt16LE(im, data + 4 * (y * w + x) + 2);
    }
  return b;
}

/**
 * An IW SLC SAFE folder: two sub-swaths × VH/VV, two bursts of 20 lines × 30 samples each, the manifest,
 * annotation (bursts with valid ranges, a 3 × 4 geolocation grid), calibration (σ⁰/β⁰/γ/DN vectors) and
 * noise (range vectors and an azimuth block) XML, and CInt16 measurement TIFFs.
 */
function safeFixture(out, truth) {
  const root = join(out, 'S1A_IW_SLC__FX21.SAFE');
  for (const d of ['annotation/calibration', 'measurement']) mkdirSync(join(root, d), { recursive: true });
  const W = 30;
  const LPB = 20;
  const NB = 2;
  const H = LPB * NB;
  const files = [];
  const objs = [];
  const units = [];
  const dmd = [];
  const t0 = '2026-10-01T13:44:05.000000';
  let k = 0;
  for (const sw of ['IW1', 'IW2']) {
    for (const pol of ['VH', 'VV']) {
      k++;
      const stem = `s1a-${sw.toLowerCase()}-slc-${pol.toLowerCase()}-20261001t134405-20261001t134410-099999-0abcde-00${k}`;
      const lon0 = -115.4 + (sw === 'IW2' ? 0.35 : 0);
      const lines = [0, LPB, H - 1];
      const pixels = [0, 10, 20, W - 1];
      const grid = lines.flatMap((l) => pixels.map((p) => ({ l, p, lat: 36.3 - 0.0009 * l + 0.0001 * p, lon: lon0 - 0.0002 * l - 0.004 * p, h: 600 + p })));
      const valid = (n) => Array.from({ length: LPB }, (_, i) => (i < 2 || i >= 18 ? -1 : n)).join(' ');
      const ann = `<?xml version="1.0" encoding="UTF-8"?>\n<product><adsHeader><missionId>S1A</missionId><productType>SLC</productType><polarisation>${pol}</polarisation><mode>IW</mode><swath>${sw}</swath><startTime>${t0}</startTime><stopTime>2026-10-01T13:44:10.000000</stopTime><absoluteOrbitNumber>99999</absoluteOrbitNumber><missionDataTakeId>703710</missionDataTakeId><imageNumber>00${k}</imageNumber></adsHeader><generalAnnotation><productInformation><pass>Descending</pass><radarFrequency>5.405000454334350e+09</radarFrequency></productInformation></generalAnnotation><imageAnnotation><imageInformation><slantRangeTime>5.3e-03</slantRangeTime><rangePixelSpacing>2.329562e+00</rangePixelSpacing><azimuthPixelSpacing>1.396719e+01</azimuthPixelSpacing><azimuthTimeInterval>2.055556e-03</azimuthTimeInterval><pixelValue>Complex</pixelValue><outputPixels>16 bit Signed Integer</outputPixels><numberOfSamples>${W}</numberOfSamples><numberOfLines>${H}</numberOfLines><incidenceAngleMidSwath>3.4e+01</incidenceAngleMidSwath></imageInformation></imageAnnotation><swathTiming><linesPerBurst>${LPB}</linesPerBurst><samplesPerBurst>${W}</samplesPerBurst><burstList count="${NB}">${Array.from({ length: NB }, (_, b) => `<burst><azimuthTime>2026-10-01T13:44:0${5 + b}.000000</azimuthTime><byteOffset>${8 + b * LPB * W * 4}</byteOffset><firstValidSample count="${LPB}">${valid(1)}</firstValidSample><lastValidSample count="${LPB}">${valid(W - 2)}</lastValidSample><burstId absolute="${117050040 + b}">${370303 + b}</burstId></burst>`).join('')}</burstList></swathTiming><geolocationGrid><geolocationGridPointList count="${grid.length}">${grid.map((g) => `<geolocationGridPoint><azimuthTime>${t0}</azimuthTime><slantRangeTime>5.3e-03</slantRangeTime><line>${g.l}</line><pixel>${g.p}</pixel><latitude>${g.lat}</latitude><longitude>${g.lon}</longitude><height>${g.h}</height><incidenceAngle>${31 + g.p / 10}</incidenceAngle><elevationAngle>27</elevationAngle></geolocationGridPoint>`).join('')}</geolocationGridPointList></geolocationGrid></product>\n`;
      const cl = [-5, 15, 35, 45];
      const cp = [0, 15, W - 1];
      const vec = (f) => cp.map((p, i) => f(p, i).toFixed(4)).join(' ');
      const cal = `<?xml version="1.0" encoding="UTF-8"?>\n<calibration><adsHeader><missionId>S1A</missionId><polarisation>${pol}</polarisation><swath>${sw}</swath></adsHeader><calibrationInformation><absoluteCalibrationConstant>1.000000e+00</absoluteCalibrationConstant></calibrationInformation><calibrationVectorList count="${cl.length}">${cl.map((l, j) => `<calibrationVector><azimuthTime>${t0}</azimuthTime><line>${l}</line><pixel count="${cp.length}">${cp.join(' ')}</pixel><sigmaNought count="${cp.length}">${vec((p) => 500 + p + j)}</sigmaNought><betaNought count="${cp.length}">${vec(() => 400)}</betaNought><gamma count="${cp.length}">${vec((p) => 450 + p + j)}</gamma><dn count="${cp.length}">${vec(() => 400)}</dn></calibrationVector>`).join('')}</calibrationVectorList></calibration>\n`;
      const noise = `<?xml version="1.0" encoding="UTF-8"?>\n<noise><adsHeader><missionId>S1A</missionId><polarisation>${pol}</polarisation><swath>${sw}</swath></adsHeader><noiseRangeVectorList count="2">${[0, LPB].map((l) => `<noiseRangeVector><azimuthTime>${t0}</azimuthTime><line>${l}</line><pixel count="3">0 15 ${W - 1}</pixel><noiseRangeLut count="3">${[30, 20 + l / 10, 25].join(' ')}</noiseRangeLut></noiseRangeVector>`).join('')}</noiseRangeVectorList><noiseAzimuthVectorList count="1"><noiseAzimuthVector><swath>${sw}</swath><firstAzimuthLine>0</firstAzimuthLine><firstRangeSample>0</firstRangeSample><lastAzimuthLine>${H - 1}</lastAzimuthLine><lastRangeSample>${W - 1}</lastRangeSample><line count="3">0 ${LPB} ${H - 1}</line><noiseAzimuthLut count="3">1 0.9 1.1</noiseAzimuthLut></noiseAzimuthVector></noiseAzimuthVectorList></noise>\n`;
      writeFileSync(join(root, 'annotation', `${stem}.xml`), ann);
      writeFileSync(join(root, 'annotation', 'calibration', `calibration-${stem}.xml`), cal);
      writeFileSync(join(root, 'annotation', 'calibration', `noise-${stem}.xml`), noise);
      writeFileSync(join(root, 'measurement', `${stem}.tiff`), cint16Tiff(W, H, (x, y) => [100 + x + (pol === 'VV' ? 50 : 0), -(y % LPB)]));
      files.push(`annotation/${stem}.xml`, `annotation/calibration/calibration-${stem}.xml`, `annotation/calibration/noise-${stem}.xml`, `measurement/${stem}.tiff`);
      const id = stem.replace(/-/g, '');
      units.push(...[['products', 'Metadata Unit', 's1Level1ProductSchema'], ['noises', 'Metadata Unit', 's1Level1NoiseSchema'], ['calibrations', 'Metadata Unit', 's1Level1CalibrationSchema'], ['', 'Measurement Data Unit', 's1Level1MeasurementSchema']].map(([pre, u, rep]) => `<xfdu:contentUnit unitType="${u}" repID="${rep}"${pre ? '' : ` dmdID="products${id}Annotation noises${id}Annotation calibrations${id}Annotation"`}><dataObjectPointer dataObjectID="${pre}${id}"/></xfdu:contentUnit>`));
      dmd.push(...['products', 'noises', 'calibrations'].map((pre) => `<metadataObject ID="${pre}${id}Annotation" classification="DESCRIPTION" category="DMD"><dataObjectPointer dataObjectID="${pre}${id}"/></metadataObject>`));
      objs.push(`<dataObject ID="products${id}" repID="s1Level1ProductSchema"><byteStream mimeType="text/xml" size="${ann.length}"><fileLocation locatorType="URL" href="./annotation/${stem}.xml"/></byteStream></dataObject>`, `<dataObject ID="calibrations${id}" repID="s1Level1CalibrationSchema"><byteStream mimeType="text/xml"><fileLocation locatorType="URL" href="./annotation/calibration/calibration-${stem}.xml"/></byteStream></dataObject>`, `<dataObject ID="noises${id}" repID="s1Level1NoiseSchema"><byteStream mimeType="text/xml"><fileLocation locatorType="URL" href="./annotation/calibration/noise-${stem}.xml"/></byteStream></dataObject>`, `<dataObject ID="${id}" repID="s1Level1MeasurementSchema"><byteStream mimeType="application/octet-stream"><fileLocation locatorType="URL" href="./measurement/${stem}.tiff"/></byteStream></dataObject>`);
    }
  }
  const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<xfdu:XFDU xmlns:xfdu="urn:ccsds:schema:xfdu:1" xmlns:safe="http://www.esa.int/safe/sentinel-1.0" xmlns:s1sarl1="http://www.esa.int/safe/sentinel-1.0/sentinel-1/sar/level-1" xmlns:gml="http://www.opengis.net/gml" version="esa/safe/sentinel-1.0/sentinel-1/sar/level-1/slc/standard/iwdp"><informationPackageMap><xfdu:contentUnit unitType="SAFE Archive Information Package" textInfo="Sentinel-1 IW Level-1 SLC Product" dmdID="acquisitionPeriod platform generalProductInformation measurementOrbitReference measurementFrameSet">${units.join('')}</xfdu:contentUnit></informationPackageMap><metadataSection><metadataObject ID="platform"><metadataWrap><xmlData><safe:platform><safe:familyName>SENTINEL-1</safe:familyName><safe:number>A</safe:number><safe:instrument><safe:extension><s1sarl1:instrumentMode><s1sarl1:mode>IW</s1sarl1:mode><s1sarl1:swath>IW1</s1sarl1:swath><s1sarl1:swath>IW2</s1sarl1:swath></s1sarl1:instrumentMode></safe:extension></safe:instrument></safe:platform></xmlData></metadataWrap></metadataObject><metadataObject ID="generalProductInformation"><metadataWrap><xmlData><s1sarl1:standAloneProductInformation><s1sarl1:productClass>S</s1sarl1:productClass><s1sarl1:productType>SLC</s1sarl1:productType><s1sarl1:transmitterReceiverPolarisation>VV</s1sarl1:transmitterReceiverPolarisation><s1sarl1:transmitterReceiverPolarisation>VH</s1sarl1:transmitterReceiverPolarisation></s1sarl1:standAloneProductInformation></xmlData></metadataWrap></metadataObject><metadataObject ID="acquisitionPeriod"><metadataWrap><xmlData><safe:acquisitionPeriod><safe:startTime>${t0}</safe:startTime><safe:stopTime>2026-10-01T13:44:10.000000</safe:stopTime></safe:acquisitionPeriod></xmlData></metadataWrap></metadataObject><metadataObject ID="measurementOrbitReference"><metadataWrap><xmlData><safe:orbitReference><safe:orbitNumber type="start">99999</safe:orbitNumber><safe:relativeOrbitNumber type="start">173</safe:relativeOrbitNumber><safe:extension><s1:orbitProperties xmlns:s1="http://www.esa.int/safe/sentinel-1.0/sentinel-1"><s1:pass>DESCENDING</s1:pass></s1:orbitProperties></safe:extension></safe:orbitReference></xmlData></metadataWrap></metadataObject><metadataObject ID="measurementFrameSet"><metadataWrap><xmlData><safe:frameSet><safe:frame><safe:footPrint srsName="http://www.opengis.net/gml/srs/epsg.xml#4326"><gml:coordinates>36.26,-115.53 36.30,-115.40 36.30,-114.93 36.26,-115.06</gml:coordinates></safe:footPrint></safe:frame></safe:frameSet></xmlData></metadataWrap></metadataObject>${dmd.join('')}</metadataSection><dataObjectSection>${objs.join('')}</dataObjectSection></xfdu:XFDU>\n`;
  writeFileSync(join(root, 'manifest.safe'), manifest);
  files.push('manifest.safe');
  truth.safe = { dir: 'S1A_IW_SLC__FX21.SAFE', W, H, LPB, bursts: NB, swaths: ['IW1', 'IW2'], pols: ['VH', 'VV'], measurements: files.filter((f) => f.endsWith('.tiff')) };
  return files.map((f) => `S1A_IW_SLC__FX21.SAFE/${f}`);
}

export async function generate(out) {
  mkdirSync(out, { recursive: true });
  const truth = {};
  const files = [...bpfFixtures(out, truth), ...cphdFixture(out, truth), ...uavsarFixtures(out, truth), ...(await swathFixtures(out, truth)), ...safeFixture(out, truth)];
  writeFileSync(join(out, 'sar_truth.json'), JSON.stringify(truth, null, 1));
  files.push('sar_truth.json');
  return files;
}
