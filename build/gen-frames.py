# REQ-GAP-16: writes the FRAMES and OPS tables of crates/gw-geodesy/src/datum/frames.rs from PROJ's
# proj.db (EPSG). Usage: python -I build/gen-frames.py <proj.db>  (the gw-te env has PROJ 9.9).
import sqlite3, sys
db = sys.argv[1]
c = sqlite3.connect(db)
meta = dict(c.execute("select key,value from metadata"))
names = {}
geo = {}
for code, name, typ in c.execute("select code,name,type from geodetic_crs where auth_name='EPSG' and deprecated=0"):
    names[int(code)] = name
    geo.setdefault(name, {})[typ] = int(code)
frames = ['ITRF88','ITRF89','ITRF90','ITRF91','ITRF92','ITRF93','ITRF94','ITRF96','ITRF97','ITRF2000','ITRF2005','ITRF2008','ITRF2014','ITRF2020',
          'WGS 84 (Transit)','WGS 84 (G730)','WGS 84 (G873)','WGS 84 (G1150)','WGS 84 (G1674)','WGS 84 (G1762)','WGS 84 (G2139)','WGS 84 (G2296)',
          'NAD83(2011)','NAD83(CSRS)v7','GDA2020','ETRF2014','ETRF2020']
fset = set(frames)
U = {9001: 1.0, 1025: 1e-3, 1033: 1e-2, 1042: 1.0, 1027: 1e-3, 1034: 1e-2,  # -> metres (per year)
     9104: 1.0, 1031: 1e-3, 1043: 1.0, 1032: 1e-3,                          # -> arc-seconds (per year)
     9202: 1.0, 1028: 1e-3, 1030: 1e-3}                                      # -> ppm (per year)
PV = {1033, 1053, 1065, 1037}
CF = {1032, 1056, 1038}
ops = []
super = {int(r[0]) for r in c.execute("select superseded_code from supersession where superseded_auth_name='EPSG' and superseded_table_name='helmert_transformation'")}
q = '''select code,name,method_code,accuracy,source_crs_code,target_crs_code,tx,ty,tz,translation_uom_code,rx,ry,rz,rotation_uom_code,scale_difference,scale_difference_uom_code,
rate_tx,rate_ty,rate_tz,rate_translation_uom_code,rate_rx,rate_ry,rate_rz,rate_rotation_uom_code,rate_scale_difference,rate_scale_difference_uom_code,epoch
from helmert_transformation where deprecated=0 and auth_name='EPSG' and source_crs_auth_name='EPSG' and target_crs_auth_name='EPSG' '''
for r in c.execute(q):
    if int(r[0]) in super:
        continue
    s, t = names.get(int(r[4])), names.get(int(r[5]))
    if s not in fset or t not in fset:
        continue
    m = int(r[2])
    if m not in PV and m not in CF:
        print('skip method', r[0], m, file=sys.stderr); continue
    def u(v, code): return 0.0 if v is None else v * U[int(code)]
    tr = [u(r[6], r[9]), u(r[7], r[9]), u(r[8], r[9])]
    rot = [u(r[10], r[13]), u(r[11], r[13]), u(r[12], r[13])]
    sc = u(r[14], r[15])
    rtr = [u(r[16], r[19] or 9001), u(r[17], r[19] or 9001), u(r[18], r[19] or 9001)]
    rrot = [u(r[20], r[23] or 9104), u(r[21], r[23] or 9104), u(r[22], r[23] or 9104)]
    rsc = u(r[24], r[25] or 9202)
    ep = r[26] if r[26] is not None else 0.0
    ops.append((int(r[0]), r[1], frames.index(s), frames.index(t), m in PV, r[3] if r[3] is not None else -1.0, tr + rot + [sc] + rtr + rrot + [rsc], ep))
print(f"// Generated from PROJ {meta.get('PROJ.VERSION', '?')} proj.db, EPSG {meta.get('EPSG.VERSION','?')} ({meta.get('EPSG.DATE','?')}).")
print("// Frames: (name, geocentric, geographic 3D, geographic 2D EPSG codes, ellipsoid 0 = GRS 80 / 1 = WGS 84).")
print("pub const FRAMES: &[(&str, u32, u32, u32, u8)] = &[")
for f in frames:
    g = geo.get(f, {})
    ell = 1 if f.startswith('WGS 84') else 0
    print(f'    ("{f}", {g.get("geocentric",0)}, {g.get("geographic 3D",0)}, {g.get("geographic 2D",0)}, {ell}),')
print("];")
print("// Operations: (EPSG code, source frame, target frame, position vector?, accuracy m, [tx ty tz m, rx ry rz arcsec, s ppm, rates per year], epoch, name).")
print("pub const OPS: &[(u32, usize, usize, bool, f64, [f64; 14], f64, &str)] = &[")
for o in ops:
    p = ', '.join(repr(float(x)) for x in o[6])
    print(f"    ({o[0]}, {o[2]}, {o[3]}, {str(o[4]).lower()}, {float(o[5])!r}, [{p}], {float(o[7])!r}, \"{o[1]}\"),")
print("];")
