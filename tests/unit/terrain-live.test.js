// CX-081: a terrain whose layer an undo removed no longer counts (Save DEM As read the removed record).
import { describe, it, expect } from 'vitest';
import { Terrain } from '../../app/src/layers/terrain.js';

describe('Terrain follows the layers in the project', () => {
  const records = new Map([['L1', { name: 'dem.tif' }]]);
  const app = { store: { get: (id) => records.get(id) }, core: { freeDem() {} }, emit() {} };
  const t = new Terrain(app);
  const bounds = { north: 1, south: 0, west: 0, east: 1 };
  t.all.push({ layerId: 'L1', name: 'DEM', coreId: 1, bounds }, { layerId: 'L2', name: 'DTM (undone)', coreId: 2, bounds });

  it('lists, finds and covers with live layers only', () => {
    expect(t.dems.map((d) => d.layerId)).toEqual(['L1']);
    expect(t.entry('L2')).toBeNull();
    expect(t.covering(0.5, 0.5).layerId).toBe('L1');
    records.delete('L1');
    expect(t.dems).toEqual([]);
    expect(t.covering(0.5, 0.5)).toBeNull();
    expect(t.available).toBe(false);
  });

  it('comes back on redo (the runtime keeps its terrain)', () => {
    records.set('L2', { name: 'DTM' });
    expect(t.entry('L2')?.name).toBe('DTM (undone)');
  });
});
