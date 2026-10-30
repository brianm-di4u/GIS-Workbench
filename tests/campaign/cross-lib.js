// Shared engine of the 2.0.4 cross campaign (c50 every file × every command it enables; c51 every corpus
// pairing × the commands the pair enables): open a set of files in a session, list the commands the app
// enables for them, run each with outcome, timing, worker-job, heap and download checks, and reset to
// the opened state between commands (re-opening when a command removed what was opened).
import { existsSync, statSync, writeFileSync, renameSync, rmSync, openSync, readSync, closeSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openApp, openFiles, settledAny, runCommand, LEGACY_PREFS } from './helpers.js';
import { setup } from './matrix-runner.js';
import { REPO } from '../../build/campaign/corpus-lib.mjs';
import { isRefusal } from '../../build/campaign/verdict.mjs';

// Never run in the cross, with where each is covered: live services (c18), hardware and browser-window
// APIs, and commands that only open UI with no data dependence (themes, help, docks: the GUI sweeps).
export const EXCLUDE = [
  [/^(online|bg|bm|cat|net)\.|^vec\.remote|^file\.openurl$|^pc\.stream$|^3d\.(tiles|qmesh)$|^hub\.relay$/, 'network service (c18)'],
  [/^stereo\.xr$|^input\.|^win\.separate$|^stereo\.mode\.dual$/, 'hardware or a second browser window (e2e)'],
  [/^(theme|help|keys|ui|ribbon|dock|panel|packs|pack|qat\.customize)\./, 'UI only, no data (GUI sweeps)'],
];
export const excluded = (id) => EXCLUDE.find(([re]) => re.test(id))?.[1] ?? null;
// Recorders capture the clip or view in real time: they get the clip's length (capped at 20 min).
export const REALTIME = /^(fmv\.export|cmp\.record|3d\.record|prod\.gif|prod\.mediapptx)$/;
export const BAD = new Set(['fail', 'timeout', 'crash']);

// File signatures for downloads: an output must be the type its name claims.
const MAGIC = [
  [/\.(tif|tiff)$/i, (b) => /^(II\*\0|MM\0\*|II\+\0|MM\0\+)/.test(b.toString('latin1', 0, 4))],
  [/\.(ntf|nitf|nsf)$/i, (b) => /^(NITF|NSIF)/.test(b.toString('latin1', 0, 4))],
  [/\.png$/i, (b) => b.toString('latin1', 1, 4) === 'PNG'],
  [/\.jpe?g$/i, (b) => b[0] === 0xff && b[1] === 0xd8],
  [/\.(zip|kmz|gwpack|3tz|docx|pptx|potx|atak|usdz)$/i, (b) => b.toString('latin1', 0, 2) === 'PK'],
  [/\.(las|laz)$/i, (b) => b.toString('latin1', 0, 4) === 'LASF'],
  [/\.gpkg$/i, (b) => b.toString('latin1', 0, 15) === 'SQLite format 3'],
  [/\.pdf$/i, (b) => b.toString('latin1', 0, 5) === '%PDF-'],
  [/\.(geojson|json|gwb)$/i, (b) => /^\s*[[{]/.test(b.toString('utf8', 0, 64).replace(/^﻿/, ''))],
  [/\.(kml|gpx|svg|xml|cot|html?)$/i, (b) => /^\s*</.test(b.toString('utf8', 0, 64).replace(/^﻿/, ''))],
  [/\.glb$/i, (b) => b.toString('latin1', 0, 4) === 'glTF'],
  [/\.webm$/i, (b) => b.readUInt32BE(0) === 0x1a45dfa3],
  [/\.mp4$/i, (b) => b.toString('latin1', 4, 8) === 'ftyp'],
  [/\.gif$/i, (b) => b.toString('latin1', 0, 3) === 'GIF'],
  [/\.dt[0-2]$/i, (b) => b.toString('latin1', 0, 3) === 'UHL'],
  [/\.psd$/i, (b) => b.toString('latin1', 0, 4) === '8BPS'],
];
export function checkDownload(p) {
  const name = p.split(/[\\/]/).pop();
  if (!existsSync(p)) return { name, ok: false, why: 'not saved' };
  const bytes = statSync(p).size;
  if (!bytes) return { name, bytes, ok: false, why: 'empty' };
  const fd = openSync(p, 'r');
  const b = Buffer.alloc(Math.min(64, bytes));
  readSync(fd, b, 0, b.length, 0);
  closeSync(fd);
  const m = MAGIC.find(([re]) => re.test(name));
  const ok = !m || m[1](b);
  return { name, bytes, ok, ...(ok ? {} : { why: `not a ${name.split('.').pop()} file (starts ${JSON.stringify(b.toString('latin1', 0, 8))})` }) };
}

// What a command may change and the reset must restore. Layers by name (ids change on re-open).
export const fingerprint = (frame) =>
  frame.evaluate(() => {
    const a = window.gisworkbench;
    const mp = a.activeMp();
    return {
      layers: [...a.layers.values()].map((l) => l.rec?.name ?? l.kind).sort().join(','),
      clouds: a.store.all('pointcloud').length,
      vlayers: a.store.all('vlayer').length,
      clips: a.fmv?.clips?.size ?? 0,
      mps: a.desktop?.multiports?.length ?? 1,
      layout: mp?.layout ?? null,
      panes: mp?.panes?.length ?? 0,
    };
  });

export async function heap(cdp) {
  const m = await cdp.send('Performance.getMetrics').catch(() => null);
  return m ? Math.round(m.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1048576) : null;
}

/**
 * A session on one set of files. `setupSteps` are matrix-runner setup steps run after each open
 * (e.g. a ground graphic and a selected feature, or a stereo pair and terrain).
 */
export async function session(page, { files, epsg = null, big = false, setupSteps = ['ai-mock', 'graphic', 'select-feature'], pre = [] }) {
  // Offline (the first-run choice a user can make, OD-2.3): online sources are c18's; here any request is a defect.
  const { frame, logs, requests, csp } = await openApp(page, 'file', { prefs: { ...LEGACY_PREFS, network: 'offline' } });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const s = { frame, logs, requests, csp, cdp, crashed: null };
  page.on('crash', () => (s.crashed = 'page crashed'));
  // The empty app's enabled set: commands enabled without data are not data-dependent.
  s.empty = new Set(await frame.evaluate(() => [...window.gisworkbench.commands.map.keys()].filter((c) => window.gisworkbench.commands.enabled(c))));
  s.open = async () => {
    await frame.evaluate((e) => {
      const a = window.gisworkbench;
      Object.assign(a, { zipPick: 'default', asciiPick: e ? { epsg: e } : 'default', relinkPick: 'skip' });
      a.runMode.caps.fsaSave = false;
      a.runMode.caps.fsaPicker = false;
      a.__test = { ...(a.__test ?? {}), noPrint: true };
      // Every toast as rendered (kind after the app's own step-first downgrade), including ones the
      // 3-slot snackbar has dismissed before the harness looks.
      if (!window.__teToasts) {
        window.__teToasts = [];
        new MutationObserver((ms) => {
          for (const m of ms) for (const n of m.addedNodes) if (n.classList?.contains('toast')) window.__teToasts.push(`${[...n.classList].find((c) => c.startsWith('toast-'))}: ${n.textContent}`);
        }).observe(document.body, { childList: true, subtree: true });
      }
    }, epsg);
    const t0 = Date.now();
    const log = await openFiles(frame, files);
    const errors = log.flatMap((r) => r.errors ?? []);
    const ok = errors.length ? false : await settledAny(frame, 0, big ? 840_000 : 120_000);
    const ms = Date.now() - t0;
    const layers = await frame.evaluate(() => [...window.gisworkbench.layers.values()].map((l) => ({ name: l.rec?.name ?? null, error: l.error ?? null, kind: l.kind, w: l.width, h: l.height, bands: l.bands, sar: !!l.info?.sar, model: l.modelName ?? null })));
    const steps = await setup(frame, setupSteps);
    for (const pid of pre) {
      const pr = await runCommand(page, frame, pid, { logs: [], pick: [], wait: 120_000, settle: 120_000 });
      steps.push(`${pid}: ${pr.outcome}${pr.errors?.length ? ` (${pr.errors.join('; ')})` : ''}`);
    }
    s.base = await fingerprint(frame);
    s.baseUndo = await frame.evaluate(() => window.gisworkbench.undo.undoStack.length);
    return { ms, ok, errors, warnings: log.flatMap((r) => r.warnings ?? []), layers, steps };
  };
  s.reopen = async () => {
    await frame.evaluate(async () => {
      const a = window.gisworkbench;
      a.dirty = false;
      a.tools?.select?.(null);
      for (const mp of [...a.desktop.multiports]) a.desktop.removeMultiport(mp);
      a.desktop.addMultiport(a.newProject());
      a.importLog.length = 0;
      a.emit('layers');
    });
    return s.open();
  };
  s.enabled = async () => {
    const all = await frame.evaluate(() => [...window.gisworkbench.commands.map.keys()].filter((c) => window.gisworkbench.commands.enabled(c)));
    return all.filter((c) => !s.empty.has(c));
  };
  return s;
}

/** Drive a slider, option list or text command the ribbon feeds through setValue / an argument. */
async function exercise(frame, id, r) {
  const sv = await frame
    .evaluate(async (c) => {
      const a = window.gisworkbench;
      const cmd = a.commands.map.get(c);
      if (!cmd?.setValue) return null;
      const t0 = window.__teToasts?.length ?? 0;
      try {
        // Disabled options are not offered to the user (e.g. β⁰ without SICD radiometry).
        const opts = (cmd.options?.() ?? []).filter((o) => !o.disabled);
        const v0 = cmd.value?.();
        if (opts.length) for (const o of opts) await cmd.setValue(o.value);
        else if (typeof v0 === 'number') await cmd.setValue(v0 === 0 ? 10 : v0 * 1.2);
        else if (typeof v0 === 'boolean') await cmd.setValue(!v0);
        await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
        return { set: opts.length || 1, toasts: (window.__teToasts ?? []).slice(t0) };
      } catch (e) {
        return { error: String(e?.message ?? e) };
      }
    }, id)
    .catch((e) => ({ error: String(e.message).split('\n')[0] }));
  if (sv) {
    r.setValue = { set: sv.set, error: sv.error };
    if (sv.error) r.errors.push(`setValue: ${sv.error}`);
    else {
      r.changed.push('setValue');
      r.errors.push(...sv.toasts.filter((t) => t.startsWith('toast-error')));
    }
  }
  // Jump To takes text: the centre of the image as "lat, lon".
  if (id === 'nav.jumpbox') {
    const j = await frame.evaluate(async () => {
      const a = window.gisworkbench;
      const l = a.activePane()?.geoLayer();
      const g = l?.groundAt?.(l.width / 2, l.height / 2);
      if (!g) return false;
      await a.commands.run('nav.jumpbox', `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`);
      return true;
    });
    if (j) r.changed.push('jump');
  }
}

/**
 * Run each command on the session's files, recording a cell per command in rec.cells, saving after each.
 * `pick` answers file pickers (c50 cancels them; c51 gives the pair's supporting files).
 */
export async function crossCommands(page, s, ids, rec, save, { wait0 = 60_000, pick = [], dlDir, fresh = false }) {
  mkdirSync(dlDir, { recursive: true });
  const { frame, logs, requests, cdp } = s;
  for (const id of ids) {
    const wait = REALTIME.test(id) ? 1_200_000 : wait0;
    if (rec.cells[id] && rec.cells[id].verdict !== 'crash' && !fresh) continue;
    if (s.crashed) {
      rec.cells[id] = { verdict: 'crash', why: s.crashed };
      continue;
    }
    const logStart = logs.length;
    const reqStart = requests.length;
    const jobStart = await frame.evaluate(() => window.gisworkbench.pool?.history?.[0]?.id ?? null).catch(() => null);
    const t0 = Date.now();
    let r;
    try {
      r = await runCommand(page, frame, id, { logs, pick, wait, settle: wait, outDir: dlDir });
      // Enabled when listed but disabled now: the reset after an earlier command did not restore what
      // it needs. Re-open and run it once more.
      if (r.outcome === 'disabled') {
        const o3 = await s.reopen();
        rec.resets = [...(rec.resets ?? []), { before: id, ok: o3.ok }];
        r = await runCommand(page, frame, id, { logs, pick, wait, settle: wait, outDir: dlDir });
        r.retried = true;
      }
      if (r.outcome !== 'error') await exercise(frame, id, r);
    } catch (e) {
      s.crashed = s.crashed ?? String(e.message).split('\n')[0];
      rec.cells[id] = { verdict: 'crash', why: s.crashed, ms: Date.now() - t0 };
      save();
      continue;
    }
    r.errors.push(...logs.slice(logStart).filter((l) => !r.errors.includes(l)));
    if (r.errors.length) r.outcome = 'error';
    const ms = Date.now() - t0;
    const jobs = await frame
      .evaluate((j0) => {
        const h = window.gisworkbench.pool?.history ?? [];
        const i = j0 === null ? h.length : h.findIndex((x) => x.id === j0);
        return h.slice(0, i < 0 ? h.length : i).map((x) => ({ op: x.op, state: x.state, ms: x.ms, ...(x.error ? { error: String(x.error).slice(0, 300) } : {}), ...(x.trapped ? { trapped: true } : {}) }));
      }, jobStart)
      .catch(() => []);
    const downloads = r.downloads.map(checkDownload);
    for (const p of r.downloads) rmSync(p, { force: true });
    const net = requests.slice(reqStart);
    // Chrome cancels in-memory downloads over ~500 MB; the harness turns the save dialog off, so such a
    // file can only be judged by the app's own size warning (CX-H09). Real Chrome/Edge stream it to disk.
    const overLimit = r.toasts.some((t) => /the browser may cancel a download this large/.test(t));
    for (const d of downloads) if (!d.ok && d.why === 'not saved' && overLimit) Object.assign(d, { ok: true, why: 'over the browser download limit (app warned; saved through the file dialog in real use)' });
    const badDl = downloads.filter((d) => !d.ok);
    const jobErr = jobs.filter((j) => j.error && !/cancel/i.test(j.error));
    let verdict = 'pass';
    let why = null;
    // A named refusal (an error toast in words, no console error or page error) is listed for review
    // as 'refused'; anything that reads like a JavaScript exception is a failure.
    const refusalOnly = isRefusal(r.errors);
    if (refusalOnly) (verdict = 'refused'), (why = r.errors.join(' | ').slice(0, 600));
    else if (r.outcome === 'error' || r.errors.length) (verdict = 'fail'), (why = r.errors.join(' | ').slice(0, 600));
    else if (jobErr.length) (verdict = 'fail'), (why = `worker job failed: ${jobErr.map((j) => `${j.op}: ${j.error}`).join(' | ')}`);
    else if (badDl.length) (verdict = 'fail'), (why = `bad download: ${badDl.map((d) => `${d.name} ${d.why}`).join('; ')}`);
    else if (net.length) (verdict = 'fail'), (why = `unrequested network: ${net.slice(0, 3).join(' ')}`);
    else if (r.outcome === 'pending') (verdict = 'timeout'), (why = `still running after ${wait / 1000} s`);
    else if (r.outcome === 'disabled') verdict = 'skip-state';
    else if (!r.changed.length && !r.dialogs.length && !downloads.length && !r.toasts.length) verdict = 'silent';
    rec.cells[id] = { verdict, ...(why ? { why } : {}), ...(r.retried ? { retried: true } : {}), outcome: r.outcome, ms, dialogs: r.dialogs, toasts: r.toasts.slice(0, 6), changed: r.changed, ...(r.setValue ? { setValue: r.setValue } : {}), downloads, jobs: jobs.slice(0, 12), console: logs.slice(logStart).slice(0, 4), heapMB: await heap(cdp) };

    // Reset: drop the tool, undo to the opened depth, close extra windows; restore the 1×1 layout;
    // re-open when what was opened is gone.
    try {
      await frame.evaluate(async (u) => {
        const a = window.gisworkbench;
        a.tools?.select?.(null);
        while (a.undo.undoStack.length > u) a.undo.undo();
        const m = a.activeMp();
        if (m?.layout !== '1x1') m?.setLayout?.('1x1');
      }, s.baseUndo);
      for (const extra of page.context().pages().filter((p) => p !== page)) await extra.close().catch(() => {});
      const now = await fingerprint(frame);
      if (JSON.stringify(now) !== JSON.stringify(s.base)) {
        rec.cells[id].reopened = Object.keys(s.base).filter((k) => s.base[k] !== now[k]).map((k) => `${k}: ${s.base[k]} → ${now[k]}`).join('; ').slice(0, 300);
        const o2 = await s.reopen();
        if (!o2.ok && !o2.layers.length) s.crashed = `re-open failed after ${id}: ${o2.errors.join(' ')}`;
      }
    } catch (e) {
      s.crashed = s.crashed ?? `reset after ${id}: ${String(e.message).split('\n')[0]}`;
    }
    save();
    // A download that lands after its cell ended (a streamed COG of a large image) is saved under the
    // next command's name and was never removed: 76 GB filled the C: drive (CX-H14). Every file here
    // has been judged or belongs to a cell already recorded, so the folder is emptied after each cell.
    for (const f of readdirSync(dlDir)) {
      try {
        rmSync(join(dlDir, f), { force: true, recursive: true });
      } catch {
        /* still being written: the next sweep takes it */
      }
    }
  }
}

// Written to a temporary file and renamed, so triage can read records while a run is writing them.
export const recordWriter = (path, rec) => () => {
  writeFileSync(`${path}.tmp`, JSON.stringify(rec, null, 1));
  renameSync(`${path}.tmp`, path);
};
export const outDir = (run) => join(REPO, 'reports/campaign/results', run);
// One folder per worker process: c50 and c51 can share a run name and worker index, and the sweep
// after each cell would empty the other's folder (CX-H16).
export const dlDirFor = (run, project, worker) => join(REPO, 'reports/campaign/out', `${run}-dl`, project, `${worker}-${process.pid}`);
