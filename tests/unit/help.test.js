// REQ-UI-15: help pages cover every release's features and do not promise work as future that has shipped.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../app/src/features/dialogs.js', import.meta.url), 'utf8');
const ribbon = readFileSync(new URL('../../app/src/shell/ribbon-data.js', import.meta.url), 'utf8');
// HELP_TOPICS and LIMITS_TEXT rows: [N_('Title'), N_('Paragraph')] (or [N_('Title'), CONSTANT]).
const titles = [...src.matchAll(/^ {2}\[N_\('([^']+)'\), /gm)].map((m) => m[1]);
// A ribbon label, plain or marked for translation (label: 'X' or label: N_('X')).
const hasLabel = (s) => new RegExp(`label: (?:N_\\()?'${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(ribbon);

describe('help topics and limits', () => {
  it('has a topic for each feature area through R3', () => {
    for (const t of ['Getting started', 'Navigation', 'Image chain', 'Mensuration', 'Coordinates', 'Stereo and 3D', 'Extraction', 'SAR', 'Spectral', 'Full-motion video', 'Data packs', 'Online sources', 'WebGPU', 'RPF']) expect(titles).toContain(t);
  });
  it('promises nothing for a release that has shipped', () => {
    expect(src).not.toMatch(/arrives? in R[0-3]\b/);
  });
  it('names ribbon tabs and groups that exist', () => {
    for (const [, tab] of src.matchAll(/(\w+ Tools) ▸/g)) expect(hasLabel(tab), tab).toBe(true);
    for (const g of ['Online', 'Packs', 'AI Assistant', '3D']) expect(hasLabel(g), g).toBe(true);
  });
});
