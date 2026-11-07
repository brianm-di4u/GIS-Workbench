// Project-wide undo/redo over store change sets (REQ-ARC-13): 500 steps; edits that share
// a mergeKey coalesce until seal() (pointer-up, field blur), so one drag is one step.

import { Emitter } from './util.js';

export class UndoManager extends Emitter {
  constructor(store, { limit = 500 } = {}) {
    super();
    this.store = store;
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.openKey = null;
    this._replaying = false;
    store.on('commit', (cs) => this._record(cs));
  }

  _record(cs) {
    if (this._replaying || cs.kind === 'undo' || cs.kind === 'redo' || cs.kind === 'load') return;
    const top = this.undoStack[this.undoStack.length - 1];
    if (cs.mergeKey && top && this.openKey === cs.mergeKey && top.mergeKey === cs.mergeKey) {
      // Coalesce: keep the first prev of each path, append new ops.
      top.ops = top.ops.concat(cs.ops);
      top.ts = cs.ts;
    } else {
      this.undoStack.push({ ...cs, ops: [...cs.ops] });
      if (this.undoStack.length > this.limit) this.undoStack.shift();
    }
    this.openKey = cs.mergeKey ?? null;
    this.redoStack.length = 0;
    this.emit('change');
  }

  seal() {
    this.openKey = null;
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const cs = this.undoStack.pop();
    if (!cs) return null;
    this.openKey = null;
    this._replaying = true;
    try {
      this.store.revertChangeSet(cs, { kind: 'undo', label: `Undo ${cs.label}` });
    } finally {
      this._replaying = false;
    }
    this.redoStack.push(cs);
    this.emit('change');
    return cs;
  }

  redo() {
    const cs = this.redoStack.pop();
    if (!cs) return null;
    this._replaying = true;
    try {
      this.store.applyChangeSet(cs, { kind: 'redo', label: cs.label });
    } finally {
      this._replaying = false;
    }
    this.undoStack.push(cs);
    this.emit('change');
    return cs;
  }

  /** History list for the History dialog: newest first. */
  history() {
    return [
      ...this.redoStack.map((cs) => ({ label: cs.label, ts: cs.ts, state: 'redo', author: cs.author })).reverse(),
      ...[...this.undoStack].reverse().map((cs) => ({ label: cs.label, ts: cs.ts, state: 'done', author: cs.author })),
    ];
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.openKey = null;
    this.emit('change');
  }
}
