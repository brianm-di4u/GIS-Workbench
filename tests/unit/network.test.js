// REQ-GAP-85 road networks: the graph built from line layers (analysis/network.js), and routes and
// service areas from the `vector` WASM bundle (gw-vector network.rs) on the SCN-78 fixture city
// against the independent reference tests/tools/network_ref.py wrote (scipy Dijkstra on its own
// graph, GeographicLib edge lengths). The bundle tests are skipped when the bundle is absent.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VectorBundle } from '../../app/src/wasm/vector.js';
import { buildGraph, graphData, snapToEdge, onewayAmbiguous, onewayOf, onewayRule, routeLine, serviceLines } from '../../app/src/analysis/network.js';

const wasmPath = (() => {
  try {
    const t = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps'], { cwd: resolve('crates'), encoding: 'utf8' })).target_directory;
    return join(t, 'wasm32-unknown-unknown', 'release', 'gw_bundle_vector.wasm');
  } catch {
    return null;
  }
})();
const haveWasm = !!wasmPath && existsSync(wasmPath);
const B = haveWasm ? new VectorBundle(new WebAssembly.Module(readFileSync(wasmPath))) : null;

const ROADS = JSON.parse(readFileSync('fixtures/network/city-roads.geojson', 'utf8')).features.map((f) => ({ id: f.properties.id, coords: f.geometry.coordinates, attrs: f.properties }));
const REF = JSON.parse(readFileSync('fixtures/network/city.ref.json', 'utf8'));

describe('REQ-GAP-85 the graph of a line layer', () => {
  it('reads one-way rules in the common spellings', () => {
    const of = (vs, rule) => vs.map((v) => onewayOf(v, rule));
    expect(of(['yes', 'Y', 'FT', 'true', '1'])).toEqual([1, 1, 1, 1, 1]);
    expect(of(['-1', 'TF', 'reverse'])).toEqual([-1, -1, -1]);
    expect(of(['no', 'B', '', null, '0', 'none'])).toEqual([0, 0, 0, 0, 0, 0]);
    expect(of(['N', 'closed'], 'here')).toEqual([null, null]);
    expect(of(['N', 'closed'], 'yn')).toEqual([0, null]);
  });
  it('reads N as two-way beside Y, and as closed only beside HERE directions', () => {
    expect(onewayRule(['Y', 'N', 'N'])).toBe('yn');
    expect(onewayRule(['N', ''])).toBe('yn');
    expect(onewayRule(['FT', 'B', 'N'])).toBe('here');
    const lines = [
      { id: 'a', coords: [[0, 0], [0.001, 0]], attrs: { ow: 'Y' } },
      { id: 'b', coords: [[0.001, 0], [0.002, 0]], attrs: { ow: 'N' } },
    ];
    const g = buildGraph(lines, { oneway: 'ow' });
    expect(g.edges.map((e) => [e.line, Number.isFinite(e.fwd), Number.isFinite(e.bwd)])).toEqual([['a', true, false], ['b', true, true]]);
  });
  it('asks about a field of only T and F, and reads it either way', () => {
    expect(onewayAmbiguous(['T', 'F', '', null, 't'])).toBe(true);
    expect([['T', 'F', 'B'], ['yes', 'no'], [], ['', null]].map(onewayAmbiguous)).toEqual([false, false, false, false]);
    const lines = [
      { id: 'a', coords: [[0, 0], [0.001, 0]], attrs: { ow: 'T' } },
      { id: 'b', coords: [[0.001, 0], [0.002, 0]], attrs: { ow: 'F' } },
    ];
    const ways = (o) => buildGraph(lines, { oneway: 'ow', ...o }).edges.map((e) => [Number.isFinite(e.fwd), Number.isFinite(e.bwd)]);
    // HERE directions, as before: T against the line, F along it.
    expect(ways({})).toEqual([[false, true], [true, false]]);
    expect(ways({ onewayAs: 'here' })).toEqual([[false, true], [true, false]]);
    // True and false: T one-way along the line, F two-way.
    expect(ways({ onewayAs: 'bool' })).toEqual([[true, false], [true, true]]);
  });
  it('splits a line where it loops back onto itself', () => {
    // A cul-de-sac drawn as one line: A to J, round the loop, back to J.
    const g = buildGraph([{ id: 'c', coords: [[0, 0], [0.002, 0], [0.002, 0.001], [0.003, 0.001], [0.003, 0], [0.002, 0], [0.002, 0]] }]);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(2);
    const aj = g.edges.find((e) => e.from !== e.to);
    expect(aj.len).toBeCloseTo(222.4, 0);
  });
  it('keeps the turn bans of every piece of a road whose id repeats', () => {
    // Road A and road B each come in two pieces with the same id; their second pieces meet.
    const lines = [
      { id: 'A', coords: [[0, 0], [0.001, 0]] },
      { id: 'A', coords: [[0.001, 0], [0.002, 0]] },
      { id: 'B', coords: [[0.002, 0.002], [0.002, 0.001]] },
      { id: 'B', coords: [[0.002, 0.001], [0.002, 0]] },
    ];
    const g = buildGraph(lines, { bans: [{ from: 'A', to: 'B' }] });
    expect(g.banned).toEqual([[1, 3]]);
  });
  it('measures each segment at its own latitude, across a network that spans 60 degrees', () => {
    // GeographicLib (WGS 84) Inverse: 0.01 degree east at 60 N is 558.0000151931846 m, at the equator 1113.1949079327358 m.
    const g = buildGraph([{ id: 'n', coords: [[0, 60], [0.01, 60]] }, { id: 's', coords: [[0, 0], [0.01, 0]] }]);
    expect(g.edges[0].len / 558.0000151931846 - 1).toBeLessThan(1e-6);
    expect(Math.abs(g.edges[1].len / 1113.1949079327358 - 1)).toBeLessThan(1e-6);
    // The heuristic's frame never stretches a distance: no straight line in it is longer than the edge.
    for (const e of g.edges) expect(Math.hypot(g.xy[2 * e.to] - g.xy[2 * e.from], g.xy[2 * e.to + 1] - g.xy[2 * e.from + 1])).toBeLessThanOrEqual(e.len);
  });
  it('has a node at every line end and shared vertex, and no node where a bridge only crosses', () => {
    const g = buildGraph(ROADS, { oneway: 'oneway', speed: 'speed', cost: 'time' });
    expect(g.nodes.length).toBe(REF.nodes);
    expect(g.edges.length).toBe(REF.edges);
    // The expressway is one edge, from corner to corner.
    expect(g.edges.filter((e) => e.line === 'xw')).toHaveLength(1);
    // The closed avenue has no edges.
    expect(g.edges.filter((e) => e.line === 'av10')).toHaveLength(0);
  });
  it('turns the bans of two lines into the edge pairs that meet', () => {
    const lines = [
      { id: 'a', coords: [[0, 0], [0.001, 0]] },
      { id: 'b', coords: [[0.001, 0], [0.001, 0.001]] },
      { id: 'c', coords: [[0.002, 0], [0.002, 0.001]] },
    ];
    const g = buildGraph(lines, { bans: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }] });
    expect(g.banned).toEqual([[0, 1]]);
  });
  it('joins a route and cuts service-area edges at the break', () => {
    const g = buildGraph([{ id: 'a', coords: [[0, 0], [0.001, 0], [0.002, 0]] }, { id: 'b', coords: [[0.002, 0], [0.002, 0.001]] }]);
    expect(routeLine(g, [0, 1], [true, true])).toEqual([[0, 0], [0.001, 0], [0.002, 0], [0.002, 0.001]]);
    expect(routeLine(g, [1, 0], [false, false])).toEqual([[0.002, 0.001], [0.002, 0], [0.001, 0], [0, 0]]);
    // From node 0, edge a (about 170 m) is cut half way at a break of half its cost.
    const half = g.edges[0].fwd / 2;
    const s = serviceLines(g, [0, null, null], [half]);
    expect(s).toHaveLength(1);
    expect(s[0].coords[0]).toEqual([0, 0]);
    expect(s[0].coords.at(-1)[0]).toBeCloseTo(0.001, 6);
  });
  it('snaps a pick to the nearest point of the nearest edge, and splits the edge there', () => {
    const lines = [{ id: 'a', coords: [[0, 0], [0.001, 0], [0.002, 0]], attrs: { ow: 'yes' } }, { id: 'b', coords: [[0.002, 0], [0.002, 0.001]], attrs: { ow: 'no' } }];
    const g = buildGraph(lines, { oneway: 'ow', bans: [{ from: 'a', to: 'b' }] });
    const [a] = g.edges;
    // A quarter of the way along a, 11 m north of it.
    const s = snapToEdge(g, [0.0005, 0.0001]);
    expect(s.metres).toBeCloseTo(11.06, 1);
    expect(s.node).toBe(g.nodes.length);
    expect(s.g.nodes.at(-1)).toEqual([0.0005, 0]);
    const [p, , q] = s.g.edges;
    expect([p.from, p.to, q.from, q.to]).toEqual([a.from, s.node, s.node, a.to]);
    expect(p.len + q.len).toBeCloseTo(a.len, 9);
    expect(p.len / a.len).toBeCloseTo(0.25, 6);
    expect(p.fwd / a.fwd).toBeCloseTo(0.25, 6);
    // One-way along the line in both pieces, and the ban stays where a meets b: on the second piece.
    expect([p.bwd, q.bwd]).toEqual([Infinity, Infinity]);
    expect(g.banned).toEqual([[0, 1]]);
    expect(s.g.banned).toEqual([[2, 1]]);
    expect(s.g.xy).toHaveLength(2 * s.g.nodes.length);
    expect(graphData(s.g)[0]).toBe(g.nodes.length + 1);
    // The built graph is left as it was.
    expect(g.edges).toHaveLength(2);
    expect(g.nodes).toHaveLength(3);
    // A pick next to a node takes the node, and the graph as it is.
    const end = snapToEdge(g, [0.002, -0.00002]);
    expect(end.g).toBe(g);
    expect(end.node).toBe(a.to);
    // A second pick on the same edge splits the piece it falls on.
    const t = snapToEdge(s.g, [0.0015, 0]);
    expect(t.node).toBe(s.node + 1);
    expect(t.g.edges.map((e) => e.len).reduce((x, y) => x + y)).toBeCloseTo(a.len + g.edges[1].len, 9);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-85 routes and service areas (vector bundle) against scipy', () => {
  const g = buildGraph(ROADS, { oneway: 'oneway', speed: 'speed', cost: 'time' });
  const data = graphData(g);
  const at = (p) => snapToEdge(g, p).node;
  it('gives the reference travel time for every route, one-way detours included', () => {
    for (const r of REF.routes) {
      const out = B.network([0, at(r.from), at(r.to)], data);
      // Local-frame lengths against geodesic ones: within 5 cm per km (the long diagonal is furthest).
      expect(Math.abs(out.cost - r.seconds) / r.seconds, `${r.from} → ${r.to}`).toBeLessThan(5e-5);
      // The route is connected end to end.
      const line = routeLine(g, out.edges, out.forward.map(Boolean));
      expect(at(line[0])).toBe(at(r.from));
      expect(at(line.at(-1))).toBe(at(r.to));
    }
  });
  it('reaches the reference nodes within each break', () => {
    const s = REF.service;
    const c = B.network([1, Math.max(...s.breaks), at(s.from)], data).cost;
    for (const b of s.breaks) {
      const got = g.nodes.filter((_, v) => c[v] !== null && c[v] <= b).map((p) => p.join()).sort();
      expect(got, `${b} s`).toEqual(s.within[String(b)].map((p) => p.join()).sort());
    }
  });
  it('starts a route where the pick is, part way along an edge', () => {
    // Half way along the 1st St block east of A Ave, and its east end: half the block's time.
    const s = snapToEdge(g, [-104.9994, 40]);
    const e = s.g.edges.find((x) => x.to === s.node);
    const end = at([-104.9988, 40]);
    const out = B.network([0, s.node, end], graphData(s.g));
    const full = g.edges.find((x) => [x.from, x.to].includes(end) && x.coords.some((p) => p[0] === -105) && x.line === 'st0');
    expect(out.cost).toBeCloseTo(full.fwd / 2, 6);
    expect(e.fwd).toBeCloseTo(full.fwd / 2, 6);
  });
  it('says when a node cannot be reached, and refuses a malformed graph', () => {
    const lines = [{ id: 'a', coords: [[0, 0], [0.001, 0]], attrs: { ow: 'yes' } }];
    const one = buildGraph(lines, { oneway: 'ow' });
    expect(B.network([0, 1, 0], graphData(one)).cost).toBeNull();
    expect(() => B.network([0, 0, 1], new Float64Array([2, 1, 0, 0]))).toThrow(/malformed/);
  });
});
