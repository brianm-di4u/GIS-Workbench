// REG-010 (#58): a DEM not in EPSG:4326 used as terrain is resampled at its own post spacing, not
// onto at most 2,048 posts a side, and is spaced out evenly only past the terrain budget.
import { describe, it, expect } from 'vitest';
import { geographicGridFor, terrainStep, Terrain, TERRAIN_POSTS } from '../../app/src/layers/terrain.js';

// A 3 km × 2.6 km box at 39.8° N (Golden, CO): 1° of latitude ≈ 111 km.
const lat = 39.8;
const box = (km = 3, kmN = 2.6) => ({ n: lat + kmN / 111 / 2, s: lat - kmN / 111 / 2, w: -105.2, e: -105.2 + km / (111 * Math.cos((lat * Math.PI) / 180)) });

describe('the geographic grid of a projected DEM', () => {
  it('keeps 1 m posts for a 3 km × 2.6 km 1 m DEM (it used to stop at 2,048 posts a side)', () => {
    const g = geographicGridFor(box(), [1, 1]);
    expect(g.width).toBeGreaterThan(2990);
    expect(g.height).toBeGreaterThan(2590);
    expect(g.dlat * 111000).toBeCloseTo(1, 6);
    expect(g.dlon * 111000 * Math.cos((lat * Math.PI) / 180)).toBeCloseTo(1, 2);
  });

  it('follows the step a large DEM was read at', () => {
    const g = geographicGridFor(box(), [1, 1], 2);
    expect(g.width).toBeGreaterThan(1495);
    expect(g.width).toBeLessThan(1505);
  });

  it('spaces the posts out evenly to stay within the budget', () => {
    const g = geographicGridFor(box(10, 10), [1, 1], 1, 25e6);
    expect(g.width * g.height).toBeLessThanOrEqual(25e6);
    expect(g.width * g.height).toBeGreaterThan(0.99 * 25e6);
    expect(g.width / g.height).toBeCloseTo(1, 1);
    expect(geographicGridFor(box(10, 10), [1, 1]).width * geographicGridFor(box(10, 10), [1, 1]).height).toBeLessThanOrEqual(TERRAIN_POSTS);
  });

  it('a small DEM stays as fine as its posts', () => {
    const g = geographicGridFor(box(0.4, 0.4), [5, 5]);
    expect(g.width).toBeGreaterThan(79);
    expect(g.width).toBeLessThan(83);
  });

  it('a grid sized to Terrain.room() reaches the core at full detail (load() counts each post twice)', () => {
    const t = new Terrain({ on() {}, core: {}, store: { get: () => ({}) } });
    expect(t.room()).toBe(TERRAIN_POSTS / 2);
    // A 7 km × 7 km 1 m DEM (49 M posts) spaced out to the room: step 1 in the core, not every 2nd post.
    const g = geographicGridFor(box(7, 7), [1, 1], 1, t.room());
    expect(g.width * g.height).toBeLessThanOrEqual(t.room());
    expect(g.width * g.height).toBeGreaterThan(0.99 * t.room());
    expect(terrainStep(g.width, g.height, 0)).toBe(1);
    // Sized to the whole budget instead, the core would keep every 2nd post.
    const all = geographicGridFor(box(7, 7), [1, 1]);
    expect(terrainStep(all.width, all.height, 0)).toBe(2);
    // Other terrains loaded leave less room.
    t.all.push({ posts: 10e6 });
    expect(t.room()).toBe((TERRAIN_POSTS - 10e6) / 2);
  });
});
