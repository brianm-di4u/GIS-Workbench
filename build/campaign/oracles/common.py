"""Shared helpers for the T&E oracles. The corpus is untrusted data: read it, never execute it.

Run every oracle with `python -I` from the gw-te environment so neither the working directory nor
a data folder can shadow a module; truth.py adds only this oracles directory to sys.path.
"""
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MANIFEST = HERE.parent / 'corpus.json'
CORPUS = Path(os.environ.get('TE_CORPUS', REPO.parent / 'TE-corpus')).resolve()
SAMPLES = REPO.parent / 'Research' / 'samples'
FIELD = Path(os.environ.get('TE_FIELD', REPO.parent / 'Research' / 'Additional Data Samples')).resolve()
TRUTH = CORPUS / '_truth'


def manifest():
    return json.loads(MANIFEST.read_text(encoding='utf-8'))


def item_dir(item):
    if item.get('origin') == 'research-samples':
        return SAMPLES / item['dir']
    return FIELD / item['dir'] if item.get('origin') == 'field-data' else CORPUS / item['id']


def files(item, roles=('primary',)):
    """Existing on-disk paths of an item's files with the given roles."""
    out = []
    for f in item['files']:
        p = item_dir(item).joinpath(*f['name'].split('/'))
        if f.get('role', 'primary') in roles and p.exists():
            out.append(p)
    return out


def write_truth(item_id, kind, data):
    TRUTH.mkdir(parents=True, exist_ok=True)
    p = TRUTH / f'{item_id}.json'
    doc = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {'id': item_id}
    doc[kind] = data
    p.write_text(json.dumps(_finite(doc), indent=1, default=_jsonable, allow_nan=False), encoding='utf-8')
    return p


def _finite(o):
    """JSON has no NaN/Infinity (GDAL nodata is often NaN): write them as null."""
    import math
    if isinstance(o, float):
        return o if math.isfinite(o) else None
    if isinstance(o, dict):
        return {k: _finite(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_finite(v) for v in o]
    try:
        import numpy as np
        if isinstance(o, np.floating):
            return _finite(float(o))
        if isinstance(o, np.ndarray):
            return _finite(o.tolist())
    except ImportError:
        pass
    return o


def _jsonable(o):
    try:
        import numpy as np
        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    if isinstance(o, (set, tuple)):
        return list(o)
    if isinstance(o, bytes):
        return o.hex()
    return str(o)


def log(*a):
    print(*a, file=sys.stderr, flush=True)
