"""Join the FAA DOF clearances (dof_surfaces.mjs) with the app's report over a DSM (c62-faa-dof.spec.js).
Prints the figures of docs/validation/2.6/oracles.md and writes a summary JSON.

    python -I dof_join.py dof-surfaces.json RESULTS_DIR PROJECT OUT.json TAG...

Terms: "above" means the DOF top is above the kernel's limit; "firm" means by more than the DOF
vertical tolerance, and "in tolerance" by less. Objects with unknown accuracy are counted apart. "Seen"
means the DSM has a post near the object (within two posts, or the DOF horizontal tolerance if wider)
no more than 3 m below the object's top. "Reported" means that highest post is over the limit by more
than the run's 3 m.
"""
import collections
import json
import math
import os
import sys

MIN_PEN = 3.0
CLASSES = [("under 50 ft", 0, 50), ("50-99 ft", 50, 100), ("100-299 ft", 100, 300), ("300 ft or more", 300, 1 << 30)]


def dist(a, b):
    k = math.cos(math.radians(a["lat"]))
    return math.hypot((a["lat"] - b["lat"]) * 111320, (a["lon"] - b["lon"]) * 111320 * k)


def med(v):
    v = sorted(v)
    return v[len(v) // 2] if v else None


def main():
    dof = json.load(open(sys.argv[1]))
    rd, project, outp = sys.argv[2:5]
    print("DOF", dof["dofCurrency"], "objects", dof["dofObjects"])
    summary = {}
    for tag in sys.argv[5:]:
        res = json.load(open(os.path.join(rd, f"c62-{tag}-{project}.json")))
        ap = dof["airports"][res["id"]]
        samples = {s["oas"]: s for s in res["samples"]}
        print(f"\n== {tag}: {res['source']} (posts {res['postM']:.2f} m)")
        summary[tag] = {}
        for regime, reg in ap["regimes"].items():
            rows = reg["rows"]
            cov = [o for o in rows if o["limit"] is not None]
            above = [o for o in cov if o["pen"] > 0]
            firm = [o for o in above if o["vTolM"] is not None and o["pen"] > o["vTolM"]]
            intol = [o for o in above if o["vTolM"] is not None and o["pen"] <= o["vTolM"]]
            unk = [o for o in above if o["vTolM"] is None]
            verified = [o for o in above if o["status"] == "O"]
            app = res["regimes"][regime]
            obs = app["obstacles"]
            inside = [o for o in cov if samples.get(o["oas"], {}).get("inside") and samples[o["oas"]].get("top5") is not None]
            for o in inside:
                s = samples[o["oas"]]
                o["dsmTop"] = s["top5"]
                o["gap"] = o["topM"] - s["top5"]
                o["seen"] = o["gap"] <= 3
                o["reported"] = s["top5"] - o["limit"] > MIN_PEN
            aboveIn = [o for o in inside if o["pen"] > MIN_PEN]
            firmIn = [o for o in aboveIn if o["vTolM"] is not None and o["pen"] > o["vTolM"]]
            rep = [o for o in aboveIn if o["reported"]]
            classes = {}
            for name, lo, hi in CLASSES:
                g = [o for o in inside if lo <= o["aglFt"] < hi]
                classes[name] = {"n": len(g), "seen": sum(o["seen"] for o in g), "medianGapM": med([o["gap"] for o in g])}
            near = []
            matched = 0
            for ob in obs:
                best = None
                for o in rows:
                    d = dist(ob, o)
                    if best is None or d < best[0]:
                        best = (d, o)
                if best and best[0] <= 150:
                    matched += 1
                near.append({"id": ob["id"], "lat": ob["lat"], "lon": ob["lon"], "pen": ob["pen"], "posts": ob["posts"], "surface": ob["surface"], "z": ob["z"], "nearestM": best[0] if best else None, "nearest": ({k: best[1][k] for k in ("oas", "type", "aglFt", "amslFt", "acc", "status", "topM", "limit", "pen")} if best else None)})
            print(f"\n[{regime}] box {reg['inBox']}, under a surface {len(cov)}; kernel vs oracle {reg['kernelVsOracle']['worstM'] * 1000:.2f} mm, kinds {reg['kernelVsOracle']['kindsDiffer']}, coverage {reg['kernelVsOracle']['coverDiffer']}")
            print(f"  above: {len(above)} ({len(verified)} verified): firm {len(firm)}, in tolerance {len(intol)}, unknown {len(unk)}; by surface {dict(collections.Counter(o['kind'] for o in above))}; firm {dict(collections.Counter(o['kind'] for o in firm))}")
            print(f"  app: {app['stats']['penetrating']} posts, {len(obs)} obstacles, {app['stats']['covered']} under a surface")
            print(f"  inside the DSM: {len(inside)}; by height {classes}")
            print(f"  above by > {MIN_PEN} m inside the DSM: {len(aboveIn)} (firm {len(firmIn)}); reported there {len(rep)} ({sum(o in rep for o in firmIn)} of the firm)")
            print(f"  app obstacles with a listed object within 150 m: {matched} of {len(obs)}; chance for a random place {reg['chanceWithin150m']:.3f}")
            for n in sorted(near, key=lambda x: -x["pen"])[:14]:
                print(f"    {n['id']} +{n['pen']:.1f} m {n['posts']} posts {n['surface']} at {n['lat']:.5f},{n['lon']:.5f} z {n['z']:.1f}: nearest {n['nearestM']:.0f} m " + (f"{n['nearest']['oas']} {n['nearest']['type']} {n['nearest']['aglFt']} ft top {n['nearest']['topM']:.1f}" if n["nearest"] else ""))
            missed = sorted([o for o in aboveIn if not o["reported"]], key=lambda x: -x["pen"])
            print("  above, not reported (first 6): " + "; ".join(f"{o['oas']} {o['type']} {o['aglFt']} ft +{o['pen']:.1f} m {o['kind']} DSM {o['dsmTop']:.1f} limit {o['limit']:.1f} {o['acc']}" for o in missed[:6]))
            summary[tag][regime] = {
                "inBox": reg["inBox"], "covered": len(cov), "kernelVsOracle": reg["kernelVsOracle"], "chanceWithin150m": reg["chanceWithin150m"],
                "above": len(above), "verifiedAbove": len(verified), "firm": len(firm), "inTolerance": len(intol), "unknownAccuracy": len(unk),
                "byKind": dict(collections.Counter(o["kind"] for o in above)), "byKindFirm": dict(collections.Counter(o["kind"] for o in firm)),
                "appPosts": app["stats"]["penetrating"], "appObstacles": len(obs), "insideDsm": len(inside), "classes": classes,
                "aboveInDsm": len(aboveIn), "firmInDsm": len(firmIn), "reportedThere": len(rep), "reportedFirm": sum(o in rep for o in firmIn),
                "appObstaclesWithListed": matched, "obstacles": near,
            }
    json.dump(summary, open(outp, "w"), indent=1)


if __name__ == "__main__":
    main()
