// SRTM HGT writer (REQ-FMT-07, Save DEM As): tile size, row order (north first), big-endian signed
// metres, bilinear resampling of the terrain grid, voids outside it, and the HAE → EGM96 conversion.
import { describe, it, expect } from 'vitest';
import { hgtCell } from '../../app/src/formats/dem-writers.js';

// A 0.01° grid over N39W106 (and a margin) whose height is a plane: h = 1000 + 100·(lat − 39) + 10·(lon + 106).
const grid = { lon0: -106.05, lat0: 40.05, dlon: 0.01, dlat: 0.01, width: 111, height: 111 };
const H = new Float32Array(grid.width * grid.height);
for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) H[j * grid.width + i] = 1000 + 100 * (grid.lat0 - j * grid.dlat - 39) + 10 * (grid.lon0 + i * grid.dlon + 106);
const app = { core: { undulation: () => -15 } };
const at = (u8, n, r, c) => new DataView(u8.buffer).getInt16(2 * (r * n + c), false);

describe('hgtCell', () => {
  it('writes a 3″ tile of 1201² big-endian samples, north row first', () => {
    const t = hgtCell(app, grid, H, 'egm96', 39, -106, 3);
    expect(t.length).toBe(1201 * 1201 * 2);
    expect(at(t, 1201, 0, 0)).toBe(1100); // NW corner: lat 40, lon −106
    expect(at(t, 1201, 1200, 0)).toBe(1000); // SW corner
    expect(at(t, 1201, 1200, 1200)).toBe(1010); // SE corner
    expect(at(t, 1201, 600, 600)).toBe(1055); // centre
  });
  it('writes a 1″ tile of 3601² samples and converts ellipsoid heights to EGM96', () => {
    const t = hgtCell(app, grid, H, 'hae', 39, -106, 1);
    expect(t.length).toBe(3601 * 3601 * 2);
    expect(at(t, 3601, 3600, 0)).toBe(1015); // HAE − N, N = −15 m
  });
  it('marks samples outside the terrain as voids (−32768)', () => {
    const t = hgtCell(app, grid, H, 'egm96', 40, -106, 3);
    expect(at(t, 1201, 0, 0)).toBe(-32768); // lat 41: north of the grid
  });
});
