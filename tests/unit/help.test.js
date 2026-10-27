// REQ-UI-15: help pages cover every release's features and do not promise work as future that has shipped.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../app/src/features/dialogs.js', import.meta.url), 'utf8');
const ribbon = readFileSync(new URL('../../app/src/shell/ribbon-data.js', import.meta.url), 'utf8');
const titles = [...src.matchAll(/^ {2}\['([^']+)', '/gm)].map((m) => m[1]);

describe('help topics and limits', () => {
  it('has a topic for each feature area through R3', () => {
    for (const t of ['Getting started', 'Navigation', 'Image chain', 'Mensuration', 'Coordinates', 'Stereo and 3D', 'Extraction', 'SAR', 'Spectral', 'Full-motion video', 'Data packs', 'Online sources', 'WebGPU', 'RPF']) expect(titles).toContain(t);
  });
  it('promises nothing for a release that has shipped', () => {
    expect(src).not.toMatch(/arrives? in R[0-3]\b/);
  });
  it('names ribbon tabs and groups that exist', () => {
    for (const [, tab] of src.matchAll(/(\w+ Tools) ▸/g)) expect(ribbon).toContain(`label: '${tab}'`);
    for (const g of ['Online', 'Packs', 'AI Assistant', '3D']) expect(ribbon).toContain(`label: '${g}'`);
  });
});
