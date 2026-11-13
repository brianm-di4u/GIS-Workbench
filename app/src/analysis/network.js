// Road networks from the user's own line layer (REQ-GAP-85): the pure parts. The graph has a node
// at every line end and at every vertex two lines share (so a bridge that only crosses a road
// stays apart from it), an edge for each piece of line between nodes, costs from the length and
// a speed field, one-way rules from a field, and turn bans as pairs of lines. The search itself is
// Rust (gw-vector network.rs, the `vector` bundle); this builds its input and reads its output.

/** Metres per degree of longitude and latitude at a latitude, on the WGS 84 ellipsoid. */
function radii(lat) {
  const a = 6378137;
  const e2 = 0.0066943799901413165;
  const s = Math.sin((lat * Math.PI) / 180);
  const w = 1 - e2 * s * s;
  const r = Math.PI / 180;
  return { kx: ((a / Math.sqrt(w)) * Math.cos((lat * Math.PI) / 180)) * r, ky: ((a * (1 - e2)) / (w * Math.sqrt(w))) * r };
}
/** A segment's length (m) at its own latitude: within parts per million of the geodesic. */
function segment(a, b) {
  const r = radii((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * r.kx, (b[1] - a[1]) * r.ky);
}
const lengthOf = (coords) => coords.reduce((s, p, i) => (i ? s + segment(coords[i - 1], p) : 0), 0);
/** Equal vertices: the same to about a centimetre. */
const key = (p) => `${Math.round(p[0] * 1e7)},${Math.round(p[1] * 1e7)}`;

const flag = (v) =>
  String(v ?? '')
    .trim()
    .toLowerCase();
/**
 * Which convention a one-way field follows, from its values: 'here' when it holds HERE or Esri
 * directions (FT, TF, B) and no Y, where N means closed; 'bool' when it holds only T and F (a DBF
 * logical field: T is one-way along the line, F two-way); otherwise 'yn', where N means two-way.
 */
export function onewayRule(values) {
  const s = new Set([...values].map(flag));
  if (s.has('y')) return 'yn';
  if (['ft', 'tf', 'b'].some((x) => s.has(x))) return 'here';
  return s.has('t') || s.has('f') ? 'bool' : 'yn';
}

/**
 * One-way rule from a field value: 1 = along the line only, -1 = against it only, 0 = both ways,
 * null = closed. Knows OSM (yes, -1, no), Y/N, Esri and HERE (FT, TF, B, N) and true/false. N is
 * closed only under the 'here' rule (see onewayRule). Under the 'bool' rule T and F are true and
 * false: T is one-way along the line, F two-way.
 */
export function onewayOf(v, rule = 'here') {
  const s = flag(v);
  if (rule === 'bool' && (s === 't' || s === 'f')) return s === 't' ? 1 : 0;
  if (['yes', 'y', 'true', '1', 'ft', 'f', 'forward'].includes(s)) return 1;
  if (['-1', 'tf', 't', 'reverse', 'backward'].includes(s)) return -1;
  if (s === 'closed' || (s === 'n' && rule === 'here')) return null;
  return 0;
}

/**
 * The graph of `lines` ([{id, coords: [[lon, lat]…], attrs}]). Options: `oneway` and `speed`
 * fields (null for none), `onewayAs` the one-way rule ('here', 'yn' or 'bool'; by default read
 * from the field's values, see onewayRule), `cost` 'length' (metres) or 'time' (seconds at the speed, km/h, or
 * `defaultSpeed` where the field is empty), and `bans` ([{from, to}] line ids: no turn from the
 * first line straight onto the second where they meet).
 */
export function buildGraph(lines, { oneway = null, onewayAs = null, speed = null, cost = 'length', defaultSpeed = 50, bans = [] } = {}) {
  const ok = lines.filter((l) => Array.isArray(l.coords) && l.coords.length >= 2);
  if (!ok.length) return null;
  // A local frame, metres east and north, for the A* heuristic and snapping to the network. It must never
  // make two nodes look further apart than they are, so it takes the east–west scale at the
  // latitude furthest from the equator and the north–south scale at the one nearest it.
  let sx = 0;
  let sy = 0;
  let n0 = 0;
  let near = Infinity;
  let far = 0;
  for (const l of ok) {
    sx += l.coords[0][0];
    sy += l.coords[0][1];
    n0++;
    for (const p of l.coords) {
      const a = Math.min(90, Math.abs(p[1]));
      near = Math.min(near, a);
      far = Math.max(far, a);
    }
  }
  const lon0 = sx / n0;
  const lat0 = sy / n0;
  const kx = radii(far).kx;
  const ky = radii(near).ky;
  const to = (p) => [(p[0] - lon0) * kx, (p[1] - lat0) * ky];
  // Lengths, though, use the scale at each segment's own latitude (segment), wherever the network is.
  // Vertices used by more than one line, or twice by one, are nodes; so are line ends.
  const uses = new Map();
  // Every visit counts, so a line that loops back onto itself (a cul-de-sac drawn as one line) is
  // split where it does; a vertex digitised twice in a row is one visit.
  for (const l of ok) {
    let prev = null;
    for (const p of l.coords) {
      const k = key(p);
      if (k !== prev) uses.set(k, (uses.get(k) ?? 0) + 1);
      prev = k;
    }
  }
  const nodeId = new Map();
  const nodes = [];
  const node = (p) => {
    const k = key(p);
    let i = nodeId.get(k);
    if (i === undefined) {
      nodeId.set(k, (i = nodes.length));
      nodes.push([p[0], p[1]]);
    }
    return i;
  };
  const edges = [];
  const byLine = new Map();
  const rule = oneway ? (onewayAs ?? onewayRule(new Set(ok.map((l) => l.attrs?.[oneway])))) : 'yn';
  for (const l of ok) {
    const way = oneway ? onewayOf(l.attrs?.[oneway], rule) : 0;
    if (way === null) continue;
    const kmh = speed ? Number(l.attrs?.[speed]) : NaN;
    const ms = ((Number.isFinite(kmh) && kmh > 0 ? kmh : defaultSpeed) * 1000) / 3600;
    let start = 0;
    const mine = [];
    for (let i = 1; i < l.coords.length; i++) {
      if (i < l.coords.length - 1 && (uses.get(key(l.coords[i])) ?? 0) < 2) continue;
      const part = l.coords.slice(start, i + 1);
      const len = lengthOf(part);
      // A vertex digitised twice in a row is no edge.
      if (len === 0) {
        start = i;
        continue;
      }
      const c = cost === 'time' ? len / ms : len;
      const e = { line: l.id, from: node(part[0]), to: node(part.at(-1)), fwd: way >= 0 ? c : Infinity, bwd: way <= 0 ? c : Infinity, len, coords: part };
      mine.push(edges.length);
      edges.push(e);
      start = i;
    }
    // A road id can repeat (a multipart feature, or a way split in two): keep every piece's edges.
    byLine.set(l.id, [...(byLine.get(l.id) ?? []), ...mine]);
  }
  // Bans: the edges of the two lines that meet at a shared node.
  const banned = [];
  for (const b of bans) {
    for (const ea of byLine.get(b.from) ?? []) {
      for (const eb of byLine.get(b.to) ?? []) {
        const A = edges[ea];
        const B = edges[eb];
        if ([A.from, A.to].some((v) => v === B.from || v === B.to)) banned.push([ea, eb]);
      }
    }
  }
  const xy = nodes.flatMap(to);
  return { nodes, edges, banned, xy, frame: { lon0, lat0, kx, ky }, cost };
}

/** The graph as the `vector` bundle takes it (see gw_network). */
export function graphData(g) {
  const ne = g.edges.length;
  const d = new Float64Array(3 + 5 * ne + g.xy.length + 2 * g.banned.length);
  d[0] = g.nodes.length;
  d[1] = ne;
  d[2] = g.banned.length;
  g.edges.forEach((e, i) => {
    d[3 + i] = e.from;
    d[3 + ne + i] = e.to;
    d[3 + 2 * ne + i] = Number.isFinite(e.fwd) ? e.fwd : -1;
    d[3 + 3 * ne + i] = Number.isFinite(e.bwd) ? e.bwd : -1;
    d[3 + 4 * ne + i] = e.len;
  });
  d.set(g.xy, 3 + 5 * ne);
  g.banned.forEach(([a, b], i) => {
    d[3 + 5 * ne + g.xy.length + 2 * i] = a;
    d[3 + 5 * ne + g.xy.length + 2 * i + 1] = b;
  });
  return d;
}

/**
 * Where a lon/lat meets the network: the graph with a node at the nearest point of the nearest
 * edge, that node, and how far away it is (m). The edge is split there into two pieces with its
 * line, one-way rule and turn bans, and costs in proportion to their lengths, so a route starts
 * where the user clicked, not at the far end of a long road. A point within `tol` metres of an
 * end of the edge takes the node there and leaves the graph as it is. `g` is never changed.
 */
export function snapToEdge(g, at, tol = 1) {
  const { lon0, lat0, kx, ky } = g.frame;
  const px = (at[0] - lon0) * kx;
  const py = (at[1] - lat0) * ky;
  let best = null;
  g.edges.forEach((e, ei) => {
    for (let i = 1; i < e.coords.length; i++) {
      const ax = (e.coords[i - 1][0] - lon0) * kx;
      const ay = (e.coords[i - 1][1] - lat0) * ky;
      const dx = (e.coords[i][0] - lon0) * kx - ax;
      const dy = (e.coords[i][1] - lat0) * ky - ay;
      const L2 = dx * dx + dy * dy;
      const u = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(ax + u * dx - px, ay + u * dy - py);
      if (!best || d < best.metres) best = { ei, i, u, metres: d };
    }
  });
  if (!best) return null;
  const { ei, i, u, metres } = best;
  const e = g.edges[ei];
  const [a, b] = [e.coords[i - 1], e.coords[i]];
  const P = [a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])];
  const head = [...e.coords.slice(0, i), P];
  const la = lengthOf(head);
  if (la <= tol) return { g, node: e.from, metres };
  if (e.len - la <= tol) return { g, node: e.to, metres };
  const n = g.nodes.length;
  const f = la / e.len;
  const edges = g.edges.slice();
  edges[ei] = { ...e, to: n, fwd: e.fwd * f, bwd: e.bwd * f, len: la, coords: head };
  const bi = edges.push({ ...e, from: n, fwd: e.fwd * (1 - f), bwd: e.bwd * (1 - f), len: e.len - la, coords: [P, ...e.coords.slice(i)] }) - 1;
  // A ban on the split edge holds where it was: at its start for the first piece, at its end for
  // the second. A U-turn ban ([x, x]) holds on each piece. The new node joins only the two pieces,
  // so no turn between them is banned there.
  const pieces = (x) => (x === ei ? [ei, bi] : [x]);
  const meet = (x, y) => [edges[x].from, edges[x].to].some((v) => v !== n && (v === edges[y].from || v === edges[y].to));
  const banned = [];
  for (const [x, y] of g.banned) {
    if (x === y) for (const p of pieces(x)) banned.push([p, p]);
    else for (const p of pieces(x)) for (const q of pieces(y)) if (p !== q && meet(p, q)) banned.push([p, q]);
  }
  const xy = new Float64Array(g.xy.length + 2);
  xy.set(g.xy);
  xy[g.xy.length] = (P[0] - lon0) * kx;
  xy[g.xy.length + 1] = (P[1] - lat0) * ky;
  return { g: { ...g, nodes: [...g.nodes, P], edges, banned, xy }, node: n, metres };
}

/** A route's line: the edges' vertices in the direction travelled, without repeating the joins. */
export function routeLine(g, edges, forward) {
  const out = [];
  edges.forEach((e, i) => {
    const c = forward[i] ? g.edges[e].coords : g.edges[e].coords.slice().reverse();
    out.push(...(out.length ? c.slice(1) : c));
  });
  return out;
}

/** A line cut at a fraction of its length from its start. */
function cutAt(coords, f) {
  if (f >= 1) return coords.slice();
  const seg = [];
  let L = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = Math.hypot((coords[i][0] - coords[i - 1][0]) * Math.cos((coords[i][1] * Math.PI) / 180), coords[i][1] - coords[i - 1][1]);
    seg.push(d);
    L += d;
  }
  let want = f * L;
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    if (want <= seg[i - 1]) {
      const u = seg[i - 1] > 0 ? want / seg[i - 1] : 0;
      out.push([coords[i - 1][0] + u * (coords[i][0] - coords[i - 1][0]), coords[i - 1][1] + u * (coords[i][1] - coords[i - 1][1])]);
      return out;
    }
    want -= seg[i - 1];
    out.push(coords[i]);
  }
  return out;
}

/**
 * The network within each cost break of a service area, as lines: every edge reached within the
 * break in full, and the reachable part of an edge whose far end is beyond it (from either end in
 * reach, in the directions allowed). `costs` is the bundle's cost per node (null = not reached);
 * `entry`, when given, its cost to enter each edge (2i + 1 along, 2i against), which a turn ban can
 * make higher than the cost at the node. Returns [{brk, coords}] for every break, so a larger
 * break repeats what a smaller one holds.
 */
export function serviceLines(g, costs, breaks, entry = null) {
  const out = [];
  const at = (arr, k) => (arr[k] === null || arr[k] === undefined ? Infinity : arr[k]);
  for (const [i, e] of g.edges.entries()) {
    const ca = entry ? at(entry, 2 * i + 1) : at(costs, e.from);
    const cb = entry ? at(entry, 2 * i) : at(costs, e.to);
    // The whole edge is reached when it can be driven end to end from a reached end.
    const full = Math.min(Number.isFinite(e.fwd) ? ca + e.fwd : Infinity, Number.isFinite(e.bwd) ? cb + e.bwd : Infinity);
    for (const B of breaks) {
      if (full <= B) out.push({ brk: B, coords: e.coords.slice() });
      else {
        if (Number.isFinite(e.fwd) && ca < B && e.fwd > 0) out.push({ brk: B, coords: cutAt(e.coords, (B - ca) / e.fwd) });
        if (Number.isFinite(e.bwd) && cb < B && e.bwd > 0) out.push({ brk: B, coords: cutAt(e.coords.slice().reverse(), (B - cb) / e.bwd) });
      }
    }
  }
  return out;
}
