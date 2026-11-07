// Shared helpers of the sidecar spikes: a test sidecar, jobs over HTTP, the gw-te oracles.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { startSidecar, stopSidecar } from '../../tests/e2e/sidecar/harness.js';

export const TE = 'C:/GIS Workbench/TE-tools/mamba/envs/gw-te';
export const TE_BIN = `${TE}/Library/bin`;
export const CORPUS = 'C:/GIS Workbench/TE-corpus';
export const REPORTS = resolve('reports', 'sidecar');

export const teEnv = () => ({ ...process.env, PATH: `${TE_BIN};${TE};${process.env.PATH}`, GDAL_DATA: `${TE}/Library/share/gdal`, PROJ_DATA: `${TE}/Library/share/proj` });
export const te = (exe, args, opts = {}) => execFileSync(join(TE_BIN, exe), args, { encoding: 'utf8', env: teEnv(), maxBuffer: 1 << 30, ...opts });
/** Python from gw-te, isolated (-I), running a script given as text. */
export const tePy = (code, args = []) => execFileSync(join(TE, 'python.exe'), ['-I', '-c', code, ...args], { encoding: 'utf8', env: teEnv(), maxBuffer: 1 << 30 });

export async function withSidecar(name, fn, { port = 47823 } = {}) {
  const s = await startSidecar({ dataDir: resolve('test-results', `spike-${name}`), port });
  const H = { Origin: 'null', Authorization: `Bearer ${s.token}` };
  const api = async (m, p, body, raw = false) => {
    const isFile = body instanceof Uint8Array || Buffer.isBuffer(body);
    const r = await fetch(s.base + p, { method: m, headers: body && !isFile ? { ...H, 'Content-Type': 'application/json' } : H, body: body ? (isFile ? body : JSON.stringify(body)) : undefined });
    if (raw) return r;
    const t = await r.text();
    if (!r.ok) throw new Error(`${m} ${p}: ${r.status} ${t}`);
    return t ? JSON.parse(t) : null;
  };
  const upload = (path, group) => api('PUT', `/v1/files?name=${encodeURIComponent(basename(path))}${group ? `&group=${group}` : ''}`, readFileSync(path));
  const run = async (profile, inputs, options = {}) => {
    const j = await api('POST', '/v1/jobs', { profile, inputs, options });
    for (;;) {
      const s2 = await api('GET', `/v1/jobs/${j.id}`);
      if (['succeeded', 'failed', 'cancelled'].includes(s2.state)) return s2;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  /** Path of a published output on disk (for the independent readers). */
  const outPath = (job, i = 0) => join(s.dataDir, 'outputs', job.id, job.outputs[i].name);
  try {
    return await fn({ s, api, upload, run, outPath });
  } finally {
    stopSidecar(s.pid);
  }
}

export function report(name, obj) {
  mkdirSync(REPORTS, { recursive: true });
  writeFileSync(join(REPORTS, `${name}.json`), JSON.stringify({ at: new Date().toISOString(), ...obj }, null, 2));
}
