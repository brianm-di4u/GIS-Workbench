#!/usr/bin/env node
// Scale test (SDP-2.1 §7.3 "Scale", §5 "a 10.7 GB MrSID mosaic must complete"): the Hamilton
// County 0.5 ft MrSID (tier U field data, 340 000 × 220 000 RGB) → COG through a sidecar, the
// input picked in the sidecar (zero copy). Writes progress and the result to <out>/scale.json.
//
//   node tests/e2e/sidecar/scale-hamilton.mjs [--compress JPEG] [--out E:/gwb-sidecar-deps/scale]
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const OUT = arg('--out', 'E:/gwb-sidecar-deps/scale');
const EXE = arg('--exe', join(OUT, 'gwb-sidecar.exe'));
const SID = arg('--sid', 'C:/GIS Workbench/Research/Additional Data Samples/Hamilton_2018_rgb_20x-002/Hamilton_2018_rgb_20x.sid');
const COMPRESS = arg('--compress', 'JPEG');
const PORT = Number(arg('--port', '47822'));
const token = randomBytes(32).toString('hex');
const data = join(OUT, 'data');
mkdirSync(data, { recursive: true });
const rep = { started: new Date().toISOString(), input: SID, input_bytes: statSync(SID).size, compress: COMPRESS, progress: [] };
const save = () => writeFileSync(join(OUT, 'scale.json'), JSON.stringify(rep, null, 2));

const child = spawn(EXE, ['--headless', '--data-dir', data, '--modules-dir', 'E:/gwb-sidecar-deps/bundle/modules', '--port', String(PORT), '--port-file', join(data, 'port.txt'), '--test-pair', `null=${token}`, '--test-pick', SID], { env: { ...process.env, GWB_SIDECAR_TEST: '1' }, stdio: 'ignore', detached: true });
child.unref();
rep.sidecar_pid = child.pid;
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: 'null', Authorization: `Bearer ${token}` };
const j = async (m, p, body) => {
  const r = await fetch(B + p, { method: m, headers: body ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};
for (let i = 0; i < 100; i++) {
  if (existsSync(join(data, 'port.txt'))) break;
  await new Promise((r) => setTimeout(r, 200));
}
for (let i = 0; i < 100; i++) {
  const c = await j('GET', '/v1/caps').catch(() => null);
  if (c?.vendor?.find((v) => v.id === 'vendor-mrsid')?.installed) break;
  await new Promise((r) => setTimeout(r, 300));
}
const pick = await j('POST', '/v1/pick', { mode: 'file' });
rep.pick = pick.files[0];
const job = await j('POST', '/v1/jobs', { profile: 'raster-cog', inputs: [pick.files[0].id], options: { compress: COMPRESS, quality: 85, blocksize: '512' }, reason: 'scale test: Hamilton 10.7 GB MrSID' });
rep.job = job.id;
save();
const t0 = Date.now();
for (;;) {
  await new Promise((r) => setTimeout(r, 30_000));
  const s = await j('GET', `/v1/jobs/${job.id}`).catch((e) => ({ state: 'unknown', error: e.message }));
  rep.progress.push({ t_s: Math.round((Date.now() - t0) / 1000), state: s.state, progress: s.progress });
  rep.last = s;
  save();
  if (['succeeded', 'failed', 'cancelled'].includes(s.state)) break;
}
rep.finished = new Date().toISOString();
rep.seconds = Math.round((Date.now() - t0) / 1000);
rep.token = token;
rep.port = PORT;
if (rep.last.outputs?.[0]) rep.output_bytes = rep.last.outputs[0].size;
save();
console.log(JSON.stringify({ state: rep.last.state, seconds: rep.seconds, output_bytes: rep.output_bytes, error: rep.last.error }));
