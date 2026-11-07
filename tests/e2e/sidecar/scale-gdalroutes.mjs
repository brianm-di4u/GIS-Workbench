#!/usr/bin/env node
// Scale runs for REQ-GAP-15, 17 and 28 (not part of the e2e suite): a synthetic very large scene, picked
// in the sidecar (zero copy), through raster-pansharpen and raster-reproject. Writes elapsed
// time, output size and the job's state to <out>/scale-gdalroutes.json. A window of the pan-sharpened
// output then goes to the Brovey oracle.
//
//   node tests/e2e/sidecar/scale-gdalroutes.mjs --exe <gwb-sidecar> --modules <modules> --out <dir> [--size 40000] [--only pansharpen,reproject]
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = arg('--out', 'D:/gwb26/data-gdalroutes/scale');
const EXE = arg('--exe');
const MODULES = arg('--modules', 'D:/gwb26/data-gdalroutes/bundle/modules');
const SIZE = Number(arg('--size', '40000'));
const ONLY = arg('--only', 'pansharpen,reproject').split(',');
const PORT = Number(arg('--port', '47829'));
const GDAL = arg('--gdal-bin', 'D:/gwb-sidecar-deps/conda-gdal/Library/bin');
const PY = arg('--python', 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe');
mkdirSync(OUT, { recursive: true });
const tool = (t, a) => execFileSync(join(GDAL, t), a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH: `${GDAL};${process.env.PATH}`, GDAL_DATA: join(GDAL, '..', 'share', 'gdal'), PROJ_DATA: join(GDAL, '..', 'share', 'proj') } });

const pan = join(OUT, `pan-${SIZE}.tif`);
const ms = join(OUT, `ms-${SIZE}.tif`);
const FX = resolve('fixtures', 'fx26', 'gdalroutes');
if (!existsSync(pan)) tool('gdal_translate', ['-q', '-outsize', String(SIZE), String(SIZE), '-r', 'bilinear', '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', '-co', 'BIGTIFF=YES', '-co', 'NUM_THREADS=ALL_CPUS', join(FX, 'pan.tif'), pan]);
if (!existsSync(ms)) tool('gdal_translate', ['-q', '-outsize', String(SIZE / 4), String(SIZE / 4), '-r', 'bilinear', '-co', 'TILED=YES', '-co', 'COMPRESS=DEFLATE', '-co', 'BIGTIFF=YES', '-co', 'NUM_THREADS=ALL_CPUS', '-co', 'PHOTOMETRIC=RGB', join(FX, 'ms.tif'), ms]);


const rep = { size: SIZE, started: new Date().toISOString(), pan_bytes: statSync(pan).size, ms_bytes: statSync(ms).size, runs: {} };
const save = () => writeFileSync(join(OUT, 'scale-gdalroutes.json'), JSON.stringify(rep, null, 2));
const token = randomBytes(32).toString('hex');
const data = join(OUT, 'data');
rmSync(data, { recursive: true, force: true });
mkdirSync(data, { recursive: true });
const child = spawn(EXE, ['--headless', '--data-dir', data, '--modules-dir', MODULES, '--port', String(PORT), '--port-file', join(data, 'port.txt'), '--test-pair', `null=${token}`, '--test-pick', pan, '--test-pick', ms, ...(existsSync(carto) ? ['--test-pick', carto] : [])], { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
child.unref();
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: 'null', Authorization: `Bearer ${token}` };
const j = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: body ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
for (let i = 0; i < 150; i++) {
  const c = await j('GET', '/v1/caps').catch(() => null);
  if (c?.tools?.length) break;
  await new Promise((r) => setTimeout(r, 300));
}
const picked = (await j('POST', '/v1/pick', { mode: 'files' })).files;
const [p, m] = [picked.find((f) => f.name.startsWith('pan')), picked.find((f) => f.name.startsWith('ms'))];
async function run(name, profile, inputs, options) {
  const t0 = Date.now();
  const job = await j('POST', '/v1/jobs', { profile, inputs, options, reason: `scale ${name}` });
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await j('GET', `/v1/jobs/${job.id}`).catch((e) => ({ state: 'unknown', error: e.message }));
    rep.runs[name] = { job: job.id, state: s.state, progress: s.progress, seconds: Math.round((Date.now() - t0) / 1000), error: s.error, outputs: s.outputs };
    save();
    if (['succeeded', 'failed', 'cancelled'].includes(s.state)) return s;
  }
}
try {
  if (ONLY.includes('pansharpen')) {
    const w = [0.25, 0.5, 0.25];
    const s = await run('pansharpen', 'raster-pansharpen', [p.id, m.id], { weights: w, resampling: 'nearest', compress: 'DEFLATE' });
    if (s.state === 'succeeded') {
      // A window of the output against the same window of the inputs.
      const dir = join(OUT, 'win');
      mkdirSync(dir, { recursive: true });
      const c = (Math.floor(SIZE / 8) * 4) | 0;
      const out = join(data, 'outputs', s.id, s.outputs[0].name);
      tool('gdal_translate', ['-q', '-srcwin', String(c), String(c), '2048', '2048', pan, join(dir, 'p.tif')]);
      tool('gdal_translate', ['-q', '-srcwin', String(c / 4), String(c / 4), '512', '512', ms, join(dir, 'm.tif')]);
      tool('gdal_translate', ['-q', '-srcwin', String(c), String(c), '2048', '2048', out, join(dir, 'o.tif')]);
      rep.runs.pansharpen.oracle = JSON.parse(execFileSync(PY, [resolve('tests', 'tools', 'gdalroutes_oracle.py'), 'brovey', join(dir, 'p.tif'), join(dir, 'm.tif'), join(dir, 'o.tif'), w.join(',')], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GDAL|PROJ)/.test(k))) }).trim().split('\n').pop());
      save();
    }
  }
  if (ONLY.includes('reproject')) await run('reproject', 'raster-reproject', [p.id], { t_srs: 'EPSG:4326', resampling: 'bilinear', compress: 'DEFLATE' });
} finally {
  rep.finished = new Date().toISOString();
  save();
  try {
    process.kill(child.pid);
  } catch {
    /* gone */
  }
}
console.log(JSON.stringify(rep.runs, null, 1));
