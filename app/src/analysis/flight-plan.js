// Route and flight planning (REQ-GAP-74), DOM-free: leg distance, course and time on the WGS 84
// ellipsoid, the altitude profile against terrain with clearance warnings, and the KML and GPX
// writers. XML reading is in features/flight-plan.js (it needs DOMParser).
//
// A plan: {name, waypoints: [{name, lat, lon}], legs: [{alt, speed}], clearance, departure}. Leg i
// runs from waypoint i to i + 1 at its altitude (m above mean sea level, EGM96) and ground speed
// (m/s); the aircraft changes level at the waypoints. `geod` is {inverse(lat1, lon1, lat2, lon2) →
// {distance, azi1, azi2}, direct(lat, lon, azi, s) → {lat, lon}} (the app core, or GeographicLib).

import { N_ } from '../i18n/index.js';

export const FT = 0.3048;
export const NM = 1852;
export const KT = NM / 3600;

const norm360 = (a) => ((a % 360) + 360) % 360;

/** Problems that stop a plan from being computed (English templates with params). */
export function planProblems(plan) {
  const p = [];
  const w = plan?.waypoints ?? [];
  if (w.length < 2) p.push({ src: N_('A route needs at least two waypoints'), params: null });
  w.forEach((q, i) => {
    if (!Number.isFinite(q.lat) || !Number.isFinite(q.lon) || Math.abs(q.lat) > 90 || Math.abs(q.lon) > 180) p.push({ src: N_('Waypoint {n} has no valid position'), params: { n: i + 1 } });
  });
  (plan?.legs ?? []).forEach((l, i) => {
    if (!(l.speed > 0)) p.push({ src: N_('Leg {n} needs a speed above zero'), params: { n: i + 1 } });
    if (!Number.isFinite(l.alt)) p.push({ src: N_('Leg {n} needs an altitude'), params: { n: i + 1 } });
  });
  if (w.length >= 2 && (plan.legs?.length ?? 0) !== w.length - 1) p.push({ src: N_('The route has {w} waypoints but {l} legs'), params: { w: w.length, l: plan.legs?.length ?? 0 } });
  return p;
}

/** Legs padded or cut to the waypoints, new ones taking `defaults` {alt, speed} (or the last leg's values). */
export function fitLegs(waypoints, legs = [], defaults = {}) {
  const out = [];
  for (let i = 0; i < Math.max(0, waypoints.length - 1); i++) out.push(legs[i] ? { ...legs[i] } : { alt: legs.at(-1)?.alt ?? defaults.alt ?? 1500 * FT, speed: legs.at(-1)?.speed ?? defaults.speed ?? 100 * KT });
  return out;
}

/**
 * Leg table: per leg {from, to, distance m, course °T (initial), finalCourse °T, time s, cumDistance,
 * cumTime, eta (ISO or null)}; totals {distance, time}.
 */
export function legTable(plan, geod) {
  const w = plan.waypoints;
  const t0 = plan.departure ? Date.parse(plan.departure) : NaN;
  let cd = 0;
  let ct = 0;
  const legs = [];
  for (let i = 0; i + 1 < w.length; i++) {
    const inv = geod.inverse(w[i].lat, w[i].lon, w[i + 1].lat, w[i + 1].lon);
    const L = plan.legs[i];
    const time = inv.distance / L.speed;
    cd += inv.distance;
    ct += time;
    legs.push({ i, from: w[i].name, to: w[i + 1].name, distance: inv.distance, course: norm360(inv.azi1), finalCourse: norm360(inv.azi2), alt: L.alt, speed: L.speed, time, cumDistance: cd, cumTime: ct, eta: Number.isFinite(t0) ? new Date(t0 + ct * 1000).toISOString() : null });
  }
  return { legs, distance: cd, time: ct };
}

/**
 * Altitude profile against terrain: samples every `step` m along each geodesic leg (and at every
 * waypoint), with the ground height (m MSL) from `ground(lat, lon)` (NaN or null where no terrain
 * is loaded). Warnings, one per leg and kind: 'terrain' (the ground reaches or passes the leg
 * altitude), 'clearance' (above the ground by less than plan.clearance), 'nodata' (part of the leg
 * has no terrain). Returns {samples: [{d, leg, lat, lon, ground, alt}], legs: [{minClearance, at,
 * nodata}], warnings: [{leg, kind, d, clearance, lat, lon}], total}.
 */
export function terrainProfile(plan, geod, ground, { step = null, maxSamples = 20000 } = {}) {
  const w = plan.waypoints;
  const segs = [];
  let total = 0;
  for (let i = 0; i + 1 < w.length; i++) {
    const inv = geod.inverse(w[i].lat, w[i].lon, w[i + 1].lat, w[i + 1].lon);
    segs.push({ i, a: w[i], azi: inv.azi1, len: inv.distance, from: total });
    total += inv.distance;
  }
  const st = step ?? Math.min(200, Math.max(15, total / 4000));
  const samples = [];
  const per = [];
  const need = plan.clearance ?? 0;
  for (const s of segs) {
    const n = Math.max(1, Math.min(Math.ceil(s.len / st), Math.ceil(maxSamples / segs.length)));
    const alt = plan.legs[s.i].alt;
    const L = { minClearance: Infinity, at: null, nodata: 0, samples: 0 };
    for (let k = 0; k <= n; k++) {
      const d = (s.len * k) / n;
      const p = k === 0 ? { lat: s.a.lat, lon: s.a.lon } : k === n ? { lat: w[s.i + 1].lat, lon: w[s.i + 1].lon } : geod.direct(s.a.lat, s.a.lon, s.azi, d);
      const g = ground(p.lat, p.lon);
      const gz = Number.isFinite(g) ? g : NaN;
      samples.push({ d: s.from + d, leg: s.i, lat: p.lat, lon: p.lon, ground: gz, alt });
      L.samples++;
      if (!Number.isFinite(gz)) {
        L.nodata++;
        continue;
      }
      const c = alt - gz;
      if (c < L.minClearance) {
        L.minClearance = c;
        L.at = { d: s.from + d, lat: p.lat, lon: p.lon, ground: gz };
      }
    }
    per.push(L);
  }
  const warnings = [];
  per.forEach((L, i) => {
    if (L.at && L.minClearance <= 0) warnings.push({ leg: i, kind: 'terrain', d: L.at.d, clearance: L.minClearance, lat: L.at.lat, lon: L.at.lon });
    else if (L.at && L.minClearance < need) warnings.push({ leg: i, kind: 'clearance', d: L.at.d, clearance: L.minClearance, lat: L.at.lat, lon: L.at.lon });
    if (L.nodata) warnings.push({ leg: i, kind: 'nodata', d: NaN, clearance: NaN, lat: NaN, lon: NaN, fraction: L.nodata / L.samples });
  });
  return { samples, legs: per, warnings, total, step: st };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const ll = (q) => `${q.lon.toFixed(8)},${q.lat.toFixed(8)}`;

/** The plan as GIS Workbench's own JSON (kept in KML ExtendedData and GPX for a lossless round trip). */
export function planJson(plan) {
  return JSON.stringify({ format: 'gw-flightplan/1', name: plan.name ?? '', clearance: plan.clearance ?? null, departure: plan.departure ?? null, waypoints: plan.waypoints.map((q) => ({ name: q.name, lat: +q.lat.toFixed(8), lon: +q.lon.toFixed(8) })), legs: plan.legs.map((l) => ({ alt: +l.alt.toFixed(2), speed: +l.speed.toFixed(3) })) });
}

/**
 * KML 2.2: a waypoint placemark each (absolute altitude: the altitude of the leg it starts, the
 * last one the last leg's) and the flight path as an absolute LineString that changes level at the
 * waypoints. KML altitudes are above mean sea level, as the plan's.
 */
export function toKml(plan) {
  const w = plan.waypoints;
  const altAt = (i) => plan.legs[Math.min(i, plan.legs.length - 1)].alt;
  const path = [];
  for (let i = 0; i < w.length; i++) {
    if (i > 0) path.push(`${ll(w[i])},${plan.legs[i - 1].alt.toFixed(2)}`);
    if (i < w.length - 1) path.push(`${ll(w[i])},${plan.legs[i].alt.toFixed(2)}`);
  }
  const wpts = w.map((q, i) => `<Placemark><name>${esc(q.name)}</name><styleUrl>#wp</styleUrl><Point><altitudeMode>absolute</altitudeMode><coordinates>${ll(q)},${altAt(i).toFixed(2)}</coordinates></Point></Placemark>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(plan.name)}</name><Style id="wp"><IconStyle><color>ffff00ff</color></IconStyle></Style><Style id="route"><LineStyle><color>ffff00ff</color><width>3</width></LineStyle></Style><Placemark><name>${esc(plan.name)}</name><styleUrl>#route</styleUrl><ExtendedData><Data name="gw:flightplan"><value>${esc(planJson(plan))}</value></Data></ExtendedData><LineString><altitudeMode>absolute</altitudeMode><coordinates>${path.join(' ')}</coordinates></LineString></Placemark>${wpts.join('')}</Document></kml>\n`;
}

/**
 * GPX 1.1 route: an rtept per waypoint whose <ele> is the altitude of the leg it starts (MSL; the
 * last point takes the last leg's), with the leg's ground speed in a GIS Workbench extension.
 */
export function toGpx(plan) {
  const w = plan.waypoints;
  const pts = w.map((q, i) => {
    const L = plan.legs[Math.min(i, plan.legs.length - 1)];
    const ext = i < plan.legs.length ? `<extensions><gw:speed>${L.speed.toFixed(3)}</gw:speed></extensions>` : '';
    return `    <rtept lat="${q.lat.toFixed(8)}" lon="${q.lon.toFixed(8)}"><ele>${L.alt.toFixed(2)}</ele><name>${esc(q.name)}</name>${ext}</rtept>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GIS Workbench" xmlns="http://www.topografix.com/GPX/1/1" xmlns:gw="https://gisworkbench.invalid/gpx/1">\n  <rte><name>${esc(plan.name)}</name>\n${pts.join('\n')}\n  </rte>\n</gpx>\n`;
}

/** A plan from GIS Workbench JSON (KML ExtendedData), checked; null when it is not one. */
export function planFromJson(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (o?.format !== 'gw-flightplan/1' || !Array.isArray(o.waypoints) || !Array.isArray(o.legs)) return null;
  const plan = {
    name: String(o.name ?? ''),
    clearance: Number.isFinite(o.clearance) ? o.clearance : null,
    departure: typeof o.departure === 'string' && Number.isFinite(Date.parse(o.departure)) ? o.departure : null,
    waypoints: o.waypoints.slice(0, 5000).map((q, i) => ({ name: String(q?.name ?? `WP${i + 1}`).slice(0, 64), lat: Number(q?.lat), lon: Number(q?.lon) })),
    legs: o.legs.slice(0, 5000).map((l) => ({ alt: Number(l?.alt), speed: Number(l?.speed) })),
  };
  return planProblems(plan).length ? null : plan;
}

/**
 * A plan from route points read from GPX or KML: pts [{lat, lon, ele (m MSL or NaN), name, speed
 * (m/s or NaN)}]. Leg i takes point i's elevation (the convention of toGpx) and speed, falling back
 * to the next point's elevation and to `defaults`.
 */
export function planFromPoints(name, pts, defaults = {}) {
  const waypoints = pts.map((p, i) => ({ name: String(p.name || `WP${i + 1}`).slice(0, 64), lat: p.lat, lon: p.lon }));
  const legs = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const alt = Number.isFinite(pts[i].ele) ? pts[i].ele : Number.isFinite(pts[i + 1].ele) ? pts[i + 1].ele : defaults.alt ?? 1500 * FT;
    const speed = pts[i].speed > 0 ? pts[i].speed : defaults.speed ?? 100 * KT;
    legs.push({ alt, speed });
  }
  return { name, waypoints, legs, clearance: defaults.clearance ?? 500 * FT, departure: null };
}
