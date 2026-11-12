// REQ-GAP-29: the summary of a structure-from-motion run and the order its results open in.
import { describe, it, expect } from 'vitest';
import { summaryRows, OPEN_ORDER } from '../../app/src/features/sfm.js';

const report = {
  georef: { images: 77, registered: 75, reprojection_px: { mean: 0.71234 }, gps_rms_m: { east: 1.234, north: 0.5, up: 2.25 }, focal: { px: 3536.883, refined: false } },
  cloud_points: 1234567,
  dsm: { resolution_m: 0.15 },
  ortho: { resolution_m: 0.04 },
};

describe('sfm summary', () => {
  it('reports what the run measured', () => {
    const rows = Object.fromEntries(summaryRows(report));
    expect(rows['Photographs oriented']).toBe('75 of 77');
    expect(rows['Mean reprojection error']).toBe('0.71 px');
    expect(rows['Fit to the GPS (RMS east, north, up)']).toBe('1.23 m, 0.50 m, 2.25 m');
    expect(rows['Focal length']).toBe('3536.9 px, held at the EXIF value');
    expect(rows['DSM cell']).toBe('0.15 m');
    expect(rows['Orthomosaic pixel']).toBe('0.04 m');
  });

  it('reports the checkpoints and control points of a run placed by ground control (REQ-GAP-94)', () => {
    const control = { gcps: 5, checks: 2, rmse_check_m: { east: 0.0312, north: 0.0201, up: 0.0857 }, rmse_gcp_m: { east: 0.01, north: 0.012, up: 0.02 } };
    const rows = Object.fromEntries(summaryRows({ georef: { ...report.georef, control } }));
    expect(rows['Checkpoints (2, RMS east, north, up)']).toBe('0.031 m, 0.020 m, 0.086 m');
    expect(rows['Ground control points (5, RMS east, north, up)']).toBe('0.010 m, 0.012 m, 0.020 m');
  });

  it('shows no row for a number the run did not report', () => {
    expect(summaryRows({})).toEqual([]);
    expect(summaryRows(null)).toEqual([]);
    expect(summaryRows({ georef: { images: 5, registered: 5 } })).toHaveLength(1);
  });

  it('never calls the GPS fit accuracy', () => {
    for (const [k] of summaryRows(report)) expect(k).not.toMatch(/accura/i);
  });
});

describe('sfm results', () => {
  const names = ['b.ortho.tif', 'b.dsm.tif', 'b.copc.laz', 'b.frames.geojson', 'b.sfm-report.json', 'b.ortho.tif.gwb-provenance.json'];
  it('opens each product once, the frames last so they sit on top', () => {
    const hits = OPEN_ORDER.map((re) => names.filter((n) => re.test(n)));
    expect(hits.map((h) => h.length)).toEqual([1, 1, 1, 1]);
    expect(hits[3][0]).toBe('b.frames.geojson');
  });
});
