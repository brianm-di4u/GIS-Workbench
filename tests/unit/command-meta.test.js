// REQ-SHL-05 REQ-SHL-06: every catalogued command has a category and an outcome in plain words
// (the second tooltip line); the palette scores and labels keys as the analyst expects.
import { describe, it, expect, afterEach } from 'vitest';
import { Commands } from '../../app/src/shell/commands.js';
import { metaOf, needOf, categoryLabel, CATEGORY_LABEL, OUTCOME_IDS } from '../../app/src/shell/command-meta.js';
import { setLocale, keyOf } from '../../app/src/i18n/index.js';
import { keyTipLetters, keyTipOf } from '../../app/src/input/keys.js';
import { score, chordLabel, searchText } from '../../app/src/shell/palette.js';

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

// REQ-L10N-12, REQ-L10N-13: the registry is translated where it is shown; the palette finds a
// command by its translated and its English words; KeyTips take letters from the catalogue.
describe('localised registry, search and KeyTips', () => {
  const de = {
    keys: ['Zoom In', 'Zoom', 'Navigate', 'Preferences…', 'settings', keyOf('H', 'keytip'), keyOf('S', 'keytip'), keyOf('A', 'keytip'), 'open an image first'],
    values: ['Vergrößern', 'Zoomen', 'Navigieren', 'Einstellungen…', 'Optionen', 'S', 'A', 'Ж', 'zuerst ein Bild öffnen'],
  };
  afterEach(() => setLocale('en'));

  it('keeps English sources in the registry and translates through labelOf()', () => {
    setLocale('de', de);
    expect(C.get('nav.zoomin').label).toBe('Zoom In');
    expect(C.labelOf('nav.zoomin')).toBe('Vergrößern');
    expect(C.labelOf('no.such.command')).toBe('no.such.command');
    expect(categoryLabel('nav')).toBe('Navigieren');
  });

  it('finds a command by its translated or its English label and keywords', () => {
    setLocale('de', de);
    const zoom = searchText(C, C.get('nav.zoomin'));
    expect(score(zoom, 'vergr')).toBeGreaterThan(0);
    expect(score(zoom, 'zoom in')).toBeGreaterThan(0);
    expect(score(zoom, 'vergroßern')).toBeGreaterThan(0); // accents do not matter
    const prefs = searchText(C, C.get('file.prefs'));
    expect(score(prefs, 'optionen')).toBeGreaterThan(0); // a translated keyword
    expect(score(prefs, 'settings')).toBeGreaterThan(0); // and the English one
  });

  it('gives each KeyTip a unique single letter, falling back to English', () => {
    setLocale('de', de);
    // Home → S (translated) collides with Select → A, and Add-Ins → Ж is not A–Z.
    const l = keyTipLetters([{ en: 'F', label: 'Datei' }, { en: 'H', label: 'Start' }, { en: 'S', label: 'Auswahl' }, { en: 'A', label: 'Add-Ins' }]);
    expect(new Set(l).size).toBe(4);
    expect(l.every((x) => /^[A-Z0-9]$/.test(x))).toBe(true);
    expect(l[0]).toBe('F');
    expect(l[3]).not.toBe('Ж');
    setLocale('en');
    expect(keyTipLetters([{ en: 'F' }, { en: 'H' }, { en: 'S' }])).toEqual(['F', 'H', 'S']);
  });

  it('reads a KeyTip from the physical key on a non-Latin layout', () => {
    expect(keyTipOf({ key: 'h', code: 'KeyH' })).toBe('H');
    expect(keyTipOf({ key: 'р', code: 'KeyH' })).toBe('H'); // Cyrillic layout
    expect(keyTipOf({ key: 'ا', code: 'KeyH' })).toBe('H'); // Arabic layout
    expect(keyTipOf({ key: 'a', code: 'KeyQ' })).toBe('A'); // AZERTY types the letter on the key
    expect(keyTipOf({ key: 'é', code: 'Digit2' })).toBe('2');
    expect(keyTipOf({ key: 'Shift', code: 'ShiftLeft' })).toBe(null);
  });

  it('says why a command is unavailable in the UI language', () => {
    setLocale('de', de);
    expect(needOf({ layers: { size: 0 }, activePane: () => null }, 'nav.zoomin')).toBe('zuerst ein Bild öffnen');
  });
});
