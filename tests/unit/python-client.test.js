// REQ-GAP-02: the Python client in the main test run. Its own tests, including its half of the wire
// contract, run in a real Python when one is found (GWB_PYTHON names one; the suite skips without),
// and the wheel the installers ship is checked as a zip against its own RECORD.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync, strFromU8 } from 'fflate';
import { makeWheel } from '../../sidecar/python/make-wheel.mjs';

const ROOT = resolve('sidecar/python');
const PY = [process.env.GWB_PYTHON, 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe', 'python3', 'python'].filter(Boolean).find((p) => {
  try {
    return /Python 3\.(9|\d\d)/.test(execFileSync(p, ['--version'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
});

describe('REQ-GAP-02 the Python client', () => {
  it.skipIf(!PY)('passes its own tests and the wire contract', () => {
    const out = execFileSync(PY, ['-B', '-m', 'unittest', 'discover', '-s', 'tests'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
    expect(out).toBeDefined();
  }, 100_000);

  it('uses the standard library only', () => {
    const src = ['__init__', '__main__', 'client', 'errors'].map((f) => readFileSync(join(ROOT, 'src', 'gis_workbench_client', `${f}.py`), 'utf8')).join('\n');
    const mods = new Set([...src.matchAll(/^(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1].split('.')[0]));
    mods.delete('');
    expect([...mods].filter((m) => !['argparse', 'http', 'inspect', 'json', 'os', 're', 'socket', 'stat', 'sys', 'tempfile', 'time', 'pathlib'].includes(m))).toEqual([]);
    expect(readFileSync(join(ROOT, 'pyproject.toml'), 'utf8')).toMatch(/^dependencies = \[\]$/m);
  });

  it('the wheel holds the package, and its RECORD is true', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gwb-wheel-'));
    try {
      const p = makeWheel(dir);
      expect(p).toMatch(/gis_workbench_client-\d+\.\d+\.\d+-py3-none-any\.whl$/);
      const bytes = readFileSync(p);
      expect(createHash('sha256').update(readFileSync(makeWheel(dir))).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex')); // reproducible
      const z = unzipSync(new Uint8Array(bytes));
      const names = Object.keys(z);
      for (const f of ['__init__.py', '__main__.py', 'client.py', 'errors.py']) expect(names).toContain(`gis_workbench_client/${f}`);
      const info = names.find((n) => n.endsWith('.dist-info/RECORD')).replace('/RECORD', '');
      expect(strFromU8(z[`${info}/WHEEL`])).toContain('Tag: py3-none-any');
      expect(strFromU8(z[`${info}/METADATA`])).toContain('License: Apache-2.0');
      for (const line of strFromU8(z[`${info}/RECORD`]).trim().split('\n')) {
        const [name, hash, size] = line.split(',');
        if (name.endsWith('/RECORD')) continue;
        expect(hash).toBe(`sha256=${createHash('sha256').update(z[name]).digest('base64url')}`);
        expect(Number(size)).toBe(z[name].length);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
