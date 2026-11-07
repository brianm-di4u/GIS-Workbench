"""Independent structural reader for the 3D PDFs of app/src/formats/pdf3d-write.js and the PRC
streams of app/src/formats/prc-write.js (REQ-GAP-68). No PRC viewer or validator was available
(Adobe Acrobat is not installed here), so this is the check: it is written from the public
working draft of ISO 14739-1 (ISO/TC 171/SC 2 N 570, kept outside the repository) and does
not use the writer's code:

* the double-coding table (acofdoe, 2,077 entries) is taken from the draft's own text at run time
  (prc-wd.txt) by this script's own pattern, and ReadDouble is the inverse of the draft's
  WriteDouble (its prefix codes, sign, mantissa nibble, byte repeats and back references);
* ReadBits / ReadUnsignedInteger / ReadInteger / ReadString / names with the current-name rule /
  graphics with the current-graphics rule, as §10–§11 define them;
* the physical file (§6): "PRC", versions, UUIDs, the file structure descriptions and their six
  section offsets, the model-file offsets, the file structure header and its uncompressed files;
  each section is inflated (zlib) and parsed to its end: globals (colours, pictures, texture
  definitions, materials and texture applications, styles), tree (part definition, poly-brep
  models, product occurrence, file structure internal data), tessellation (3D tessellations and
  their face tessellations), geometry, extra geometry and the model file;
* consistency: every index (style, colour, material, picture, tessellation, triangulated index into
  points / normals / texture coordinates) in range, unit vectors, and the unread bits at the end of
  each section (only the zero padding may remain).

With a PDF it first checks the 3D annotation with pypdf (catalogue extension level 3, /Subtype /3D,
/3DD stream /Subtype /PRC, /3DV with a 12-number C2W and /CO, /3DA, the appearance with its
poster).

Usage: python -I prc_ref.py file.pdf|file.prc prc-wd.txt [dump.json]
       python -I prc_ref.py --doubles stream.bin prc-wd.txt   (a WriteDouble sequence → JSON list)
"""
import json
import re
import struct
import sys
import zlib


def acofdoe(wd_text_path):
    t = open(wd_text_path, encoding='utf-8', errors='replace').read()
    rows = re.findall(r'\{\s*(VT_double|VT_exponent)\s*,\s*(\d+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*DOUBLEWITHTWODWORDINTREE\(\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\)\s*\}', t)
    if len(rows) != 2077:
        raise SystemExit(f'acofdoe: {len(rows)} entries read from the draft, 2077 expected')
    codes = {}
    for ty, nb, bits, up, lo in rows:
        key = (int(nb), int(bits, 16))
        if key in codes:
            raise SystemExit('acofdoe: duplicate code')
        codes[key] = (ty == 'VT_double', int(up, 16), int(lo, 16))
    # A prefix code: no code is a prefix of another.
    for (nb, c) in codes:
        for k in range(1, nb):
            if (k, c >> (nb - k)) in codes:
                raise SystemExit('acofdoe: not a prefix code')
    return codes


class Bits:
    def __init__(self, data, codes):
        self.d = data
        self.p = 0  # bit position
        self.codes = codes
        self.name = None
        self.graphics = None

    def bit(self):
        if self.p >= 8 * len(self.d):
            raise EOFError('read past the end of the section')
        b = (self.d[self.p >> 3] >> (7 - (self.p & 7))) & 1
        self.p += 1
        return b

    def bits(self, n):
        v = 0
        for _ in range(n):
            v = (v << 1) | self.bit()
        return v

    def boolean(self):
        return self.bit() == 1

    def char(self):
        return self.bits(8)

    def uint(self):
        v = 0
        s = 0
        while self.bit():
            v |= self.bits(8) << s
            s += 8
            if s > 32:
                raise ValueError('unsigned integer longer than 32 bits')
        return v

    def int(self):
        v = 0
        s = 0
        last = 0
        while self.bit():
            last = self.bits(8)
            v |= last << s
            s += 8
            if s > 40:
                raise ValueError('integer too long')
        if s and (last & 0x80):
            v -= 1 << s
        return v

    def string(self):
        if not self.bit():
            return None
        n = self.uint()
        return bytes(self.char() for _ in range(n)).decode('utf-8')

    def double(self):
        nb = 0
        c = 0
        while True:
            c = (c << 1) | self.bit()
            nb += 1
            if (nb, c) in self.codes:
                break
            if nb > 22:
                raise ValueError('no double code')
        is_double, up, lo = self.codes[(nb, c)]
        if is_double and up == 0 and lo == 0:
            return 0.0
        sign = self.bit()
        if is_double:
            v = struct.unpack('>d', struct.pack('>II', up, lo))[0]
            return -v if sign else v
        e = (up >> 20) & 0x7ff
        B = [0] * 8
        B[7] = (sign << 7) | (e >> 4)
        B[6] = (e & 0xf) << 4
        if self.bit() == 0:
            return struct.unpack('<d', bytes(B))[0]
        B[6] |= self.bits(4)
        p = 5
        while p >= 0:
            if self.bit():
                B[p] = self.bits(8)
                p -= 1
                continue
            d = self.bits(3)
            if d == 0:
                for q in range(p, -1, -1):
                    B[q] = B[p + 1]
                break
            if d == 6:
                for q in range(p, 0, -1):
                    B[q] = B[p + 1]
                B[0] = self.bits(8)
                break
            if p + d > 5:
                raise ValueError('double back reference out of range')
            B[p] = B[p + d]
            p -= 1
        return struct.unpack('<d', bytes(B))[0]

    def name_(self):
        if self.boolean():
            return self.name
        self.name = self.string()
        return self.name

    def left(self):
        return 8 * len(self.d) - self.p

    def tail_is_padding(self):
        rest = self.left()
        return rest < 8 and all(self.bit() == 0 for _ in range(rest))


REFERENCEABLE = {308, 309, 237, 701, 702, 711, 712}


def content_base(r, t):
    n = r.uint()
    if n:
        raise ValueError('attributes are not expected')
    nm = r.name_()
    if t in REFERENCEABLE:
        r.uint()
        r.uint()
        uid = r.uint()
        return nm, uid
    return nm, None


def graphics(r):
    if r.boolean():
        return r.graphics
    g = (r.uint() - 1, r.uint() - 1, r.char() | (r.char() << 8))
    r.graphics = g
    return g


def user_data(r):
    n = r.uint()
    for _ in range(n):
        r.bit()


def expect(r, t):
    v = r.uint()
    if v != t:
        raise ValueError(f'entity type {v} where {t} was expected (bit {r.p})')


def parse_prc(b, codes, dump=None):
    rep = {'errors': []}
    if b[:3] != b'PRC':
        raise ValueError('not a PRC stream')
    u = lambda o: struct.unpack_from('<I', b, o)[0]
    rep['minVersion'], rep['authoringVersion'] = u(3), u(7)
    o = 11 + 32
    nfs = u(o)
    o += 4
    rep['fileStructures'] = nfs
    fss = []
    for _ in range(nfs):
        uid = [u(o + 4 * k) for k in range(4)]
        o += 16
        reserved = u(o)
        noff = u(o + 4)
        offs = [u(o + 8 + 4 * k) for k in range(noff)]
        o += 8 + 4 * noff
        fss.append({'uid': uid, 'reserved': reserved, 'offsets': offs})
    model_start, model_end = u(o), u(o + 4)
    nunc = u(o + 8)
    rep['headerUncompressedFiles'] = nunc
    rep['modelFile'] = [model_start, model_end]
    rep['length'] = len(b)
    if model_end != len(b):
        rep['errors'].append('model file end offset is not the end of the stream')
    fs = fss[0]
    if len(fs['offsets']) != 6:
        rep['errors'].append('a file structure without 6 sections')
    h = fs['offsets'][0]
    if b[h:h + 3] != b'PRC':
        raise ValueError('file structure header is not at its offset')
    if [u(h + 11 + 4 * k) for k in range(4)] != fs['uid']:
        rep['errors'].append('file structure UUID differs between the file header and its own header')
    nfiles = u(h + 43)
    files = []
    q = h + 47
    for _ in range(nfiles):
        n = u(q)
        files.append(b[q + 4:q + 4 + n])
        q += 4 + n
    if q != fs['offsets'][1]:
        rep['errors'].append('the globals section does not follow the file structure header')
    rep['uncompressedFiles'] = [{'bytes': len(f), 'kind': 'jpeg' if f[:2] == b'\xff\xd8' else 'png' if f[:4] == b'\x89PNG' else 'other'} for f in files]
    bounds = fs['offsets'][1:] + [model_start]
    sec = {}
    for name, a, z in zip(['globals', 'tree', 'tessellation', 'geometry', 'extra'], bounds[:-1], bounds[1:]):
        sec[name] = zlib.decompress(b[a:z])
    sec['model'] = zlib.decompress(b[model_start:model_end])
    rep['sectionBytes'] = {k: len(v) for k, v in sec.items()}
    tails = {}

    # Globals.
    r = Bits(sec['globals'], codes)
    if r.uint() != 0:
        raise ValueError('a schema is present (not expected)')
    expect(r, 303)
    content_base(r, 303)
    if r.uint():
        raise ValueError('referenced file structures')
    rep['chordHeight'], rep['angle'] = r.double(), r.double()
    r.string()
    if r.uint():
        raise ValueError('fonts')
    colours = [[r.double(), r.double(), r.double()] for _ in range(r.uint())]
    pictures = []
    for _ in range(r.uint()):
        expect(r, 703)
        content_base(r, 703)
        pictures.append({'format': r.int(), 'file': r.uint() - 1, 'width': r.uint(), 'height': r.uint()})
    texdefs = []
    for _ in range(r.uint()):
        expect(r, 712)
        content_base(r, 712)
        d = {'picture': r.uint() - 1, 'dimension': r.char(), 'mappingType': r.int()}
        if d['mappingType'] == 4:
            raise ValueError('mapping operator not expected')
        d['attributes'] = r.uint()
        for _ in range(r.uint()):
            r.double()
        for _ in range(r.uint()):
            r.char()
        d['function'] = r.int()
        if d['function'] == 4:
            [r.double() for _ in range(4)]
        d['blendSrcRgb'] = r.int()
        d['blendSrcAlpha'] = r.int()
        d['applying'] = r.char()
        if d['applying'] & 0x2:
            r.int()
            r.double()
        d['wrapS'] = r.int()
        if d['dimension'] > 1:
            d['wrapT'] = r.int()
        if d['dimension'] > 2:
            r.int()
        if r.bit():
            raise ValueError('texture transformation not expected')
        texdefs.append(d)
    materials = []
    for _ in range(r.uint()):
        t = r.uint()
        content_base(r, t)
        if t == 702:
            m = {'kind': 'generic', 'ambient': r.uint() - 1, 'diffuse': r.uint() - 1, 'emissive': r.uint() - 1, 'specular': r.uint() - 1, 'shininess': r.double(), 'alphas': [r.double() for _ in range(4)]}
        elif t == 711:
            m = {'kind': 'texture', 'material': r.uint() - 1, 'definition': r.uint() - 1, 'next': r.uint() - 1, 'uvSet': r.uint() - 1}
        else:
            raise ValueError(f'material type {t}')
        materials.append(m)
    if r.uint():
        raise ValueError('line patterns not expected')
    styles = []
    for _ in range(r.uint()):
        expect(r, 701)
        content_base(r, 701)
        s = {'width': r.double(), 'vpicture': r.boolean(), 'pattern': r.uint() - 1, 'isMaterial': r.boolean(), 'index': r.uint() - 1}
        if r.boolean():
            s['transparency'] = r.char()
        for _ in range(3):
            if r.boolean():
                r.char()
        styles.append(s)
    if r.uint() or r.uint():
        raise ValueError('fill patterns or coordinate systems not expected')
    user_data(r)
    tails['globals'] = r.tail_is_padding()

    # Tree.
    r = Bits(sec['tree'], codes)
    expect(r, 304)
    content_base(r, 304)
    parts = []
    for _ in range(r.uint()):
        expect(r, 309)
        nm, uid = content_base(r, 309)
        graphics(r)
        bbox = [r.double() for _ in range(6)]
        ris = []
        for _ in range(r.uint()):
            expect(r, 237)
            rnm, ruid = content_base(r, 237)
            g = graphics(r)
            ris.append({'name': rnm, 'uid': ruid, 'style': g[1], 'layer': g[0], 'behaviour': g[2], 'cs': r.uint() - 1, 'tess': r.uint() - 1, 'closed': r.boolean()})
            user_data(r)
        for _ in range(4):
            if r.uint():
                raise ValueError('markups not expected')
        if r.uint():
            raise ValueError('views not expected')
        user_data(r)
        parts.append({'name': nm, 'uid': uid, 'bbox': bbox, 'items': ris})
    pos = []
    for _ in range(r.uint()):
        expect(r, 308)
        nm, uid = content_base(r, 308)
        graphics(r)
        po = {'name': nm, 'uid': uid, 'part': r.uint() - 1, 'prototype': r.uint() - 1, 'external': r.uint() - 1}
        po['sons'] = [r.uint() for _ in range(r.uint())]
        po['behaviour'] = r.char()
        po['unitFromCad'] = r.boolean()
        po['unit'] = r.double()
        po['flags'] = r.char()
        po['loadStatus'] = r.int()
        if r.bit():
            raise ValueError('location not expected')
        if r.uint():
            raise ValueError('entity references not expected')
        for _ in range(4):
            r.uint()
        r.uint()
        if r.bit():
            raise ValueError('entity filter not expected')
        r.uint()
        r.uint()
        user_data(r)
        pos.append(po)
    expect(r, 302)
    content_base(r, 302)
    next_index = r.uint()
    root = r.uint()
    user_data(r)
    user_data(r)
    tails['tree'] = r.tail_is_padding()

    # Tessellation.
    r = Bits(sec['tessellation'], codes)
    expect(r, 305)
    content_base(r, 305)
    tess = []
    dumps = []
    for _ in range(r.uint()):
        expect(r, 172)
        r.boolean()
        P = [r.double() for _ in range(r.uint())]
        has_faces, has_loops = r.boolean(), r.boolean()
        recalc = r.boolean()
        if recalc:
            r.char()
            r.double()
        N = [r.double() for _ in range(r.uint())]
        wires = [r.uint() for _ in range(r.uint())]
        tri = [r.uint() for _ in range(r.uint())]
        faces = []
        for _ in range(r.uint()):
            expect(r, 174)
            la = [r.uint() for _ in range(r.uint())]
            sw = r.uint()
            szw = [r.uint() for _ in range(r.uint())]
            flag = r.uint()
            st = r.uint()
            td = [r.uint() for _ in range(r.uint())]
            ntc = r.uint()
            if r.boolean():
                raise ValueError('vertex colours not expected')
            if la:
                r.uint()
            faces.append({'flag': flag, 'start': st, 'data': td, 'texIdx': ntc, 'lineAttributes': la})
        UV = [r.double() for _ in range(r.uint())]
        t = {'points': len(P) // 3, 'normals': len(N) // 3, 'uv': len(UV) // 2, 'indices': len(tri), 'faces': faces, 'hasFaces': has_faces, 'wires': len(wires)}
        # Index checks and triangles.
        errs = []
        k = 0
        tris = 0
        lo = [float('inf')] * 3
        hi = [float('-inf')] * 3
        maxlen = 0
        for f in faces:
            per = 3 if f['flag'] == 0x200 else 2
            if f['flag'] not in (0x2, 0x200):
                errs.append(f'face flag {f["flag"]:#x}')
                continue
            ntr = f['data'][0]
            k = f['start']
            for _ in range(ntr):
                for c in range(3):
                    ni = tri[k]
                    pi = tri[k + per - 1]
                    if ni % 3 or pi % 3 or ni // 3 >= len(N) // 3 or pi // 3 >= len(P) // 3:
                        errs.append(f'index out of range at {k}')
                    if per == 3:
                        ti = tri[k + 1]
                        if ti % 2 or ti // 2 >= len(UV) // 2:
                            errs.append(f'texture index out of range at {k}')
                    for a in range(3):
                        lo[a] = min(lo[a], P[pi + a])
                        hi[a] = max(hi[a], P[pi + a])
                    k += per
                tris += 1
        for i in range(0, len(N), 3):
            maxlen = max(maxlen, abs((N[i] ** 2 + N[i + 1] ** 2 + N[i + 2] ** 2) ** 0.5 - 1))
        if k != len(tri):
            errs.append(f'{len(tri) - k} triangulated indices not used')
        t.update({'triangles': tris, 'bbox': [lo, hi], 'normalError': maxlen, 'errors': errs[:10], 'uvRange': [min(UV[0::2] or [0]), max(UV[0::2] or [0]), min(UV[1::2] or [0]), max(UV[1::2] or [0])]})
        tess.append(t)
        if dump is not None:
            dumps.append({'P': P, 'UV': UV, 'tri': tri})
    user_data(r)
    tails['tessellation'] = r.tail_is_padding()

    for name, t in (('geometry', 306), ('extra', 307)):
        r = Bits(sec[name], codes)
        expect(r, t)
        content_base(r, t)
        if r.uint():
            raise ValueError(f'{name}: contexts not expected')
        user_data(r)
        tails[name] = r.tail_is_padding()

    r = Bits(sec['model'], codes)
    if r.uint() != 0:
        raise ValueError('model file schema')
    expect(r, 301)
    content_base(r, 301)
    mf = {'unitFromCad': r.boolean()}
    if mf['unitFromCad']:
        mf['unit'] = r.double()
    roots = []
    for _ in range(r.uint()):
        uid = [r.uint() for _ in range(4)]
        roots.append({'uid': uid, 'index': r.uint(), 'active': r.boolean()})
    mf['roots'] = roots
    mf['fileStructureIndex'] = [r.uint() for _ in range(nfs)]
    user_data(r)
    tails['model'] = r.tail_is_padding()

    # Cross-references.
    e = rep['errors']
    for p in pictures:
        if not 0 <= p['file'] < len(files):
            e.append('picture file index out of range')
    for d in texdefs:
        if not 0 <= d['picture'] < len(pictures):
            e.append('texture picture index out of range')
    for m in materials:
        if m['kind'] == 'generic' and not all(0 <= m[k] < len(colours) for k in ('ambient', 'diffuse', 'emissive', 'specular')):
            e.append('material colour index out of range')
        if m['kind'] == 'texture' and not (0 <= m['definition'] < len(texdefs) and materials[m['material']]['kind'] == 'generic'):
            e.append('texture application references')
    for s in styles:
        if not 0 <= s['index'] < (len(materials) if s['isMaterial'] else len(colours)):
            e.append('style colour/material index out of range')
    uids = []
    for p in parts:
        uids.append(p['uid'])
        for it in p['items']:
            uids.append(it['uid'])
            if not 0 <= it['tess'] < len(tess):
                e.append('tessellation index out of range')
            if not 0 <= it['style'] < len(styles):
                e.append('style index out of range')
            st = styles[it['style']]
            textured = st['isMaterial'] and materials[st['index']]['kind'] == 'texture'
            t = tess[it['tess']]
            if textured != (t['faces'][0]['flag'] == 0x200):
                e.append('textured style on an untextured tessellation, or the reverse')
    for po in pos:
        uids.append(po['uid'])
        if not 0 <= po['part'] < len(parts):
            e.append('part index out of range')
    if roots[0]['uid'] != fs['uid']:
        e.append('the model file root does not name the file structure')
    if not all(tails.values()):
        e.append(f'bits left at the end of a section: {tails}')
    for t in tess:
        e.extend(t['errors'])
    rep.update({'colours': colours, 'pictures': pictures, 'textureDefinitions': texdefs, 'materials': materials, 'styles': styles, 'parts': [{k: v for k, v in p.items() if k != 'items'} | {'items': len(p['items'])} for p in parts], 'items': [it for p in parts for it in p['items']], 'productOccurrences': pos, 'nextIndex': next_index, 'uidsUnique': len(set(uids)) == len(uids) and max(uids) < next_index, 'tessellations': [{k: v for k, v in t.items() if k != 'errors'} for t in tess], 'modelFile': mf, 'tails': tails, 'triangles': sum(t['triangles'] for t in tess)})
    if dump is not None:
        json.dump(dumps, open(dump, 'w'))
    return rep


def check_pdf(path):
    from pypdf import PdfReader
    rd = PdfReader(path)
    cat = rd.trailer['/Root']
    rep = {'pages': len(rd.pages), 'pdfHeader': rd.pdf_header}
    ext = cat.get('/Extensions', {}).get('/ADBE', {})
    rep['extension'] = {'base': str(ext.get('/BaseVersion')), 'level': int(ext.get('/ExtensionLevel', 0))}
    annots = [a.get_object() for a in rd.pages[0].get('/Annots', [])]
    a3 = [a for a in annots if a.get('/Subtype') == '/3D']
    rep['annotations3d'] = len(a3)
    a = a3[0]
    d3 = a['/3DD'].get_object()
    rep['stream'] = {'type': str(d3.get('/Type')), 'subtype': str(d3.get('/Subtype'))}
    v = a['/3DV'].get_object()
    c2w = [float(x) for x in v['/C2W']]
    rep['view'] = {'c2w': c2w, 'co': float(v['/CO']), 'projection': str(v['/P']['/Subtype']), 'fov': float(v['/P'].get('/FOV', 0)), 'ms': str(v.get('/MS'))}
    X, Y, Z = c2w[0:3], c2w[3:6], c2w[6:9]
    dot = lambda p, q: sum(i * j for i, j in zip(p, q))
    cross = lambda p, q: [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]]
    rep['view']['orthonormal'] = max(abs(dot(X, X) - 1), abs(dot(Y, Y) - 1), abs(dot(Z, Z) - 1), abs(dot(X, Y)), abs(dot(Y, Z)), abs(dot(X, Z)))
    rep['view']['rightHanded'] = dot(cross(X, Y), Z)
    rep['activation'] = {k: str(v2) for k, v2 in a['/3DA'].items()}
    ap = a['/AP']['/N'].get_object()
    xo = ap.get('/Resources', {}).get('/XObject', {})
    rep['poster'] = {k: {'w': int(x.get_object()['/Width']), 'h': int(x.get_object()['/Height']), 'filter': str(x.get_object()['/Filter'])} for k, x in xo.items()}
    rep['rect'] = [float(x) for x in a['/Rect']]
    return rep, d3.get_data()


if __name__ == '__main__':
    if sys.argv[1] == '--doubles':
        codes = acofdoe(sys.argv[3])
        data = open(sys.argv[2], 'rb').read()
        r = Bits(data, codes)
        n = r.uint()
        vals = [r.double() for _ in range(n)]
        print(json.dumps({'values': [struct.pack('<d', x).hex() for x in vals], 'padding': r.tail_is_padding()}))
        sys.exit(0)
    path, wd = sys.argv[1], sys.argv[2]
    codes = acofdoe(wd)
    out = {}
    if path.lower().endswith('.pdf'):
        out['pdf'], prc = check_pdf(path)
    else:
        prc = open(path, 'rb').read()
    out['prc'] = parse_prc(prc, codes, sys.argv[3] if len(sys.argv) > 3 else None)
    print(json.dumps(out))
