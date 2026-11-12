// REG-075: what the ground control marking dialog computes. The control file is read as gwb-sfm
// reads it, written back as the CSV it reads, and each point is projected into the photographs of
// the first stage's model file.
import { describe, it, expect } from 'vitest';
import { parseControl, controlCsv, readModelHeader, project, candidates, distort, readiness, parseCrs } from '../../app/src/features/sfm-gcp.js';

const CSV = `id,x,y,z,crs,sigma,role,image,px,py
G1,500010,900020,120.5,EPSG:32630,0.02,gcp,A.JPG,10,20
G1,500010,900020,120.5,EPSG:32630,0.02,gcp,B.JPG,30.5,40
C1,500100,900200,121,EPSG:32630,0.05,check,,,
`;

/** A camera 100 m up looking straight down (x east, y south in the image), 1000 x 800 pixels. */
const header = (images) => ({
  georef: { epsg: 32630, offset: [500000, 900000, 0] },
  cameras: [{ id: 1, model: 2, width: 1000, height: 800, params: [1000, 500, 400, 0] }],
  images,
});
const down = (name, c) => ({
  id: 1,
  name,
  camera: 1,
  r: [
    [1, 0, 0],
    [0, -1, 0],
    [0, 0, -1],
  ],
  c,
});

describe('the control file', () => {
  it('reads the CSV, one row per mark, a point with no mark kept', () => {
    const c = parseControl(CSV);
    expect(c.epsg).toBe(32630);
    expect(c.points.map((p) => [p.id, p.check, p.marks.length])).toEqual([
      ['C1', true, 0],
      ['G1', false, 2],
    ]);
    expect(c.points[1].marks[1]).toEqual({ image: 'B.JPG', px: 30.5, py: 40 });
  });

  it("reads ODM's gcp_list.txt", () => {
    const c = parseControl('+proj=utm +zone=30 +ellps=WGS84 +datum=WGS84 +units=m +no_defs\n500010 900020 120 10 20 A.JPG GCP1\n500010 900020 120 11 21 B.JPG GCP1\n');
    expect(c.epsg).toBe(32630);
    expect(c.points).toHaveLength(1);
    expect(c.points[0]).toMatchObject({
      id: 'GCP1',
      sigma: 0.02,
      check: false,
    });
    expect(c.points[0].marks).toHaveLength(2);
  });

  it('refuses what gwb-sfm would refuse', () => {
    expect(() => parseControl(CSV.replace('EPSG:32630,0.05', 'EPSG:32631,0.05'))).toThrow(/same CRS/);
    expect(() => parseControl(CSV.replace('check', 'tie'))).toThrow(/neither gcp nor check/);
    expect(() => parseControl(CSV.replace('120.5,EPSG:32630,0.02,gcp,B', '121.5,EPSG:32630,0.02,gcp,B'))).toThrow(/given twice/);
    expect(() => parseControl('')).toThrow(/empty/);
    expect(() => parseCrs('EPSG:4326x')).toThrow(/not an EPSG code/);
    expect(parseCrs('WGS84 UTM 17S')).toBe(32717);
  });

  it('is written back as the CSV it was read from', () => {
    const c = parseControl(CSV);
    c.points[0].marks.push({ image: 'C.JPG', px: 1.234, py: 5.678 });
    const again = parseControl(controlCsv(c));
    expect(again.points[0].marks).toEqual([{ image: 'C.JPG', px: 1.23, py: 5.68 }]);
    expect(again.points[1]).toEqual(c.points[1]);
  });

  it('is ready with three control points each in two photographs', () => {
    const c = parseControl(CSV);
    expect(readiness(c)).toEqual({ marked: 1, checks: 0, ready: false });
  });
});

describe('the model file', () => {
  it('gives its header without reading the binaries, and refuses another file or version', async () => {
    const h = { format: 'gwb-sfm-model', version: 1, images: [] };
    const blob = new Blob(['GWB-SFM-MODEL 1\n', JSON.stringify(h), '\n', new Uint8Array(1 << 20)]);
    expect(await readModelHeader(blob)).toEqual(h);
    await expect(readModelHeader(new Blob(['GWB-SFM-MODEL 2\n{}\n']))).rejects.toThrow(/version 2/);
    await expect(readModelHeader(new Blob(['id,x,y\n']))).rejects.toThrow(/not a model file/);
    await expect(readModelHeader(new Blob(['GWB-SFM-MODEL 1\n{"a":']))).rejects.toThrow(/cut short/);
  });
});

describe('projection', () => {
  it('puts a surveyed point where a camera above it sees it', () => {
    const h = header([down('A.JPG', [0, 0, 100])]);
    // 10 m east and 20 m north of the nadir, 100 m below: (0.1, -0.2) on the image plane.
    expect(project(h, h.images[0], [10, 20, 0])).toEqual([600, 200]);
    expect(project(h, h.images[0], [0, 0, 150])).toBeNull(); // behind the camera
    expect(project(h, h.images[0], [80, 0, 0])).toBeNull(); // outside the frame
  });

  it('applies the lens as COLMAP does', () => {
    const [px] = distort({ model: 4, params: [1000, 1000, 500, 400, 0.1, 0, 0, 0] }, 0.2, 0);
    expect(px).toBeCloseTo(1000 * 0.2 * (1 + 0.1 * 0.04) + 500, 9);
  });

  it('lists the photographs a point falls in, nearest the centre first', () => {
    const h = header([down('far.JPG', [30, 0, 100]), down('near.JPG', [5, 20, 100]), down('off.JPG', [400, 0, 100])]);
    const got = candidates(h, { xyz: [500010, 900020, 0] });
    expect(got.map((c) => c.image)).toEqual(['near.JPG', 'far.JPG']);
    expect(got[0].px).toBeCloseTo(550, 9);
  });
});
