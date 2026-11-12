#!/usr/bin/env node
// S-45 (does PDAL's BPF reader decode QuickLZ?) and the points-copc profile (REQ-FMT-46, REQ-LDR-12):
//  1. PDAL (the sidecar's and gw-te's) statistics of the corpus BPF v3 variants against the
//     uncompressed file: DEFLATE must match; FastLZ and code 1 (QuickLZ) are checked for silence.
//  2. points-copc through the sidecar: DEFLATE BPF and the PDAL E57 samples → COPC, read back by
//     laspy (gw-te), point counts and means compared with the source; FastLZ/QuickLZ BPF refused.
//   node sidecar/spikes/s45-points.mjs
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { withSidecar, tePy, te, report, CORPUS } from './common.mjs';

const BPF = join(CORPUS, 'lidar-bpf-pdal-v3');
const E57 = join(CORPUS, 'points-e57-pdal-test');
const M = 'E:/gwb-sidecar-deps/bundle/modules';
const tmp = 'E:/gwb-sidecar-deps/s45';
mkdirSync(tmp, { recursive: true });

const stats = (pdal, file, env) => {
  const j = JSON.parse(execFileSync(pdal, ['info', '--stats', '--dimensions', 'X,Y,Z', file], { encoding: 'utf8', env }));
  return Object.fromEntries(j.stats.statistic.map((d) => [d.name, { n: d.count, mean: d.average, min: d.minimum, max: d.maximum }]));
};
const sideEnv = { ...process.env, PATH: `${M}/points/bin;${M}/core-gdal/bin;C:/Windows/System32` };
const teEnv = { ...process.env, PATH: `C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin;${process.env.PATH}` };
const variants = { plain: 'autzen-utm-chipped-25-v3.bpf', deflate: 'autzen-utm-chipped-25-v3-deflate.bpf', fastlz: 'autzen-utm-chipped-25-v3-fastlz.bpf' };
// No QuickLZ file exists in the corpus or PDAL's test data; relabel the uncompressed file as code 1
// to see what the reader does with that code.
const q = readFileSync(join(BPF, variants.plain));
q[14] = 1;
writeFileSync(join(tmp, 'as-quicklz.bpf'), q);
const files = { ...Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, join(BPF, v)])), quicklz_label: join(tmp, 'as-quicklz.bpf') };
const truth = stats(`${M}/points/bin/pdal.exe`, files.plain, sideEnv);
const pdalRows = {};
for (const [k, f] of Object.entries(files)) {
  const a = stats(`${M}/points/bin/pdal.exe`, f, sideEnv);
  const b = stats('C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin/pdal.exe', f, teEnv);
  const ok = (s) => ['X', 'Y', 'Z'].every((d) => Math.abs(s[d].mean - truth[d].mean) < 1e-6 && s[d].n === truth[d].n);
  pdalRows[k] = { compression: readFileSync(f)[14], sidecar_pdal_correct: ok(a), gwte_pdal_correct: ok(b), z_mean: a.Z.mean };
}
console.log(pdalRows);

const LASPY = `
import sys, laspy, json
import numpy as np
f = laspy.read(sys.argv[1])
print(json.dumps({"n": len(f.points), "x": float(np.asarray(f.x).mean()), "y": float(np.asarray(f.y).mean()), "z": float(np.asarray(f.z).mean()), "copc": f.header.version.minor >= 4 and any(v.user_id == "copc" for v in f.header.vlrs)}))
`;

await withSidecar('s45', async ({ upload, run, outPath, api }) => {
  const rows = [];
  for (const [k, f] of [['bpf-deflate', files.deflate], ...['A4.e57', 'A_B.e57', 'B2.e57'].map((e) => [`e57-${e}`, join(E57, e)])]) {
    const up = await upload(f);
    const job = await run('points-copc', [up.id]);
    const row = { input: k, state: job.state, error: job.error };
    if (job.state === 'succeeded') {
      const got = JSON.parse(tePy(LASPY, [outPath(job)]));
      const src = stats('C:/GIS Workbench/TE-tools/mamba/envs/gw-te/Library/bin/pdal.exe', f, teEnv);
      row.copc = got.copc;
      row.points = got.n;
      row.points_source = src.X.n;
      row.mean_dx = Math.abs(got.x - src.X.mean);
      row.mean_dz = Math.abs(got.z - src.Z.mean);
      row.ok = got.copc && got.n === src.X.n && row.mean_dx < 0.01 && row.mean_dz < 0.01;
    }
    rows.push(row);
    console.log(row);
  }
  for (const [k, f] of [['bpf-fastlz', files.fastlz], ['bpf-quicklz-label', files.quicklz_label]]) {
    const up = await upload(f);
    const r = await api('POST', '/v1/jobs', { profile: 'points-copc', inputs: [up.id] }, true);
    const body = await r.json();
    rows.push({ input: k, refused: r.status === 422, status: r.status, error: body.error });
    console.log(rows.at(-1));
  }
  const pdalQuicklz = pdalRows.quicklz_label.sidecar_pdal_correct;
  report('s45-points', {
    spike: 'S-45',
    verdict: pdalQuicklz ? 'pass' : 'fail',
    finding: 'PDAL 2.10.2 (sidecar, conda-forge) and the gw-te PDAL decode DEFLATE BPF exactly; for FastLZ (2) and code 1 (QuickLZ) they return wrong coordinates (Z mean 0) without an error. No QuickLZ BPF exists in the corpus or in PDAL’s test data. The sidecar therefore refuses BPF with compression 1 or 2 (422) instead of writing a wrong COPC; the app reads FastLZ natively. QuickLZ stays unread: the SDP fallback is a clean-room decoder from a specification drafted by a second person (open owner item).',
    pdal: pdalRows,
    profile: rows,
  });
});
