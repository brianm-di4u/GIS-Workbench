#!/usr/bin/env node
// The part of IfcOpenShell the model3d module ships (REQ-GAP-36):
//
//   node sidecar/installer/subset-ifcopenshell.mjs --wheel-dir <unpacked wheel> --typing <typing_extensions.py> --out <dir> [--platform linux]
//   node sidecar/installer/subset-ifcopenshell.mjs --wheel-dir <install>/python --typing <...> --out <dir> --platform linux-source --boost <lib dir>
//
// The wheel holds the whole of IfcOpenShell. Writing IFC needs only the wrapper, the parser, the
// IFC4 schema and the Python layer. The CGAL kernels stay out, and with them GMP, MPFR and wgpu.
// Windows takes this from the wheel. On Linux the wheel's wrapper links the Open CASCADE kernel at
// load time and needs glibc 2.34, so Sidecar 0.3.0 builds these libraries from source instead
// (build-ifcopenshell.sh, `linux-source`), with no kernel; `linux` is the wheel's list, kept for
// comparing against it. The list is an allow-list, so a new file stays out until it is reviewed;
// compose.mjs refuses the barred names again when it builds the module.

import { cpSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const src = join(arg('--wheel-dir'), 'ifcopenshell');
const out = arg('--out');
const platform = arg('--platform', 'windows');
const NATIVE = platform === 'linux-source'
  ? [/^_ifcopenshell_wrapper\.cpython-312-x86_64-linux-gnu\.so$/, /^libifcopenshell\.parse\.so$/, /^libifcopenshell\.geometry\.so$/, /^libifcopenshell\.plugin\.so$/, /^ifcopenshell_parse_schema_ifc4\.so$/, /^libifcopenshell\.geometry\.writer\.so$/]
  : platform === 'linux'
  ? [/^_ifcopenshell_wrapper\.cpython-312-x86_64-linux-gnu\.so$/, /^libifcopenshell\.parse\.so$/, /^libifcopenshell\.geometry\.so$/, /^libifcopenshell\.plugin\.so$/, /^ifcopenshell_document_rdb\.so$/, /^ifcopenshell_parse_schema_ifc4\.so$/, /^libifcopenshell\.geometry\.writer\.so$/, /^libboost_program_options\.so\.1\.86\.0$/, /^ifcopenshell_geometry_kernel_opencascade\.so$/, /^libTK(GeomAlgo|GeomBase|Bool|TopAlgo|Fillet|ShHealing|Math|BO|ernel|Offset|G3d|BRep|Mesh|Prim|G2d)\.so\.7\.8$/]
  : [/^_ifcopenshell_wrapper\.cp312-win_amd64\.pyd$/, /^ifcopenshell\.parse\.dll$/, /^ifcopenshell\.geometry\.dll$/, /^ifcopenshell\.plugin\.dll$/, /^ifcopenshell_document_rdb\.dll$/, /^ifcopenshell_parse_schema_ifc4\.dll$/];
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'ifcopenshell'), { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (f.endsWith('.py') || NATIVE.some((re) => re.test(f))) {
    copyFileSync(join(src, f), join(out, 'ifcopenshell', f));
    n++;
  }
}
cpSync(join(src, 'util'), join(out, 'ifcopenshell', 'util'), { recursive: true });
if (platform === 'linux-source') {
  const boost = readdirSync(arg('--boost')).filter((f) => /^libboost_(program_options|container)\.so\.\d/.test(f));
  if (boost.length !== 2) throw new Error(`--boost: looked for program_options and container, found ${boost.join(', ') || 'neither'}`);
  for (const f of boost) copyFileSync(join(arg('--boost'), f), join(out, 'ifcopenshell', f));
}
const te = arg('--typing');
if (!te || !existsSync(te)) throw new Error('--typing: typing_extensions.py is needed');
copyFileSync(te, join(out, 'typing_extensions.py'));
console.log(`${n} files and util/ in ${out}`);
