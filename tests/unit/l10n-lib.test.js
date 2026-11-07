// Localisation of the library modules (SDP-2.3 L2/L5, REQ-L10N-05/06/08/19): the AI prompt's
// language line, the local copilot's fallback, displayed lengths, Mensuration Log rows for display
// and for CSV, and errors that keep their message key.
import { describe, it, expect, afterEach } from 'vitest';
import { setLocale, msgOf } from '../../app/src/i18n/index.js';
import { setUnits } from '../../app/src/i18n/format.js';
import { SYSTEM_PROMPT, languageLine, systemPrompt } from '../../app/src/ai/assistant.js';
import { LOCAL_HELP, localHelp } from '../../app/src/ai/intent.js';
import { fmtLen, fmtArea } from '../../app/src/tools/tools.js';
import { menRow, MENLOG_COLUMNS } from '../../app/src/tools/menlog.js';
import { sidecarError } from '../../app/src/sidecar/client.js';
import { parseReply } from '../../app/src/ai/prompt-helper.js';
import { parse as parseBandMath } from '../../app/src/render/bandmath.js';

const DE = (pairs) => ({ keys: pairs.map((p) => p[0]), values: pairs.map((p) => p[1]) });

afterEach(() => {
  setLocale('en');
  setUnits('metric');
});

describe('REQ-L10N-19 the AI prompt names the UI language', () => {
  it('adds nothing for English or a pseudo-locale', () => {
    expect(systemPrompt('en')).toBe(SYSTEM_PROMPT);
    expect(systemPrompt('en-XA')).toBe(SYSTEM_PROMPT);
    expect(languageLine('en-GB')).toBe('');
  });
  it('names the language in English with its tag', () => {
    expect(languageLine('de')).toBe("The user's interface language is German (de); answer in that language unless asked otherwise.");
    expect(languageLine('pt-BR')).toContain('Portuguese (Brazil) (pt-BR)');
    expect(systemPrompt('fr').startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(systemPrompt('fr')).toContain('French (fr)');
    setLocale('ja');
    expect(systemPrompt()).toContain('Japanese (ja)');
  });
  it('the local copilot says it reads English when the UI is not English', () => {
    expect(localHelp('en')).toBe(LOCAL_HELP);
    const de = localHelp('de');
    expect(de).toMatch(/understand requests in English/);
    expect(de).toContain('“go to 38SMB4484”');
    expect(de).toMatch(/AI connection/);
  });
});

describe('REQ-L10N-08 measured lengths follow the Units preference', () => {
  it('metric keeps the mensuration precision', () => {
    expect(fmtLen(12.345)).toBe('12.35 m');
    expect(fmtLen(512.3)).toBe('512.30 m');
    expect(fmtLen(1234.6)).toBe('1.235 km');
    expect(fmtArea(512.34)).toBe('512.3 m²');
    expect(fmtArea(2.5e6)).toBe('2.5000 km²');
  });
  it('imperial and nautical', () => {
    setUnits('imperial');
    expect(fmtLen(10)).toBe('32.81 ft');
    expect(fmtLen(5000)).toBe('3.107 mi');
    setUnits('nautical');
    expect(fmtLen(1852)).toBe('1.000 NM');
  });
  it('uses the locale decimal sign', () => {
    setLocale('de', DE([]));
    expect(fmtLen(12.345)).toBe('12,35 m');
  });
});

describe('Mensuration Log rows', () => {
  const m = { mid: 'M-01', mtype: 'Point', value: 'MGRS', units: 'MGRS', method: 'Mono-DEM', ce90: 2.345, le90: NaN, tag: 'absolute', coords: { mgrs: '38SMB4484', lat: 33.1234567, lon: 44.1234567, hae: 100.5, msl: null }, time: '2026-01-01T00:00:00Z' };
  it('English display rows are as before', () => {
    const r = menRow(m);
    expect(r.ce90).toBe('2.35');
    expect(r.le90).toBe('error not available');
    expect(r.coordinates).toBe('38SMB4484 · 33.1234567, 44.1234567 WGS 84 · 100.50 m HAE');
    expect(r.object).toBe('N/A');
  });
  it('display rows follow the locale; machine rows stay English with "." decimals', () => {
    setLocale('de', DE([['error not available', 'Fehler nicht verfügbar'], ['N/A', 'k. A.']]));
    const d = menRow(m);
    expect(d.ce90).toBe('2,35');
    expect(d.le90).toBe('Fehler nicht verfügbar');
    expect(d.object).toBe('k. A.');
    expect(d.coordinates).toContain('33,1234567');
    const c = menRow(m, { machine: true });
    expect(c.ce90).toBe('2.35');
    expect(c.le90).toBe('error not available');
    expect(c.object).toBe('N/A');
    expect(c.coordinates).toBe('38SMB4484 · 33.1234567, 44.1234567 WGS 84 · 100.50 m HAE');
    expect(MENLOG_COLUMNS[0][1]).toBe('ID');
  });
});

describe('REQ-L10N-05 errors keep their key', () => {
  it('a sidecar error is shown in the UI language', () => {
    const e = sidecarError('the sidecar did not answer ({msg})', { msg: 'refused' }, { code: 'unreachable' });
    expect(e.message).toBe('the sidecar did not answer (refused)');
    expect(e.code).toBe('unreachable');
    setLocale('de', DE([['the sidecar did not answer ({msg})', 'der Sidecar antwortete nicht ({msg})']]));
    expect(msgOf(e)).toBe('der Sidecar antwortete nicht (refused)');
  });
  it('Band Math errors keep their English text and quotes', () => {
    expect(() => parseBandMath('b1 + #', { nb: 3 })).toThrow("Band Math: unexpected '#' at 6");
    expect(() => parseBandMath('abs(b1, b1)', { nb: 3 })).toThrow('Band Math: abs() takes 1 argument');
  });
  it('a parse failure is a message', () => {
    setLocale('en-XA');
    expect(parseReply('not json').errors[0]).toMatch(/^⟦/);
  });
});
