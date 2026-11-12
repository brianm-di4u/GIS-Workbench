"""Tie points for the REQ-GAP-22 real-data runs (OpenDroneMap blocks): OpenCV SIFT on each image,
ratio-test matches between image pairs (pairs within a GPS distance, or every pair when the
images have no GPS), a fundamental-matrix RANSAC per pair, and tracks by union–find (a track that
holds two features of one image is dropped). The aerial triangulation solver is not used here:
this only produces its input.

Run with the gw-te environment, isolated (-I), from outside the data folder:
  python -I tests/tools/aero_ties.py E:/TE-corpus/frames-odm-bellus-gcp E:/gwb25/data-aero/ties/bellus.json

Output JSON: {block, images: [{file, width, height, exif}], tracks: [[[image, x, y], ...], ...]}.
Pixel coordinates are corner-origin (the app's convention): OpenCV keypoint + 0.5, divided by the
detection scale.
"""
import json
import math
import os
import re
import sys
import time

import cv2
import numpy as np
from PIL import Image
from PIL.ExifTags import GPSTAGS, TAGS


def rational(v):
    try:
        return float(v)
    except TypeError:
        return float(v[0]) / float(v[1])


def exif_of(path):
    im = Image.open(path)
    w, h = im.size
    raw = im._getexif() or {}
    ex = {TAGS.get(k, k): v for k, v in raw.items()}
    out = {"make": str(ex.get("Make", "")).strip("\x00 "), "model": str(ex.get("Model", "")).strip("\x00 ")}
    if "FocalLength" in ex:
        out["focal_mm"] = rational(ex["FocalLength"])
    for k in ("FocalPlaneXResolution", "FocalPlaneYResolution", "FocalPlaneResolutionUnit", "FocalLengthIn35mmFilm", "ExifImageWidth", "ExifImageHeight"):
        if k in ex:
            out[k] = rational(ex[k]) if not isinstance(ex[k], int) else ex[k]
    gps = ex.get("GPSInfo")
    if gps:
        g = {GPSTAGS.get(k, k): v for k, v in gps.items()}
        if "GPSLatitude" in g and "GPSLongitude" in g:
            dms = lambda t: rational(t[0]) + rational(t[1]) / 60 + rational(t[2]) / 3600
            lat = dms(g["GPSLatitude"]) * (-1 if g.get("GPSLatitudeRef", "N") in ("S", b"S") else 1)
            lon = dms(g["GPSLongitude"]) * (-1 if g.get("GPSLongitudeRef", "E") in ("W", b"W") else 1)
            out["lat"], out["lon"] = lat, lon
        if "GPSAltitude" in g:
            alt = rational(g["GPSAltitude"])
            if g.get("GPSAltitudeRef") in (1, b"\x01"):
                alt = -alt
            out["alt"] = alt
    # XMP (senseFly, DJI, Pix4D keys), read by key from the raw bytes.
    data = open(path, "rb").read(256 * 1024)
    m = re.search(rb"<x:xmpmeta.*?</x:xmpmeta>", data, re.S)
    if m:
        x = m.group(0).decode("utf-8", "replace")
        xmp = {}
        for k, v in re.findall(r'(\w+:\w+)="([^"]*)"', x):
            xmp[k] = v
        for k, v in re.findall(r"<(\w+:\w+)>([^<]*)</\1>", x):
            xmp.setdefault(k, v)
        out["xmp"] = {k: v for k, v in xmp.items() if not k.startswith(("xmlns", "rdf:", "x:"))}
    return w, h, out


class UF:
    def __init__(self):
        self.p = {}

    def find(self, a):
        p = self.p
        p.setdefault(a, a)
        while p[a] != a:
            p[a] = p[p[a]]
            a = p[a]
        return a

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb


def main():
    src, out = sys.argv[1], sys.argv[2]
    scale = float(os.environ.get("AERO_SCALE", "0.5"))
    nfeat = int(os.environ.get("AERO_FEATURES", "6000"))
    pair_m = float(os.environ.get("AERO_PAIR_M", "0"))
    imdir = os.path.join(src, "images")
    files = sorted(f for f in os.listdir(imdir) if f.lower().endswith((".jpg", ".jpeg", ".tif")))
    sift = cv2.SIFT_create(nfeatures=nfeat)
    images, feats = [], []
    t0 = time.time()
    for f in files:
        p = os.path.join(imdir, f)
        w, h, ex = exif_of(p)
        g = cv2.imread(p, cv2.IMREAD_GRAYSCALE)
        if g is None:
            continue
        gs = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale != 1 else g
        kp, de = sift.detectAndCompute(gs, None)
        xy = np.array([[(k.pt[0] + 0.5) / scale, (k.pt[1] + 0.5) / scale] for k in kp], dtype=np.float64)
        images.append({"file": f, "width": w, "height": h, "exif": ex})
        feats.append((xy, de))
        print(f"{f}: {len(kp)} features ({time.time() - t0:.0f} s)", flush=True)
    n = len(images)
    # Pairs: by GPS distance when every image has a position, else all.
    have = all("lat" in im["exif"] for im in images)
    pairs = []
    if have:
        lat0 = sum(im["exif"]["lat"] for im in images) / n
        xy = [((im["exif"]["lon"]) * 111320 * math.cos(math.radians(lat0)), im["exif"]["lat"] * 110540) for im in images]
        if pair_m <= 0:
            # 6 × the median nearest-neighbour spacing, at least 60 m.
            nn = sorted(min(math.dist(xy[i], xy[k]) for k in range(n) if k != i) for i in range(n))
            pair_m = max(60.0, 6.0 * nn[n // 2])
        for i in range(n):
            for k in range(i + 1, n):
                if math.dist(xy[i], xy[k]) <= pair_m:
                    pairs.append((i, k))
    else:
        pairs = [(i, k) for i in range(n) for k in range(i + 1, n)]
    print(f"{len(pairs)} pairs (radius {pair_m:.0f} m)" if have else f"{len(pairs)} pairs (all)", flush=True)
    index = dict(algorithm=1, trees=5)
    flann = cv2.FlannBasedMatcher(index, dict(checks=64))
    uf = UF()
    links = 0
    for (i, k) in pairs:
        (xa, da), (xb, db) = feats[i], feats[k]
        if da is None or db is None or len(da) < 20 or len(db) < 20:
            continue
        m = flann.knnMatch(da, db, k=2)
        good = [a for a, b in (x for x in m if len(x) == 2) if a.distance < 0.75 * b.distance]
        if len(good) < 30:
            continue
        pa = np.float64([xa[g.queryIdx] for g in good])
        pb = np.float64([xb[g.trainIdx] for g in good])
        F, mask = cv2.findFundamentalMat(pa, pb, cv2.FM_RANSAC, 1.5, 0.999, 4000)
        if F is None:
            continue
        inl = [g for g, ok in zip(good, mask.ravel()) if ok]
        if len(inl) < 25:
            continue
        for g in inl:
            uf.union((i, g.queryIdx), (k, g.trainIdx))
        links += len(inl)
    groups = {}
    for key in list(uf.p.keys()):
        groups.setdefault(uf.find(key), []).append(key)
    tracks = []
    for members in groups.values():
        imgs = [m[0] for m in members]
        if len(set(imgs)) != len(imgs) or len(members) < 2:
            continue
        tracks.append([[i, round(float(feats[i][0][j][0]), 3), round(float(feats[i][0][j][1]), 3)] for i, j in sorted(members)])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as fo:
        json.dump({"block": os.path.basename(src.rstrip("/\\")), "scale": scale, "features": nfeat, "images": images, "tracks": tracks}, fo)
    lens = [len(t) for t in tracks]
    print(f"{links} matches, {len(tracks)} tracks (3+ rays: {sum(1 for l in lens if l >= 3)}, mean {np.mean(lens):.2f})", flush=True)


if __name__ == "__main__":
    main()
