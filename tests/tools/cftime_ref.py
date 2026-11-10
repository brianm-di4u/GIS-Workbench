"""Reference for cfTime (app/src/workers/decode/cf.js): cftime.num2date on fixed cases.

Run with the gw-te environment (cftime 1.x). Prints JSON lines {units, calendar, value, iso}
that tests/unit/cf-time.test.js holds as its expected values.
"""
import json
import sys

import cftime

CASES = [
    ("days since 1970-01-01", "standard", [0, 19000.5, -1, 36524.25]),
    ("hours since 1900-01-01 00:00:00", "gregorian", [0, 1000000, 876600.75]),
    ("seconds since 2020-01-01T00:00:00Z", "standard", [1.5, 86399, 31622400]),
    ("days since 1582-10-04", "standard", [0, 1, 10]),
    ("days since 1500-03-01", "standard", [0, 100000]),
    ("days since 1500-03-01", "proleptic_gregorian", [0, 100000]),
    ("days since 0001-01-01", "julian", [0, 730000]),
    ("days since 2000-01-01", "noleap", [59, 365, 3650]),
    ("days since 2000-01-01", "365_day", [59]),
    ("days since 2000-01-01", "all_leap", [59, 366, 3660]),
    ("days since 2000-01-01", "360_day", [29, 59, 359, 3600]),
    ("minutes since 2010-06-30 23:00", "standard", [59, 61, 525600]),
    ("days since 2000-01-01 00:00:00 -06:00", "standard", [0, 0.25]),
    ("days since 2000-01-01T00:00:00+05:30", "standard", [0, 1]),
]

for units, cal, vals in CASES:
    for v in vals:
        d = cftime.num2date(v, units, calendar=cal, only_use_cftime_datetimes=True)
        ms = round(d.microsecond / 1000)
        iso = f"{d.year:04d}-{d.month:02d}-{d.day:02d}T{d.hour:02d}:{d.minute:02d}:{d.second:02d}" + (f".{ms:03d}" if ms else "") + "Z"
        json.dump({"units": units, "calendar": cal, "value": v, "iso": iso}, sys.stdout)
        sys.stdout.write("\n")

# MONTH_STARTS: the day number of each month start in 2001, and of 2002-01-01, for the two
# fixed-length calendars with months (cf-time.test.js derives every day of the year from them).
MONTH_STARTS = {}
for cal, n in (("noleap", 365), ("all_leap", 366)):
    days = [cftime.num2date(v, "days since 2001-01-01", calendar=cal) for v in range(n + 1)]
    MONTH_STARTS[cal] = [v for v, d in enumerate(days) if d.day == 1]
json.dump({"MONTH_STARTS": MONTH_STARTS}, sys.stdout)
sys.stdout.write("\n")
