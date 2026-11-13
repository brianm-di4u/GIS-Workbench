"""SCN-76 fixture and its reference values (REQ-GAP-83).

Writes fixtures/timeseries/ndvi-2010-2019.nc, a synthetic ten-year monthly NDVI stack as CF NetCDF-3
(time, lat, lon; "days since 2010-01-01"; _FillValue for cloud gaps), and
fixtures/timeseries/ndvi-2010-2019.ref.json with what an independent implementation gives for it:

* the dates, decoded by cftime, and their decimal years (proleptic Gregorian, from datetime);
* per pixel, scipy.stats.linregress of NDVI on decimal year over the dates present: slope per year,
  two-sided p-value and the number of dates;
* the anomaly against 2010-2014 by calendar month, and its z-score (sample standard deviation),
  at a few pixels.

The values are read back from the file, so the reference sees the float32 values the app reads.
Run with the gw-te environment (numpy, scipy, netCDF4, cftime):
  python -I tests/tools/timeseries_ref.py
"""
import datetime as dt
import json
import os

import cftime
import numpy as np
from netCDF4 import Dataset
from scipy import stats

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "fixtures", "timeseries")
NC = os.path.join(OUT, "ndvi-2010-2019.nc")
W, H, YEARS = 32, 24, 10
FILL = -9999.0
UNITS = "days since 2010-01-01 00:00:00"

rng = np.random.default_rng(76)
days = np.array([(dt.date(2010 + k // 12, k % 12 + 1, 16) - dt.date(2010, 1, 1)).days for k in range(12 * YEARS)], dtype="f8")
nt = days.size
month = np.arange(nt) % 12
t_year = np.arange(nt) / 12.0
# The trend runs from -0.02 to +0.02 NDVI a year across the columns; the bottom quarter has none.
slope = np.tile(np.linspace(-0.02, 0.02, W), (H, 1))
slope[3 * H // 4 :, :] = 0.0
ndvi = 0.45 + 0.2 * np.sin(2 * np.pi * (month - 3) / 12)[:, None, None] + slope[None] * t_year[:, None, None]
ndvi = ndvi + rng.normal(0, 0.03, ndvi.shape)
cloud = rng.random(ndvi.shape) < 0.05
data = np.where(cloud, FILL, ndvi).astype("f4")

os.makedirs(OUT, exist_ok=True)
with Dataset(NC, "w", format="NETCDF3_CLASSIC") as ds:
    ds.Conventions = "CF-1.8"
    ds.title = "Synthetic monthly NDVI, 2010-2019 (GIS Workbench SCN-76 fixture)"
    ds.createDimension("time", nt)
    ds.createDimension("lat", H)
    ds.createDimension("lon", W)
    tv = ds.createVariable("time", "f8", ("time",))
    tv.units = UNITS
    tv.calendar = "standard"
    tv.standard_name = "time"
    tv.axis = "T"
    tv[:] = days
    la = ds.createVariable("lat", "f8", ("lat",))
    la.units = "degrees_north"
    la.standard_name = "latitude"
    la[:] = 40.0 - 0.01 * (np.arange(H) + 0.5)
    lo = ds.createVariable("lon", "f8", ("lon",))
    lo.units = "degrees_east"
    lo.standard_name = "longitude"
    lo[:] = -105.0 + 0.01 * (np.arange(W) + 0.5)
    v = ds.createVariable("ndvi", "f4", ("time", "lat", "lon"), fill_value=FILL)
    v.long_name = "normalized difference vegetation index"
    v.units = "1"
    v.set_auto_mask(False)
    v[:] = data

with Dataset(NC) as ds:
    tv = ds["time"]
    dates = cftime.num2date(tv[:], tv.units, calendar=tv.calendar, only_use_cftime_datetimes=False)
    v = ds["ndvi"]
    v.set_auto_mask(False)
    cube = np.array(v[:], dtype="f4")
cube = np.where(cube == np.float32(FILL), np.nan, cube.astype("f8"))
iso = [d.strftime("%Y-%m-%dT%H:%M:%SZ") for d in dates]


def decimal_year(d):
    a = dt.datetime(d.year, 1, 1)
    b = dt.datetime(d.year + 1, 1, 1)
    return d.year + (dt.datetime(d.year, d.month, d.day, d.hour, d.minute, d.second) - a) / (b - a)


x = np.array([decimal_year(d) for d in dates])
sl = np.full((H, W), np.nan)
pv = np.full((H, W), np.nan)
nn = np.zeros((H, W))
for r in range(H):
    for c in range(W):
        y = cube[:, r, c]
        ok = np.isfinite(y)
        nn[r, c] = ok.sum()
        if ok.sum() >= 3:
            res = stats.linregress(x[ok], y[ok])
            sl[r, c], pv[r, c] = res.slope, res.pvalue

base = np.array([d.year <= 2014 for d in dates])
samples = [[0, 0], [W - 1, 0], [W // 2, H // 2], [5, H - 1]]
anomaly = []
for c, r in samples:
    y = cube[:, r, c]
    a = np.full(nt, np.nan)
    z = np.full(nt, np.nan)
    for g in range(12):
        sel = (month == g) & base & np.isfinite(y)
        mu, sd = y[sel].mean(), y[sel].std(ddof=1)
        a[month == g] = y[month == g] - mu
        z[month == g] = (y[month == g] - mu) / sd
    anomaly.append({"x": c, "y": r, "anomaly": [None if np.isnan(q) else round(float(q), 7) for q in a], "z": [None if np.isnan(q) else round(float(q), 6) for q in z]})


def flat(a, d):
    return [None if np.isnan(q) else round(float(q), d) for q in a.ravel()]


ref = {
    "source": "tests/tools/timeseries_ref.py (numpy %s, scipy %s, cftime %s)" % (np.__version__, __import__("scipy").__version__, cftime.__version__),
    "width": W,
    "height": H,
    "dates": iso,
    "years": [round(float(q), 10) for q in x],
    "trend": {"slope": flat(sl, 8), "pvalue": [None if np.isnan(q) else float("%.9g" % q) for q in pv.ravel()], "n": [int(q) for q in nn.ravel()]},
    "baseline": ["2010-01-01", "2014-12-31"],
    "anomaly": anomaly,
}
with open(os.path.join(OUT, "ndvi-2010-2019.ref.json"), "w", newline="\n") as f:
    json.dump(ref, f, separators=(",", ":"))
print("wrote", NC, os.path.getsize(NC), "bytes;", int(np.isnan(cube).sum()), "cloud gaps")
