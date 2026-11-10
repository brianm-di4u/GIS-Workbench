// Analysis worker (Appendix D §2.2): photogrammetric jobs on the lazily loaded `photo` bundle
// (block adjustment, RPC fitting, Harris corners and window matching). Inputs arrive as typed
// arrays; nothing here touches files.

import { Photo } from '../../wasm/photo.js';
import { VendorBundle } from '../../wasm/vendor.js';
import { Raster } from '../../wasm/raster.js';
import { TerrainBundle } from '../../wasm/terrain.js';
import { VectorBundle } from '../../wasm/vector.js';
import { SarBundle } from '../../wasm/sar.js';
import { SpectralBundle } from '../../wasm/spectral.js';
import { TinBundle } from '../../wasm/tin.js';
import { AviationBundle } from '../../wasm/aviation.js';
import { HydroBundle, HYDRO_MAX_POSTS } from '../../wasm/hydro.js';
import { GeoprocBundle } from '../../wasm/geoproc.js';
import { bufferGeoms, dissolveFeatures, overlay, spatialJoin } from '../../analysis/geoproc.js';
import { gpuDsmTile } from '../../analysis/gpu-sgm.js';
import { gwError } from '../../i18n/index.js';
import { ensureCsm, jobNeedsCsm } from '../../sensor/csm-worker.js';
import { slpkEnd, slpkDirectory, i3sGeometry } from '../../formats/i3s-wasm.js';
import '../pack-verify.js'; // OD-2.27: large data packs

const { GW } = self;
let photo = null;
async function bundle() {
  if (!photo) {
    await GW.ensure('photo');
    photo = new Photo(GW.ctx.modules.photo);
  }
  return photo;
}

// WASM linear memory never shrinks: a stateless module an earlier job grew past 384 MiB is
// replaced before the next job, so big jobs in a row do not fragment it up to the 1 GiB cap.
const grown = (b) => b?.x?.memory?.buffer?.byteLength > 384 * 2 ** 20;

let raster = null;
async function rasterBundle() {
  if (grown(raster)) raster = null;
  if (!raster) {
    await GW.ensure('raster');
    raster = new Raster(GW.ctx.modules.raster);
  }
  return raster;
}
let terrain = null;
async function terrainBundle() {
  if (grown(terrain)) terrain = null;
  if (!terrain) {
    await GW.ensure('terrain');
    terrain = new TerrainBundle(GW.ctx.modules.terrain);
  }
  return terrain;
}
let tinB = null;
async function tinBundle() {
  if (grown(tinB)) tinB = null;
  if (!tinB) {
    await GW.ensure('tin');
    tinB = new TinBundle(GW.ctx.modules.tin);
  }
  return tinB;
}
let vector = null;
async function vectorBundle() {
  if (grown(vector)) vector = null;
  if (!vector) {
    await GW.ensure('vector');
    vector = new VectorBundle(GW.ctx.modules.vector);
  }
  return vector;
}
let sar = null;
async function sarBundle() {
  if (grown(sar)) sar = null;
  if (!sar) {
    await GW.ensure('sar');
    sar = new SarBundle(GW.ctx.modules.sar);
  }
  return sar;
}
let spectral = null;
async function spectralBundle() {
  if (grown(spectral)) spectral = null;
  if (!spectral) {
    await GW.ensure('spectral');
    spectral = new SpectralBundle(GW.ctx.modules.spectral);
  }
  return spectral;
}
// Spectral (REQ-MSI-05..14, 16, REQ-EXT-28): one entry point, `op` names the wrapper method.
const SPEC_OPS = new Set(['stats', 'train', 'classify', 'kmeans', 'isodata', 'post', 'accuracy', 'detect', 'transform', 'endmembers', 'correct', 'elm', 'bt', 'resample', 'template']);
GW.register('spectral', async ({ op, args }) => {
  if (!SPEC_OPS.has(op)) throw gwError('unknown spectral operation {op}', { op: String(op) });
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
GW.register('sar.polsar', async ({ data, w, h, opts }) => {
  const r = (await sarBundle()).polsar(data, w, h, opts);
  return GW.transfer(r, r.products.flatMap((p) => Object.values(p.planes).map((a) => a.buffer)));
});
GW.register('sar.pairs',async ({ collects, limits }) => (await sarBundle()).pairs(collects, limits));
// Radargrammetry (REQ-GAP-42): the SAR stereo pair finder, multilooking of image tiles, and the DSM
// job, stepped so that it reports progress and a cancel reaches it between steps.
GW.register('sar.stereoPairs', async ({ collects, limits }) => (await sarBundle()).stereoPairs(collects, limits));
GW.register('sar.multilook', async ({ v, w, h, mx, my, amplitude = true }) => {
  const r = (await sarBundle()).multilook(v, w, h, mx, my, amplitude);
  const out = r.v.slice();
  return GW.transfer({ w: r.w, h: r.h, v: out }, [out.buffer]);
});
GW.register('sar.stereoDsm', async ({ prm, recA, recB, prior, chipA, chipB, posts }, job) => {
  const b = await sarBundle();
  const id = b.stereoNew(prm, recA, recB, prior, chipA, chipB);
  try {
    let p = 0;
    let shown = 0;
    let yielded = performance.now();
    while (p < 1) {
      job.checkCancel();
      p = b.stereoStep(id, 1);
      if (p < 0) throw new Error('radargrammetry: the job was lost');
      if (p - shown >= 0.005 || p >= 1) {
        job.progress(p);
        shown = p;
      }
      // Let the cancel message in (the steps are synchronous).
      if (performance.now() - yielded > 100) {
        await new Promise((r) => setTimeout(r, 0));
        yielded = performance.now();
      }
    }
    const r = b.stereoResult(id, posts);
    const out = { stats: r.stats, heights: r.heights.slice(), sigma: r.sigma.slice(), score: r.score.slice(), flags: r.flags.slice() };
    return GW.transfer(out, [out.heights.buffer, out.sigma.buffer, out.score.buffer, out.flags.buffer]);
  } finally {
    b.stereoFree(id);
  }
});
GW.register('validate', async ({ prm, data }) => (await vectorBundle()).validate(prm, data));
GW.register('rtin', async ({ z, size, maxError }) => {
  const r = (await terrainBundle()).rtin(z, size, maxError);
  return GW.transfer(r, [r.xy.buffer, r.tris.buffer]);
});
GW.register('buildings', async ({ prm, dsm, ndsm }) => (await terrainBundle()).buildings(prm, dsm, ndsm));
// DEM edit kernels (REQ-DEM-08/09, REQ-GAP-37/38): the edit log replayed over the source heights.
GW.register('dem.replay', async ({ geo, ops, z }) => {
  const v = (await terrainBundle()).demReplay(geo, ops, z);
  return GW.transfer({ v }, [v.buffer]);
});
// TIN builds (REQ-GAP-39): from points or DEM posts, a LandXML file's own faces, then the source's lines (an edit list); the
// state bytes go to the main thread, which edits the TIN there. A raster of a large TIN runs here too.
GW.register('tin.build', async ({ src, ops }) => {
  const b = await tinBundle();
  const t0 = performance.now();
  const r = src.kind === 'dem' ? b.fromDem(src.grid, src.z, src) : b.fromPoints(src.pts, src);
  const buildMs = performance.now() - t0;
  try {
    // A LandXML surface keeps its own faces (OD-2.41), before its breaklines go in.
    const kept = src.faces ? b.keepFaces(r.id, src.pts, src.faces, src.hidden) : null;
    const results = ops?.length > 1 ? b.apply(r.id, ops) : [];
    const state = b.save(r.id);
    return GW.transfer({ state, report: r.report, kept, results, buildMs, opsMs: performance.now() - t0 - buildMs }, [state.buffer]);
  } finally {
    b.dispose(r.id);
  }
});
GW.register('tin.raster', async ({ state, grid }) => {
  const b = await tinBundle();
  const id = b.load(state);
  try {
    const z = b.raster(id, grid);
    return GW.transfer({ z }, [z.buffer]);
  } finally {
    b.dispose(id);
  }
});
GW.register('dem.blocks', async ({ geo, src, cur, tile }) => (await terrainBundle()).demBlocks(geo, src, cur, tile));
GW.register('viewshed',async ({ prm, z }) => {
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
// Pan-sharpening tiles (REQ-GAP-14): statistics, Wald's reduced-scale check, fused tiles.
GW.register('ps.stats', async ({ spec, ms, pan, n }) => {
  const r = (await rasterBundle()).psStats(spec, ms, pan, n);
  return GW.transfer(r, [r.s1.buffer, r.s2.buffer, r.low.px.buffer]);
});
GW.register('ps.wald', async ({ spec, ms, pan }) => {
  const q = (await rasterBundle()).psWald(spec, ms, pan);
  return GW.transfer(q, [q.buffer]);
});
GW.register('ps.fuse', async ({ spec, ms, pan, nq }) => {
  const r = (await rasterBundle()).psFuse(spec, ms, pan, nq);
  return GW.transfer(r, [r.q.buffer, r.px.buffer]);
});
GW.register('blend', async ({ prm, data, w, h, nb }) => {
  const r = (await rasterBundle()).blend(prm, data, w, h, nb);
  return GW.transfer(r, [...r.bands.map((b) => b.buffer), r.mask.buffer]);
});
GW.register('adjust', async ({ job }) => {
  if (jobNeedsCsm(job, 'adjust')) await ensureCsm(GW); // CSM models (REQ-GAP-24)
  return (await bundle()).adjust(job);
});
GW.register('fitrpc', async ({ job }) => (await bundle()).fitRpc(job));
GW.register('fitrpcsamples', async ({ job }) => (await bundle()).fitRpcSamples(job));
GW.register('fitrsm', async ({ job }) => {
  if (jobNeedsCsm(job, 'fitrsm')) await ensureCsm(GW);
  return (await bundle()).fitRsm(job);
});
// REQ-GAP-20: a model record from vendor metadata (DigitalGlobe EPH/ATT/GEO/IMD, Landsat ANG, Sentinel-2 MTD_TL).
let vendor = null;
GW.register('vendorModel', async ({ kind, parts, band, step, href }) => {
  if (!vendor) {
    await GW.ensure('vendor');
    vendor = new VendorBundle(GW.ctx.modules.vendor);
  }
  return vendor.vendorModel(kind, parts, band, step, href);
});
GW.register('lidarreg', async ({ prm, dsm, inten, chip }) => (await bundle()).lidarRegister(prm, dsm, inten, chip)); // REQ-GAP-46
GW.register('gpm', async ({ job }) => (await bundle()).gpm(job));
// Aerial triangulation (REQ-GAP-22): one iteration per step, progress after each and a cancel
// check between steps (a macrotask turn lets the cancel message in).
GW.register('aero', async ({ job, maxIterations = 60 }, j) => {
  const b = await bundle();
  try {
    const setup = b.aeroBegin(job);
    j.progress(0.02, { phase: 'setup', ...setup });
    for (let k = 0; ; k++) {
      await new Promise((r) => setTimeout(r, 0));
      j.checkCancel();
      const p = b.aeroStep();
      j.progress(Math.min(0.95, 0.05 + (0.9 * (k + 1)) / (maxIterations + (p.rejected ?? 0) * 8)), { phase: 'iterate', ...p });
      if (p.done) break;
    }
    j.checkCancel();
    return { setup, report: b.aeroReport() };
  } finally {
    b.aeroEnd();
  }
});
GW.register('resect', async ({ job }) => (await bundle()).resect(job));
GW.register('fiducialio', async ({ job }) => (await bundle()).fiducialIo(job));
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
// I3S scene layer packages (REQ-GAP-35): the SLPK's ZIP directory and uncompressed geometry
// buffers, in the `tiles` bundle (formats/i3s-wasm.js).
GW.register('i3s.slpkEnd', async ({ tail, length }) => slpkEnd(await GW.ensure('tiles'), tail, length));
GW.register('i3s.slpkDir', async ({ cd }) => slpkDirectory(await GW.ensure('tiles'), cd));
GW.register('i3s.geometry', async ({ bytes, layout, maxVertices }) => {
  const g = i3sGeometry(await GW.ensure('tiles'), bytes, layout, maxVertices);
  return GW.transfer(g, Object.values(g).filter((v) => v?.buffer).map((v) => v.buffer));
});
// Quantized-mesh tile encoder (REQ-FMT-39): the `tiles` bundle's gw_qmesh_tile.
GW.register('qmesh.tile', async ({ z, prm }) => {
  const b = await GW.ensure('tiles');
  return b.guard(() => {
    const [pz, nz] = b.putF32(z);
    const [pp, np] = b.putF64(prm);
    try {
      b.check(b.x.gw_qmesh_tile(pz, z.length, pp, prm.length), 'qmesh');
      const out = b.outBytes();
      return GW.transfer({ bytes: out }, [out.buffer]);
    } finally {
      b.free(pz, nz);
      b.free(pp, np);
    }
  });
});

// Airfield obstruction surfaces (REQ-GAP-73): the lazy `aviation` bundle.
let aviation = null;
async function aviationBundle() {
  if (grown(aviation)) aviation = null;
  if (!aviation) {
    await GW.ensure('aviation');
    aviation = new AviationBundle(GW.ctx.modules.aviation);
  }
  return aviation;
}
GW.register('obs.surfaces', async ({ def }) => (await aviationBundle()).surfaces(def));
GW.register('obs.grid', async ({ def, geo, z }) => {
  const r = (await aviationBundle()).grid(def, geo, z);
  return GW.transfer(r, [r.limit.buffer, r.sid.buffer, ...(r.zoneLimit ? [r.zoneLimit.buffer, r.zoneSid.buffer] : [])]);
});
GW.register('obs.points', async ({ def, ll }) => {
  const r = (await aviationBundle()).points(def, ll);
  return GW.transfer(r, [r.limit.buffer, r.sid.buffer, ...(r.zoneLimit ? [r.zoneLimit.buffer, r.zoneSid.buffer] : [])]);
});

// Hydrology (REQ-GAP-80): the lazy `hydro` bundle. One run per job, stage by stage, with progress
// and a cancel between stages (S-63). A run leaves memory grown by up to about 750 MiB, so the
// instance is dropped once it holds more than 384 MiB.
let hydro = null;
GW.register('hydro.run', async ({ z, w, h, opts }, job) => {
  if (w * h > HYDRO_MAX_POSTS) throw gwError('hydrology: {n} posts is more than the 48 million posts it takes; crop or resample the elevation model first', { n: String(w * h) }, 'E_HYDRO_SIZE');
  if (grown(hydro)) hydro = null;
  if (!hydro) {
    await GW.ensure('hydro');
    hydro = new HydroBundle(GW.ctx.modules.hydro);
  }
  const r = await hydro.run(z, w, h, opts, async (phase, p) => {
    job.checkCancel();
    job.progress(p, { phase });
    await new Promise((ok) => setTimeout(ok, 0)); // let a cancel message in between stages
    job.checkCancel();
  });
  return GW.transfer(r, ['filled', 'dir', 'acc', 'strahler', 'shreve', 'labels', 'dinfAcc', 'streams'].filter((k) => r[k]).map((k) => r[k].buffer));
});

// Vector geoprocessing (REQ-GAP-79): buffer and dissolve on the lazy `geoproc` bundle; overlay and
// spatial join in JavaScript (analysis/geoproc.js, S-62). Geodesic buffers use the core bundle's
// WGS 84 geodesics.
let geoproc = null;
async function geoprocBundle() {
  if (grown(geoproc)) geoproc = null;
  if (!geoproc) {
    await GW.ensure('geoproc');
    geoproc = new GeoprocBundle(GW.ctx.modules.geoproc);
  }
  return geoproc;
}
GW.register('geo.buffer', async ({ geoms, distance, cap = 'round', quadSegs = 8, geodesic = false }, job) => {
  const b = await geoprocBundle();
  const geo = geodesic ? GW.bundle('core') : null;
  const out = [];
  // In chunks, for progress and Cancel.
  for (let k = 0; k < geoms.length; k += 500) {
    job.checkCancel();
    const part = geoms.slice(k, k + 500);
    out.push(...bufferGeoms(part, { distance, cap, quadSegs, geodesic, geo, run: (flat, d, c, q) => b.buffer(flat, d, c, q, part.length) }));
    job.progress(Math.min(1, (k + part.length) / geoms.length));
  }
  return out;
});
GW.register('geo.dissolve', async ({ features, field = null }) => {
  const b = await geoprocBundle();
  return dissolveFeatures(features, { field, run: (flat, groups) => b.dissolve(flat, groups) });
});
GW.register('geo.overlay', async ({ a, b, op, aFields, bFields }, job) => overlay(a, b, op, { aFields, bFields, job }));
GW.register('geo.join', async ({ targets, joins, predicate, field = null, maxDistance = Infinity }, job) => spatialJoin(targets, joins, { predicate, field, maxDistance: maxDistance ?? Infinity, job }));
