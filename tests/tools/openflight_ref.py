"""Independent OpenFlight reader for the .flt writer of app/src/formats/openflight-write.js
(REQ-GAP-35), written from OGC Community Standard 19-065 (OpenFlight Scene Description 16.0),
not from the writer. It walks the record stream (opcode, length; big-endian; continuation
records 23 appended to the record before them), follows Push/Pop levels, resolves each Face's
Vertex List offsets into the Vertex Palette (records 68, 69, 70, 71) and reports:

* the header: format revision, units, projection, ellipsoid, origin and corner latitude/longitude;
* the palettes: texture file names and indices, number of materials and colours;
* the hierarchy: groups, objects (with their Long ID names), faces per object, the maximum depth,
  and whether every Push has its Pop;
* geometry: triangles (faces with 3 vertices), other polygons, vertex count, the bounding box of
  the referenced vertices, and the texture coordinates' range;
* errors: unknown or malformed records, offsets outside the palette, unbalanced levels.

Usage: python -I openflight_ref.py file.flt [out.json]
With out.json it also writes every face's vertices ({objects: [{name, faces: [[x, y, z, u, v]...]}]})
for coordinate comparisons.
"""
import json
import struct
import sys

VERTEX = {68: 'color', 69: 'color_normal', 70: 'color_normal_uv', 71: 'color_uv'}
KNOWN = {1, 2, 4, 5, 10, 11, 14, 19, 20, 21, 22, 23, 31, 32, 33, 49, 50, 52, 53, 55, 60, 61, 62, 63, 64, 67, 68, 69, 70, 71, 72, 73,
         76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 100, 101, 102, 103, 104, 105,
         106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124, 125, 126, 127, 128, 129,
         130, 131, 132, 133}


def cstr(b):
    return b.split(b'\0', 1)[0].decode('latin-1')


def records(data, errors):
    """(opcode, offset, body bytes) with continuation records merged."""
    out = []
    p = 0
    while p + 4 <= len(data):
        op, ln = struct.unpack_from('>HH', data, p)
        if ln < 4 or p + ln > len(data):
            errors.append(f'record {op} at {p}: length {ln} outside the file')
            break
        if op == 23 and out:
            o, at, body = out[-1]
            out[-1] = (o, at, body + data[p + 4:p + ln])
        else:
            out.append((op, p, data[p:p + ln]))
        p += ln
    if p != len(data):
        errors.append(f'{len(data) - p} bytes after the last record')
    return out


def parse(path, dump=None):
    data = open(path, 'rb').read()
    errors = []
    recs = records(data, errors)
    rep = {'records': len(recs), 'errors': errors, 'textures': [], 'materials': 0, 'colours': 0,
           'groups': 0, 'objects': [], 'faces': 0, 'triangles': 0, 'polygons': 0, 'vertices': 0,
           'maxDepth': 0, 'balanced': True, 'unknown': {}}
    if not recs or recs[0][0] != 1:
        errors.append('the first record is not a header')
        return rep
    h = recs[0][2]
    rep['header'] = {
        'id': cstr(h[4:12]), 'revision': struct.unpack_from('>i', h, 12)[0], 'units': h[62],
        'projection': struct.unpack_from('>i', h, 92)[0], 'storage': struct.unpack_from('>h', h, 126)[0],
        'sw': list(struct.unpack_from('>dd', h, 188)), 'ne': list(struct.unpack_from('>dd', h, 204)),
        'origin': list(struct.unpack_from('>dd', h, 220)), 'ellipsoid': struct.unpack_from('>i', h, 268)[0] if len(h) >= 272 else None,
        'length': len(h),
    }
    # Vertex palette: the absolute file offset of the palette record, and vertices by offset.
    pal_at = None
    verts = {}
    for op, at, body in recs:
        if op == 67:
            pal_at = at
            rep['paletteLength'] = struct.unpack_from('>i', body, 4)[0]
        elif op in VERTEX:
            if pal_at is None:
                errors.append(f'vertex record at {at} before the vertex palette')
                continue
            kind = VERTEX[op]
            x, y, z = struct.unpack_from('>ddd', body, 8)
            u = v = None
            if kind == 'color_normal_uv':
                u, v = struct.unpack_from('>ff', body, 44)
            elif kind == 'color_uv':
                u, v = struct.unpack_from('>ff', body, 32)
            nrm = struct.unpack_from('>fff', body, 32) if kind in ('color_normal', 'color_normal_uv') else None
            verts[at - pal_at] = (x, y, z, u, v, nrm)
        elif op == 64:
            rep['textures'].append({'file': cstr(body[4:204]), 'index': struct.unpack_from('>i', body, 204)[0]})
        elif op == 113:
            rep['materials'] += 1
        elif op == 32:
            rep['colours'] = (len(body) - 132) // 4 if len(body) >= 4228 else 0
        elif op not in KNOWN:
            rep['unknown'][op] = rep['unknown'].get(op, 0) + 1
    if pal_at is not None and rep.get('paletteLength') is not None:
        end = pal_at + rep['paletteLength']
        last = max([pal_at + o for o in verts] or [pal_at])
        if last >= end:
            errors.append('a vertex lies past the vertex palette length')
    # Hierarchy.
    depth = 0
    current = None
    last_node = None
    lo = [float('inf')] * 3
    hi = [float('-inf')] * 3
    ulo, uhi = [float('inf')] * 2, [float('-inf')] * 2
    used = set()
    dump_objs = []
    face_tex = []
    for op, at, body in recs:
        if op == 10:
            depth += 1
            rep['maxDepth'] = max(rep['maxDepth'], depth)
        elif op == 11:
            depth -= 1
            if depth < 0:
                rep['balanced'] = False
                errors.append(f'pop below level 0 at {at}')
                depth = 0
        elif op == 2:
            rep['groups'] += 1
            last_node = {'kind': 'group', 'name': cstr(body[4:12])}
        elif op == 4:
            current = {'name': cstr(body[4:12]), 'faces': 0, 'triangles': 0}
            rep['objects'].append(current)
            last_node = current
            if dump is not None:
                dump_objs.append({'name': current['name'], 'faces': []})
        elif op == 33 and last_node is not None:
            last_node['name'] = cstr(body[4:])
            if dump is not None and last_node is current and dump_objs:
                dump_objs[-1]['name'] = last_node['name']
        elif op == 5:
            rep['faces'] += 1
            tex = struct.unpack_from('>h', body, 28)[0]
            face_tex.append(tex)
            if current is not None:
                current['faces'] += 1
            last_node = {'kind': 'face'}
        elif op == 72:
            n = (len(body) - 4) // 4
            offs = struct.unpack_from(f'>{n}i', body, 4)
            pts = []
            for o in offs:
                if o not in verts:
                    errors.append(f'vertex list at {at}: offset {o} is not a vertex in the palette')
                    continue
                used.add(o)
                x, y, z, u, v, _ = verts[o]
                pts.append([x, y, z, u, v])
                for k, c in enumerate((x, y, z)):
                    lo[k] = min(lo[k], c)
                    hi[k] = max(hi[k], c)
                if u is not None:
                    ulo = [min(ulo[0], u), min(ulo[1], v)]
                    uhi = [max(uhi[0], u), max(uhi[1], v)]
            if n == 3:
                rep['triangles'] += 1
                if current is not None:
                    current['triangles'] += 1
            else:
                rep['polygons'] += 1
            if dump is not None and dump_objs:
                dump_objs[-1]['faces'].append(pts)
    if depth != 0:
        rep['balanced'] = False
        errors.append(f'{depth} push level(s) without a pop')
    rep['vertices'] = len(verts)
    rep['verticesUsed'] = len(used)
    rep['bbox'] = [lo, hi] if lo[0] != float('inf') else None
    rep['uvRange'] = [ulo, uhi] if ulo[0] != float('inf') else None
    rep['texturedFaces'] = sum(1 for t in face_tex if t >= 0)
    rep['unknown'] = {str(k): v for k, v in rep['unknown'].items()}
    if dump is not None:
        with open(dump, 'w') as f:
            json.dump({'objects': dump_objs}, f)
    return rep


if __name__ == '__main__':
    r = parse(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
    r['objects'] = r['objects'][:2000]
    print(json.dumps(r))
