// The Python client as a wheel (REQ-GAP-02), built without Python so packaging needs nothing new:
// a wheel is a zip with three metadata files. Pure Python, no compiled parts, no dependencies, and
// reproducible (fixed times). Called by sidecar/installer/package*.mjs; alone:
//   node sidecar/python/make-wheel.mjs <out dir>

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const HERE = dirname(fileURLToPath(import.meta.url));
const NAME = 'gis_workbench_client';

const hash = (b) => `sha256=${createHash('sha256').update(b).digest('base64url')}`;
const enc = (s) => new TextEncoder().encode(s);

/** Name, version and summary from pyproject.toml: the one place they are written. */
function project() {
  const t = readFileSync(join(HERE, 'pyproject.toml'), 'utf8');
  const get = (k) => new RegExp(`^${k} = "(.*)"$`, 'm').exec(t)[1];
  return { name: get('name'), version: get('version'), summary: get('description'), python: get('requires-python') };
}

/** Write the wheel into `outDir`; returns its path. */
export function makeWheel(outDir) {
  const p = project();
  const src = join(HERE, 'src', NAME);
  const code = new RegExp(`__version__ = "${p.version.replace(/\./g, '\\.')}"`);
  if (!code.test(readFileSync(join(src, 'client.py'), 'utf8'))) throw new Error('client.py __version__ differs from pyproject.toml');
  const info = `${NAME}-${p.version}.dist-info`;
  const files = {};
  for (const f of readdirSync(src).filter((x) => x.endsWith('.py')).sort()) files[`${NAME}/${f}`] = readFileSync(join(src, f));
  files[`${info}/METADATA`] = enc(`Metadata-Version: 2.1\nName: ${p.name}\nVersion: ${p.version}\nSummary: ${p.summary}\nLicense: Apache-2.0\nRequires-Python: ${p.python}\nDescription-Content-Type: text/markdown\n\n${readFileSync(join(HERE, 'README.md'), 'utf8')}`);
  files[`${info}/WHEEL`] = enc('Wheel-Version: 1.0\nGenerator: gis-workbench make-wheel\nRoot-Is-Purelib: true\nTag: py3-none-any\n');
  const record = Object.entries(files).map(([k, v]) => `${k},${hash(v)},${v.length}`);
  files[`${info}/RECORD`] = enc(`${[...record, `${info}/RECORD,,`].join('\n')}\n`);
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [new Uint8Array(v), { mtime: new Date(1980, 0, 2), level: 9 }]])));
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `${NAME}-${p.version}-py3-none-any.whl`);
  writeFileSync(out, zip);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(makeWheel(resolve(process.argv[2] ?? '.')));
