"""NASR's controlling obstacle of each runway end beside the FAA DOF: position relative to the threshold.

NASR (FAA 5010) gives the object's type, height above the runway end, distance from the threshold,
offset from the extended centre line and clearance slope. Put an object the DOF lists into the same
terms, and the two independent FAA records can be compared, which needs no surface at all. Written from
the NASR field descriptions, on a local plane about the threshold (good to a metre or so at these
distances), not from the kernel.

    python -I dof_nasr.py dof-surfaces.json OUT.json
"""
import json
import math
import sys

FT = 0.3048


def enu(lat0, lon0, lat, lon):
    k = math.cos(math.radians(lat0))
    return (lon - lon0) * 111320 * k, (lat - lat0) * 111132


def main():
    d = json.load(open(sys.argv[1]))
    out = []
    for id_, ap in d["airports"].items():
        rows = {o["oas"]: o for reg in ap["regimes"].values() for o in reg["rows"]}
        for rw in ap["runways"]:
            for k, e in enumerate(rw["ends"]):
                ob = e.get("nasrObstacle")
                if not ob:
                    continue
                far = rw["ends"][1 - k]
                ex, ey = enu(e["lat"], e["lon"], far["lat"], far["lon"])
                n = math.hypot(ex, ey)
                ux, uy = ex / n, ey / n  # along the runway, from this end to the far end
                disp = e.get("disp") or 0
                best = []
                for o in rows.values():
                    x, y = enu(e["lat"], e["lon"], o["lat"], o["lon"])
                    s = x * ux + y * uy  # station, negative off the end
                    t = -x * uy + y * ux  # left of the landing direction positive
                    dist_ft = (disp - s) / FT  # from the threshold, outward
                    off_ft = abs(t) / FT
                    hgt_ft = o["amslFt"] - e["elevM"] / FT
                    if dist_ft < 0 or off_ft > 2000 or dist_ft > 12000:
                        continue
                    dd = math.hypot(dist_ft - ob["distFt"], off_ft - ob["offsetFt"])
                    best.append((dd, o["oas"], o["type"], o["aglFt"], o["amslFt"], round(dist_ft), round(off_ft), round(hgt_ft, 1), o["acc"], "L" if t > 0 else "R"))
                best.sort()
                rec = {"airport": id_, "end": e["id"], "nasr": ob, "dofNearest": best[:3]}
                out.append(rec)
                print(id_, e["id"], ob, "->", best[:2])
    json.dump(out, open(sys.argv[2], "w"), indent=1)


if __name__ == "__main__":
    main()
