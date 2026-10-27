"""HTJ2K fixtures (REQ-FMT-17): encoded by OpenJPH (C++, through imagecodecs); lossless cases
are checked against the source pixels, lossy and reduced-resolution cases against OpenJPEG's
decode (an independent decoder; OpenJPH's own decode through imagecodecs wraps out-of-range
samples instead of clamping them). Run: python -I build/fixtures/gen-htj2k.py (needs numpy and
imagecodecs >= 2024 in that Python). Writes fixtures/htj2k/."""
import json
import os
import sys

import imagecodecs as ic
import numpy as np

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'fixtures', 'htj2k')
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(15444)


def scene(h, w, bits):
    y, x = np.mgrid[0:h, 0:w].astype(np.float64)
    top = (1 << bits) - 1
    v = 0.35 * top * (1 + np.sin(x / 23.0) * np.cos(y / 31.0)) + rng.normal(0, top * 0.02, (h, w))
    v[(x // 40 + y // 40) % 2 == 0] += top * 0.15  # edges
    v[h // 3 : h // 3 + 9, :] = top  # a bright line
    return np.clip(np.round(v), 0, top)


cases = {}


def save(name, enc, ref, meta):
    open(os.path.join(out, f'{name}.j2c'), 'wb').write(enc)
    ref = np.ascontiguousarray(ref)
    planar = ref.transpose(2, 0, 1) if ref.ndim == 3 else ref
    (planar.astype('<u2') if ref.dtype != np.uint8 else planar).tofile(os.path.join(out, f'{name}.ref'))
    cases[name] = {**meta, 'refType': 'u8' if ref.dtype == np.uint8 else 'u16', 'shape': list(ref.shape)}


# 1. 11-bit mono, reversible, 256² tiles with partial edge tiles, 5 levels: lossless.
a = scene(389, 517, 11).astype(np.uint16)
enc = ic.htj2k_encode(a, bitspersample=11, reversible=True, tile=(256, 256), resolutions=6)
assert (ic.htj2k_decode(enc) == a).all()
save('ht_mono11_tiles', enc, a, {'bits': 11, 'lossless': True})
r2 = ic.jpeg2k_decode(enc, skipres=2)
save('ht_mono11_tiles_skip2', enc, r2, {'bits': 11, 'lossless': False, 'skipres': 2})
os.remove(os.path.join(out, 'ht_mono11_tiles_skip2.j2c'))

# 2. 8-bit RGB, irreversible (9/7) with the colour transform: compare with OpenJPH's decode.
rgb = np.stack([scene(203, 301, 8), np.roll(scene(203, 301, 8), 17, 1), 255 - scene(203, 301, 8)], -1).astype(np.uint8)
enc = ic.htj2k_encode(rgb, rgb=True, reversible=False)
save('ht_rgb8_lossy', enc, ic.jpeg2k_decode(enc), {'bits': 8, 'lossless': False})

# 2b. The same RGB, reversible with the colour transform (RCT): lossless.
enc = ic.htj2k_encode(rgb, rgb=True, reversible=True)
assert (ic.jpeg2k_decode(enc) == rgb).all()
save('ht_rgb8_rct', enc, rgb, {'bits': 8, 'lossless': True})

# 3. 16-bit mono, one tile, reversible.
b = scene(96, 128, 16).astype(np.uint16)
enc = ic.htj2k_encode(b, reversible=True)
save('ht_mono16', enc, b, {'bits': 16, 'lossless': True})

json.dump({'encoder': f'OpenJPH {ic.htj2k_version()} via imagecodecs {ic.__version__}', 'reference': f'OpenJPEG {ic.jpeg2k_version()}', 'cases': cases}, open(os.path.join(out, 'cases.json'), 'w'), indent=1)
print(json.dumps(cases))
print({f: os.path.getsize(os.path.join(out, f)) for f in sorted(os.listdir(out))})
