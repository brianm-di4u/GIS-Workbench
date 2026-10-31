// Point-cloud worker (Appendix D §2.2): LAS/LAZ decoding by blocks and chunk runs (several
// workers decode one file in parallel, REQ-LDR-01), the LOD index, gridding, SMRF, profiles and
// LAS 1.4 export on the lazily loaded `pointcloud` bundle. Inputs arrive as typed arrays.

import { PointCloudBundle, sliceColumns } from '../../wasm/pointcloud.js';

const { GW } = self;
let pc = null;
async function bundle() {
  // WASM linear memory never shrinks: a module an earlier job grew past 384 MiB is replaced, so this
  // job starts small (TE 2.0.4: a LAZ export after a 220 MB LAS export of the same 7.3 M-point cloud
  // trapped at the 1 GiB cap). Jobs keep no state in the module between calls.
  if (pc && pc.x?.memory?.buffer?.byteLength > 384 * 2 ** 20) pc = null;
  if (!pc) {
    await GW.ensure('pointcloud');
    pc = new PointCloudBundle(GW.ctx.modules.pointcloud);
  }
  return pc;
}

GW.register('info', async ({ head }) => (await bundle()).info(head));
GW.register('evlrs', async ({ buf, start, count }) => (await bundle()).evlrs(buf, start, count));
GW.register('wkt', async ({ text }) => (await bundle()).wkt(text));
GW.register('lazChunks', async ({ vlr, table, n }) => (await bundle()).lazChunks(vlr, table, n));
GW.register('decodeLas', async ({ prm, raw }) => {
  const b = (await bundle()).decodeLas(prm, raw);
  return GW.transfer(b, [b.buffer]);
});
GW.register('decodeLazStream', async ({ prm, vlr, data, n }) => {
  const b = (await bundle()).decodeLazStream(prm, vlr, data, n);
  return GW.transfer(b, [b.buffer]);
});
GW.register('decodeLaz', async ({ prm, vlr, data, chunks }) => {
  const b = (await bundle()).decodeLaz(prm, vlr, data, chunks);
  return GW.transfer(b, [b.buffer]);
});
GW.register('index', async ({ pos, tile, s0, maxLevel }) => {
  const r = (await bundle()).index(pos, tile, s0, maxLevel);
  return GW.transfer(r, [r.perm.buffer]);
});
GW.register('grid', async ({ pos, mask, val, prm }) => {
  const g = (await bundle()).grid(pos, mask, val, prm);
  return GW.transfer(g, [g.buffer]);
});
GW.register('smrf', async ({ pos, mask, prm }) => {
  const c = (await bundle()).smrf(pos, mask, prm);
  return GW.transfer(c, [c.buffer]);
});
GW.register('profile', async ({ pos, mask, prm }) => {
  const r = (await bundle()).profile(pos, mask, prm);
  return GW.transfer(r, [r.index.buffer]);
});
// Clouds above SLAB points are written in slabs (a whole number of 50 000-point LAZ chunks), so the
// module never holds more than one slab: a 3DEP tile of 37 M points needs ~2 GB in one piece, past
// the 1 GiB worker memory (REQ-RUST-05; TE 2.0.4). The bytes equal the one-piece writer's.
const SLAB = 3_000_000;
GW.register('write', async ({ cols, n, rgb, inv, prm, text }, job) => {
  if (n <= SLAB) {
    const b = (await bundle()).write(cols, n, rgb, inv, prm, text);
    return GW.transfer(b, [b.buffer]);
  }
  const ranges = [];
  for (let a = 0; a < n; a += SLAB) ranges.push([a, Math.min(n, a + SLAB)]);
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (const [a, b] of ranges) {
    const r = (await bundle()).lasBounds(sliceColumns(cols, n, rgb, a, b), b - a, rgb, inv);
    for (let k = 0; k < 3; k++) {
      mn[k] = Math.min(mn[k], r[k]);
      mx[k] = Math.max(mx[k], r[3 + k]);
    }
    job.checkCancel();
  }
  const offset = mn.map((v) => Math.floor(v / 1000) * 1000);
  const parts = [];
  const entries = [];
  const byReturn = new Array(15).fill(0);
  let body = 0;
  for (const [i, [a, b]] of ranges.entries()) {
    const r = (await bundle()).lasSlab(sliceColumns(cols, n, rgb, a, b), b - a, rgb, inv, [...prm, ...offset]);
    parts.push(r.body.slice());
    entries.push(...r.entries);
    r.byReturn.forEach((v, k) => (byReturn[k] += v));
    body += r.body.length;
    job.progress((i + 1) / ranges.length);
    job.checkCancel();
  }
  const { head, table } = (await bundle()).lasHead([...prm, ...offset, ...mn, ...mx, n, body, ...byReturn], prm[8] ? entries : [], text);
  return new Blob([head, ...parts, table], { type: 'application/octet-stream' });
});
