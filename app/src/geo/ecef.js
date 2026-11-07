// WGS 84 Earth-centred Earth-fixed ↔ geodetic in closed form, for code that runs without the core
// bundle (point-cloud parsing, the decode worker's CPHD geometry). gw-geodesy (core.geodetic/ecef) is
// the reference; tests/unit/bpf21.test.js checks these round-trip to 1e-9° and 0.1 mm.

/** WGS 84 ECEF (m) → [lat°, lon°, h m] (Heikkinen's closed form). */
export function ecefToGeodeticJs(X, Y, Z) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const b = a * (1 - f);
  const e2 = f * (2 - f);
  const ep2 = (a * a - b * b) / (b * b);
  const p = Math.hypot(X, Y);
  if (p < 1e-9) return [Z >= 0 ? 90 : -90, 0, Math.abs(Z) - b];
  const F = 54 * b * b * Z * Z;
  const G = p * p + (1 - e2) * Z * Z - e2 * (a * a - b * b);
  const c = (e2 * e2 * F * p * p) / (G * G * G);
  const s = Math.cbrt(1 + c + Math.sqrt(c * c + 2 * c));
  const P = F / (3 * (s + 1 / s + 1) ** 2 * G * G);
  const Q = Math.sqrt(1 + 2 * e2 * e2 * P);
  const r0 = (-P * e2 * p) / (1 + Q) + Math.sqrt(Math.max(0, 0.5 * a * a * (1 + 1 / Q) - (P * (1 - e2) * Z * Z) / (Q * (1 + Q)) - 0.5 * P * p * p));
  const U = Math.hypot(p - e2 * r0, Z);
  const V = Math.sqrt((p - e2 * r0) ** 2 + (1 - e2) * Z * Z);
  const z0 = (b * b * Z) / (a * V);
  const h = U * (1 - (b * b) / (a * V));
  return [(Math.atan((Z + ep2 * z0) / p) * 180) / Math.PI, (Math.atan2(Y, X) * 180) / Math.PI, h];
}

/** WGS 84 [lat°, lon°, h] → ECEF [X, Y, Z] m. */
export function geodeticToEcefJs(lat, lon, h) {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  const N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + h) * Math.sin(la)];
}
