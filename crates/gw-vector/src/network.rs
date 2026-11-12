//! Road networks (REQ-GAP-85): shortest paths and service areas on a graph the caller builds from
//! the user's own road layer. Nodes are numbered 0..n; edge e runs from `from[e]` to `to[e]` and
//! costs `fwd[e]` along it and `bwd[e]` against it (infinite or negative = not allowed, as on a
//! one-way street). `len[e]` is its length in metres and `xy` the nodes in a local metric frame,
//! for the A* heuristic. A turn restriction forbids going from edge a straight onto edge b at the
//! node they share; with any, the search runs on directed edges instead of nodes.

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};

pub struct Graph<'a> {
    pub n: usize,
    pub from: &'a [u32],
    pub to: &'a [u32],
    pub fwd: &'a [f64],
    pub bwd: &'a [f64],
    pub len: &'a [f64],
    pub xy: &'a [f64],
    /// Forbidden turns (edge in, edge out).
    pub banned: HashSet<(u32, u32)>,
}

/// A route: its cost, and the edges in order, each with the direction travelled (true = from → to).
#[derive(Debug, PartialEq)]
pub struct Route {
    pub cost: f64,
    pub edges: Vec<(u32, bool)>,
}

#[derive(Clone, Copy, PartialEq)]
struct Item {
    f: f64,
    s: usize,
}
impl Eq for Item {}
impl Ord for Item {
    fn cmp(&self, o: &Self) -> Ordering {
        // Smallest first: BinaryHeap is a max-heap.
        o.f.partial_cmp(&self.f).unwrap_or(Ordering::Equal).then_with(|| o.s.cmp(&self.s))
    }
}
impl PartialOrd for Item {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}

fn ok(c: f64) -> bool {
    c.is_finite() && c >= 0.0
}

impl Graph<'_> {
    /// Directed edges leaving each node: (edge, forward).
    fn adjacency(&self) -> Vec<Vec<(u32, bool)>> {
        let mut adj = vec![Vec::new(); self.n];
        for e in 0..self.from.len() {
            let (a, b) = (self.from[e] as usize, self.to[e] as usize);
            if ok(self.fwd[e]) {
                adj[a].push((e as u32, true));
            }
            if ok(self.bwd[e]) {
                adj[b].push((e as u32, false));
            }
        }
        adj
    }
    fn head(&self, e: u32, fw: bool) -> usize {
        if fw { self.to[e as usize] as usize } else { self.from[e as usize] as usize }
    }
    fn cost(&self, e: u32, fw: bool) -> f64 {
        if fw { self.fwd[e as usize] } else { self.bwd[e as usize] }
    }
    /// The least cost per metre of any usable edge: with it, straight-line distance never overestimates.
    fn rate(&self) -> f64 {
        let mut r = f64::INFINITY;
        for e in 0..self.from.len() {
            let l = self.len[e];
            if l > 0.0 {
                for c in [self.fwd[e], self.bwd[e]] {
                    if ok(c) {
                        r = r.min(c / l);
                    }
                }
            }
        }
        if r.is_finite() { r } else { 0.0 }
    }
    fn dist(&self, a: usize, b: usize) -> f64 {
        if self.xy.len() < 2 * self.n {
            return 0.0;
        }
        (self.xy[2 * a] - self.xy[2 * b]).hypot(self.xy[2 * a + 1] - self.xy[2 * b + 1])
    }

    /// Least-cost route from `src` to `dst` (A*), or None when `dst` cannot be reached.
    pub fn route(&self, src: usize, dst: usize) -> Option<Route> {
        if src >= self.n || dst >= self.n {
            return None;
        }
        if src == dst {
            return Some(Route { cost: 0.0, edges: Vec::new() });
        }
        let adj = self.adjacency();
        let rate = self.rate();
        let h = |v: usize| self.dist(v, dst) * rate;
        // States: nodes (no restrictions), or directed edges arrived along (2e + forward), plus a start state.
        let edge_based = !self.banned.is_empty();
        let ns = if edge_based { 2 * self.from.len() + 1 } else { self.n };
        let start = if edge_based { ns - 1 } else { src };
        let node_of = |s: usize| if !edge_based { s } else if s == ns - 1 { src } else { self.head((s / 2) as u32, s % 2 == 1) };
        let mut g = vec![f64::INFINITY; ns];
        let mut prev = vec![usize::MAX; ns];
        let mut done = vec![false; ns];
        let mut q = BinaryHeap::new();
        g[start] = 0.0;
        q.push(Item { f: h(src), s: start });
        while let Some(Item { s, .. }) = q.pop() {
            if done[s] {
                continue;
            }
            done[s] = true;
            let v = node_of(s);
            if v == dst {
                return Some(Route { cost: g[s], edges: self.unwind(s, &prev, edge_based, start) });
            }
            let came = if edge_based && s != start { Some((s / 2) as u32) } else { None };
            for &(e, fw) in &adj[v] {
                if let Some(a) = came {
                    if self.banned.contains(&(a, e)) {
                        continue;
                    }
                }
                let w = self.head(e, fw);
                let t = if edge_based { 2 * e as usize + usize::from(fw) } else { w };
                let c = g[s] + self.cost(e, fw);
                if c < g[t] {
                    g[t] = c;
                    prev[t] = if edge_based { s } else { 2 * e as usize + usize::from(fw) };
                    q.push(Item { f: c + h(w), s: t });
                }
            }
        }
        None
    }

    fn unwind(&self, mut s: usize, prev: &[usize], edge_based: bool, start: usize) -> Vec<(u32, bool)> {
        let mut out = Vec::new();
        if edge_based {
            while s != start {
                out.push(((s / 2) as u32, s % 2 == 1));
                s = prev[s];
            }
        } else {
            while prev[s] != usize::MAX {
                let (e, fw) = ((prev[s] / 2) as u32, prev[s] % 2 == 1);
                out.push((e, fw));
                s = if fw { self.from[e as usize] as usize } else { self.to[e as usize] as usize };
            }
        }
        out.reverse();
        out
    }

    /// Least cost from any of `sources` to every node, up to `max` (Dijkstra), infinite beyond it;
    /// and per edge direction (index 2e + 1 along, 2e against) the least cost at which that edge can
    /// be entered at its tail. With turn bans the two differ: a node reached only by a road that may
    /// not turn into an edge does not open that edge.
    pub fn reach(&self, sources: &[usize], max: f64) -> Reach {
        let adj = self.adjacency();
        let edge_based = !self.banned.is_empty();
        let ns = if edge_based { 2 * self.from.len() + self.n } else { self.n };
        // In the edge-based search the last n states are "standing at node v", where the sources start.
        let node_of = |s: usize| if !edge_based { s } else if s >= 2 * self.from.len() { s - 2 * self.from.len() } else { self.head((s / 2) as u32, s % 2 == 1) };
        let mut g = vec![f64::INFINITY; ns];
        let mut q = BinaryHeap::new();
        for &v in sources {
            if v < self.n {
                let s = if edge_based { 2 * self.from.len() + v } else { v };
                g[s] = 0.0;
                q.push(Item { f: 0.0, s });
            }
        }
        let mut best = vec![f64::INFINITY; self.n];
        while let Some(Item { f, s }) = q.pop() {
            if f > g[s] || f > max {
                continue;
            }
            let v = node_of(s);
            best[v] = best[v].min(f);
            let came = if edge_based && s < 2 * self.from.len() { Some((s / 2) as u32) } else { None };
            for &(e, fw) in &adj[v] {
                if let Some(a) = came {
                    if self.banned.contains(&(a, e)) {
                        continue;
                    }
                }
                let t = if edge_based { 2 * e as usize + usize::from(fw) } else { self.head(e, fw) };
                let c = f + self.cost(e, fw);
                if c < g[t] && c <= max {
                    g[t] = c;
                    q.push(Item { f: c, s: t });
                }
            }
        }
        // Entry costs: from every settled state, the edges it may go on to (the same rule as the search).
        let ne = self.from.len();
        let mut entry = vec![f64::INFINITY; 2 * ne];
        for (s, &f) in g.iter().enumerate() {
            if !f.is_finite() {
                continue;
            }
            let came = if edge_based && s < 2 * ne { Some((s / 2) as u32) } else { None };
            for &(e, fw) in &adj[node_of(s)] {
                if came.is_some_and(|a| self.banned.contains(&(a, e))) {
                    continue;
                }
                let k = 2 * e as usize + usize::from(fw);
                entry[k] = entry[k].min(f);
            }
        }
        Reach { node: best, entry }
    }
}

/// The result of [`Graph::reach`].
pub struct Reach {
    pub node: Vec<f64>,
    pub entry: Vec<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 3 × 3 grid of nodes 100 m apart (node = 3·row + col), every street both ways at 1 per metre.
    fn grid() -> (Vec<u32>, Vec<u32>, Vec<f64>, Vec<f64>) {
        let (mut from, mut to, mut xy) = (vec![], vec![], vec![]);
        for r in 0..3u32 {
            for c in 0..3u32 {
                xy.extend([c as f64 * 100.0, r as f64 * 100.0]);
                if c < 2 {
                    from.push(3 * r + c);
                    to.push(3 * r + c + 1);
                }
                if r < 2 {
                    from.push(3 * r + c);
                    to.push(3 * (r + 1) + c);
                }
            }
        }
        let len = vec![100.0; from.len()];
        (from, to, len, xy)
    }

    #[test]
    fn shortest_route_one_way_and_unreachable() {
        let (from, to, len, xy) = grid();
        let mut fwd = len.clone();
        let mut bwd = len.clone();
        let g = Graph { n: 9, from: &from, to: &to, fwd: &fwd, bwd: &bwd, len: &len, xy: &xy, banned: HashSet::new() };
        let r = g.route(0, 8).unwrap();
        assert_eq!(r.cost, 400.0);
        assert_eq!(r.edges.len(), 4);
        // Back the other way the cost is the same.
        assert_eq!(g.route(8, 0).unwrap().cost, 400.0);
        // Make every edge one-way (from → to only): 8 → 0 cannot be reached.
        bwd.iter_mut().for_each(|c| *c = f64::INFINITY);
        let g = Graph { n: 9, from: &from, to: &to, fwd: &fwd, bwd: &bwd, len: &len, xy: &xy, banned: HashSet::new() };
        assert!(g.route(8, 0).is_none());
        assert_eq!(g.route(0, 8).unwrap().cost, 400.0);
        // One-way, a slow edge that is the only way is taken; two-way, it is driven round.
        fwd[0] = 1000.0;
        let g = Graph { n: 9, from: &from, to: &to, fwd: &fwd, bwd: &bwd, len: &len, xy: &xy, banned: HashSet::new() };
        assert_eq!(g.route(0, 2).unwrap().cost, 1100.0);
        let both = len.clone();
        let g = Graph { n: 9, from: &from, to: &to, fwd: &fwd, bwd: &both, len: &len, xy: &xy, banned: HashSet::new() };
        assert_eq!(g.route(0, 2).unwrap().cost, 400.0);
    }

    #[test]
    fn a_turn_restriction_forces_a_detour() {
        let (from, to, len, xy) = grid();
        let e = |a: u32, b: u32| from.iter().zip(&to).position(|(&x, &y)| (x, y) == (a, b) || (x, y) == (b, a)).unwrap() as u32;
        // 0 → 1 → 4 is 200 m. Ban the turn from edge 0-1 onto edge 1-4.
        let banned: HashSet<(u32, u32)> = [(e(0, 1), e(1, 4))].into_iter().collect();
        let g = Graph { n: 9, from: &from, to: &to, fwd: &len, bwd: &len, len: &len, xy: &xy, banned };
        let r = g.route(0, 4).unwrap();
        // Still 200 m, the other way round: 0 → 3 → 4.
        assert_eq!(r.cost, 200.0);
        assert_eq!(r.edges[0].0, e(0, 3));
        // To 7 via 1 → 4 is banned; the best is 0 → 3 → 6 → 7 or 0 → 3 → 4 → 7: 300 m either way.
        assert_eq!(g.route(0, 7).unwrap().cost, 300.0);
    }

    #[test]
    fn service_area_costs() {
        let (from, to, len, xy) = grid();
        let g = Graph { n: 9, from: &from, to: &to, fwd: &len, bwd: &len, len: &len, xy: &xy, banned: HashSet::new() };
        let c = g.reach(&[4], 150.0).node;
        assert_eq!(c[4], 0.0);
        assert_eq!(c[1], 100.0);
        assert!(c[0].is_infinite());
        let c = g.reach(&[0, 8], f64::INFINITY).node;
        assert_eq!(c[4], 200.0);
        assert_eq!(c[2], 200.0);
    }

    #[test]
    fn an_edge_behind_a_turn_ban_is_not_entered() {
        // A T: a = 0-1, b = 1-2 straight on, c = 1-3. The turn a → b is banned.
        let (from, to) = (vec![0u32, 1, 1], vec![1u32, 2, 3]);
        let len = vec![100.0; 3];
        let xy = vec![0.0, 0.0, 100.0, 0.0, 200.0, 0.0, 100.0, 100.0];
        let banned: HashSet<(u32, u32)> = [(0, 1)].into_iter().collect();
        let g = Graph { n: 4, from: &from, to: &to, fwd: &len, bwd: &len, len: &len, xy: &xy, banned };
        // 250 m: the way round (a, c, back along c, then b) is 400 m, beyond it.
        let r = g.reach(&[0], 250.0);
        // Node 1 is reached at 100 m, yet b cannot be entered from it: 2 is out of reach.
        assert_eq!(r.node[1], 100.0);
        assert!(r.node[2].is_infinite());
        assert!(r.entry[2 * 1 + 1].is_infinite());
        // c can: its entry along is 100 m.
        assert_eq!(r.entry[2 * 2 + 1], 100.0);
        // Without the ban, b is entered at 100 m too.
        let g = Graph { n: 4, from: &from, to: &to, fwd: &len, bwd: &len, len: &len, xy: &xy, banned: HashSet::new() };
        assert_eq!(g.reach(&[0], 250.0).entry[2 * 1 + 1], 100.0);
    }
}
