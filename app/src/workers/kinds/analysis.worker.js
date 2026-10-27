// Analysis worker (Appendix D §2.2): photogrammetric jobs on the lazily loaded `photo` bundle
// (block adjustment, RPC fitting, Harris corners and window matching). Inputs arrive as typed
// arrays; nothing here touches files.

import { Photo } from '../../wasm/photo.js';
import { Raster } from '../../wasm/raster.js';
import { TerrainBundle } from '../../wasm/terrain.js';
import { VectorBundle } from '../../wasm/vector.js';
import { SarBundle } from '../../wasm/sar.js';
import { SpectralBundle } from '../../wasm/spectral.js';
import { gpuDsmTile } from '../../analysis/gpu-sgm.js';

const { GW } = self;
let photo = null;
async function bundle() {
  if (!photo) {
    await GW.ensure('photo');
    photo = new Photo(GW.ctx.modules.photo);
  }
  return photo;
}

let raster = null;
async function rasterBundle() {
  if (!raster) {
    await GW.ensure('raster');
    raster = new Raster(GW.ctx.modules.raster);
  }
  return raster;
}
let terrain = null;
async function terrainBundle() {
  if (!terrain) {
    await GW.ensure('terrain');
    terrain = new TerrainBundle(GW.ctx.modules.terrain);
  }
  return terrain;
}
let vector = null;
async function vectorBundle() {
  if (!vector) {
    await GW.ensure('vector');
    vector = new VectorBundle(GW.ctx.modules.vector);
  }
  return vector;
}
let sar = null;
async function sarBundle() {
  if (!sar) {
    await GW.ensure('sar');
    sar = new SarBundle(GW.ctx.modules.sar);
  }
  return sar;
}
let spectral = null;
async function spectralBundle() {
  if (!spectral) {
    await GW.ensure('spectral');
    spectral = new SpectralBundle(GW.ctx.modules.spectral);
  }
  return spectral;
}
// Spectral (REQ-MSI-05..14, 16, REQ-EXT-28): one entry point, `op` names the wrapper method.
const SPEC_OPS = new Set(['stats', 'train', 'classify', 'kmeans', 'isodata', 'post', 'accuracy', 'detect', 'transform', 'correct', 'elm', 'bt', 'resample', 'template']);
GW.register('spectral', async ({ op, args }) => {
  if (!SPEC_OPS.has(op)) throw new Error(`unknown spectral operation ${op}`);
  const b = await spectralBundle();
  const r = b[op](...args);
  // Typed arrays back as transferables.
  const tr = [];
  const walk = (o) => {
    if (o && typeof o === 'object') {
      if (ArrayBuffer.isView(o)) tr.push(o.buffer);
      else Object.values(o).forEach(walk);
    }
  };
  walk(r);
  return GW.transfer({ r }, [...new Set(tr)]);
});
// SAR (REQ-SAR-07..11, 13, 14): inputs are detected intensity or complex AOI chips.
GW.register('sar.speckle', async ({ kind, v, w, h, opts }) => {
  const o = (await sarBundle()).speckle(kind, v, w, h, opts);
  return GW.transfer({ v: o }, [o.buffer]);
});
GW.register('sar.logratio', async ({ i1, i2, w, h, win }) => {
  const o = (await sarBundle()).logRatio(i1, i2, w, h, win);
  return GW.transfer({ v: o }, [o.buffer]);
});
GW.register('sar.ccd', async ({ f, g, w, h, opts }) => {
  const r = (await sarBundle()).ccd(f, g, w, h, opts);
  const out = { ...r, gamma: r.gamma.slice(), phase: r.phase.slice(), i1: r.i1.slice(), i2: r.i2.slice() };
  return GW.transfer(out, [out.gamma.buffer, out.phase.buffer, out.i1.buffer, out.i2.buffer]);
});
GW.register('sar.subaperture', async ({ z, w, h, opts }) => {
  const o = (await sarBundle()).subaperture(z, w, h, opts);
  return GW.transfer({ v: o }, [o.buffer]);
});
GW.register('sar.csi', async ({ z, w, h, opts }) => {
  const o = (await sarBundle()).csi(z, w, h, opts);
  return GW.transfer({ v: o }, [o.buffer]);
});
GW.register('sar.pauli', async ({ hh, hv, vv }) => {
  const o = (await sarBundle()).pauli(hh, hv, vv);
  return GW.transfer({ v: o }, [o.buffer]);
});
GW.register('sar.pairs', async ({ collects, limits }) => (await sarBundle()).pairs(collects, limits));
GW.register('validate', async ({ prm, data }) => (await vectorBundle()).validate(prm, data));
GW.register('rtin', async ({ z, size, maxError }) => {
  const r = (await terrainBundle()).rtin(z, size, maxError);
  return GW.transfer(r, [r.xy.buffer, r.tris.buffer]);
});
GW.register('buildings', async ({ prm, dsm, ndsm }) => (await terrainBundle()).buildings(prm, dsm, ndsm));
GW.register('viewshed', async ({ prm, z }) => {
  const v = (await terrainBundle()).viewshed(prm, z);
  return GW.transfer(v, [v.buffer]);
});
GW.register('hlz', async ({ prm, z }) => {
  const r = (await terrainBundle()).hlz(prm, z);
  return GW.transfer(r, [r.classes.buffer, r.slope.buffer, r.obstruction.buffer]);
});
GW.register('ortho', async ({ spec, dem, src, w, h, nb }) => {
  const r = (await rasterBundle()).ortho(spec, dem, src, w, h, nb);
  return GW.transfer(r, [...r.bands.map((b) => b.buffer), r.mask.buffer]);
});
GW.register('blend', async ({ prm, data, w, h, nb }) => {
  const r = (await rasterBundle()).blend(prm, data, w, h, nb);
  return GW.transfer(r, [...r.bands.map((b) => b.buffer), r.mask.buffer]);
});
GW.register('adjust', async ({ job }) => (await bundle()).adjust(job));
GW.register('fitrpc', async ({ job }) => (await bundle()).fitRpc(job));
GW.register('fitrpcklv', async ({ job }) => (await bundle()).fitRpcKlv(job));
GW.register('orb', async ({ a, aw, ah, b, bw, bh, n, ratio, tol }) => (await bundle()).orbMatch(a, aw, ah, b, bw, bh, n, ratio, tol));
GW.register('harris', async ({ px, w, h, n, border, minDist }) => (await bundle()).harris(px, w, h, n, border, minDist));
// REQ-PRF-06: SGM on the GPU where WebGPU is available; the Rust matcher otherwise (and for NCC).
GW.register('dsmTileGpu', async ({ prm, left, right, n }) => {
  let r = null;
  let gpuError = null;
  try {
    r = await gpuDsmTile(prm.slice(), left, right, n);
  } catch (e) {
    gpuError = e.message;
  }
  if (!r) {
    r = (await bundle()).dsmTile(prm, left, right, n);
    r.engine = 'worker';
    r.gpuError = gpuError;
  }
  return GW.transfer(r, [r.sum.buffer, r.count.buffer, r.fomM.buffer, r.fomU.buffer]);
});
GW.register('dsmTile', async ({ prm, left, right, n }) => {
  const r = (await bundle()).dsmTile(prm, left, right, n);
  return GW.transfer(r, [r.sum.buffer, r.count.buffer, r.fomM.buffer, r.fomU.buffer]);
});
GW.register('match', async ({ tpl, tw, th, srch, sw, sh, refine }) => (await bundle()).match(tpl, tw, th, srch, sw, sh, refine));
/** Several matches in one round trip: [{tpl, tw, th, srch, sw, sh}]. */
GW.register('matchMany', async ({ items, refine = true }) => {
  const b = await bundle();
  return items.map((m) => b.match(m.tpl, m.tw, m.th, m.srch, m.sw, m.sh, refine));
});
