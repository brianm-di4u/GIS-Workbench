#!/usr/bin/env node
// OSGeo4W v2 package resolver and fetcher for the sidecar bundle (SDP-2.1 §3.7, S-43, S-44).
//
//   node sidecar/installer/osgeo4w.mjs --root E:/gwb-sidecar-deps/osgeo4w gdal pdal gdal-mrsid gdal-ecw
//
// Reads setup.ini, resolves `requires:` transitively, downloads each package tarball once into
// <root>/pkgs (checked against the md5 that setup.ini gives), and unpacks it into <root>/<tree>
// (default `root`). Vendor plugin packages carry a `license:` file; it is downloaded next to the
// tarball so the installer can show it before unpacking (the plugins are never bundled: the
// installer runs this same resolver at install time, after the user accepts the licence text).
// Writes <root>/<tree>.lock.json: package, version, file, size, md5, sha256, licence file.
// No shell is used: tar.exe (bsdtar, part of Windows) is spawned with an argument array.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

export const MIRROR = 'https://download.osgeo.org/osgeo4w/v2';
/** Packages whose licence the user must accept before they are installed (REQ-SDC-12, S-44). */
export const VENDOR = new Set(['gdal-mrsid', 'gdal-ecw']);

/** setup.ini → Map(name → {name, requires[], version, install:{path,size,md5}, license?}) (current version only). */
export function parseSetupIni(text) {
  const out = new Map();
  let cur = null;
  let prev = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('@ ')) {
      cur = { name: line.slice(2).trim(), requires: [], version: null, install: null, license: null, category: '' };
      out.set(cur.name, cur);
      prev = false;
      continue;
    }
    if (!cur) continue;
    if (line === '[prev]' || line === '[test]') {
      prev = true;
      continue;
    }
    if (prev) continue;
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'requires') cur.requires = v.split(/\s+/).filter(Boolean);
    else if (k === 'version') cur.version = v;
    else if (k === 'category') cur.category = v;
    else if (k === 'install' || k === 'license') {
      const [path, size, md5] = v.split(/\s+/);
      cur[k] = { path, size: Number(size), md5 };
    }
  }
  return out;
}

/** Transitive closure of `roots` (each must exist), in dependency-first order. */
export function resolve(index, roots, { skip = new Set() } = {}) {
  const order = [];
  const seen = new Set();
  const visit = (n, from) => {
    if (seen.has(n) || skip.has(n)) return;
    const p = index.get(n);
    if (!p) throw new Error(`OSGeo4W: package "${n}" (needed by ${from}) is not in setup.ini`);
    seen.add(n);
    for (const r of p.requires) visit(r, n);
    order.push(p);
  };
  for (const r of roots) visit(r, 'the command line');
  return order;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + '.part'));
  const { renameSync } = await import('node:fs');
  renameSync(dest + '.part', dest);
}

function hashFile(path, algo) {
  return createHash(algo).update(readFileSync(path)).digest('hex');
}

export async function fetchPackages(root, names, { tree = 'root', acceptVendor = false, log = console.log, skip = [] } = {}) {
  mkdirSync(join(root, 'pkgs'), { recursive: true });
  const iniPath = join(root, 'setup.ini');
  if (!existsSync(iniPath) || Date.now() - statSync(iniPath).mtimeMs > 7 * 864e5) await download(`${MIRROR}/x86_64/setup.ini`, iniPath);
  const index = parseSetupIni(readFileSync(iniPath, 'utf8'));
  const pkgs = resolve(index, names, { skip: new Set(skip) });
  const vendor = pkgs.filter((p) => VENDOR.has(p.name));
  if (vendor.length && !acceptVendor) throw new Error(`vendor packages ${vendor.map((p) => p.name).join(', ')} need --accept-vendor-licence after the licence text has been shown and accepted`);
  const lock = [];
  const dest = join(root, tree);
  mkdirSync(dest, { recursive: true });
  for (const p of pkgs) {
    if (!p.install) {
      lock.push({ name: p.name, version: p.version, meta: true });
      continue;
    }
    const file = join(root, 'pkgs', p.install.path.split('/').pop());
    if (!existsSync(file) || hashFile(file, 'md5') !== p.install.md5) {
      log(`download ${p.name} ${p.version} (${(p.install.size / 1e6).toFixed(1)} MB)`);
      await download(`${MIRROR}/${p.install.path}`, file);
    }
    const md5 = hashFile(file, 'md5');
    if (md5 !== p.install.md5) throw new Error(`${p.name}: md5 ${md5} ≠ setup.ini ${p.install.md5}`);
    let licence = null;
    if (p.license) {
      licence = join(root, 'pkgs', `${p.name}-LICENSE.txt`);
      if (!existsSync(licence)) await download(`${MIRROR}/${p.license.path}`, licence);
    }
    const tarExe = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe') : 'tar';
    const r = spawnSync(tarExe, ['-xjf', file, '-C', dest], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (r.status !== 0) throw new Error(`${p.name}: tar failed: ${r.stderr}`);
    lock.push({ name: p.name, version: p.version, category: p.category, file: p.install.path, size: p.install.size, md5, sha256: hashFile(file, 'sha256'), licence: licence ? licence.split(/[\\/]/).pop() : null, vendor: VENDOR.has(p.name) });
  }
  writeFileSync(join(root, `${tree}.lock.json`), JSON.stringify({ mirror: MIRROR, at: new Date().toISOString(), roots: names, packages: lock }, null, 2));
  return lock;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('osgeo4w.mjs')) {
  const args = process.argv.slice(2);
  const opt = (k, d) => {
    const i = args.indexOf(k);
    if (i < 0) return d;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const root = opt('--root', 'E:/gwb-sidecar-deps/osgeo4w');
  const tree = opt('--tree', 'root');
  const skip = (opt('--skip', '') || '').split(',').filter(Boolean);
  const accept = args.includes('--accept-vendor-licence');
  const names = args.filter((a) => !a.startsWith('--'));
  fetchPackages(root, names, { tree, acceptVendor: accept, skip }).then(
    (lock) => console.log(`${lock.length} packages in ${join(root, tree)}`),
    (e) => {
      console.error(e.message);
      process.exit(1);
    },
  );
}
