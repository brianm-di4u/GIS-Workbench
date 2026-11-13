"""SCN-78 fixture city and its reference values (REQ-GAP-85).

Writes fixtures/network/:
* city-roads.geojson: a 12 x 12 street grid near 40 N (streets "1st St".."12th St" run east,
  avenues "A Ave".."L Ave" run north; each line spans the whole grid, so crossings are shared
  vertices), with a speed field (km/h), a oneway field (OSM style: yes, -1, no), one closed road,
  an expressway overpass that crosses the grid without sharing a vertex and joins it only at its
  ends, and a dead-end spur;
* city-addresses.geojson: address points at the middle of every block face, numbered by block
  (block k gets 100k + 1 on the north or east side, 100k + 2 on the south or west side);
* city-queries.csv: addresses to geocode in a batch, some misspelt, one that does not exist;
* city.ref.json: the expected answers, computed independently of the app:
  - per edge length by GeographicLib (WGS 84 geodesic) and travel time at the speed;
  - shortest travel times between node pairs by scipy.sparse.csgraph.dijkstra on a graph built
    here (a node at every line end and shared vertex, one-way rules applied);
  - the nodes within 30 s and 60 s of a start (service area);
  - each query's true location (from the address points as generated).

Run with the gw-te environment (numpy, scipy, geographiclib):
  python -I tests/tools/network_ref.py
"""
import csv
import json
import os

import numpy as np
from geographiclib.geodesic import Geodesic
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import dijkstra

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "fixtures", "network")
os.makedirs(OUT, exist_ok=True)
G = Geodesic.WGS84
N = 12
LON0, LAT0, DLON, DLAT = -105.0, 40.0, 0.0012, 0.0009  # about 102 m by 100 m blocks
ORD = ["1st", "2nd", "3rd"] + [f"{i}th" for i in range(4, N + 1)]


def P(i, j):
    """Grid crossing of avenue i (west to east) and street j (south to north)."""
    return [round(LON0 + i * DLON, 7), round(LAT0 + j * DLAT, 7)]


roads = []
for j in range(N):
    # Streets run east. 3rd St is one-way east, 5th St one-way west (drawn east, so -1); 8th St is 70 km/h.
    roads.append({"id": f"st{j}", "name": f"{ORD[j]} St", "coords": [P(i, j) for i in range(N)], "speed": 70 if j == 7 else 50, "oneway": "yes" if j == 2 else "-1" if j == 4 else "no"})
for i in range(N):
    # Avenues run north. C Ave is 30 km/h; K Ave is closed.
    roads.append({"id": f"av{i}", "name": f"{chr(65 + i)} Ave", "coords": [P(i, j) for j in range(N)], "speed": 30 if i == 2 else 50, "oneway": "closed" if i == 10 else "no"})
# An expressway from the south-west corner to the north-east corner, crossing the grid on a bridge:
# its middle vertices sit between grid lines, so it shares no vertex except its ends.
roads.append({"id": "xw", "name": "Expressway", "coords": [P(0, 0), [round(LON0 + 5.5 * DLON, 7), round(LAT0 + 5.5 * DLAT, 7)], P(N - 1, N - 1)], "speed": 90, "oneway": "no"})
# A dead-end spur off the 6th St / F Ave corner.
roads.append({"id": "spur", "name": "Spur Ln", "coords": [P(5, 5), [round(LON0 + 5.5 * DLON, 7), round(LAT0 + 5.2 * DLAT, 7)]], "speed": 30, "oneway": "no"})

features = [{"type": "Feature", "properties": {"id": r["id"], "name": r["name"], "speed": r["speed"], "oneway": r["oneway"]}, "geometry": {"type": "LineString", "coordinates": r["coords"]}} for r in roads]
with open(os.path.join(OUT, "city-roads.geojson"), "w", newline="\n") as f:
    json.dump({"type": "FeatureCollection", "features": features}, f, separators=(",", ":"))

# ---- the reference graph, built here ----
key = lambda p: (round(p[0] * 1e7), round(p[1] * 1e7))
uses = {}
for r in roads:
    for k in {key(p) for p in r["coords"]}:
        uses[k] = uses.get(k, 0) + 1
node_of = {}


def node(p):
    k = key(p)
    if k not in node_of:
        node_of[k] = len(node_of)
    return node_of[k]


edges = []
for r in roads:
    if r["oneway"] == "closed":
        continue
    c = r["coords"]
    start = 0
    for i in range(1, len(c)):
        if i < len(c) - 1 and uses.get(key(c[i]), 0) < 2:
            continue
        part = c[start : i + 1]
        length = sum(G.Inverse(part[k - 1][1], part[k - 1][0], part[k][1], part[k][0])["s12"] for k in range(1, len(part)))
        t = length / (r["speed"] / 3.6)
        a, b = node(part[0]), node(part[-1])
        edges.append((a, b, t, r["oneway"] in ("no", "yes"), r["oneway"] in ("no", "-1"), length, r["id"]))
        start = i

n = len(node_of)
rows, cols, vals = [], [], []
for a, b, t, fw, bw, _, _ in edges:
    if fw:
        rows.append(a), cols.append(b), vals.append(t)
    if bw:
        rows.append(b), cols.append(a), vals.append(t)
M = csr_matrix((vals, (rows, cols)), shape=(n, n))
coord = {v: k for k, v in node_of.items()}
lonlat = lambda v: [coord[v][0] / 1e7, coord[v][1] / 1e7]
nid = lambda i, j: node_of[key(P(i, j))]

pairs = [((0, 0), (11, 11)), ((0, 0), (6, 6)), ((3, 2), (9, 2)), ((9, 2), (3, 2)), ((2, 4), (8, 4)), ((8, 4), (2, 4)), ((1, 10), (10, 1)), ((5, 5), (11, 0)), ((10, 3), (10, 9))]
routes = []
for s, t in pairs:
    d = dijkstra(M, directed=True, indices=nid(*s))
    routes.append({"from": lonlat(nid(*s)), "to": lonlat(nid(*t)), "seconds": float(d[nid(*t)])})

start = nid(6, 6)
d = dijkstra(M, directed=True, indices=start)
service = {"from": lonlat(start), "breaks": [30, 60], "within": {str(b): sorted([lonlat(v) for v in range(n) if d[v] <= b]) for b in (30, 60)}}

# ---- addresses ----
addresses = []
for j in range(N):
    for i in range(N - 1):
        mid = [round(LON0 + (i + 0.5) * DLON, 7), round(LAT0 + j * DLAT, 7)]
        addresses.append({"number": str(100 * (i + 1) + 1), "street": f"{ORD[j]} St", "at": [mid[0], round(mid[1] + 0.00008, 7)]})
        addresses.append({"number": str(100 * (i + 1) + 2), "street": f"{ORD[j]} St", "at": [mid[0], round(mid[1] - 0.00008, 7)]})
for i in range(N):
    for j in range(N - 1):
        mid = [round(LON0 + i * DLON, 7), round(LAT0 + (j + 0.5) * DLAT, 7)]
        addresses.append({"number": str(100 * (j + 1) + 1), "street": f"{chr(65 + i)} Avenue", "at": [round(mid[0] + 0.0001, 7), mid[1]]})
        addresses.append({"number": str(100 * (j + 1) + 2), "street": f"{chr(65 + i)} Avenue", "at": [round(mid[0] - 0.0001, 7), mid[1]]})
af = [{"type": "Feature", "properties": {"addr_number": a["number"], "addr_street": a["street"], "city": "Gridley"}, "geometry": {"type": "Point", "coordinates": a["at"]}} for a in addresses]
with open(os.path.join(OUT, "city-addresses.geojson"), "w", newline="\n") as f:
    json.dump({"type": "FeatureCollection", "features": af}, f, separators=(",", ":"))

look = {(a["number"], a["street"]): a["at"] for a in addresses}
queries = [
    ("q1", "101 1st Street", ("101", "1st St")),
    ("q2", "502 C Avenue, Gridley", ("502", "C Avenue")),
    ("q3", "1101 12th St", ("1101", "12th St")),
    ("q4", "301 4th Stret", ("301", "4th St")),  # misspelt
    ("q5", "Avenue G 702", ("702", "G Avenue")),  # number last
    ("q6", "202 Fifth Avenue", None),  # no such street
    ("q7", "701 8th St", ("701", "8th St")),
]
with open(os.path.join(OUT, "city-queries.csv"), "w", newline="") as f:
    w = csv.writer(f, lineterminator="\n")
    w.writerow(["ref", "address"])
    for q in queries:
        w.writerow([q[0], q[1]])

ref = {
    "source": "tests/tools/network_ref.py (scipy dijkstra, GeographicLib %s)" % __import__("geographiclib").__version__,
    "nodes": n,
    "edges": len(edges),
    "routes": routes,
    "service": service,
    "queries": [{"ref": q[0], "address": q[1], "at": look[q[2]] if q[2] else None} for q in queries],
}
with open(os.path.join(OUT, "city.ref.json"), "w", newline="\n") as f:
    json.dump(ref, f, separators=(",", ":"))
print("wrote", n, "nodes,", len(edges), "edges,", len(addresses), "addresses")
