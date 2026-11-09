#!/usr/bin/env node
// Is the live app the latest stable release? It hashes the page at pipeline.config.json's smoke
// URL and looks for that hash in the latest stable release's SHA256SUMS. A mismatch exits 1, so
// the nightly report opens a triage issue. That's not a red main: the site can lag a release for
// a day by design, which is why this isn't part of smoke.
//
//   node build/check-live.mjs [--url <page>] [--file gis-workbench.html] [--repo owner/name]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseSums } from './release/assets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The live page's build, from its manifest, or null. */
export function liveBuild(html) {
  const m = /<script type="application\/json" id="build-manifest">(.*?)<\/script>/s.exec(html);
  try {
    return m ? JSON.parse(m[1]).build ?? null : null;
  } catch {
    return null;
  }
}

/** Whether the live page is `file` of the release, and a sentence saying so. */
export function liveVerdict({ sha256, build, tag, sums, file }) {
  const want = sums.get(file);
  const what = build ? `${build.version}, build ${build.id}` : 'no build manifest';
  if (!want) return { ok: false, message: `${tag}'s SHA256SUMS has no ${file}.` };
  if (want === sha256) return { ok: true, message: `The live app is ${tag}'s ${file} (${what}).` };
  return { ok: false, message: `The live app is not ${tag}'s ${file}: it hashes to ${sha256}, the release lists ${want}. The page says ${what}.` };
}

// The API call authenticates when CI provides a token: unauthenticated calls share 60 an hour per
// runner IP, and a refused call must not read as a stale site.
async function get(url, accept) {
  const token = url.startsWith('https://api.github.com/') ? process.env.GITHUB_TOKEN : undefined;
  const headers = { 'user-agent': 'gis-workbench-check-live', ...(accept ? { accept } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(url, { redirect: 'follow', headers });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const config = JSON.parse(readFileSync(join(ROOT, 'pipeline.config.json'), 'utf8'));
  const { values } = parseArgs({ options: { url: { type: 'string' }, file: { type: 'string' }, repo: { type: 'string' } } });
  const url = values.url ?? config.smoke?.url;
  const file = values.file ?? 'gis-workbench.html';
  const repo = values.repo ?? process.env.GITHUB_REPOSITORY ?? 'brianm-di4u/GIS-Workbench';
  if (!url) throw new Error('No URL: pass --url or set smoke.url in pipeline.config.json.');
  // releases/latest is the newest published release that isn't a prerelease or a draft.
  const latest = JSON.parse((await get(`https://api.github.com/repos/${repo}/releases/latest`)).toString('utf8'));
  const asset = latest.assets?.find((a) => a.name === 'SHA256SUMS');
  if (!asset) throw new Error(`${latest.tag_name} has no SHA256SUMS asset.`);
  // Through the API, not browser_download_url: on 2026-11-09 the public download URL returned 504
  // for this file for at least 20 minutes while the API served it.
  const sums = parseSums((await get(asset.url, 'application/octet-stream')).toString('utf8'));
  const page = await get(url);
  const verdict = liveVerdict({ sha256: createHash('sha256').update(page).digest('hex'), build: liveBuild(page.toString('utf8')), tag: latest.tag_name, sums, file });
  console.log(`${url}\n${verdict.message}`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => (process.exitCode = code),
    (err) => {
      console.error(`Could not check the live app: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
