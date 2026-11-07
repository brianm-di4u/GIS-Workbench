// A test sidecar over real files too large to upload: picked in place (--test-pick, zero copy), jobs
// through /v1/jobs. Shared by the 26-plugindata spec and the runs behind docs/validation/2.6/plugindata.md.
import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const LINUX = process.platform === 'linux';

export async function openSidecar({ exe, modules, dataDir, port, picks }) {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const portFile = join(dataDir, 'port.txt');
  const args = ['--headless', '--data-dir', dataDir, '--modules-dir', modules, '--port', String(port), '--port-file', portFile, '--test-pair', `null=${token}`];
  for (const p of picks) args.push('--test-pick', p);
  const child = spawn(exe, args, { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  const base = `http://127.0.0.1:${port}`;
  const headers = { Origin: 'null', Authorization: `Bearer ${token}` };
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${t}`), { status: r.status, body: t });
    return t ? (t.trimStart().startsWith('{') || t.trimStart().startsWith('[') ? JSON.parse(t) : t) : null;
  };
  let caps = null;
  for (let i = 0; i < 1000; i++) {
    caps = await call('GET', '/v1/caps').catch(() => null);
    if (caps?.tools?.length) break;
    caps = null;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!caps) throw new Error('the test sidecar did not start');
  const files = (await call('POST', '/v1/pick', { mode: 'files' })).files;
  const stop = () => {
    try {
      if (LINUX) process.kill(-child.pid, 'SIGKILL');
      else execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
  };
  return { pid: child.pid, call, caps, files, stop, dataDir };
}

/** Largest resident memory of the tools under the sidecar, sampled until `done` is set. */
function sampler(pid) {
  let peak = 0;
  let stop = false;
  const tick = () => {
    if (stop) return;
    try {
      if (LINUX) {
        for (const d of readdirSync('/proc')) {
          if (!/^\d+$/.test(d)) continue;
          try {
            const s = readFileSync(`/proc/${d}/status`, 'utf8');
            if (/^Name:\s+(gdal|ogr)/m.test(s)) {
              const m = s.match(/^VmHWM:\s+(\d+) kB/m);
              if (m) peak = Math.max(peak, Number(m[1]) * 1024);
            }
          } catch {
            /* gone */
          }
        }
      }
    } catch {
      /* ignore */
    }
    timer = setTimeout(tick, 500);
  };
  let timer = setTimeout(tick, 200);
  return () => {
    stop = true;
    clearTimeout(timer);
    return peak;
  };
}

/** One job to the end: {state, seconds, outputs, error, result, path, log, peak_rss}. */
export async function runJob(sc, profile, inputs, options = {}, { timeoutMs = 4 * 3600_000 } = {}) {
  const t0 = Date.now();
  const end = sampler(sc.pid);
  let job;
  try {
    job = await sc.call('POST', '/v1/jobs', { profile, inputs, options, reason: 'plugindata' });
  } catch (e) {
    end();
    return { state: 'refused', status: e.status, error: e.body ?? e.message, seconds: 0 };
  }
  let s;
  for (;;) {
    await new Promise((r) => setTimeout(r, 400));
    s = await sc.call('GET', `/v1/jobs/${job.id}`).catch(() => null);
    if (s && ['succeeded', 'failed', 'cancelled'].includes(s.state)) break;
    if (Date.now() - t0 > timeoutMs) {
      await sc.call('DELETE', `/v1/jobs/${job.id}`).catch(() => {});
      end();
      return { state: 'timeout', seconds: (Date.now() - t0) / 1000, id: job.id };
    }
  }
  const peak_rss = end();
  const out = { state: s.state, id: job.id, seconds: Math.round((Date.now() - t0) / 100) / 10, outputs: s.outputs, error: s.error, result: s.result, peak_rss };
  const log = await sc.call('GET', `/v1/jobs/${job.id}/log`).catch(() => '');
  const peaks = [...(typeof log === 'string' ? log : JSON.stringify(log)).matchAll(/peak memory (\d+) MB/g)].map((m) => Number(m[1]));
  out.peak_mb = peaks.length ? Math.max(...peaks) : null;
  if (s.outputs?.[0]) out.path = join(sc.dataDir, 'outputs', job.id, s.outputs[0].name);
  return out;
}
export const exists = existsSync;

// ---- the oracle: tests/tools/plugindata_oracle.py, in its own environment. ----
export const DATA = process.env.GWB_PLUGINDATA ?? (LINUX ? '/mnt/d/gwb26/data-plugindata' : 'D:/gwb26/data-plugindata');
export const PY = process.env.GWB_PLUGINDATA_PY ?? (LINUX ? '/mnt/d/gwb26/envs/plugindata/python.exe' : 'D:/gwb26/envs/plugindata/python.exe');
const ORACLE = new URL('../../tools/plugindata_oracle.py', import.meta.url);
// In WSL the oracle may be a Windows Python: /mnt/d/x is D:/x to it, and the Linux disk a share.
const winPath = (p) => (PY.endsWith('.exe') && LINUX ? String(p).replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:/`).replace(/^\/home\//, '//wsl.localhost/Ubuntu/home/') : String(p));
export function oracle(cmd, ...args) {
  const file = decodeURIComponent(ORACLE.pathname).replace(/^\/([A-Za-z]:)/, '$1');
  const t = execFileSync(PY, ['-I', winPath(file), cmd, ...args.map(winPath)], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(t.trim().split('\n').pop());
}

/** The subdatasets GDAL reports, from a probe: [{n, name, desc, kind, group, field}]. */
export function subdatasets(probe) {
  const m = probe.result?.tools?.gdal?.metadata?.SUBDATASETS ?? {};
  const out = [];
  for (let n = 1; m[`SUBDATASET_${n}_NAME`]; n++) {
    const name = m[`SUBDATASET_${n}_NAME`];
    const e = name.match(/^HDF4_EOS:EOS_(GRID|SWATH(?:_GEOL)?):"?.*?"?:([^:]+):([^:]+)$/);
    const f = name.match(/^FITS:"?.*?"?:(\d+)$/);
    const s = name.match(/^HDF4_SDS:[^:]*:"?.*?"?:(\d+)$/);
    out.push({ n, name, desc: m[`SUBDATASET_${n}_DESC`], kind: e ? e[1] : f ? 'FITS' : s ? 'SDS' : 'other', group: e?.[2], field: e?.[3].replace(/^"|"$/g, ''), hdu: f ? Number(f[1]) : undefined, index: s ? Number(s[1]) : undefined });
  }
  return out;
}

/** Remove a job's outputs: the runs write tens of gigabytes. */
export async function dropOutputs(sc, job) {
  for (const o of job.outputs ?? []) await sc.call('DELETE', `/v1/files/${o.id}`).catch(() => {});
}

// ---- the cases: each returns its rows, each row with `problems` (empty when it passes). ----
const QUICK = !!process.env.GWB_PLUGINDATA_QUICK;
const fit = (list, n) => (QUICK && list.length > n ? [...list.slice(0, n - 1), list[list.length - 1]] : list);
const short = (s) => String(s ?? '').replace(/"[^"]*[\\/][^"]*"/g, 'FILE').slice(0, 200);

/** Every subdataset of an HDF4 / HDF-EOS file against pyhdf. */
export async function hdf4Case(sc, f, path) {
  const row = { file: f.name, size: f.size, problems: [], subs: [] };
  const t0 = Date.now();
  const pr = await runJob(sc, 'probe', [f.id]);
  const subs = subdatasets(pr);
  row.probe_seconds = (Date.now() - t0) / 1000;
  row.listed = subs.length;
  const l = oracle('hdf4-list', path);
  row.grids = Object.keys(l.grids);
  row.swaths = Object.keys(l.swaths);
  const fields = [...Object.values(l.grids).flat(), ...Object.values(l.swaths).flatMap((s) => s.data)];
  const twoD = fields.filter((n) => (l.sds[n]?.shape?.length ?? 2) >= 2);
  const got = new Set(subs.map((s) => s.field));
  row.not_listed = twoD.filter((n) => !got.has(n));
  if (row.not_listed.length) row.problems.push(`GDAL does not list ${row.not_listed.join(', ')}`);
  const seen = new Set();
  for (const s of fit(subs, 3)) {
    const j = await runJob(sc, 'raster-sds-cog', [f.id], { subdataset: s.n });
    const r = { n: s.n, field: s.field, desc: s.desc, state: j.state, seconds: j.seconds, peak_mb: j.peak_mb, peak_rss: j.peak_rss, output: j.outputs?.[0]?.size };
    if (j.state !== 'succeeded') {
      row.problems.push(`${s.field}: ${j.state} ${short(j.error)}`);
    } else {
      const c = oracle('hdf4-check', path, s.field ?? `#${s.index}`, j.path);
      r.check = c;
      if (!c.equal) row.problems.push(`${s.field}: pixels differ ${JSON.stringify([c.sds_shape, c.cog_shape, c.share_diff])}`);
      if (!c.nodata_ok) row.problems.push(`${s.field}: nodata ${c.fill_attr} / ${c.nodata_tif}`);
      if (!c.scale_ok) row.problems.push(`${s.field}: scale ${c.scale_attr} / ${c.scale_tif}`);
      const key = `${s.kind}:${s.group}:${c.cog_shape?.slice(1)}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (s.kind === 'GRID') {
          const g = oracle('modis-grid', path, j.path);
          r.georef = g;
          if (!g.origin_err || Math.max(...g.origin_err, ...g.pixel_err) > 1e-6) row.problems.push(`${s.group}: georeferencing ${JSON.stringify(g)}`.slice(0, 300));
          if (g.tile_ul_err && Math.max(...g.tile_ul_err) > 0.01) row.problems.push(`${s.group}: tile corner off by ${g.tile_ul_err}`);
          if (g.tile_from_name && String(g.tile_from_name) !== String(g.tile_from_grid)) row.problems.push(`${s.group}: tile ${g.tile_from_grid}, name ${g.tile_from_name}`);
        } else if (s.kind.startsWith('SWATH')) {
          const g = oracle('swath-gcp', path, s.field, j.path);
          r.georef = g;
          if (g.outside_image) row.problems.push(`${s.field}: ${g.outside_image} tie points outside the raster`);
          if (!g.gcp_crs_stored) row.problems.push(`${s.field}: the tie points have no CRS`);
          // Band 3B is ASTER's backward look: see plugindata.md. SWIR stays within half its 30 m pixel.
          const limit = s.field?.startsWith('ImageData') ? 15 : 1;
          if (s.field === 'ImageData3B') r.known_limit = `tie points ${Math.round(g.rms_m)} m from the product's dimension map`;
          else if (!(g.rms_m < limit)) row.problems.push(`${s.field}: tie points off the geolocation by ${g.rms_m} m`);
        }
      }
    }
    row.subs.push(r);
    await dropOutputs(sc, j);
  }
  return row;
}

/** A FITS file: the image, or its image HDUs, against astropy. */
export async function fitsCase(sc, f, path, { hdus = 3, keep = false } = {}) {
  const row = { file: f.name, size: f.size, problems: [], subs: [] };
  const pr = await runJob(sc, 'probe', [f.id]);
  row.profile = pr.result?.match?.profile;
  row.kinds = pr.result?.matches?.map((m) => m.kind);
  const l = oracle('fits-list', path);
  row.hdus = l.hdus.length;
  row.header = l.hdus.slice(0, 3);
  const subs = subdatasets(pr);
  row.listed = subs.length;
  const images = l.hdus.filter((h) => h.shape?.length >= 2);
  // Tables only: the file is a vector source, and the raster route refuses it by name.
  if (!images.length) {
    if (row.profile !== 'vector-gpkg') row.problems.push(`no image HDU, offered ${row.profile}`);
    return row;
  }
  if (subs.length && subs.length !== images.length) row.problems.push(`${subs.length} subdatasets listed, ${images.length} image HDUs`);
  // All of a few extensions; of the 84 of a Kepler frame, the first ones and the last.
  const some = hdus && subs.length > 12 ? [...subs.slice(0, hdus - 1), subs[subs.length - 1]] : subs;
  const todo = subs.length ? fit(some, 3) : [{ hdu: 1 }];
  for (const s of todo) {
    const single = !s.n;
    const j = single ? await runJob(sc, 'raster-cog', [f.id], {}) : await runJob(sc, 'raster-sds-cog', [f.id], { subdataset: s.n });
    const hdu = String(s.hdu - 1); // GDAL counts HDUs from 1, astropy from 0
    const r = { hdu: Number(hdu), desc: s.desc, state: j.state, seconds: j.seconds, peak_mb: j.peak_mb, peak_rss: j.peak_rss, output: j.outputs?.[0]?.size };
    if (j.state !== 'succeeded') {
      row.problems.push(`HDU ${hdu}: ${j.state} ${short(j.error)}`);
    } else {
      const c = oracle('fits-check', path, hdu, j.path);
      r.check = c;
      if (!c.equal) row.problems.push(`HDU ${hdu}: pixels differ, ${c.row_order} ${JSON.stringify([c.fits_shape, c.cog])}`);
      if (c.row_order === 'same') row.problems.push(`HDU ${hdu}: rows not turned top down`);
      if (c.physical_ok === false) row.problems.push(`HDU ${hdu}: BSCALE ${c.bscale}, BZERO ${c.bzero}, in the TIFF ${c.tif_scale}, ${c.tif_offset}`);
      if (c.blank != null && Number(c.nodata_tif) !== c.blank) row.problems.push(`HDU ${hdu}: BLANK ${c.blank}, nodata ${c.nodata_tif}`);
      if (l.hdus[Number(hdu)]?.ctype1 || l.hdus[hdu === '0' ? 1 : 0]?.ctype1) {
        const w = oracle('fits-wcs', path, hdu, j.path);
        r.wcs = { ctype: w.ctype, kept: w.wcs_keys_kept, tie: w.tif_tiepoints, corners: w.corners_astropy };
        if (w.wcs_keys_kept === false) row.problems.push(`HDU ${hdu}: WCS keywords not kept`);
      }
      if (keep) r.path = j.path;
    }
    row.subs.push(r);
    if (!keep) await dropOutputs(sc, j);
  }
  return row;
}

/** Damaged or mislabelled files: a clean, named refusal and nothing published. */
export async function badCase(sc, f) {
  const row = { file: f.name, size: f.size, problems: [], jobs: [] };
  const pr = await runJob(sc, 'probe', [f.id]);
  row.probe = pr.result?.match?.profile ?? null;
  const subs = subdatasets(pr);
  row.listed = subs.length;
  for (const [profile, options] of [['raster-cog', {}], ['raster-sds-cog', { subdataset: Math.max(1, subs.length) }]]) {
    const j = await runJob(sc, profile, [f.id], options);
    row.jobs.push({ profile, state: j.state, seconds: j.seconds, error: short(j.error) });
    if (j.state === 'succeeded') row.problems.push(`${profile} succeeded on a damaged file`);
    else if (!j.error || /No such file/.test(j.error)) row.problems.push(`${profile}: no useful message: ${short(j.error)}`);
    if (j.outputs?.length) row.problems.push(`${profile}: left an output`);
    await dropOutputs(sc, j);
  }
  return row;
}

/** A large real raster to KEA through a job, against the HDF5 arrays read with h5py, and back to a COG. */
export async function keaCase(sc, f, { compare, via } = {}) {
  const row = { file: f.name, size: f.size, problems: [] };
  const j = await runJob(sc, 'export-gdal', [f.id], { driver: 'KEA' });
  row.export = { state: j.state, seconds: j.seconds, peak_mb: j.peak_mb, peak_rss: j.peak_rss, output: j.outputs?.[0]?.size, error: short(j.error) };
  if (j.state !== 'succeeded') {
    row.problems.push(`to KEA: ${short(j.error)}`);
    return row;
  }
  // HDF5 will not open a file on a network share: `via` is a copy where the oracle can read it.
  if (via) copyFileSync(j.path, via);
  const c = oracle('kea-check', via ?? j.path, compare ?? f.path);
  row.h5py = c;
  if (!c.equal) row.problems.push(`KEA differs in ${c.different} of ${c.pixels} values`);
  return { row, j };
}

/** A large real raster to a TileDB array through a job; `array` is where the caller wants it unpacked. */
export async function tiledbExport(sc, f, array, options = {}) {
  const row = { file: f.name, size: f.size, problems: [] };
  const j = await runJob(sc, 'raster-tiledb', [f.id], options);
  row.export = { state: j.state, seconds: j.seconds, peak_mb: j.peak_mb, peak_rss: j.peak_rss, output: j.outputs?.[0]?.size, error: short(j.error) };
  if (j.state !== 'succeeded') {
    row.problems.push(`to TileDB: ${short(j.error)}`);
    return row;
  }
  row.unzip = oracle('unzip', j.path, array);
  await dropOutputs(sc, j);
  return row;
}
