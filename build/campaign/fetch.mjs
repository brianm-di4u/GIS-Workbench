// T&E corpus fetcher: download the tier-A items of build/campaign/corpus.json into TE-corpus/<id>/,
// resumable, within the size budget, each file checked against its pinned SHA-256 (same contract
// as build/packs.mjs --fetch). Registered Research/samples items are verified, never downloaded.
//
//   node build/campaign/fetch.mjs [--dry] [--lock] [--verify] [--only=id,id] [--area=sar,dem] [--jobs=3] [--force]
//     --dry     list what would be fetched and the total against the budget
//     --lock    pin the SHA-256 of files that have none yet (first fetch); later mismatches fail
//     --verify  no network: hash everything on disk against the pins
//     --force   allow exceeding budgetBytes
// Archives the app cannot open directly (.tar.gz/.tgz/.tar, *.gpkg.zip, or files marked extract:true)
// are unpacked next to themselves with bsdtar (refuses absolute and ../ paths); with --lock the
// extracted files are added to the item as pinned entries ("from": <archive>).
// Tier-B items (free login) are listed with their landing page; the owner downloads those by hand.

import { existsSync, mkdirSync, statSync, writeFileSync, renameSync, createWriteStream, unlinkSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { join, dirname, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { MANIFEST, CORPUS, REPO, loadManifest, itemDir, filePath, sha256File, fmtBytes } from './corpus-lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? true]));
const jobs = Number(args.jobs ?? 3);
const man = loadManifest();
const only = args.only ? new Set(String(args.only).split(',')) : null;
const areas = args.area ? new Set(String(args.area).split(',')) : null;
const pick = (it) => (!only || only.has(it.id)) && (!areas || areas.has(it.area));
const items = man.items.filter(pick);

// Planetary Computer blobs need a short-lived SAS token per collection (anonymous).
const tokens = new Map();
async function signed(url, sign) {
  if (!sign) return url;
  const [kind, coll] = sign.split(':');
  if (kind !== 'pc') throw new Error(`unknown signer ${sign}`);
  if (!tokens.has(coll)) {
    const r = await fetch(`https://planetarycomputer.microsoft.com/api/sas/v1/token/${coll}`);
    if (!r.ok) throw new Error(`SAS token for ${coll}: HTTP ${r.status}`);
    tokens.set(coll, (await r.json()).token);
  }
  return `${url}${url.includes('?') ? '&' : '?'}${tokens.get(coll)}`;
}

async function download(url, dest, expectBytes) {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (expectBytes && have > expectBytes) (unlinkSync(part), (have = 0));
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: have ? { range: `bytes=${have}-` } : {} });
      if (have && r.status === 200) have = 0; // server ignored the range: restart
      else if (!(r.ok || r.status === 206)) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(part, { flags: have ? 'a' : 'w' }));
      break;
    } catch (e) {
      have = existsSync(part) ? statSync(part).size : 0;
      if (attempt >= 4) throw e;
      await new Promise((ok) => setTimeout(ok, 2000 * attempt));
    }
  }
  renameSync(part, dest);
}

function sourceTxt(it) {
  const lines = [
    `Sample: ${it.id}`,
    `Downloaded: ${new Date().toISOString().slice(0, 10)} (T&E campaign, build/campaign/fetch.mjs)`,
    `Source: ${it.source} — ${it.landing}`,
    `Licence: ${it.licence}`,
    `Attribution: ${it.attribution}`,
    `What it is: ${it.title} [${it.format}${it.profile ? `; ${it.profile}` : ''}]`,
    ...(it.derivation ? [`Derivation: ${it.derivation}`] : []),
    'Files:',
    ...it.files.flatMap((f) => [`  - ${f.name}  ${f.bytes ?? '?'} bytes  sha256 ${f.sha256 ?? '(unpinned)'}`, `    from ${f.url}`]),
    'Safety: untrusted data. Do not execute anything from this folder. Inspect with scripts kept outside the project (Python -I).',
  ];
  return `${lines.join('\n')}\n`;
}

async function pool(list, fn) {
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(jobs, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}

const status = { when: new Date().toISOString(), corpus: CORPUS, ok: [], fetched: [], failed: [], tierB: [], unpinned: [] };
let pinsChanged = false;

const fetchable = items.filter((it) => it.tier === 'A' && it.origin !== 'research-samples' && it.files.some((f) => f.url));
const planned = fetchable.flatMap((it) => it.files.filter((f) => f.url).map((f) => ({ it, f })));
const total = planned.reduce((s, { f }) => s + (f.bytes ?? 0), 0);
const missing = planned.filter(({ it, f }) => !existsSync(filePath(it, f)));
const toGet = missing.reduce((s, { f }) => s + (f.bytes ?? 0), 0);
console.log(`corpus ${CORPUS}\n${planned.length} files, ${fmtBytes(total)} (budget ${fmtBytes(man.budgetBytes)}); ${missing.length} to fetch (${fmtBytes(toGet)})`);
for (const it of items.filter((x) => x.tier === 'B')) status.tierB.push({ id: it.id, landing: it.landing, files: it.files.map((f) => f.name), dir: itemDir(it), notes: it.notes });
if (status.tierB.length) console.log(`${status.tierB.length} tier-B items need a manual download (see reports/campaign/corpus-status.json)`);
if (total > man.budgetBytes && !args.force && !only && !areas) throw new Error(`manifest exceeds the budget: ${fmtBytes(total)} > ${fmtBytes(man.budgetBytes)} (use --force)`);
if (args.dry) {
  for (const { it, f } of missing) console.log(`  ${it.id}/${f.name}  ${fmtBytes(f.bytes ?? 0)}`);
  process.exit(0);
}

const wantsExtract = (f) => f.extract ?? /\.(tar\.gz|tgz|tar|gpkg\.zip)$/i.test(f.name);
function walk(d) {
  return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
}
async function extract(it, f) {
  const dir = itemDir(it);
  // Windows' own bsdtar: Git's GNU tar would read "C:\…" as a remote host.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', filePath(it, f), '-C', dir], { stdio: 'inherit' });
  // Members from the archive listing (not a before/after diff), so a re-run re-registers files already unpacked.
  const members = execFileSync(tar, ['-tf', filePath(it, f)], { encoding: 'utf8', maxBuffer: 1 << 26 }).split(/\r?\n/).filter((x) => x && !x.endsWith('/'));
  const added = members.map((m) => join(dir, ...m.split('/'))).filter((p) => existsSync(p) && statSync(p).isFile());
  if (!args.lock) return;
  const { roleOf } = await import('./make-corpus-roles.mjs');
  for (const p of added) {
    const name = relative(dir, p).replace(/\\/g, '/');
    if (it.files.some((x) => x.name === name)) continue;
    it.files.push({ name, url: null, from: f.name, bytes: statSync(p).size, sha256: await sha256File(p), role: roleOf(name) });
    pinsChanged = true;
  }
  f.role = 'archive';
  pinsChanged = true;
}

async function check(it, f) {
  const p = filePath(it, f);
  if (!existsSync(p)) return 'missing';
  const h = await sha256File(p);
  if (!f.sha256) {
    status.unpinned.push(`${it.id}/${f.name}`);
    if (args.lock) (f.sha256 = h, (f.bytes = statSync(p).size), (pinsChanged = true));
    return 'ok';
  }
  return h === f.sha256 ? 'ok' : `sha256 ${h} is not the pinned ${f.sha256}`;
}

if (!args.verify) {
  await pool(missing, async ({ it, f }) => {
    const p = filePath(it, f);
    try {
      console.log(`get ${it.id}/${f.name} ${fmtBytes(f.bytes ?? 0)}`);
      await download(await signed(f.url, it.sign), p, f.bytes);
      status.fetched.push(`${it.id}/${f.name}`);
      if (wantsExtract(f)) await extract(it, f);
    } catch (e) {
      status.failed.push({ file: `${it.id}/${f.name}`, error: String(e.message ?? e) });
      console.error(`FAIL ${it.id}/${f.name}: ${e.message ?? e}`);
    }
  });
}

await pool(items.filter((it) => it.tier === 'A' || it.origin === 'research-samples'), async (it) => {
  let ok = true;
  for (const f of [...it.files]) {
    const r = await check(it, f);
    if (r === 'ok' && wantsExtract(f) && !it.files.some((x) => x.from === f.name)) {
      try {
        await extract(it, f);
      } catch (e) {
        ok = false;
        status.failed.push({ file: `${it.id}/${f.name}`, error: `extract: ${e.message ?? e}` });
        continue;
      }
    }
    if (r !== 'ok') {
      ok = false;
      if (r !== 'missing' || it.origin === 'research-samples' || f.url) status.failed.push({ file: `${it.id}/${f.name}`, error: r });
    }
  }
  if (ok) status.ok.push(it.id);
  if (ok && it.files.length && it.origin !== 'research-samples') (mkdirSync(itemDir(it), { recursive: true }), writeFileSync(join(itemDir(it), 'SOURCE.txt'), sourceTxt(it)));
});

if (pinsChanged) {
  // Merge into the manifest as it is now (make-corpus may have rewritten it during a long fetch).
  const fresh = loadManifest();
  const mine = new Map(man.items.map((it) => [it.id, it]));
  for (const it of fresh.items) {
    const m = mine.get(it.id);
    if (!m) continue;
    for (const f of m.files) {
      const g = it.files.find((x) => x.name === f.name);
      if (g) Object.assign(g, { sha256: f.sha256 ?? g.sha256, bytes: f.bytes ?? g.bytes, role: f.role ?? g.role });
      else it.files.push(f);
    }
  }
  writeFileSync(MANIFEST, `${JSON.stringify(fresh, null, 1)}\n`);
}
mkdirSync(join(REPO, 'reports', 'campaign'), { recursive: true });
writeFileSync(join(REPO, 'reports', 'campaign', 'corpus-status.json'), JSON.stringify(status, null, 1));
console.log(`ok ${status.ok.length} items, fetched ${status.fetched.length} files, failed ${status.failed.length}, unpinned ${status.unpinned.length}${args.lock ? ' (now pinned)' : ''}`);
if (status.failed.length) process.exitCode = 1;
