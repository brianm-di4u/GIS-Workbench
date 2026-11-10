// #99 REQ-ARC-11: crash recovery after a save. The journal restarts from what the save wrote, so
// Recover gives the saved work and the edits after it, not the records as they were opened.
import { describe, it, expect } from 'vitest';
import { Journal } from '../../app/src/storage/journal.js';
import { parseRecords } from '../../app/src/storage/project.js';
import { Store } from '../../app/src/core/store.js';

/** A journal over an in-memory record store, fed by a Store's commits, as files.js wires it. */
function setup(db = new Map()) {
  const store = new Store();
  store.transact('start', (tx) => tx.create('project', { name: 'P', created: 7 }, 'project'));
  const app = { prefs: { get: () => 'on', set() {} }, store, project: () => store.get('project'), log() {} };
  const j = new Journal(app);
  j.available = true;
  // A read takes a moment, as IndexedDB's does, so that writes can overlap.
  j.get = async (_s, k) => {
    const v = structuredClone(db.get(k) ?? null);
    await new Promise((r) => setTimeout(r, 5));
    return v;
  };
  j.put = async (_s, k, v) => void db.set(k, structuredClone(v));
  j.del = async (_s, k) => void db.delete(k);
  j.base = store.snapshot();
  store.on('reset', () => (j.base = store.snapshot()));
  store.on('commit', (cs) => j.record(cs));
  const add = (name) => store.transact(name, (tx) => tx.create('vlayer', { name }));
  /** What Recover would rebuild from the journal, as files.js does it. */
  const recover = () => {
    const rec = db.get('gw/7');
    const s = new Store();
    s.load(typeof rec.snapshot === 'string' ? parseRecords(rec.snapshot) : rec.snapshot);
    for (const cs of rec.changesets) s.applyChangeSet(cs, { kind: 'load' });
    return { names: s.all('vlayer').map((v) => v.name).sort(), views: rec.views };
  };
  /** Save as files.js does: hold, read the store, write, mark saved, then hand the journal the result. */
  const save = async ({ during = null, cancel = false } = {}) => {
    const since = j.hold();
    const kept = { records: JSON.stringify(store.snapshot()), views: { views: { p1: { zoom: 9 } } } };
    if (during) add(during); // an edit while the file is written
    if (cancel) return j.release();
    const until = j.seq;
    store.transact('Mark saved', (tx) => tx.set('project', 'savedAt', 'now'), { kind: 'load' });
    await j.saved(kept, since, until);
  };
  /** Click Recover in this session, as files.js does: the journal entry is replayed into the store. */
  const recoverHere = async () => {
    const rec = { key: 'gw/7', ...structuredClone(db.get('gw/7')) };
    await j.recovering(rec.key);
    store.load(typeof rec.snapshot === 'string' ? parseRecords(rec.snapshot) : rec.snapshot);
    for (const cs of rec.changesets) store.applyChangeSet(cs, { kind: 'load' });
  };
  return { j, db, store, add, recover, save, recoverHere };
}

describe('Journal after a save (#99)', () => {
  it('REQ-ARC-11 #99 open, edit A, save, edit B, crash: Recover gives A and B', async () => {
    const { j, add, recover, save } = setup();
    add('A');
    await j.flush();
    await save();
    add('B');
    await j.flush();
    expect(recover().names).toEqual(['A', 'B']);
  });

  it('REQ-ARC-11 #99 the views the save wrote come back with the records', async () => {
    const { j, add, recover, save } = setup();
    await save();
    add('B');
    await j.flush();
    expect(recover().views).toEqual({ views: { p1: { zoom: 9 } } });
  });

  it('REQ-ARC-11 #99 a save with nothing after it clears the journal, its own Mark saved included', async () => {
    const { j, db, add, save } = setup();
    add('A');
    await j.flush();
    await save();
    await j.flush();
    expect(db.size).toBe(0);
  });

  it('REQ-ARC-11 #99 an edit made while the file was written stays in the journal', async () => {
    const { j, db, add, recover, save } = setup();
    add('A');
    await save({ during: 'during' });
    expect(db.size).toBe(1);
    expect(recover().names).toEqual(['A', 'during']);
    add('B');
    await j.flush();
    expect(recover().names).toEqual(['A', 'B', 'during']);
  });

  it('REQ-ARC-11 #99 writes wait while a save is under way, and a cancelled save writes them', async () => {
    const { j, db, add, recover, save } = setup();
    add('A');
    j.hold();
    await j.flush();
    expect(db.size).toBe(0);
    j.holding--;
    await save({ cancel: true });
    expect(recover().names).toEqual(['A']);
  });

  it('REQ-ARC-11 #99 writes run one after another, so a save cannot be overtaken by an older write', async () => {
    const { j, db, add, recover, save } = setup();
    add('A1');
    await j.flush();
    add('A2');
    const old = j.flush(); // still reading the journal (A1) when the save lands
    await new Promise((r) => setTimeout(r, 1)); // the write has taken its batch and is reading
    await save();
    await old;
    add('B');
    await j.flush();
    expect(db.get('gw/7').changesets.map((c) => c.label)).toEqual(['B']);
    expect(recover().names).toEqual(['A1', 'A2', 'B']);
  });
  it('REQ-ARC-11 #99 an edit made during a save is not taken by a write that began before it', async () => {
    const { j, add, recover, save } = setup();
    add('A1');
    await j.flush();
    add('A2');
    const old = j.flush(); // takes A2, then reads
    await new Promise((r) => setTimeout(r, 1)); // the write has taken its batch and is reading
    await save({ during: 'D' });
    await old;
    expect(recover().names).toEqual(['A1', 'A2', 'D']);
  });
  it('REQ-ARC-11 #99 an edit made just after a save, before the journal has caught up, stays', async () => {
    const { j, add, recover, save } = setup();
    add('A');
    await j.flush();
    const saving = save();
    add('B');
    await saving;
    await j.flush();
    expect(recover().names).toEqual(['A', 'B']);
  });
});

describe('Journal after a Recover (#117)', () => {
  it('REQ-ARC-11 #117 an edit made while a write compacts the journal is replayed once', async () => {
    const { j, db, add, recover } = setup();
    for (let i = 0; i < 199; i++) add('L' + i);
    await j.flush();
    add('L199');
    const compacting = j.flush(); // the 200th change set: this write snapshots the store
    await new Promise((r) => setTimeout(r, 1));
    add('X'); // committed while that write reads, so the snapshot holds it
    await compacting;
    await j.flush();
    expect(db.get('gw/7').changesets.map((c) => c.label)).toEqual([]);
    expect(recover().names.filter((n) => n === 'X')).toEqual(['X']);
  });
  it('REQ-ARC-11 #117 crash, Recover, edit, crash again: each edit is recovered once', async () => {
    const first = setup();
    first.add('A');
    first.add('B');
    await first.j.flush();
    // Crash. The next session starts afresh and recovers.
    const second = setup(first.db);
    await second.recoverHere();
    expect(second.store.all('vlayer').map((v) => v.name).sort()).toEqual(['A', 'B']);
    // Until the replays are written, a crash still finds the entry they came from.
    expect(second.recover().names).toEqual(['A', 'B']);
    second.add('C');
    await second.j.flush();
    // Crash again: the entry holds each edit once, not A and B twice.
    expect(first.db.get('gw/7').changesets.map((c) => c.label)).toEqual(['A', 'B', 'C']);
    expect(second.recover().names).toEqual(['A', 'B', 'C']);
  });
  it('REQ-ARC-11 #117 a save straight after Recover removes the entry Recover read, under whatever key', async () => {
    const { j, db, store, save } = setup();
    db.set('gw/old', { changesets: [], snapshot: store.snapshot(), views: null, updated: 1 });
    await j.recovering('gw/old');
    store.load(db.get('gw/old').snapshot); // nothing to replay, so no write follows
    await j.flush();
    await save();
    expect([...db.keys()]).toEqual([]);
  });
});
