// TE-C56 robustness on damaged files (2.0.4 campaign): one file per census format key is cut at 10 %,
// 50 % and 90 % of its length and has its first bytes inverted; each mutant (with the original's
// sidecars beside it) must be opened or refused by name within 120 s, with no page crash, no page
// error and no console error, and the app must still open a good file afterwards (a trapped or hung
// worker is replaced). Mutants are written under TE-corpus/_mutants (regenerable, never committed).
//
//   TE_DIST=dist-cx5/gis-workbench.html TE_RUN=cx-robust [TE_ONLY=<regex>]
//   npx playwright test -c playwright.campaign.config.js c56-robustness --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, statSync, mkdirSync, openSync, readSync, writeSync, closeSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { resolve } from 'node:path';
import { openFiles, settledAny } from './helpers.js';
import { cases, CENSUS, EXPECT, ROBUST } from './cases.js';
import { session, recordWriter, outDir } from './cross-lib.js';
import { CORPUS } from '../../build/campaign/corpus-lib.mjs';

const RUN = process.env.TE_RUN ?? 'cx-robust';
const OUT = outDir(RUN);
const MUT = join(CORPUS, '_mutants');
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;
const GOOD = resolve('fixtures/fx01/fx01.ntf');
// A raw JavaScript exception surfacing as the reason: a robustness defect even when caught.
const RAW = /DataView|MAX_SAFE_INTEGER|array buffer length|is not a function|Cannot read propert|undefined|Invalid typed array|RangeError|TypeError|out of bounds|Maximum call stack|unreachable|RuntimeError/;

// One file per key (the smallest, under 300 MB: cutting copies it).
const pick = new Map();
for (const c of cases) {
  const k = `${c.it.id}/${c.f.name}`;
  if (ONLY && !ONLY.test(k)) continue;
  if (ROBUST(c.it) || EXPECT[c.f.name.split('/').pop()]?.refuse || !c.files.every(existsSync)) continue;
  const bytes = statSync(c.files.find((p) => p.endsWith(c.f.name.split('/').pop())) ?? c.files[0]).size;
  if (bytes > 300e6 || bytes < 64) continue;
  for (const key of CENSUS.get(k) ?? []) if (!pick.has(key) || pick.get(key).bytes > bytes) pick.set(key, { ...c, bytes, key });
}
const chosen = [...new Map([...pick.values()].map((c) => [`${c.it.id}/${c.f.name}`, c])).values()];

/** Write a mutant: the primary cut to `frac` of its length, or with its first 64 bytes inverted. */
function mutate(src, dst, how) {
  const n = statSync(src).size;
  const len = how === 'flip' ? n : Math.max(16, Math.floor(n * how));
  const fi = openSync(src, 'r');
  const fo = openSync(dst, 'w');
  const buf = Buffer.alloc(1 << 20);
  for (let off = 0; off < len; ) {
    const k = readSync(fi, buf, 0, Math.min(buf.length, len - off), off);
    if (!k) break;
    if (how === 'flip' && off === 0) for (let i = 0; i < Math.min(64, k); i += 3) buf[i] ^= 0xff;
    writeSync(fo, buf, 0, k);
    off += k;
  }
  closeSync(fi);
  closeSync(fo);
}

test.describe.configure({ mode: 'parallel' });
for (const c of chosen) {
  const key = `${c.it.id}/${c.f.name}`;
  for (const how of [0.1, 0.5, 0.9, 'flip']) {
    test(`TE-C56 REQ-SEC-02 ${key} ${how === 'flip' ? 'header inverted' : `cut at ${how * 100} %`}`, async ({ page }, info) => {
      test.setTimeout(300_000);
      const dir = join(MUT, `${key.replace(/[^\w.-]+/g, '_')}_${how}`);
      mkdirSync(dir, { recursive: true });
      mkdirSync(OUT, { recursive: true });
      const prim = c.files.find((p) => basename(p) === basename(c.f.name)) ?? c.files.find((p) => !/\.gwpack$/i.test(p));
      const files = c.files.map((p) => {
        const d = join(dir, basename(p));
        if (p === prim) mutate(p, d, how);
        else if (!existsSync(d)) copyFileSync(p, d);
        return d;
      });
      const rec = { spec: 'c56-robustness', project: info.project.name, key, mutation: how, item: c.it.id, file: basename(c.f.name), formatKey: c.key };
      const save = recordWriter(join(OUT, `c56-${info.project.name}-${key.replace(/[^\w.-]+/g, '_')}-${how}.json`), rec);
      const s = await session(page, { files, setupSteps: [] });
      let crashed = false;
      page.on('crash', () => (crashed = true));
      const t0 = Date.now();
      const o = await Promise.race([s.open(), new Promise((r) => setTimeout(() => r({ hung: true }), 120_000))]);
      rec.ms = Date.now() - t0;
      rec.hung = !!o.hung;
      rec.errors = o.errors ?? [];
      rec.layers = (o.layers ?? []).map((l) => ({ error: l.error, w: l.w, h: l.h }));
      rec.toasts = await s.frame.evaluate(() => (window.gisworkbench.toastLog ?? []).slice(-6).map((t) => `${t.kind}: ${t.message.slice(0, 200)}`)).catch(() => []);
      rec.console = s.logs.slice(0, 6);
      // Recovery: a good file opens after the damaged one (new project; a stuck worker is replaced).
      let recovered = false;
      if (!crashed) {
        await s.frame.evaluate(() => {
          const a = window.gisworkbench;
          a.dirty = false;
          for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
          a.desktop.addMultiport(a.newProject());
          a.importLog.length = 0;
        }).catch(() => {});
        await openFiles(s.frame, [GOOD]).catch(() => {});
        recovered = await settledAny(s.frame, 0, 120_000);
      }
      rec.crashed = crashed;
      rec.recovered = recovered;
      const raw = [...rec.errors, ...rec.layers.map((l) => l.error).filter(Boolean), ...rec.toasts].filter((m) => RAW.test(m));
      rec.raw = raw;
      save();
      expect(crashed, 'the page survives').toBe(false);
      expect(rec.hung, 'the open settles (or is refused) within 120 s').toBe(false);
      expect(rec.console.filter((l) => !/Failed to load resource/.test(l)), 'no console or page error').toEqual([]);
      expect(raw, 'damage is reported in words, not as a raw exception').toEqual([]);
      expect(recovered, 'a good file still opens afterwards').toBe(true);
    });
  }
}
