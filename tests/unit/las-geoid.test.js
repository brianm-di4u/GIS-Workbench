// REG-027 (#54): the LAS reader's height warnings name the geoid that converts the heights
// (app.core.geoidName), not EGM96 whatever is loaded — as the obstruction notes do since 2.6.
import { describe, it, expect } from 'vitest';
import { lasCrs } from '../../app/src/formats/las.js';

const info = { min: [545952, 3817161, 634], max: [546454, 3817663, 919] };
const keys = (vert) => ({ ...info, geoKeys: [[1024, 1], [3072, 32611], [4096, vert]] });
const notes = (vert, geoid) => lasCrs(keys(vert), null, null, null, geoid).warnings.join(' ');

describe('LAS height warnings name the geoid in use', () => {
  it('EGM96 when no other geoid is named', () => {
    expect(notes(5703, null)).toMatch(/NAVD88 heights are converted to HAE with EGM96/);
    expect(notes(3855, undefined)).toMatch(/EGM2008 heights are converted with EGM96: differences/);
    expect(notes(5773, null)).toBe('');
  });

  it('EGM2008 2.5′ in use: NAVD88 names it, EGM2008 heights need no note, EGM96 heights get one', () => {
    const g = 'EGM2008 2.5′';
    expect(notes(5703, g)).toMatch(/NAVD88 heights are converted to HAE with EGM2008 2\.5′/);
    expect(notes(5703, g)).not.toMatch(/EGM96/);
    expect(notes(3855, g)).toBe('');
    expect(notes(5773, g)).toMatch(/EGM96 heights are converted with EGM2008 2\.5′: differences/);
  });
});
