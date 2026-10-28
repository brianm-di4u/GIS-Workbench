// REQ-SHL-05 REQ-SHL-06: every catalogued command has a category and an outcome in plain words
// (the second tooltip line); the palette scores and labels keys as the analyst expects.
import { describe, it, expect } from 'vitest';
import { Commands } from '../../app/src/shell/commands.js';
import { metaOf, CATEGORY_LABEL, OUTCOME_IDS } from '../../app/src/shell/command-meta.js';
import { score, chordLabel } from '../../app/src/shell/palette.js';

const C = new Commands({});

describe('command metadata', () => {
  it('gives every catalogued command a known category', () => {
    for (const c of C.list()) expect(CATEGORY_LABEL[metaOf(c.id).cat], c.id).toBeTruthy();
  });

  it('gives every catalogued command an outcome (its own tip or a meta entry)', () => {
    const missing = C.list().filter((c) => !metaOf(c.id).out && !c.tip).map((c) => c.id);
    expect(missing).toEqual([]);
  });

  it('keeps outcomes short, plain sentences', () => {
    for (const c of C.list()) {
      const out = metaOf(c.id).out ?? c.tip;
      expect(out.length, c.id).toBeLessThanOrEqual(160);
      expect(out, c.id).toMatch(/^[A-Z0-9"'(]/);
    }
  });

  it('has no outcome for a command that does not exist', () => {
    for (const id of OUTCOME_IDS) expect(C.get(id), id).toBeTruthy();
  });
});

describe('palette scoring', () => {
  it('matches word starts above substrings, and rejects non-matches', () => {
    expect(score('Zoom In Navigate', 'zoom in')).toBeGreaterThan(score('Customize Zoom Navigate', 'in'));
    expect(score('Zoom In', 'zoom')).toBeGreaterThan(0);
    expect(score('Polyline Z Stereo', 'zoom in')).toBe(0);
  });
  it('matches initials of short queries', () => {
    expect(score('Zoom In Navigate', 'zi')).toBeGreaterThan(0);
  });
  it('labels chords in plain key names', () => {
    expect(chordLabel('Mod+KeyK')).toBe('Ctrl+K');
    expect(chordLabel('Equal')).toBe('=');
    expect(chordLabel('Mod+Shift+KeyZ')).toBe('Ctrl+Shift+Z');
  });
});
