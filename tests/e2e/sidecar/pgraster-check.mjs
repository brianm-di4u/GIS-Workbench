#!/usr/bin/env node
// REQ-GAP-72, PostGIS raster (not part of the e2e suite). The route is gated off in every shipped
// build (OD-2.17), so this is the only place it runs: a real PostgreSQL with PostGIS on 127.0.0.1:55432
// (conda-forge has no win-64 postgis, so a test-only server in WSL, reached through its loopback
// forwarding), holding fixture pan.tif as table pan, loaded by raster2pgsql; and a test sidecar with
// --test-allow-database. The job's COG must equal the fixture pixel for pixel.
//
//   node tests/e2e/sidecar/pgraster-check.mjs --exe <gwb-sidecar> --modules <modules> [--forward-to <WSL address>]
// --forward-to relays 127.0.0.1:<--local-port> to the server when WSL does not forward loopback itself.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, connect } from 'node:net';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const EXE = arg('--exe');
const MODULES = arg('--modules', 'D:/gwb26/data-gdalroutes/bundle/modules');
const WORK = arg('--work', 'D:/gwb26/data-gdalroutes/pgcheck');
const PY = arg('--python', 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te/python.exe');
const PORT = 55432;
const SC = 47828;
const LOCAL = Number(arg('--local-port', PORT));
const fixture = resolve('fixtures', 'fx26', 'gdalroutes', 'pan.tif');

const target = arg('--forward-to');
const relay = target
  ? await new Promise((res) => {
      const srv = createServer((c) => {
        const s = connect(PORT, target);
        c.pipe(s).pipe(c);
        c.on('error', () => s.destroy());
        s.on('error', () => c.destroy());
      });
      srv.listen(LOCAL, '127.0.0.1', () => res(srv));
    })
  : null;
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
let child = null;
let code = 1;
try {
  const token = randomBytes(32).toString('hex');
  const sd = join(WORK, 'sc');
  mkdirSync(sd, { recursive: true });
  child = spawn(EXE, ['--headless', '--data-dir', sd, '--modules-dir', MODULES, '--port', String(SC), '--port-file', join(sd, 'port.txt'), '--test-pair', `null=${token}`, '--test-allow-database'], { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, stdio: 'ignore', detached: true, windowsHide: true });
  child.unref();
  const B = `http://127.0.0.1:${SC}`;
  const H = { Origin: 'null', Authorization: `Bearer ${token}` };
  const j = async (m, p, body) => {
    const r = await fetch(B + p, { method: m, headers: body ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  let caps = null;
  for (let i = 0; i < 150; i++) {
    caps = await j('GET', '/v1/caps').catch(() => null);
    if (caps?.tools?.length) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('drivers', caps.raster_drivers.length, caps.raster_drivers.filter((d) => /postgis|PDF|KEA|FITS/i.test(d.name)).map((d) => d.name), 'profile available', caps.profiles.find((p) => p.id === 'pgraster-cog').available);
  const job = await j('POST', '/v1/jobs', { profile: 'pgraster-cog', inputs: [], options: { port: LOCAL, dbname: 'gis', user: 'gwb', table: 'pan' }, output_name: 'pan' });
  let s;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    s = await j('GET', `/v1/jobs/${job.id}`);
    if (['succeeded', 'failed', 'cancelled'].includes(s.state)) break;
  }
  console.log(s.state, s.error ?? '', s.outputs?.[0]?.name);
  if (s.state === 'succeeded') {
    const out = join(sd, 'outputs', s.id, s.outputs[0].name);
    const py = `import numpy as np\nfrom osgeo import gdal\ngdal.UseExceptions()\na=gdal.Open(r"${fixture}").ReadAsArray();d=gdal.Open(r"${out}");b=d.ReadAsArray()\nprint({"shape":a.shape,"equal":bool(np.array_equal(a,b)),"gt_src":gdal.Open(r"${fixture}").GetGeoTransform(),"gt_out":d.GetGeoTransform()})`;
    console.log(execFileSync(PY, ['-c', py], { encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GDAL|PROJ)/.test(k))) }));
    code = 0;
  }
} finally {
  relay?.close();
  if (child) {
    try {
      process.kill(child.pid);
    } catch {
      /* gone */
    }
  }
}
process.exit(code);
