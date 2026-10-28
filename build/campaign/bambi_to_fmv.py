"""BAMBI flight folder -> app-ready FMV: lossless MP4->MPEG-TS remux (ffmpeg -c copy) and a platform
metadata CSV (the app's fmv.csv import) from the DJI per-frame SRT + lens calibration.
  ../TE-tools/micromamba.exe run -n gw-te python -I build/campaign/bambi_to_fmv.py <flight_dir> <out_dir>
Pointing: DJI gimbal angles are world-referenced, so heading = gb_yaw, az = 0, el = gb_pitch,
pitch = roll = 0. HAE = abs_alt (MSL) + EGM96 N; fc_hae (the app's ground plane) = takeoff MSL + N on
every row; fc_lat/fc_lon only for nadir rows, where the frame centre is directly below the sensor.
SRT times are local (Europe/Vienna); they are written as UTC."""
import json, math, os, re, subprocess, sys
from datetime import datetime, timedelta, timezone

flight, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
try:
    from zoneinfo import ZoneInfo
    VIENNA = ZoneInfo("Europe/Vienna")
except Exception:
    VIENNA = None


def to_utc(local):
    if VIENNA:
        return local.replace(tzinfo=VIENNA).astimezone(timezone.utc)
    y = local.year  # EU DST: last Sunday of March .. last Sunday of October, 01:00 UTC
    last_sun = lambda m: max(d for d in range(25, 32) if datetime(y, m, d).weekday() == 6)
    dst = datetime(y, 3, last_sun(3), 2) <= local < datetime(y, 10, last_sun(10), 3)
    return (local - timedelta(hours=2 if dst else 1)).replace(tzinfo=timezone.utc)


def geoid_n(lat, lon):
    from pyproj import Transformer
    t = Transformer.from_crs("EPSG:4326+5773", "EPSG:4979", always_xy=True)
    h = t.transform(lon, lat, 0.0)[2]
    if not math.isfinite(h) or h == 0.0:
        raise RuntimeError("EGM96 grid unavailable to pyproj")
    return h


REC = re.compile(r"FrameCnt: (\d+).*?\n(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+).*?\[focal_len: ([\d.]+)\].*?\[latitude: ([-\d.]+)\] \[longitude: ([-\d.]+)\] \[rel_alt: ([-\d.]+) abs_alt: ([-\d.]+)\] \[gb_yaw: ([-\d.]+) gb_pitch: ([-\d.]+) gb_roll: ([-\d.]+)\]", re.S)
FF = os.environ.get("FFMPEG", "ffmpeg")

for mp4 in sorted(f for f in os.listdir(flight) if f.upper().endswith(".MP4")):
    stem = mp4[:-4]
    srt = os.path.join(flight, stem + ".SRT")
    lens = "T" if re.search(r"_T(_|$)", stem) else "W"
    cal = json.load(open(os.path.join(flight, f"{lens}_calib.json")))
    fx, cx = cal["mtx"][0][0], cal["mtx"][0][2]
    hfov = math.degrees(2 * math.atan((2 * cx) / (2 * fx)))  # calibration image width ~= 2*cx
    rows = [m.groups() for m in REC.finditer(open(srt, encoding="utf-8", errors="replace").read())]
    if not rows:
        raise SystemExit(f"no SRT records in {srt}")
    lat0, lon0 = float(rows[0][3]), float(rows[0][4])
    n = geoid_n(lat0, lon0)
    ts = os.path.join(out, stem + ".ts")
    subprocess.run([FF, "-v", "error", "-y", "-i", os.path.join(flight, mp4), "-map", "0:v:0", "-c", "copy", "-f", "mpegts", ts], check=True)
    csv = os.path.join(out, stem + ".csv")
    with open(csv, "w", newline="\n") as f:
        f.write("time,lat,lon,hae,heading,pitch,roll,az,el,hfov,fc_lat,fc_lon,fc_hae\n")
        for cnt, t, focal, lat, lon, rel, absa, yaw, pitch, roll in rows:
            utc = to_utc(datetime.strptime(t, "%Y-%m-%d %H:%M:%S.%f"))
            hae = float(absa) + n
            ground = float(absa) - float(rel) + n
            nadir = abs(float(pitch) + 90) < 1.0
            f.write(",".join([utc.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z", lat, lon, f"{hae:.2f}", yaw, "0", "0", "0", pitch, f"{hfov:.2f}",
                              lat if nadir else "", lon if nadir else "", f"{ground:.2f}"]) + "\n")
    print(f"{stem}: {len(rows)} rows, hfov {hfov:.1f} deg, N {n:.2f} m, ts {os.path.getsize(ts)} bytes")
