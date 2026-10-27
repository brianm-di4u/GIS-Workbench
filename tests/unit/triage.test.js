// REQ-WB-12 triage fields and filters; REQ-WB-13 a page becomes an observation linked to its pins.
import { describe, it, expect } from 'vitest';
import { filterPages, pageToObservation, newPage, TRIAGE_STATUS } from '../../app/src/feedback/model.js';

const page = (triage, extra = {}) => ({ ...newPage({ image: null, width: 1, height: 1, marks: [], context: { image: 'IMG1', centre: { lat: 1, lon: 2, mgrs: 'X' } } }), triage, ...extra });

describe('triage', () => {
  const pages = [page({ status: 'new', priority: 'high', assignee: 'Ana' }), page({ status: 'done', priority: 'low', assignee: 'ben' }), page({ status: 'new', priority: '', assignee: '' }), page(undefined)];
  it('defaults new pages to status new', () => {
    expect(newPage({ image: null, width: 1, height: 1, marks: [], context: {} }).triage).toEqual({ status: 'new', priority: '', assignee: '' });
    expect(TRIAGE_STATUS).toContain("won't fix");
  });
  it('filters by status, priority and assignee (case-insensitive substring)', () => {
    expect(filterPages(pages, { status: 'new' })).toHaveLength(3);
    expect(filterPages(pages, { priority: 'high' })).toHaveLength(1);
    expect(filterPages(pages, { assignee: 'an' })).toHaveLength(1);
    expect(filterPages(pages, { status: 'done', assignee: 'BEN' })).toHaveLength(1);
    expect(filterPages(pages, {})).toHaveLength(4);
  });
  it('turns a page into an observation linked to its pinned store items', () => {
    const p = page(undefined, { type: 'bug', summary: 'Wrong height', notes: 'Shadow tool gave 31 m', pins: [{ n: 1, note: 'here', target: { id: 'measurement:ms_1', label: 'Measurement M-01' } }, { n: 2, note: '', target: { id: 'cmd:men.height', label: 'Command: Height' } }] });
    const o = pageToObservation(p);
    expect(o.text.split('\n')).toEqual(['Wrong height', 'Shadow tool gave 31 m', 'Pin 1 (Measurement M-01): here', 'Pin 2 (Command: Height):']);
    expect(o.links).toEqual([{ kind: 'measurement', id: 'ms_1', ref: 'measurement:ms_1' }]);
    expect(o.image).toBe('IMG1');
    expect(o.fromPage).toBe(p.id);
  });
});
