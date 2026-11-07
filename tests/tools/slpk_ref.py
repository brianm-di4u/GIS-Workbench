"""Independent SLPK reference for the I3S reader of app/src/formats/i3s-scene.js and the Rust
SLPK/geometry decoders of crates/gw-tiles/src/i3s.rs (REQ-GAP-35). Uses only Python's zipfile,
gzip, struct and json (not the app's code):

* `list file.slpk`: every entry's name, local header offset, compressed and uncompressed size and
  method, as zipfile reads the central directory;
* `geometry file.slpk entry layout.json`: the uncompressed geometry buffer of an entry decoded by
  the I3S geometryBuffer rules (header vertexCount, featureCount; per-vertex attributes then
  per-feature attributes, in the order position, normal, uv0, color, uvRegion, featureId,
  faceRange), printed as JSON lists;
* `attribute file.slpk entry storage.json`: one binary attribute resource decoded by its
  attributeStorageInfo (count header, string byte counts, values; 8-byte values aligned).
* `hash file.slpk`: checks the @specialIndexFileHASH128@ index (MD5 of each lower-cased path, sorted
  as two little-endian uint64, offset of the entry's local header) against the directory.

Usage: python -I slpk_ref.py <command> ...
"""
import gzip
import hashlib
import json
import struct
import sys
import zipfile

SIZE = {'UInt8': ('B', 1), 'Int8': ('b', 1), 'UInt16': ('H', 2), 'Int16': ('h', 2), 'UInt32': ('I', 4), 'Int32': ('i', 4),
        'UInt64': ('Q', 8), 'Int64': ('q', 8), 'Float32': ('f', 4), 'Float64': ('d', 8), 'Oid32': ('I', 4), 'Oid64': ('Q', 8)}


def raw(z, name):
    b = z.read(name)
    return gzip.decompress(b) if b[:2] == b'\x1f\x8b' else b


def cmd_list(path):
    z = zipfile.ZipFile(path)
    out = [{'name': i.filename, 'offset': i.header_offset, 'csize': i.compress_size, 'size': i.file_size, 'method': i.compress_type} for i in z.infolist()]
    print(json.dumps(out))


def cmd_geometry(path, entry, layout_json):
    lay = json.loads(layout_json)
    b = raw(zipfile.ZipFile(path), entry)
    nv, nf = struct.unpack_from('<II', b, 0)
    off = lay.get('offset', 0)
    out = {'vertexCount': nv, 'featureCount': nf}
    for k, count in (('position', nv), ('normal', nv), ('uv0', nv), ('color', nv), ('uvRegion', nv), ('featureId', nf), ('faceRange', nf)):
        d = lay.get(k)
        if not d:
            continue
        fmt, sz = SIZE[d['type']]
        n = count * d.get('component', 1)
        out[k] = list(struct.unpack_from(f'<{n}{fmt}', b, off))
        off += n * sz
    out['bytesUsed'] = off
    out['bytes'] = len(b)
    print(json.dumps(out))


def cmd_attribute(path, entry, storage_json):
    s = json.loads(storage_json)
    b = raw(zipfile.ZipFile(path), entry)
    off = 0
    head = {}
    for h in s.get('header', []):
        fmt, sz = SIZE[h['valueType']]
        head[h['property']] = struct.unpack_from('<' + fmt, b, off)[0]
        off += sz
    n = head.get('count', 0)
    vals = s.get('attributeValues', {})
    lens = None
    out = []
    for o in s.get('ordering', ['attributeValues']):
        if o == 'attributeByteCounts':
            lens = struct.unpack_from(f'<{n}I', b, off)
            off += 4 * n
        elif o in ('ObjectIds', 'objectIds'):
            off += 4 * n
        elif o == 'attributeValues':
            if vals['valueType'] == 'String':
                for i in range(n):
                    t = b[off:off + lens[i]].decode('utf-8')
                    out.append(t[:-1] if t.endswith('\0') else t)
                    off += lens[i]
            else:
                fmt, sz = SIZE[vals['valueType']]
                if sz == 8 and off % 8:
                    off += 8 - off % 8
                out = list(struct.unpack_from(f'<{n}{fmt}', b, off))
                off += n * sz
    print(json.dumps({'values': out, 'bytesUsed': off, 'bytes': len(b)}))


def cmd_hash(path):
    z = zipfile.ZipFile(path)
    infos = z.infolist()
    last = infos[-1]
    if last.filename != '@specialIndexFileHASH128@':
        print(json.dumps({'present': False}))
        return
    b = z.read(last.filename)
    n = len(b) // 24
    rows = [(b[24 * i:24 * i + 16], struct.unpack_from('<Q', b, 24 * i + 16)[0]) for i in range(n)]
    keys = [struct.unpack('<QQ', h) for h, _ in rows]
    by = {hashlib.md5(i.filename.lower().lstrip('/').encode('utf-8')).digest(): i.header_offset for i in infos[:-1]}
    wrong = sum(1 for h, o in rows if by.get(h) != o)
    print(json.dumps({'present': True, 'entries': n, 'files': len(infos) - 1, 'sorted': keys == sorted(keys, key=lambda k: (k[0], k[1])), 'wrong': wrong, 'trailingBytes': len(b) % 24}))


if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'list':
        cmd_list(sys.argv[2])
    elif c == 'geometry':
        cmd_geometry(sys.argv[2], sys.argv[3], sys.argv[4])
    elif c == 'attribute':
        cmd_attribute(sys.argv[2], sys.argv[3], sys.argv[4])
    elif c == 'hash':
        cmd_hash(sys.argv[2])
