// TE-C51 multi-input functions (2.0.4 campaign): every pairing the corpus records (`pairs` in the
// source entries and coverage-tags.json) is opened together with the setup its role implies (a stereo
// pair, a DEM in use as terrain, both epochs), and every command of the role's family that the pair
// enables is run on it with the c50 engine. Supporting files (GCPs, checkpoints, MTD/MTL, spectral
// libraries, datum grids) answer the file pickers that ask for them.
//
//   TE_DIST=dist-cx/gis-workbench.html TE_RUN=cx-pairs [TE_ONLY=<regex>] [TE_FRESH=1]
//   npx playwright test -c playwright.campaign.config.js c51-pairs --project=chrome
import { test, expect } from '@playwright/test';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { manifest, item, paths, ASCII_CRS } from './helpers.js';
import { SKIP_EXT } from './cases.js';
import { session, crossCommands, excluded, heap, fingerprint, BAD, recordWriter, outDir, dlDirFor } from './cross-lib.js';
import { filePath } from '../../build/campaign/corpus-lib.mjs';

const RUN = process.env.TE_RUN ?? 'cx-pairs';
const OUT = outDir(RUN);
const ONLY = process.env.TE_ONLY ? new RegExp(process.env.TE_ONLY) : null;

// Role → which files are opened, how the session is set up, which command family is crossed.
//  open: 'both' (the item and its partners), 'self' (the item's own primaries), 'partners' (the
//  partners only; the item's files answer pickers).
const ROLES = {
  'stereo-mate': { open: 'both', n: 2, setup: ['stereo-pair'], cmds: /^(stereo|tri|align|model)\.|^dem\.extract$/ },
  'dem-under': { open: 'both', setup: ['terrain-dem'], cmds: /^(ortho|men|los|dem|profile|3d|glb)\.|^ext\.droptoground$|^img\.orthofly$|^hub\.(glb|usdz)$/ },
  'imagery-over': { open: 'both', setup: ['terrain-dem'], cmds: /^(pc\.colourise|3d\.|ortho\.|dem\.|hub\.(glb|usdz))/ },
  'pan-ms': { open: 'self', n: 4, cmds: /^enh\.pansharpen$/ },
  'pre-post': { open: 'both', n: 2, cmds: /^(chg|cmp|lay|align)\.|^hud\.flicker$|^msi\.change$|^img\.vmosaic$/ },
  'change-truth': { open: 'both', n: 2, cmds: /^(chg|cmp|lay)\.|^msi\.(change|accuracy)$/ },
  'repeat-pass': { open: 'both', n: 8, cmds: /^sar\./ },
  'co-register': { open: 'both', n: 8, cmds: /^sar\.|^align\.|^msi\.change$/ },
  'repeat-pass-incoherent': { open: 'both', n: 2, cmds: /^sar\./ },
  'lidar-epoch': { open: 'both', cmds: /^pc\./ },
  'dem-epoch': { open: 'both', setup: ['terrain-all'], cmds: /^dem\.|^los\./ },
  'dsm-truth': { open: 'both', n: 2, setup: ['terrain-all'], cmds: /^dem\.(diff|accuracy|compare)/ },
  'height-truth': { open: 'self', n: 3, setup: ['terrain-all'], cmds: /^dem\.|^men\./ },
  gcp: { open: 'partners', pickSelf: true, cmds: /^(model|align|tri|geo)\.|^dem\.accuracy$/ },
  checkpoints: { open: 'partners', pickSelf: true, setup: ['terrain-dem'], cmds: /^dem\.accuracy$|^(model|align|tri)\./ },
  'labels-detect': { open: 'both', cmds: /^(det|triage|lai)\./ },
  labels: { open: 'self', n: 2, cmds: /^(pc|msi)\./ },
  'labels-raster': { open: 'self', n: 2, cmds: /^msi\./ },
  'spectral-lib': { open: 'both', cmds: /^msi\.|^profile\.spectral$|^search\./ },
  calibration: { open: 'partners', pickSelf: true, cmds: /^msi\.(radiometric|thermal|toa|index)|^tri\.frame|^model\./ },
  'datum-grid': { open: 'partners', pickSelf: true, cmds: /^geo\./ },
  'vmti-video': { open: 'self', cmds: /^fmv\./ },
  'security-marked': { open: 'self', n: 6, cmds: /^(meta|prod|snap|chip)\.|^file\.print$/ },
  striped: { open: 'self', n: 3, cmds: /^(enh|msi)\./ },
};

const tags = JSON.parse(readFileSync(resolve('build/campaign/coverage-tags.json'), 'utf8'));
const has = (id) => manifest.items.some((x) => x.id === id);
// The first n primaries of an item, each with its sidecars (the set a user would select together).
function prims(it, n = 1) {
  const all = paths(it, ['primary', 'sidecar']);
  const base = (p) => p.split(/[\\/]/).pop();
  return it.files
    .filter((f) => (f.role ?? 'primary') === 'primary' && (!SKIP_EXT.test(f.name) || /\.gwt\.json$/i.test(f.name)))
    .slice(0, n)
    .flatMap((f) => {
      const stem = base(f.name).replace(/\.[^.]+$/, '');
      return [filePath(it, f), ...all.filter((p) => p !== filePath(it, f) && (base(p).startsWith(`${stem}.`) || base(p).startsWith(`${base(f.name)}.`)))];
    });
}

const pairCases = [];
for (const it of manifest.items) {
  for (const p of [...(it.pairs ?? []), ...(tags[it.id]?.pairs ?? [])]) {
    const role = ROLES[p.role];
    if (!role) continue;
    const partners = (p.with ?? []).filter(has).map(item);
    const self = prims(it, role.n ?? 1);
    const others = partners.flatMap((x) => prims(x, role.n ?? 1));
    const files = role.open === 'self' ? self : role.open === 'partners' ? others : [...self, ...others];
    const pick = role.pickSelf ? paths(it, ['primary', 'sidecar']) : [...self, ...others];
    if (!files.length) continue;
    const key = `${p.role}/${it.id}${partners.length ? `+${partners.map((x) => x.id).join('+')}` : ''}`;
    if (ONLY && !ONLY.test(key)) continue;
    if (pairCases.some((c) => c.key === key)) continue;
    pairCases.push({ key, role: p.role, spec: role, files, pick });
  }
}

// Role setup, in the page after the files open (and after each re-open).
async function roleSetup(frame, steps) {
  return frame.evaluate(async (steps) => {
    const app = window.gisworkbench;
    const done = [];
    const imgs = () => [...app.layers.values()].filter((l) => !l.error);
    const activate = (l) => l && app.store.transact('TE active layer', (tx) => tx.set(app.activePane().id, 'activeLayer', l.id));
    for (const s of steps) {
      try {
        if (s === 'terrain-dem') {
          // Every DEM-like layer in use as terrain; the first image that is not a DEM becomes active.
          const dems = imgs().filter((l) => l.kind === 'dem');
          for (const d of dems) await app.useAsTerrain(d, 'hae');
          activate(imgs().find((l) => l.kind !== 'dem'));
          done.push(`terrain ${dems.length}`);
        } else if (s === 'terrain-all') {
          for (const l of imgs()) await app.useAsTerrain(l, 'hae');
          done.push(`terrain-all ${imgs().length}`);
        } else if (s === 'stereo-pair') {
          const m = imgs().filter((l) => l.modelId);
          if (m.length >= 2) app.stereo.open(m[0], m[1]);
          done.push(`stereo ${m.length}`);
        }
      } catch (e) {
        done.push(`${s}: ${e.message}`);
      }
    }
    return done;
  }, steps);
}

test.describe.configure({ mode: 'parallel' });
for (const c of pairCases) {
  test(`TE-C51 ${c.key}`, async ({ page }, info) => {
    test.skip(!c.files.every(existsSync), 'not on disk');
    const rp = join(OUT, `c51-${info.project.name}-${c.key.replace(/[^\w.-]+/g, '_').slice(0, 180)}.json`);
    const prev = !process.env.TE_FRESH && existsSync(rp) ? JSON.parse(readFileSync(rp, 'utf8')) : null;
    test.skip(prev?.done === true, 'already recorded (TE_FRESH=1 reruns)');
    const bytes = c.files.reduce((t, p) => t + statSync(p).size, 0);
    const big = bytes > 200e6;
    test.setTimeout(big ? 4 * 3600_000 : 2 * 3600_000);
    mkdirSync(OUT, { recursive: true });
    const rec = prev ?? { spec: 'c51-pairs', project: info.project.name, key: c.key, role: c.role, files: c.files.map((p) => p.split(/[\\/]/).slice(-2).join('/')), bytes, cells: {} };
    rec.when = new Date().toISOString();
    rec.done = false;
    const save = recordWriter(rp, rec);
    const epsg = c.files.map((p) => ASCII_CRS[p.split(/[\\/]/).pop()]).find(Boolean) ?? null;
    const s = await session(page, { files: c.files, epsg, big, setupSteps: ['ai-mock', 'graphic'] });
    // Role setup runs after every (re-)open, before the baseline is taken.
    const open0 = s.open;
    s.open = async () => {
      const o = await open0();
      o.steps.push(...(await roleSetup(s.frame, c.spec.setup ?? [])));
      s.base = await fingerprint(s.frame);
      s.baseUndo = await s.frame.evaluate(() => window.gisworkbench.undo.undoStack.length);
      return o;
    };
    const o = await s.open();
    rec.open = { ms: o.ms, settled: o.ok, errors: o.errors, layers: o.layers, setup: o.steps, heapMB: await heap(s.cdp) };
    const en = await s.enabled();
    rec.applicable = en.filter((id) => c.spec.cmds.test(id) && !excluded(id));
    rec.notEnabled = await s.frame.evaluate((src) => [...window.gisworkbench.commands.map.keys()].filter((id) => new RegExp(src).test(id) && !window.gisworkbench.commands.enabled(id)), c.spec.cmds.source);
    save();
    await crossCommands(page, s, rec.applicable, rec, save, { wait0: big ? 600_000 : 180_000, pick: c.pick, dlDir: dlDirFor(RUN, info.project.name, info.workerIndex), fresh: !!process.env.TE_FRESH });
    rec.csp = await s.csp().catch(() => []);
    rec.done = !s.crashed;
    rec.crashed = s.crashed;
    save();
    expect(rec.open.errors, 'the pair opens').toEqual([]);
    expect(rec.applicable.length, `${c.role}: the pair enables some of its role's commands (not enabled: ${rec.notEnabled.slice(0, 12).join(', ')})`).toBeGreaterThan(0);
    const failed = Object.entries(rec.cells).filter(([, x]) => BAD.has(x.verdict));
    expect(failed.map(([id, x]) => `${id}: ${x.verdict} ${x.why ?? ''}`), `${c.key}: every enabled command runs cleanly`).toEqual([]);
  });
}
