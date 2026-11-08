// REQ-GAP-86 (OD-2.40): the Lite project file. Lite writes the same .gwb as Full; what Lite does not
// show (more panels, dock layouts, Full-only records) goes back as it came, so a Full project
// survives a save from Lite.
import { describe, it, expect } from 'vitest';
import { serialiseProject, readProject } from '../../app/src/storage/project.js';
import { LITE_RECORDS, LITE_COMMANDS } from '../../app/src/core/profile.js';

/** The parts of an app serialiseProject reads. */
function fakeApp(records, ports, extra = {}) {
  return {
    store: { snapshot: () => structuredClone(records), all: (type) => records.filter((r) => r.type === type) },
    desktop: { multiports: ports },
    undo: { history: () => [] },
    project: () => ({ name: 'Survey', origins: [] }),
    build: { version: 'test' },
    ...extra,
  };
}
const port = (id, panes, layout = {}) => ({ id, panes: panes.map(([pid, view]) => ({ id: pid, view })), docks: { layout: () => layout } });

describe('REQ-GAP-86 Lite project file', () => {
  const records = [
    { id: 'project', type: 'project', name: 'Survey' },
    { id: 'mp1', type: 'multiport', panes: ['p1', 'p2'] },
    { id: 'p1', type: 'pane' },
    { id: 'p2', type: 'pane' },
    { id: 'o1', type: 'observation', text: 'Gate' },
    { id: 't1', type: 'tin', name: 'EG', source: { kind: 'import' } },
  ];

  it('Full writes its panels and docks; Lite saves them back with its own panel and records', () => {
    const full = fakeApp(records, [port('mp1', [['p1', { zoom: 2 }], ['p2', { zoom: 5 }]], { left: ['layers'] })], {});
    full.desktop.arrange = 'tabs';
    const saved = readProject(serialiseProject(full));
    expect(saved.views.views).toEqual({ p1: { zoom: 2 }, p2: { zoom: 5 } });
    // Lite opened it: one panel shown, no docks or arrangement; it adds an observation and saves.
    const liteRecords = [...saved.records, { id: 'o2', type: 'observation', text: 'Fence' }];
    const lite = fakeApp(liteRecords, [port('mp1', [['p1', { zoom: 3 }]])], { projectViews: saved.views });
    const back = readProject(serialiseProject(lite));
    expect(back.views.views).toEqual({ p1: { zoom: 3 }, p2: { zoom: 5 } }); // Lite's view of p1, Full's of p2
    expect(back.views.docks).toEqual({ mp1: { left: ['layers'] } });
    expect(back.views.arrange).toBe('tabs');
    expect(back.records.find((r) => r.id === 't1')).toEqual(records[5]); // the TIN untouched
    expect(back.records.filter((r) => r.type === 'observation').map((r) => r.text)).toEqual(['Gate', 'Fence']);
  });

  it('a new project starts with no carried views', () => {
    const app = fakeApp(records, [port('mp1', [['p1', { zoom: 1 }]])], { projectViews: null });
    expect(readProject(serialiseProject(app)).views.views).toEqual({ p1: { zoom: 1 } });
  });

  it('Lite shows its own records and offers the project commands', () => {
    for (const t of ['observation', 'aoi', 'graphic', 'glayer', 'layer', 'fileref', 'pane', 'multiport', 'project']) expect(LITE_RECORDS.has(t), t).toBe(true);
    for (const t of ['tin', 'tinedit', 'pointcloud', 'pcedit']) expect(LITE_RECORDS.has(t), t).toBe(false);
    for (const id of ['file.save', 'file.openproject', 'file.relink']) expect(LITE_COMMANDS.has(id), id).toBe(true);
  });
});
