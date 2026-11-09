#!/usr/bin/env node
// Gathers a release's assets into one new folder and writes their SHA256SUMS.
//
//   node build/release/stage.mjs --sidecar-version 0.3.0 --out D:/gwb-release/2.7.0
//        [--dist dist] [--sidecar D:/gwb-sidecar-deps/release] [--like v2.6.0 [--allow-missing]]
//
// From --dist: the three HTML files and packs/*.gwpack, each checked against dist/SHA256SUMS, and
// gis-workbench-<v>-sbom.cdx.json, the web app's SBOM, written from dist/build-report.json.
// From <sidecar>/<version>: the Windows MSI, portable ZIP, module ZIPs and SBOM.
// From <sidecar>/<version>/linux: the .deb, AppImage, tar.gz, module tar.gz files and SBOM.
// The two SBOMs are published as GWB-Sidecar-<v>-sbom.cdx.json and GWB-Sidecar-<v>-linux-sbom.cdx.json.
// --like compares asset families with an earlier release, so a build that skipped packs is caught.
// --out must be new or empty. Nothing is deleted.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HTML, family, formatSums, missingFamilies, parseSums, stagedNames } from './assets.mjs';
import { manifestParts, webSbom } from './sbom.mjs';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function sha256File(path) {
  return new Promise((done, fail) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (b) => h.update(b)).on('error', fail).on('end', () => done(h.digest('hex')));
  });
}

/** Works out what to copy, without copying. Returns {picks: [{from or text, name, expect?}], problems}. */
export function plan({ dist, sidecar, version }) {
  const picks = [];
  const problems = [];
  const list = (dir) => (existsSync(dir) ? readdirSync(dir) : []);
  const distSums = existsSync(join(dist, 'SHA256SUMS')) ? parseSums(readFileSync(join(dist, 'SHA256SUMS'), 'utf8')) : null;
  if (!distSums) problems.push(`${dist}/SHA256SUMS is missing: build first`);
  const fromDist = (rel, name) => {
    if (!existsSync(join(dist, rel))) return problems.push(`${dist}/${rel} is missing`);
    if (distSums && !distSums.has(rel)) return problems.push(`${dist}/${rel} isn't in dist/SHA256SUMS, so it's left over from another build`);
    picks.push({ from: join(dist, rel), name, expect: distSums?.get(rel) });
  };
  for (const n of HTML) fromDist(n, n);
  for (const n of list(join(dist, 'packs')).filter((x) => x.endsWith('.gwpack')).sort()) fromDist(`packs/${n}`, n);

  // The web app's SBOM is written here, from the build report, rather than copied.
  const report = join(dist, 'build-report.json');
  if (!existsSync(report)) problems.push(`${report} is missing: build first`);
  else if (distSums && createHash('sha256').update(readFileSync(report)).digest('hex') !== distSums.get('build-report.json')) problems.push(`${report} doesn't match dist/SHA256SUMS`);
  else {
    const r = JSON.parse(readFileSync(report, 'utf8'));
    const html = join(dist, HTML[0]);
    const sbom = webSbom(r, existsSync(html) ? manifestParts(readFileSync(html, 'utf8')) : {});
    picks.push({ name: `gis-workbench-${r.build.version}-sbom.cdx.json`, text: JSON.stringify(sbom, null, 2) + '\n' });
  }

  const v = escape(version);
  const take = (dir, pattern, { rename, min = 1, label }) => {
    const found = list(dir).filter((x) => pattern.test(x)).sort();
    if (found.length < min) problems.push(`${dir}: no ${label}`);
    if (rename && found.length > 1 && new Set(found.map((n) => readFileSync(join(dir, n), 'utf8'))).size > 1) problems.push(`${dir}: ${found.join(' and ')} differ, so it's unclear which ${label} is current`);
    for (const n of rename ? found.slice(0, 1) : found) picks.push({ from: join(dir, n), name: rename ?? n });
  };
  const win = join(sidecar, version);
  const linux = join(win, 'linux');
  take(win, new RegExp(`^GWB-Sidecar-${v}-x64\\.msi$`), { label: 'MSI' });
  take(win, new RegExp(`^GWB-Sidecar-${v}-x64-portable\\.zip$`), { label: 'portable ZIP' });
  take(win, new RegExp(`^gwb-sidecar-module-.+-${v}\\.zip$`), { label: 'module ZIPs' });
  take(win, new RegExp(`^(GWB-Sidecar-${v}-sbom\\.cdx\\.json|sbom\\.cdx\\.json)$`), { label: 'SBOM', rename: `GWB-Sidecar-${version}-sbom.cdx.json` });
  take(linux, new RegExp(`^GWB-Sidecar-${v}-amd64\\.deb$`), { label: '.deb' });
  take(linux, new RegExp(`^GWB-Sidecar-${v}-x86_64\\.AppImage$`), { label: 'AppImage' });
  take(linux, new RegExp(`^GWB-Sidecar-${v}-linux-x86_64\\.tar\\.gz$`), { label: 'Linux tar.gz' });
  take(linux, new RegExp(`^gwb-sidecar-module-.+-${v}\\.tar\\.gz$`), { label: 'module tar.gz', min: 0 });
  take(linux, new RegExp(`^(GWB-Sidecar-${v}-linux-sbom\\.cdx\\.json|sbom\\.cdx\\.json)$`), { label: 'Linux SBOM', rename: `GWB-Sidecar-${version}-linux-sbom.cdx.json` });

  const seen = new Set();
  for (const p of picks) {
    if (seen.has(p.name)) problems.push(`two files would be published as ${p.name}`);
    seen.add(p.name);
  }
  return { picks, problems };
}

/** Copies the picks into out, checks each against its expected hash, and writes SHA256SUMS. */
export async function copyAndHash(picks, out) {
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} isn't empty. Pick a new folder: nothing is deleted here.`);
  mkdirSync(out, { recursive: true });
  const entries = [];
  const problems = [];
  for (const p of picks) {
    const to = join(out, p.name);
    if (p.text) writeFileSync(to, p.text);
    else copyFileSync(p.from, to);
    const sha256 = await sha256File(to);
    if (p.expect && p.expect !== sha256) problems.push(`${p.name} doesn't match dist/SHA256SUMS`);
    entries.push({ name: p.name, sha256, bytes: statSync(to).size });
  }
  writeFileSync(join(out, 'SHA256SUMS'), formatSums(entries));
  return { entries, problems };
}

async function main() {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const version = arg('--sidecar-version');
  const out = arg('--out');
  if (!version || !out) {
    console.error('Usage: node build/release/stage.mjs --sidecar-version <v> --out <new folder> [--dist dist] [--sidecar <dir>] [--like <tag>] [--allow-missing]');
    process.exit(2);
  }
  const { picks, problems } = plan({ dist: resolve(arg('--dist', 'dist')), sidecar: resolve(arg('--sidecar', 'D:/gwb-sidecar-deps/release')), version });
  const like = arg('--like');
  if (like) {
    const listed = execFileSync('gh', ['release', 'view', like, '--json', 'assets', '--jq', '.assets[].name'], { encoding: 'utf8' }).split(/\r?\n/);
    const previous = stagedNames(listed);
    const missing = missingFamilies(picks.map((p) => p.name), previous);
    const added = [...new Set(picks.map((p) => family(p.name)))].filter((f) => !previous.some((n) => family(n) === f));
    if (added.length) console.log(`New since ${like}: ${added.join(', ')}`);
    if (missing.length && !process.argv.includes('--allow-missing')) problems.push(`missing since ${like}: ${missing.join(', ')} (pass --allow-missing if that's intended)`);
    else if (missing.length) console.log(`Missing since ${like}, allowed: ${missing.join(', ')}`);
  }
  if (problems.length) {
    console.error(`Not staged:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  const done = await copyAndHash(picks, resolve(out));
  if (done.problems.length) {
    console.error(`Staged, but:\n  ${done.problems.join('\n  ')}`);
    process.exit(1);
  }
  const bytes = done.entries.reduce((s, e) => s + e.bytes, 0);
  console.log(`Staged ${done.entries.length} assets plus SHA256SUMS, ${(bytes / 2 ** 30).toFixed(2)} GiB, in ${resolve(out)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
