// One op/transaction store for every user edit (REQ-ARC-12): layers, panes, chains,
// graphics, features, measurements, observations. Ops are invertible; a committed
// transaction becomes a change set that undo, the journal and AI proposals use.
//
// Ops:
//   {op:'create', id, rec}                 add a record
//   {op:'delete', id}                      remove a record (prev = the record)
//   {op:'set', id, path, value}            set a dotted path (prev recorded)
//   {op:'vset', id, path, index, value}    set one vertex of a coordinate array (no clone)
//   {op:'vins', id, path, index, value}    insert a vertex
//   {op:'vdel', id, path, index}           remove a vertex
// Geometry coordinate arrays are arrays of [x, y(, z)] vertices; vertex ops touch one entry,
// so a 10 000-vertex polygon edit costs one small op (S-17).

import { Emitter, clone, deepEqual, getPath, setPath, newId, splitPath } from './util.js';

export class Store extends Emitter {
  constructor() {
    super();
    this.records = new Map();
    this.byType = new Map();
    this.rev = 0;
    this._tx = null;
    this._silent = 0;
  }

  get(id) {
    return this.records.get(id);
  }

  has(id) {
    return this.records.has(id);
  }

  all(type) {
    if (!type) return [...this.records.values()];
    const s = this.byType.get(type);
    return s ? [...s].map((id) => this.records.get(id)) : [];
  }

  _index(rec, add) {
    const t = rec.type ?? 'record';
    if (!this.byType.has(t)) this.byType.set(t, new Set());
    if (add) this.byType.get(t).add(rec.id);
    else this.byType.get(t).delete(rec.id);
  }

  /** Apply one op and return it with what is needed to invert it. */
  _apply(op) {
    const { id } = op;
    switch (op.op) {
      case 'create': {
        if (this.records.has(id)) throw new Error(`record ${id} exists`);
        const rec = clone(op.rec);
        rec.id = id;
        this.records.set(id, rec);
        this._index(rec, true);
        return { op: 'create', id, rec: clone(rec) };
      }
      case 'delete': {
        const rec = this.records.get(id);
        if (!rec) throw new Error(`no record ${id}`);
        this.records.delete(id);
        this._index(rec, false);
        return { op: 'delete', id, prev: rec };
      }
      case 'set': {
        const rec = this.records.get(id);
        if (!rec) throw new Error(`no record ${id}`);
        const parts = splitPath(op.path);
        if (parts[0] === 'id') throw new Error('ids are immutable');
        if (parts[0] === 'type' && parts.length === 1) throw new Error('record type is immutable');
        const value = clone(op.value);
        const prev = setPath(rec, parts, value);
        return { op: 'set', id, path: op.path, value: clone(value), prev };
      }
      case 'vset':
      case 'vins':
      case 'vdel': {
        const rec = this.records.get(id);
        if (!rec) throw new Error(`no record ${id}`);
        const arr = getPath(rec, op.path);
        if (!Array.isArray(arr)) throw new Error(`${op.path} is not a vertex array`);
        const i = op.index;
        if (!Number.isInteger(i) || i < 0 || i > arr.length || (op.op !== 'vins' && i === arr.length)) throw new Error(`vertex index ${i} out of range`);
        if (op.op === 'vset') {
          const prev = arr[i];
          arr[i] = [...op.value];
          return { op: 'vset', id, path: op.path, index: i, value: [...op.value], prev };
        }
        if (op.op === 'vins') {
          arr.splice(i, 0, [...op.value]);
          return { op: 'vins', id, path: op.path, index: i, value: [...op.value] };
        }
        const [prev] = arr.splice(i, 1);
        return { op: 'vdel', id, path: op.path, index: i, prev };
      }
      default:
        throw new Error(`unknown op ${op.op}`);
    }
  }

  static invert(op) {
    switch (op.op) {
      case 'create':
        return { op: 'delete', id: op.id };
      case 'delete':
        return { op: 'create', id: op.id, rec: op.prev };
      case 'set':
        return { op: 'set', id: op.id, path: op.path, value: op.prev };
      case 'vset':
        return { op: 'vset', id: op.id, path: op.path, index: op.index, value: op.prev };
      case 'vins':
        return { op: 'vdel', id: op.id, path: op.path, index: op.index };
      case 'vdel':
        return { op: 'vins', id: op.id, path: op.path, index: op.index, value: op.prev };
      default:
        throw new Error(`cannot invert ${op.op}`);
    }
  }

  /**
   * Run fn(tx) inside a transaction. Ops apply immediately (later reads see them); any
   * exception rolls everything back. Returns the change set, or null if nothing changed.
   */
  transact(label, fn, opts = {}) {
    if (this._tx) {
      // Nested: join the outer transaction.
      return fn(this._tx);
    }
    const applied = [];
    const tx = {
      store: this,
      apply: (op) => {
        const done = this._apply(op);
        applied.push(done);
        return done;
      },
      create: (type, rec = {}, id = rec.id ?? newId(type.slice(0, 4))) => {
        tx.apply({ op: 'create', id, rec: { ...rec, type } });
        return id;
      },
      delete: (id) => tx.apply({ op: 'delete', id }),
      set: (id, path, value) => {
        const cur = getPath(this.records.get(id), path);
        if (deepEqual(cur, value)) return null;
        return tx.apply({ op: 'set', id, path, value });
      },
      vset: (id, path, index, value) => tx.apply({ op: 'vset', id, path, index, value }),
      vins: (id, path, index, value) => tx.apply({ op: 'vins', id, path, index, value }),
      vdel: (id, path, index) => tx.apply({ op: 'vdel', id, path, index }),
      get: (id) => this.records.get(id),
    };
    this._tx = tx;
    let result;
    try {
      result = fn(tx);
      if (result && typeof result.then === 'function') throw new Error('transactions must be synchronous');
    } catch (e) {
      for (let i = applied.length - 1; i >= 0; i--) this._apply(Store.invert(applied[i]));
      this._tx = null;
      throw e;
    }
    this._tx = null;
    if (!applied.length) return null;
    const cs = {
      id: newId('cs'),
      label,
      kind: opts.kind ?? 'edit',
      author: opts.author ?? 'user',
      provenance: opts.provenance ?? null,
      ts: Date.now(),
      mergeKey: opts.mergeKey ?? null,
      ops: applied,
      rev: ++this.rev,
    };
    if (opts.dryRun) {
      for (let i = applied.length - 1; i >= 0; i--) this._apply(Store.invert(applied[i]));
      this.rev--;
      return cs;
    }
    this.emit('commit', cs);
    this.emit('change', { cs, ids: new Set(applied.map((o) => o.id)) });
    return cs;
  }

  /** Capture the change set fn would make, then revert it (AI proposals, REQ-AI-06). */
  dryRun(label, fn, opts = {}) {
    return this.transact(label, fn, { ...opts, dryRun: true });
  }

  /** Whether a change set would still apply exactly as captured (proposal staleness). */
  isCurrent(cs) {
    for (const o of cs.ops) {
      const rec = this.records.get(o.id);
      switch (o.op) {
        case 'create':
          if (rec) return false;
          break;
        case 'delete':
          if (!rec) return false;
          break;
        case 'set':
          if (!rec || !deepEqual(getPath(rec, o.path), o.prev)) return false;
          break;
        default:
          if (!rec) return false;
      }
    }
    return true;
  }

  /** Replay a change set atomically as a new transaction. */
  applyChangeSet(cs, opts = {}) {
    return this.transact(opts.label ?? cs.label, (tx) => {
      for (const o of cs.ops) {
        const { prev, ...fwd } = o;
        tx.apply(fwd);
      }
    }, { kind: opts.kind ?? cs.kind, author: opts.author ?? cs.author, provenance: opts.provenance ?? cs.provenance, mergeKey: null });
  }

  /** Revert a change set (used by undo). */
  revertChangeSet(cs, opts = {}) {
    return this.transact(opts.label ?? `Undo ${cs.label}`, (tx) => {
      for (let i = cs.ops.length - 1; i >= 0; i--) tx.apply(Store.invert(cs.ops[i]));
    }, { kind: opts.kind ?? 'undo', author: 'user' });
  }

  /** Serialise all records (project file). */
  snapshot() {
    return [...this.records.values()].map((r) => clone(r));
  }

  /** Replace all records without history (project load). */
  load(records) {
    this.records.clear();
    this.byType.clear();
    for (const r of records) {
      if (!r || typeof r.id !== 'string') continue;
      const rec = clone(r);
      this.records.set(rec.id, rec);
      this._index(rec, true);
    }
    this.rev++;
    this.emit('reset');
    this.emit('change', { cs: null, ids: null });
  }
}
