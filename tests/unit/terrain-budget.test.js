// CX-093: terrains stay within the core's memory budget (posts loaded plus the copy on the way in).
import { describe, it, expect } from 'vitest';
import { Terrain, terrainStep, decimateGrid, TERRAIN_POSTS } from '../../app/src/layers/terrain.js';

const tile = 3601; // a 1″ SRTM/DTED cell: 12.97 M posts

function fakeApp() {
  const loaded = new Map();
  let next = 1;
  const toasts = [];
  return {
    toasts,
    loaded,
    store: { get: () => ({}) },
    emit() {},
    toast: (t) => toasts.push(t),
    core: {
      loadDem: (g) => {
        loaded.set(next, g.width * g.height);
        return next++;
      },
      freeDem: (id) => loaded.delete(id),
    },
  };
}
const grid = (n) => ({ lat0: 40, lon0: -106, dlat: 1 / (n - 1), dlon: 1 / (n - 1), width: n, height: n });

describe('CX-093 terrain memory budget', () => {
  it('keeps full resolution while there is room and decimates beyond it', () => {
    expect(terrainStep(tile, tile, 0)).toBe(1);
    expect(terrainStep(tile, tile, 2 * tile * tile)).toBe(2);
    expect(terrainStep(tile, tile, TERRAIN_POSTS)).toBe(0);
  });

  it('takes every k-th post, keeping the first post and the spacing', () => {
    const h = Float32Array.from({ length: 25 }, (_, i) => i);
    const d = decimateGrid({ lat0: 1, lon0: 2, dlat: 0.1, dlon: 0.2, width: 5, height: 5 }, h, 2);
    expect([d.width, d.height, d.dlat, d.dlon, d.lat0, d.lon0]).toEqual([3, 3, 0.2, 0.4, 1, 2]);
    expect(Array.from(d.heights)).toEqual([0, 2, 4, 10, 12, 14, 20, 22, 24]);
  });

  it('loads five 1″ tiles without exceeding the budget, warning for the decimated ones', () => {
    const app = fakeApp();
    const t = new Terrain(app);
    for (let i = 0; i < 5; i++) t.addGrid({ id: `L${i}`, rec: { name: `t${i}` } }, { ...grid(tile), heights: new Float32Array(tile * tile) });
    const posts = [...app.loaded.values()];
    expect(posts.length).toBe(5);
    expect(posts.slice(0, 2)).toEqual([tile * tile, tile * tile]);
    expect(posts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(TERRAIN_POSTS);
    expect(app.toasts.length).toBe(3);
    expect(t.dems.map((d) => d.step)).toEqual([1, 1, 2, 2, 2]);
  });
});

// REG-084: a terrain's heights on the ellipsoid, h = H + N, with N bilinear on a coarse lattice. A
// separation linear in longitude and latitude comes back exactly at every post, the last lattice
// interval (shorter than a step) included.
describe('REG-084 haeHeights', () => {
  it('interpolates the separation lattice by its nodes’ own posts', () => {
    const [w, h] = [101, 131]; // a step of 3 posts, so the last interval is short in both axes
    const g = { width: w, height: h, lat0: 10, lon0: 20, dlat: 0.01, dlon: 0.02, heights: new Float32Array(w * h).fill(100) };
    const self = { separations: (_v, pts) => pts.map(([lon, lat]) => 3 * lon - 2 * lat) };
    const out = Terrain.prototype.haeHeights.call(self, { grid: g, vertical: 'egm96' });
    let worst = 0;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) worst = Math.max(worst, Math.abs(out[j * w + i] - (100 + 3 * (20 + i * 0.02) - 2 * (10 - j * 0.01))));
    expect(worst).toBeLessThan(1e-3);
    expect(Terrain.prototype.haeHeights.call(self, { grid: g, vertical: 'hae' })[0]).toBe(100);
  });
});
