#!/usr/bin/env node
// Uploads a staged folder to a draft release, then checks every asset's digest against SHA256SUMS.
//
//   node build/release/upload.mjs --tag v2.7.0 --dir D:/gwb-release/2.7.0 [--jobs 6] [--repo owner/name]
//   node build/release/upload.mjs --tag v2.7.0 --dir D:/gwb-release/2.7.0 --check
//
// It can be stopped and run again: an asset already uploaded with the staged file's digest is
// skipped, and anything else is replaced. SHA256SUMS itself is checked like every other asset. Each file goes up in its own `gh release upload --clobber`, smallest
// first, with retries. It won't upload to a published release. --check only compares digests.
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { digestProblems, parseSums, uploadPlan } from './assets.mjs';

const run = promisify(execFile);
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const lines = (text) => text.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));

function release(repo, tag) {
  const filter = `.[] | select(.tag_name == ${JSON.stringify(tag)}) | {id, draft}`;
  const [found] = lines(execFileSync('gh', ['api', `repos/${repo}/releases?per_page=100`, '--paginate', '--jq', filter], { encoding: 'utf8' }));
  if (!found) throw new Error(`No release ${tag} in ${repo}. The admin cuts the draft with the release workflow first.`);
  const assets = lines(execFileSync('gh', ['api', `repos/${repo}/releases/${found.id}/assets?per_page=100`, '--paginate', '--jq', '.[] | {name, size, state, digest}'], { encoding: 'utf8' }));
  return { ...found, assets };
}

async function pool(items, jobs, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, worker));
}

async function main() {
  const tag = arg('--tag');
  const dir = arg('--dir') && resolve(arg('--dir'));
  if (!tag || !dir) {
    console.error('Usage: node build/release/upload.mjs --tag <tag> --dir <staged folder> [--jobs 6] [--repo owner/name] [--check]');
    process.exit(2);
  }
  const repo = arg('--repo', '{owner}/{repo}');
  const ghRepo = repo.includes('{') ? [] : ['--repo', repo];
  const sumsText = readFileSync(join(dir, 'SHA256SUMS'));
  const sums = parseSums(sumsText.toString('utf8'));
  const want = new Map([...sums, ['SHA256SUMS', createHash('sha256').update(sumsText).digest('hex')]]);
  let rel = release(repo, tag);

  if (!process.argv.includes('--check')) {
    if (!rel.draft) throw new Error(`${tag} is already published. Upload only to a draft.`);
    const local = readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()).map((name) => ({ name, size: statSync(join(dir, name)).size }));
    const strays = local.filter((f) => f.name !== 'SHA256SUMS' && !sums.has(f.name));
    if (strays.length) throw new Error(`Not in SHA256SUMS, so not uploaded: ${strays.map((f) => f.name).join(', ')}. Re-stage.`);
    const todo = uploadPlan(local, rel.assets, want);
    console.log(`${local.length - todo.length} of ${local.length} already uploaded. Uploading ${todo.length}, ${Number(arg('--jobs', 6))} at a time.`);
    const failed = [];
    await pool(todo, Number(arg('--jobs', 6)), async (f) => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const t0 = Date.now();
        try {
          await run('gh', ['release', 'upload', tag, join(dir, f.name), '--clobber', ...ghRepo], { maxBuffer: 1 << 24 });
          console.log(`ok ${f.name} ${f.size} bytes in ${Math.round((Date.now() - t0) / 1000)} s`);
          return;
        } catch (e) {
          console.log(`retry ${f.name}, attempt ${attempt}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
          await new Promise((r) => setTimeout(r, 10_000 * attempt));
        }
      }
      failed.push(f.name);
    });
    if (failed.length) {
      console.error(`Failed after 5 tries: ${failed.join(', ')}. Run this again to resume.`);
      process.exit(1);
    }
    rel = release(repo, tag);
  }

  const problems = digestProblems(want, rel.assets);
  if (problems.length) {
    console.error(`${tag} doesn't match SHA256SUMS:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`${tag}: all ${sums.size} assets and SHA256SUMS are on the release, and every digest matches.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
