#!/usr/bin/env node
// GIS Workbench: a usgscsm frame ISD on the Earth (WGS 84) for REQ-GAP-24's check of a CSM frame
// camera against GIS Workbench's own frame model (gw_sensor::frame). Every usgscsm test ISD is for
// another body (or a 10 m sphere); this one is a simple frame camera 600 km above 35° N, 117° W,
// tilted 3° to the north, 500 mm focal length, 0.01 mm pixels, 400 × 300, no distortion. Modelled on
// usgscsm's tests/data/orbitalFramer.json (public domain). Deterministic.
//
//   node build/csm/oracle/make-earth-isd.mjs fixtures/fx25/csm/isd/earthFramer.json

import { writeFileSync } from 'node:fs';

const A = 6378137;
const B = 6356752.314245;
const e2 = 1 - (B * B) / (A * A);
const D = Math.PI / 180;
const ecef = (lat, lon, h) => {
  const n = A / Math.sqrt(1 - e2 * Math.sin(lat * D) ** 2);
  return [(n + h) * Math.cos(lat * D) * Math.cos(lon * D), (n + h) * Math.cos(lat * D) * Math.sin(lon * D), (n * (1 - e2) + h) * Math.sin(lat * D)];
};
const [lat, lon, alt] = [35, -117, 600000];
const C = ecef(lat, lon, alt);
const east = [-Math.sin(lon * D), Math.cos(lon * D), 0];
const north = [-Math.sin(lat * D) * Math.cos(lon * D), -Math.sin(lat * D) * Math.sin(lon * D), Math.cos(lat * D)];
const up = [Math.cos(lat * D) * Math.cos(lon * D), Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D)];
const tilt = 3 * D;
// Sensor axes in ECEF: z (boresight) down, tilted toward north; x east; y = z × x (right-handed).
const c2 = up.map((u, i) => -Math.cos(tilt) * u + Math.sin(tilt) * north[i]);
const c0 = east;
const c1 = [c2[1] * c0[2] - c2[2] * c0[1], c2[2] * c0[0] - c2[0] * c0[2], c2[0] * c0[1] - c2[1] * c0[0]];
// j2000 (= body, identity body rotation) → sensor: the matrix with rows c0, c1, c2; its quaternion
// [w, x, y, z] (ALE order), by Shoemake's method.
const m = [c0, c1, c2];
const tr = m[0][0] + m[1][1] + m[2][2];
let q;
if (tr > 0) {
  const s = Math.sqrt(tr + 1) * 2;
  q = [0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s];
} else {
  const i = m[1][1] > m[0][0] ? (m[2][2] > m[1][1] ? 2 : 1) : m[2][2] > m[0][0] ? 2 : 0;
  const j = (i + 1) % 3;
  const k = (j + 1) % 3;
  const s = Math.sqrt(m[i][i] - m[j][j] - m[k][k] + 1) * 2;
  const v = [0, 0, 0];
  v[i] = 0.25 * s;
  v[j] = (m[j][i] + m[i][j]) / s;
  v[k] = (m[k][i] + m[i][k]) / s;
  q = [(m[k][j] - m[j][k]) / s, ...v];
}
const isd = {
  name_model: 'USGS_ASTRO_FRAME_SENSOR_MODEL',
  name_platform: 'GW_TEST_PLATFORM',
  name_sensor: 'GW_EARTH_FRAME',
  image_identifier: 'earthFramer',
  center_ephemeris_time: 1000.0,
  starting_ephemeris_time: 1000.0,
  detector_sample_summing: 1,
  detector_line_summing: 1,
  starting_detector_line: 0,
  starting_detector_sample: 0,
  focal2pixel_lines: [0.0, 0.0, 100.0],
  focal2pixel_samples: [0.0, 100.0, 0.0],
  focal_length_model: { focal_length: 500 },
  image_lines: 300,
  image_samples: 400,
  detector_center: { line: 150.0, sample: 200.0 },
  interpolation_method: 'lagrange',
  optical_distortion: { radial: { coefficients: [0.0, 0.0, 0.0] } },
  radii: { semimajor: A / 1000, semiminor: B / 1000, unit: 'km' },
  reference_height: { maxheight: 5000, minheight: -500, unit: 'm' },
  instrument_position: { unit: 'km', positions: [C.map((v) => v / 1000)], velocities: [[0, 0, 0]], ephemeris_times: [1000.0], reference_frame: 1 },
  instrument_pointing: { quaternions: [q], angular_velocities: [[0, 0, 0]], ephemeris_times: [1000.0], reference_frame: 1 },
  body_rotation: { quaternions: [[1, 0, 0, 0]], ephemeris_times: [1000.0], angular_velocities: [[0, 0, 0]], reference_frame: 1, constant_frames: [1, 2, 3], time_dependent_frames: [4, 5, 6] },
  sun_position: { positions: [[1.5e8, 0, 0]], velocities: [[0, 0, 0]], ephemeris_times: [1000.0], unit: 'km', reference_frame: 1 },
};
writeFileSync(process.argv[2] ?? 'earthFramer.json', `${JSON.stringify(isd, null, 2)}\n`);
