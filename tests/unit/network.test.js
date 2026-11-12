// REQ-GAP-85 road networks: the graph built from line layers (analysis/network.js), and routes and
// service areas from the `vector` WASM bundle (gw-vector network.rs) on the SCN-78 fixture city
// against the independent reference tests/tools/network_ref.py wrote (scipy Dijkstra on its own
// graph, GeographicLib edge lengths). The bundle tests are skipped when the bundle is absent.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VectorBundle } from '../../app/src/wasm/vector.js';
import { buildGraph, graphData, nearestNode, onewayOf, onewayRule, routeLine, serviceLines } from '../../app/src/analysis/network.js';

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
    expect(nearestNode(g, [0.0019, 0.0001]).node).toBe(g.edges[0].to);
  });
  it('snaps to a road that can be travelled, never to the end of a closed one', () => {
    // HERE flags: N is closed. The closed road ends beside the click; the open one is 1 km away.
    const lines = [
      { id: 'shut', coords: [[0, 0], [0.001, 0]], attrs: { dir: 'N' } },
      { id: 'open', coords: [[0, 0.01], [0.001, 0.01]], attrs: { dir: 'B' } },
    ];
    const g = buildGraph(lines, { oneway: 'dir' });
    expect(g.nodes).toHaveLength(2);
    expect(g.edges.map((e) => e.line)).toEqual(['open']);
    const s = nearestNode(g, [0.001, 0.0001]);
    expect(g.nodes[s.node]).toEqual([0.001, 0.01]);
    expect(s.metres).toBeGreaterThan(1000);
    // With every road closed there is no node to snap to. (N alone reads as Y/N, so closed is spelt out.)
    const shut = buildGraph([{ id: 'x', coords: [[0, 0], [0.001, 0]], attrs: { dir: 'closed' } }], { oneway: 'dir' });
    expect(shut?.nodes ?? []).toHaveLength(0);
  });
});

describe.skipIf(!haveWasm)('REQ-GAP-85 routes and service areas (vector bundle) against scipy', () => {
  const g = buildGraph(ROADS, { oneway: 'oneway', speed: 'speed', cost: 'time' });
  const data = graphData(g);
  const at = (p) => nearestNode(g, p).node;
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
  it('says when a node cannot be reached, and refuses a malformed graph', () => {
    const lines = [{ id: 'a', coords: [[0, 0], [0.001, 0]], attrs: { ow: 'yes' } }];
    const one = buildGraph(lines, { oneway: 'ow' });
    expect(B.network([0, 1, 0], graphData(one)).cost).toBeNull();
    expect(() => B.network([0, 0, 1], new Float64Array([2, 1, 0, 0]))).toThrow(/malformed/);
  });
});
