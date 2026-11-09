// Point-cloud edits without the DOM (REQ-GAP-81, REQ-LDR-09): the replay of a cloud's `pcedit`
// records over the file's own classes and flags, the one deleted-point mask every consumer honours,
// a compacted copy of the kept points (exports and outside analyses), and selection in a profile
// (box and lasso in the profile's own along/height plane).

import { reorder } from '../formats/las.js';

/** LAS 1.4 classification flag bit for withheld points (point formats 6–10). */
export const WITHHELD = 4;

/**
 * Replay edits over a cloud: `ops` are its `pcedit` records in sequence order, `diffOf(op)` gives an
 * op's {index, value} (no value for a deletion). An op's `params.field` says what it changes:
 * 'class' (the default, as before 2.7), 'flags', or 'deleted'. Returns {class, flags, deleted,
 * nDeleted}; `deleted` is null when no point is deleted.
 */
export function replay(c, ops, diffOf) {
  const cls = c.class0.slice();
  const flags = (c.flags0 ?? c.flags).slice();
  let deleted = null;
  let nDeleted = 0;
  for (const o of ops) {
    const d = diffOf(o);
    if (!d) continue;
    const field = o.params?.field ?? 'class';
    if (field === 'deleted') {
      deleted ??= new Uint8Array(c.n);
      for (let k = 0; k < d.index.length; k++) {
        if (!deleted[d.index[k]]) nDeleted++;
        deleted[d.index[k]] = 1;
      }
    } else {
      const to = field === 'flags' ? flags : cls;
      for (let k = 0; k < d.index.length; k++) to[d.index[k]] = d.value[k];
    }
  }
  return { class: cls, flags, deleted, nDeleted };
}

/** Is point k kept (not deleted)? */
export const kept = (c, k) => !c.deleted?.[k];

/** The indices of the kept points, or null when none is deleted. */
export function keptIndex(c) {
  if (!c.deleted) return null;
  const out = [];
  for (let k = 0; k < c.n; k++) if (!c.deleted[k]) out.push(k);
  return Uint32Array.from(out);
}

/**
 * The cloud as its kept points: the cloud itself when nothing is deleted, else a shallow copy with
 * every column compacted and no deleted mask or display state.
 */
export function compact(c) {
  const idx = keptIndex(c);
  if (!idx) return c;
  const sub = { ...c, deleted: null, nDeleted: 0, tiles: null, order: null, dtm: null };
  reorder(sub, idx);
  for (const f of ['hag', 'class0', 'flags0']) if (c[f]) sub[f] = c[f].constructor.from(idx, (k) => c[f][k]);
  sub.n = idx.length;
  return sub;
}

/** Points of a profile (its `along`, `z` and `index`) inside a box [along0, z0, along1, z1]. */
export function selectBox(pr, box) {
  const [a0, a1] = [Math.min(box[0], box[2]), Math.max(box[0], box[2])];
  const [z0, z1] = [Math.min(box[1], box[3]), Math.max(box[1], box[3])];
  const out = [];
  for (let i = 0; i < pr.index.length; i++) if (pr.along[i] >= a0 && pr.along[i] <= a1 && pr.z[i] >= z0 && pr.z[i] <= z1) out.push(pr.index[i]);
  return Uint32Array.from(out);
}

/** Points of a profile inside a lasso ring [[along, z]…] (even-odd). */
export function selectLasso(pr, ring) {
  const out = [];
  if (ring.length < 3) return Uint32Array.from(out);
  for (let i = 0; i < pr.index.length; i++) {
    const x = pr.along[i];
    const y = pr.z[i];
    let inside = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) if (ring[a][1] > y !== ring[b][1] > y && x < ((ring[b][0] - ring[a][0]) * (y - ring[a][1])) / (ring[b][1] - ring[a][1]) + ring[a][0]) inside = !inside;
    if (inside) out.push(pr.index[i]);
  }
  return Uint32Array.from(out);
}
