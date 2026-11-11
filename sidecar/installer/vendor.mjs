#!/usr/bin/env node
// Development twin of `gwb-sidecar-setup vendor` (S-44, REQ-SDC-12): installs the MrSID or ECW
// GDAL plug-in module from the OSGeo4W packages gdal-mrsid / gdal-ecw.
//
//   node sidecar/installer/vendor.mjs --modules E:/gwb-sidecar-deps/bundle/modules --accept mrsid ecw
//
// The packages come from OSGeo4W (never from this repository); --accept records that the licence
// text (shown first, printed here) was accepted. The plug-in was built against OSGeo4W's
// gdal313.dll; the sidecar's Core GDAL is conda-forge's libgdal-core 3.13 (gdal.dll, no GPL
// poppler/MySQL), so the plug-in's import of gdal313.dll is renamed to gdal.dll. Both are GDAL
// 3.13.3 with the same MSVC ABI; S-44/S-43 checked pixel-identical output on the corpus samples.

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fetchPackages } from './osgeo4w.mjs';

export const VENDOR_MODULES = {
  mrsid: { pkg: 'gdal-mrsid', module: 'vendor-mrsid', plugin: 'apps/gdal/lib/gdalplugins/gdal_MrSID.dll', dlls: ['bin/lti_dsdk_9.5.dll', 'bin/lti_dsdk_cdll_9.5.dll', 'bin/lti_lidar_dsdk_1.1.dll', 'bin/tbb.dll'] },
  ecw: { pkg: 'gdal-ecw', module: 'vendor-ecw', plugin: 'apps/gdal/lib/gdalplugins/gdal_ECW_JP2ECW.dll', dlls: ['bin/NCSEcw.dll'] },
};

/** Rename the plug-in's import of gdal313.dll to gdal.dll (same length budget, NUL padded). */
export function retargetImport(buf, from = 'gdal313.dll', to = 'gdal.dll') {
  const a = Buffer.from(`${from}\0`);
  const b = Buffer.alloc(a.length);
  Buffer.from(to).copy(b);
  let n = 0;
  for (let i = buf.indexOf(a); i >= 0; i = buf.indexOf(a, i + 1)) {
    b.copy(buf, i);
    n++;
  }
  if (n !== 1) throw new Error(`expected one import of ${from}, found ${n}`);
  return buf;
}

export async function installVendor(modulesDir, which, { accept = false, cache = 'E:/gwb-sidecar-deps/osgeo4w', log = console.log } = {}) {
  const v = VENDOR_MODULES[which];
  if (!v) throw new Error(`unknown vendor module ${which}`);
  const tree = `vendor-${which}`;
  // Only the vendor package itself is unpacked (its gdal313-runtime dependency is skipped: the
  // sidecar's own Core GDAL serves it).
  const lock = await fetchPackages(cache, [v.pkg], { tree, acceptVendor: true, skip: ['gdal313-runtime', 'msvcrt2019'], log });
  const entry = lock.find((p) => p.name === v.pkg);
  const licencePath = join(cache, 'pkgs', `${v.pkg}-LICENSE.txt`);
  const licence = readFileSync(licencePath, 'utf8');
  if (!accept) {
    log(licence);
    throw new Error(`read the licence above; run again with --accept to install ${v.pkg}`);
  }
  const dest = join(modulesDir, v.module);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(join(dest, 'gdalplugins'), { recursive: true });
  mkdirSync(join(dest, 'bin'), { recursive: true });
  const src = join(cache, tree);
  const plugin = retargetImport(readFileSync(join(src, v.plugin)));
  writeFileSync(join(dest, 'gdalplugins', v.plugin.split('/').pop()), plugin);
  for (const d of v.dlls) if (existsSync(join(src, d))) copyFileSync(join(src, d), join(dest, 'bin', d.split('/').pop()));
  copyFileSync(licencePath, join(dest, 'LICENSE.txt'));
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  writeFileSync(join(dest, 'ACCEPTED.json'), JSON.stringify({ package: v.pkg, version: entry?.version, source: 'https://download.osgeo.org/osgeo4w/v2', licence_sha256: sha(Buffer.from(licence)), accepted_at: new Date().toISOString(), by: process.env.USERNAME ?? '' }, null, 2));
  writeFileSync(join(dest, 'MANIFEST.json'), JSON.stringify({ id: v.module, version: entry?.version, package: v.pkg, files: [v.plugin, ...v.dlls] }, null, 2));
  return dest;
}

if (process.argv[1]?.endsWith('vendor.mjs')) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--modules');
  const dir = i >= 0 ? args[i + 1] : 'E:/gwb-sidecar-deps/bundle/modules';
  const accept = args.includes('--accept');
  const which = args.filter((a, k) => !a.startsWith('--') && args[k - 1] !== '--modules');
  (async () => {
    for (const w of which) console.log(await installVendor(dir, w, { accept }));
  })().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
