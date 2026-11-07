// Orthogonal regularizer (REQ-LAI-02; 2.0 plan P5): squares the outline of a man-made object (a
// SAM polygon of a building) so its corners are right angles. The dominant direction is the
// length-weighted mean of the edge directions modulo 90°; each edge is snapped to that direction
// or its perpendicular; runs of edges with the same direction become one line placed at their
// length-weighted mean offset; lines shorter than `minLen` are dropped and their neighbours
// merged; consecutive (perpendicular) lines are intersected for the corners.

/** ring [[x, y], …] (open or closed) → squared ring (open), or the input when it cannot be squared. */
export function regularize(ring, { minLen = 2 } = {}) {
  const pts = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring.slice();
  const n = pts.length;
  if (n < 4) return pts;
  // Dominant direction θ from the 4θ-doubled angles (period 90°).
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    const len = Math.hypot(bx - ax, by - ay);
    const a = Math.atan2(by - ay, bx - ax);
    sx += len * Math.cos(4 * a);
    sy += len * Math.sin(4 * a);
  }
  const th = Math.atan2(sy, sx) / 4;
  const u = [Math.cos(th), Math.sin(th)]; // direction 0
  const v = [-Math.sin(th), Math.cos(th)]; // direction 1
  // Edges → {dir 0|1, offset (along the normal), length, extent along the line}.
  const edges = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % n];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const along0 = Math.abs(dx * u[0] + dy * u[1]);
    const along1 = Math.abs(dx * v[0] + dy * v[1]);
    const dir = along0 >= along1 ? 0 : 1;
    const nrm = dir === 0 ? v : u; // the normal of a direction-0 line is v
    const mx = (ax + bx) / 2;
    const my = (ay + by) / 2;
    edges.push({ dir, off: mx * nrm[0] + my * nrm[1], len });
  }
  // Merge runs of one direction (around the ring).
  const merge = (list) => {
    const out = [];
    for (const e of list) {
      const last = out.at(-1);
      if (last && last.dir === e.dir) {
        const L = last.len + e.len;
        last.off = (last.off * last.len + e.off * e.len) / L;
        last.len = L;
      } else out.push({ ...e });
    }
    if (out.length > 1 && out[0].dir === out.at(-1).dir) {
      const a = out.pop();
      const L = a.len + out[0].len;
      out[0].off = (a.off * a.len + out[0].off * out[0].len) / L;
      out[0].len = L;
    }
    return out;
  };
  let lines = merge(edges);
  // Drop the shortest line below minLen, re-merge, repeat (keep at least a rectangle).
  for (let guard = 0; guard < 1000 && lines.length > 4; guard++) {
    let k = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].len < minLen && (k < 0 || lines[i].len < lines[k].len)) k = i;
    if (k < 0) break;
    lines.splice(k, 1);
    lines = merge(lines);
  }
  if (lines.length < 4 || lines.length % 2) return pts;
  // Corner between line i (dir d, offset o) and line i+1 (the other direction).
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i];
    const b = lines[(i + 1) % lines.length];
    const o0 = a.dir === 0 ? a.off : b.off; // offset along v of the direction-0 line
    const o1 = a.dir === 1 ? a.off : b.off; // offset along u of the direction-1 line
    out.push([o1 * u[0] + o0 * v[0], o1 * u[1] + o0 * v[1]]);
  }
  return out;
}
