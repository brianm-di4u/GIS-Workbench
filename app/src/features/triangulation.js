// Triangulation (R2.2): the RPC bias-compensated block adjustment (REQ-SNS-11), tie points
// measured automatically (model-guided search, Harris, NCC, LSM, a grid per overlap) or by
// hand (REQ-SNS-13), non-destructive solutions with a `.sup` sidecar and a refitted RPC00B
// (REQ-SNS-15/16), Stereo Align on a pair (REQ-SNS-10) and the multi-image point
// (REQ-MEN-11). Block points live in the store ('tripoint'), so undo and project files carry
// them; a solution is a 'trisolution' record plus a `triangulation` field on each layer,
// from which the adjusted model is rebuilt (the base model never changes). Images whose model is
// an RSM, the CSEPHA pushbroom or a frame camera join the block too, corrected in image space or,
// with "Sensor parameters", through the model's adjustable parameters and their a priori
// covariance (REQ-GAP-18/19/23).

import { h, clear } from '../shell/dom.js';
import { modal, field, section, confirmBox } from '../shell/dialogs.js';
import { pickFiles, saveBlob } from '../storage/files.js';
import { parseDelimited } from './workspace-tools.js';
import { groundOf } from '../tools/tools.js';
import { t, N_, tr, gwError, msgOf } from '../i18n/index.js';
import { num, length, height, collator, dateTime } from '../i18n/format.js';
import { modelLabel } from '../formats/model-names.js';
import { pointText } from '../i18n/fonts.js';

export const name = 'triangulation';

const KINDS = { shift: 0, drift: 1, affine: 2, sensor: 0 };
// English names go into the .sup file as they are; the dock shows them through tr().
const KIND_NAMES = { shift: N_('Shift'), drift: N_('Shift + drift'), affine: N_('Affine'), sensor: N_('Sensor parameters') };
const ROLE_NAMES = { tie: N_('tie'), gcp: N_('gcp'), check: N_('check') };
const ID6 = [0, 1, 0, 0, 0, 1];

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);

  // ---- block membership and base models ----
  const rpcRecordOf = (l) => {
    const rec = l.info.subheader?.rpc?.slice(0, 92) ?? l.info.meta?.rpc?.slice(0, 92) ?? l.sideRpc?.rpc?.slice(0, 92);
    if (!rec || rec.length < 92) return null;
    const chip = l.rec?.registration?.kind === 'rpc' ? l.rec.registration.chip : (l.info.subheader?.ichipb ?? l.sideRpc?.chip);
    return [...rec, ...(chip && chip.some((v) => v !== 0) ? chip : ID6)];
  };
  /**
   * A model the analysis worker can rebuild from its record (RSM, line scanner, frame camera):
   * the one the layer uses, or the base of its applied solution.
   */
  const recordModelOf = (l) => {
    const want = l.rec?.triangulation?.base ?? l.modelName;
    return (l.models ?? []).find((m) => m.record && !m.error && m.name === want && !/triangulated/.test(m.name)) ?? null;
  };
  /** Image layers that can join the block (an RPC model, or a model with a record), in a stable order. */
  const blockLayers = () => [...app.layers.values()].filter((l) => l.kind !== 'dem' && (rpcRecordOf(l) || recordModelOf(l)) && !l.rec?.blockExcluded).sort((a, b) => String(a.info.iid).localeCompare(String(b.info.iid)));
  /** The model the adjustment starts from: the RSM, pushbroom or frame model in use, else the registered RPC, else the file's RPC. */
  const baseModelOf = (l) => {
    const rm = recordModelOf(l);
    if (rm) return rm;
    const models = l.models ?? [];
    const reg = l.rec?.registration?.kind === 'rpc' ? models.find((m) => m.name === l.rec.registration.name) : null;
    // A solution on another model (a map model registered to a point cloud, REQ-GAP-46) names its base.
    const named = l.rec?.triangulation?.base ? models.find((m) => !m.error && m.name === l.rec.triangulation.base && !/triangulated/.test(m.name)) : null;
    return reg ?? models.find((m) => !m.error && /^RPC/.test(m.name) && !/triangulated/.test(m.name)) ?? named;
  };
  const points = () => {
    const cmp = collator().compare;
    return S.all('tripoint').sort((a, b) => cmp(a.name, b.name));
  };

  // ---- the adjusted model follows the stored solution (undo, redo, project reload) ----
  function activate(l, name, id) {
    const info = app.core.modelInfo(id);
    l.models = (l.models ?? []).filter((m) => !/triangulated/.test(m.name));
    l.models.push({ name, id, info });
    l.modelId = id;
    l.modelName = name;
    l.modelInfo = info;
  }
  function syncModels() {
    let changed = false;
    for (const l of app.layers.values()) {
      const tri = l.rec?.triangulation ?? null;
      const sig = JSON.stringify(tri) + JSON.stringify(l.rec?.registration ?? null);
      if (l._triSig === sig) continue;
      l._triSig = sig;
      const base = baseModelOf(l);
      if (!base) continue;
      if (tri) {
        try {
          // The model name is an identifier (code and tests match /triangulated/): not translated.
          const name = `${/^RPC/.test(base.name) ? 'RPC00B' : base.name} (triangulated: ${tri.solution})`;
          const id = tri.params?.length ? app.core.paramModel(base.id, tri.params, name, tri.cov?.length === tri.params.length ** 2 ? tri.cov : null) : app.core.adjustedModel(base.id, tri.c, { centre: tri.centre, half: tri.half, sigma: tri.sigma ?? NaN, name });
          activate(l, name, id);
          changed = true;
        } catch (e) {
          toast(t('{layer}: triangulated model not restored ({msg})', { layer: l.rec.name, msg: msgOf(e) }), { kind: 'warn' });
        }
      } else if (/triangulated/.test(l.modelName ?? '')) {
        l.models = (l.models ?? []).filter((m) => !/triangulated/.test(m.name));
        l.modelId = base.id;
        l.modelName = base.name;
        l.modelInfo = base.info;
        changed = true;
      }
    }
    if (changed) {
      app.renderer?.invalidate();
      for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
      app.emit('state');
    }
  }
  S.on('change', syncModels);
  app.on('state', syncModels); // layers created after their records (project reload)

  // ---- control points ----
  /** Import control: CSV/TSV with id, lat, lon, hae (or h), sigma_h, sigma_v, role (gcp/checkpoint). */
  function importControl(text) {
    const { rows } = parseDelimited(text);
    if (rows.length < 2) throw new Error('the control file has no rows');
    const head = rows[0].map((c) => c.trim().toLowerCase());
    const col = (...names) => head.findIndex((c) => names.includes(c));
    const ci = { id: col('id', 'name', 'point'), lat: col('lat', 'latitude'), lon: col('lon', 'long', 'longitude'), h: col('hae', 'h', 'height', 'elev', 'z'), sh: col('sigma_h', 'sh', 'sigmah'), sv: col('sigma_v', 'sv', 'sigmav'), role: col('role', 'type', 'kind') };
    if (ci.lat < 0 || ci.lon < 0 || ci.h < 0) throw new Error('the control file needs lat, lon and hae (or h) columns');
    const have = new Map(points().map((p) => [p.name, p]));
    let n = 0;
    S.transact(t('Import control points'), (tx) => {
      for (const r of rows.slice(1)) {
        const lat = Number(r[ci.lat]);
        const lon = Number(r[ci.lon]);
        const hae = Number(r[ci.h]);
        if (![lat, lon, hae].every(Number.isFinite)) continue;
        const name = (ci.id >= 0 ? r[ci.id] : '') || `GCP${n + 1}`;
        const role = String(ci.role >= 0 ? r[ci.role] : 'gcp').toLowerCase();
        const kind = /^(check|chk)/.test(role) ? 'check' : 'gcp';
        const v = { name, kind, known: { lat, lon, hae }, sigmaH: Number(r[ci.sh]) > 0 ? Number(r[ci.sh]) : 0.5, sigmaV: Number(r[ci.sv]) > 0 ? Number(r[ci.sv]) : 1 };
        const old = have.get(name);
        if (old) for (const [k, val] of Object.entries(v)) tx.set(old.id, k, val);
        else tx.create('tripoint', { ...v, obs: {} });
        n++;
      }
    });
    return n;
  }

  /** Set (or clear, when x is null) one image measurement of a block point. */
  function measure(pointId, layerId, x, y, { sigma = app.prefs.get('pickSigmaPx') ?? 0.5, auto = false } = {}) {
    const p = S.get(pointId);
    if (!p) throw new Error('no such block point');
    const obs = { ...(p.obs ?? {}) };
    if (x === null) delete obs[layerId];
    else obs[layerId] = { x, y, sigma, auto };
    S.transact(t('Measure {point}', { point: p.name }), (tx) => tx.set(pointId, 'obs', obs), { mergeKey: `tri-measure-${pointId}-${layerId}` });
  }

  /** Predicted image position of a point in a layer: from its known or intersected ground. */
  function predict(p, l) {
    const g = p.known ? { lat: p.known.lat, lon: p.known.lon, h: p.known.hae } : groundOfPoint(p);
    return g ? l.imageAt(g.lat, g.lon, g.h) : null;
  }
  function groundOfPoint(p) {
    const obs = Object.entries(p.obs ?? {}).map(([lid, o]) => ({ l: app.layers.get(lid), o })).filter((x) => x.l?.modelId);
    if (obs.length < 2) return null;
    try {
      const r = app.core.intersect(obs.map(({ l, o }) => ({ model: l.modelId, x: o.x, y: o.y, sigma: o.sigma ?? 0.5 })));
      return { lat: r.lat, lon: r.lon, h: r.h };
    } catch {
      return null;
    }
  }

  // ---- automatic tie points ----
  const patch = (l, x, y, w, hh) => app.pool.run('patch', { handle: l.handle, x, y, w, h: hh, band: 0 }, { affinity: l.affinity, priority: 'background' });
  const analysis = (op, args, transfer = []) => app.pool.run(op, args, { kind: 'analysis', transfer, timeout: 300000 });

  /** Match the template of layer A at (xa, ya) into layer B around (xb, yb) within ±radius. */
  async function matchAt(A, xa, ya, B, xb, yb, { tpl, radius }) {
    const half = Math.floor(tpl / 2);
    const t = await patch(A, Math.round(xa) - half, Math.round(ya) - half, tpl, tpl);
    const sw = tpl + 2 * radius;
    const s = await patch(B, Math.round(xb) - half - radius, Math.round(yb) - half - radius, sw, sw);
    if (t.w !== tpl || t.h !== tpl || s.w < tpl + 4 || s.h < tpl + 4) return null;
    const m = await analysis('match', { tpl: t.px, tw: t.w, th: t.h, srch: s.px, sw: s.w, sh: s.h, refine: true }, [t.px.buffer, s.px.buffer]);
    if (!(m.ok > 0) || !Number.isFinite(m.x)) return null;
    // The template centre is at (xa − t.x0) in its window; the match is in search-window pixels.
    const offA = { x: xa - t.x0 - t.w / 2, y: ya - t.y0 - t.h / 2 };
    return { x: s.x0 + m.x + offA.x, y: s.y0 + m.y + offA.y, ncc: m.lsmScore > 0 ? m.lsmScore : m.ncc, ratio: m.ratio, lsm: m.ok === 1, sigma: m.sigma };
  }

  /**
   * Tie points for every overlapping pair: a grid of cells over image A; in each, the strongest
   * Harris corner; its prediction in B through both models (terrain height when a DEM covers
   * it); a wide search on a few cells fixes the pair's offset, then NCC + LSM with a back-match.
   */
  /**
   * The image-to-image affine of a pair from descriptors (REQ-SNS-21): ORB on overviews of both
   * images (≤ `size` px), no sensor model involved. Returns a full-resolution affine B = T·(A, 1).
   */
  async function descriptorAffine(A, B, { size = 1024, n = 600 } = {}) {
    const ov = async (l) => {
      const step = Math.max(1, Math.ceil(Math.max(l.width, l.height) / size));
      const r = await app.pool.run('window', { handle: l.handle, x0: 0, y0: 0, w: Math.ceil(l.width / step), h: Math.ceil(l.height / step), step, bands: [l.chain?.bands?.[0] ?? 0] }, { affinity: l.affinity, priority: 'background' });
      return { ...r, step, px: r.planes[0] instanceof Float32Array ? r.planes[0] : Float32Array.from(r.planes[0]) };
    };
    const [a, b] = [await ov(A), await ov(B)];
    const m = await analysis('orb', { a: a.px, aw: a.w, ah: a.h, b: b.px, bw: b.w, bh: b.h, n, ratio: 0.85, tol: 2 }, [a.px.buffer, b.px.buffer]);
    if (!m.affine) return null;
    // The window op samples full-resolution pixel i·step, so overview pixel centres (i + 0.5)
    // sit at full i·step + 0.5: full = step·(ov − 0.5) + 0.5. T = S_b · M · S_a⁻¹ (corner origin).
    const comp = (P, Q) => [P[0] + P[1] * Q[0] + P[2] * Q[3], P[1] * Q[1] + P[2] * Q[4], P[1] * Q[2] + P[2] * Q[5], P[3] + P[4] * Q[0] + P[5] * Q[3], P[4] * Q[1] + P[5] * Q[4], P[4] * Q[2] + P[5] * Q[5]];
    const S = (k) => [0.5 - 0.5 * k, k, 0, 0.5 - 0.5 * k, 0, k];
    const T = comp(S(b.step), comp(m.affine, S(1 / a.step)));
    return { T, inliers: m.pairs.length, features: m.features, steps: [a.step, b.step] };
  }

  async function autoTiePoints({ grid = 4, tpl = 21, radius = 24, coarseRadius = 160, minNcc = 0.75, minRatio = 1.1, matcher = 'auto', onProgress, layers = null } = {}) {
    const ls = layers ?? blockLayers();
    if (ls.length < 2) throw new Error('tie points need two or more images with RPC models');
    const pairs = [];
    for (let i = 0; i < ls.length; i++) for (let k = i + 1; k < ls.length; k++) pairs.push([ls[i], ls[k]]);
    const found = [];
    let done = 0;
    let descriptorPairs = 0;
    // Why candidates were dropped, for the report and for tuning (TE campaign).
    const stats = { corners: 0, offsets: 0, noMatch: 0, ncc: 0, ratio: 0, lsm: 0, back: 0 };
    for (const [A, B] of pairs) {
      // With poor support data the models cannot predict B; descriptors give the pair's affine.
      let T = null;
      const predict = (x, y) => {
        if (T) return { x: T[0] + T[1] * x + T[2] * y, y: T[3] + T[4] * x + T[5] * y };
        const g = A.groundWithTerrain(x, y);
        return g ? B.imageAt(g.lat, g.lon, g.h) : null;
      };
      if (matcher === 'orb') {
        const d = await descriptorAffine(A, B);
        if (d) T = d.T;
        else {
          done++;
          onProgress?.(done / pairs.length);
          continue;
        }
      }
      const cellsFor = () => {
        const out = [];
        for (let j = 0; j < grid; j++)
          for (let i = 0; i < grid; i++) {
            const cx = ((i + 0.5) * A.width) / grid;
            const cy = ((j + 0.5) * A.height) / grid;
            const q = predict(cx, cy);
            // Stage 2 searches ±radius around the prediction; only the stage-1 candidates need the
            // wide margin (TE-038: a 181 px margin dropped most cells of a 1536 px chip).
            const m = radius + tpl;
            if (q && q.x > m && q.y > m && q.x < B.width - m && q.y < B.height - m) out.push({ cx, cy });
          }
        return out;
      };
      let cells = cellsFor();
      if (!cells.length && matcher === 'auto') {
        const d = await descriptorAffine(A, B);
        if (d) {
          T = d.T;
          cells = cellsFor();
        }
      }
      // Corners in each cell (one Harris window per cell).
      const corners = [];
      for (const c of cells) {
        const win = Math.min(160, Math.floor(A.width / grid), Math.floor(A.height / grid));
        const p = await patch(A, Math.round(c.cx - win / 2), Math.round(c.cy - win / 2), win, win);
        const best = await analysis('harris', { px: p.px, w: p.w, h: p.h, n: 1, border: tpl, minDist: 8 }, [p.px.buffer]);
        if (best[0]) corners.push({ x: p.x0 + best[0].x, y: p.y0 + best[0].y });
      }
      // Stage 1: the pair's image offset from a few wide searches (median); with a descriptor
      // affine the residual offset is found the same way, over a smaller radius.
      const stage1 = async () => {
        const offs = [];
        const wide = T ? Math.max(radius, 32) : coarseRadius;
        const mw = wide + Math.max(tpl, 41);
        const inside = corners.filter((c) => {
          const q = predict(c.x, c.y);
          return q && q.x > mw && q.y > mw && q.x < B.width - mw && q.y < B.height - mw;
        });
        for (const c of (inside.length ? inside : corners).slice(0, 9)) {
          const q = predict(c.x, c.y);
          if (!q) continue;
          const m = await matchAt(A, c.x, c.y, B, q.x, q.y, { tpl: Math.max(tpl, 41), radius: T ? Math.max(radius, 32) : coarseRadius });
          if (m && m.ncc >= minNcc && m.ratio >= minRatio) offs.push([m.x - q.x, m.y - q.y]);
        }
        return offs;
      };
      stats.corners += corners.length;
      let offs = await stage1();
      if (!offs.length && !T && matcher === 'auto') {
        const d = await descriptorAffine(A, B);
        if (d) {
          T = d.T;
          offs = await stage1();
        }
      }
      if (!offs.length) {
        done++;
        onProgress?.(done / pairs.length);
        continue;
      }
      if (T) descriptorPairs++;
      stats.offsets += offs.length;
      const med = (k) => offs.map((o) => o[k]).sort((a, b) => a - b)[Math.floor(offs.length / 2)];
      const off = [med(0), med(1)];
      // Stage 2: every corner with the offset, narrow search, back-match.
      for (const c of corners) {
        const q = predict(c.x, c.y);
        if (!q) continue;
        const m = await matchAt(A, c.x, c.y, B, q.x + off[0], q.y + off[1], { tpl, radius });
        const why = !m ? 'noMatch' : m.ncc < minNcc ? 'ncc' : m.ratio < minRatio ? 'ratio' : !m.lsm ? 'lsm' : null;
        if (why) {
          stats[why]++;
          continue;
        }
        const back = await matchAt(B, m.x, m.y, A, c.x, c.y, { tpl, radius: 3 });
        if (!back || Math.hypot(back.x - c.x, back.y - c.y) > 1) {
          stats.back++;
          continue;
        }
        found.push({ a: A, b: B, pa: c, pb: { x: m.x, y: m.y }, ncc: m.ncc, descriptor: !!T });
      }
      done++;
      onProgress?.(done / pairs.length);
    }
    const start = points().filter((p) => p.kind === 'tie').length;
    S.transact(t('Automatic tie points ({n})', { n: found.length }), (tx) => {
      found.forEach((f, i) => tx.create('tripoint', { name: `TP${String(start + i + 1).padStart(3, '0')}`, kind: 'tie', known: null, sigmaH: 0, sigmaV: 0, auto: true, ncc: Number(f.ncc.toFixed(3)), matcher: f.descriptor ? 'ORB + NCC/LSM' : 'NCC/LSM', obs: { [f.a.id]: { x: f.pa.x, y: f.pa.y, sigma: 0.5, auto: true }, [f.b.id]: { x: f.pb.x, y: f.pb.y, sigma: 0.5, auto: true } } }));
    });
    return { pairs: pairs.length, points: found.length, descriptorPairs, stats };
  }

  // ---- the solve ----
  /** Run the adjustment in the analysis worker; returns the report (nothing applied yet). */
  async function solve({ kind = 'shift', rejectK = 3, autoReject = 0, fixed = [], priorSigmaPx = 0, maxIterations = 50, layers = blockLayers(), exclude = new Set() } = {}) {
    const ls = layers.filter((l) => baseModelOf(l));
    if (!ls.length) throw new Error('no images with RPC models in the block');
    const pts = points().filter((p) => Object.keys(p.obs ?? {}).some((lid) => ls.some((l) => l.id === lid)));
    // Job version 2: each image's model as a typed record; "Sensor parameters" corrects the images
    // whose model has adjustable parameters through them, the others by a shift.
    const job = [2, ls.length, pts.length, 0, maxIterations, rejectK, autoReject];
    const modes = [];
    for (const l of ls) {
      const base = baseModelOf(l);
      const rpc = rpcRecordOf(l);
      const r = base.record ?? (rpc ? { type: 0, rec: rpc } : null);
      if (!r) throw gwError('{image}: its model ({model}) has no RPC record the adjustment can use', { image: l.rec?.name ?? l.info.iid, model: base.name }, 'E_TRI_NO_RPC');
      const sensor = kind === 'sensor' && (base.info?.params ?? 0) > 0;
      modes.push(sensor);
      job.push(r.type, r.rec.length, ...r.rec, KINDS[kind] ?? 0, fixed.includes(l.id) ? 1 : 0, l.width / 2, l.height / 2, l.width / 2, l.height / 2, priorSigmaPx, sensor ? 1 : 0);
    }
    const kindCode = { tie: 0, gcp: 1, check: 2 };
    for (const p of pts) job.push(kindCode[p.kind] ?? 0, p.known?.lat ?? NaN, p.known?.lon ?? NaN, p.known?.hae ?? NaN, p.sigmaH || 0.5, p.sigmaV || 1);
    const obsIndex = [];
    pts.forEach((p, j) =>
      ls.forEach((l, i) => {
        const o = p.obs?.[l.id];
        if (!o || exclude.has(`${p.id}:${l.id}`)) return;
        job.push(i, j, o.x, o.y, o.sigma ?? 0.5);
        obsIndex.push({ point: p.id, layer: l.id });
      }),
    );
    job[3] = obsIndex.length;
    const f = Float64Array.from(job);
    const r = await analysis('adjust', { job: f }, [f.buffer]);
    const residuals = r.residuals.map(([vx, vy, z, flag, rej], k) => ({ ...obsIndex[k], point: obsIndex[k].point, pointName: S.get(obsIndex[k].point)?.name, image: app.layers.get(obsIndex[k].layer)?.info.iid, vx, vy, normalized: z, flagged: flag, rejected: rej }));
    return {
      kind,
      layers: ls.map((l) => l.id),
      images: ls.map((l, i) => ({ layer: l.id, image: l.info.iid, base: baseModelOf(l).name, c: r.images[i].c, cov: r.images[i].cov, params: modes[i] ? r.images[i].params : null, paramNames: modes[i] ? baseModelOf(l).info.paramNames : null, centre: [l.width / 2, l.height / 2], half: [l.width / 2, l.height / 2], fixed: fixed.includes(l.id) })),
      points: pts.map((p, j) => ({ id: p.id, name: p.name, kind: p.kind, adjusted: r.points[j], known: p.known })),
      residuals,
      sigma0: r.sigma0,
      dof: r.dof,
      iterations: r.iterations,
      converged: r.converged,
      before: r.before,
      after: r.after,
      gcpResiduals: r.gcp.map(([j, e, n, u]) => ({ name: pts[j].name, e, n, u })),
      counts: { images: ls.length, gcps: pts.filter((p) => p.kind === 'gcp').length, checkpoints: pts.filter((p) => p.kind === 'check').length, ties: pts.filter((p) => p.kind === 'tie').length, observations: obsIndex.length },
      rejected: r.rejected.map((k) => obsIndex[k]),
      unused: r.unused.map((j) => pts[j].name),
    };
  }

  /** Horizontal σ (m) of an adjusted image from its shift covariance and the GSD. */
  const adjustedSigma = (l, im) => {
    if (im.params) return null; // the model states its own covariance (posterior) instead
    const k = Math.round(Math.sqrt(im.cov.length));
    if (!k) return null;
    const s = Math.sqrt(Math.max(0, (im.cov[0] + im.cov[(k / 2) * k + k / 2]) / 2)); // Δy0 and Δx0 terms
    const g0 = l.groundAt(l.width / 2, l.height / 2);
    const g1 = l.groundAt(l.width / 2 + 1, l.height / 2);
    const gsd = g0 && g1 ? app.core.inverse(g0.lat, g0.lon, g1.lat, g1.lon).distance : 1;
    return s * gsd;
  };

  /** Apply a solved report: a 'trisolution' record and each layer's correction, in one undo step. */
  function applySolution(rep) {
    const n = S.all('trisolution').length + 1;
    const label = `SOL-${String(n).padStart(4, '0')}`;
    let sid;
    S.transact(t('Apply triangulation {label}', { label }), (tx) => {
      sid = tx.create('trisolution', { label, created: new Date().toISOString(), analyst: app.prefs.get('analyst') ?? 'analyst', kind: rep.kind, layers: rep.layers, sigma0: rep.sigma0, dof: rep.dof, counts: rep.counts, before: rep.before, after: rep.after, gcpResiduals: rep.gcpResiduals, images: rep.images, residuals: rep.residuals.map(({ pointName, image, vx, vy, normalized, flagged, rejected }) => ({ pointName, image, vx, vy, normalized, flagged, rejected })) });
      for (const im of rep.images) {
        const l = app.layers.get(im.layer);
        if (!l) continue;
        tx.set(l.id, 'triangulation', { solution: label, solutionId: sid, kind: rep.kind, base: im.base, c: im.c, cov: im.cov, ...(im.params ? { params: im.params, paramNames: im.paramNames } : {}), centre: im.centre, half: im.half, sigma: adjustedSigma(l, im) });
      }
    });
    return label;
  }

  function removeSolution() {
    S.transact(t('Remove triangulation'), (tx) => {
      for (const l of app.layers.values()) if (l.rec?.triangulation) tx.set(l.id, 'triangulation', null);
    });
  }

  // ---- .sup sidecar and the refitted RPC00B (REQ-SNS-15) ----
  function supText(l) {
    const tri = l.rec?.triangulation;
    if (!tri) throw gwError('{layer} has no triangulation solution', { layer: l.rec.name }, 'E_TRI_NO_SOLUTION');
    const sol = S.all('trisolution').find((s) => s.label === tri.solution);
    return JSON.stringify(
      {
        kind: 'gisworkbench-support-adjustment',
        version: 1,
        note: tri.params ? 'The original support data is unchanged. Add these corrections to the adjustable sensor parameters of the base model (names and units as listed; covariance row-major, posterior).' : 'The original support data (the RPC00B in the image file) is unchanged. Apply this image-space correction to the model: Δline = a0 + a1·u + a2·v, Δsample = b0 + b1·u + b2·v, with u = (x − cx)/hx and v = (y − cy)/hy in corner-origin pixels of the full image.',
        image: { iid: l.info.iid, file: l.info.fileName, size: [l.width, l.height] },
        baseModel: tri.base ?? baseModelOf(l)?.name,
        solution: { id: tri.solution, created: sol?.created, analyst: sol?.analyst, family: KIND_NAMES[tri.kind], sigma0: sol?.sigma0, dof: sol?.dof, counts: sol?.counts, checkpoints: sol?.after },
        correction: tri.params ? { sensorParameters: tri.params.map((v, i) => ({ name: tri.paramNames?.[i] ?? `p${i + 1}`, correction: v })), covariance: tri.cov } : { a: tri.c.slice(0, 3), b: tri.c.slice(3, 6), centre: tri.centre, half: tri.half, covariance: tri.cov, adjustedSigmaHM: tri.sigma },
      },
      null,
      1,
    );
  }

  /** Refit an RPC00B to the adjusted model over the image's footprint and height range. */
  async function refitRpc(l) {
    const tri = l.rec?.triangulation;
    if (!tri) throw gwError('{layer} has no triangulation solution', { layer: l.rec.name }, 'E_TRI_NO_SOLUTION');
    const rec = rpcRecordOf(l);
    if (tri.params || !rec || (tri.base && !/^RPC/.test(tri.base))) throw gwError('{layer}: the RPC00B refit works on image-space corrections of an RPC; this solution corrects another model', { layer: l.rec.name }, 'E_TRI_REFIT_MODEL');
    const fp = l.footprint();
    if (!fp) throw new Error('the image footprint is unknown');
    const lats = fp.map((p) => p[0]);
    const lons = fp.map((p) => p[1]);
    const pad = 0.0005;
    const h0 = rec[6] - rec[11];
    const h1 = rec[6] + rec[11];
    const job = Float64Array.from([0, ...rec, ...tri.c, ...tri.centre, ...tri.half, Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lons) - pad, Math.max(...lons) + pad, h0, h1, l.width, l.height, tri.sigma ?? rec[0], 0]);
    return analysis('fitrpc', { job }, [job.buffer]);
  }

  /** GDAL `_RPC.TXT` text of an RPC00B record (pixel-centre convention, as RPC00B). */
  function rpcText(rec) {
    const names = ['ERR_BIAS', 'ERR_RAND', 'LINE_OFF', 'SAMP_OFF', 'LAT_OFF', 'LONG_OFF', 'HEIGHT_OFF', 'LINE_SCALE', 'SAMP_SCALE', 'LAT_SCALE', 'LONG_SCALE', 'HEIGHT_SCALE'];
    const lines = names.map((n, i) => `${n}: ${rec[i]}`);
    const arr = ['LINE_NUM_COEFF', 'LINE_DEN_COEFF', 'SAMP_NUM_COEFF', 'SAMP_DEN_COEFF'];
    arr.forEach((n, a) => rec.slice(12 + 20 * a, 32 + 20 * a).forEach((v, k) => lines.push(`${n}_${k + 1}: ${v.toExponential(15)}`)));
    return `${lines.join('\n')}\n`;
  }

  // ---- multi-image point (REQ-MEN-11) ----
  /** Intersect image measurements [{layer, x, y}] → result with the error budget. */
  function multiImagePoint(meas, { pick = app.prefs.get('pickSigmaPx') ?? 0.5 } = {}) {
    if (meas.length < 2) throw new Error('a multi-image point needs two or more images');
    const ls = meas.map((m) => app.layers.get(m.layer) ?? m.layer);
    if (new Set(ls.map((l) => l.id)).size < meas.length) throw new Error('measure the point in different images');
    const h0 = ls[0].groundWithTerrain(meas[0].x, meas[0].y)?.h ?? ls[0].defaultHeight();
    const obs = meas.map((m, i) => ({ model: ls[i].modelId, x: m.x, y: m.y, sigma: app.core.observationSigma(ls[i].modelId, m.x, m.y, h0, pick) }));
    const r = app.core.intersect(obs);
    const N = app.core.undulation(r.lat, r.lon);
    return {
      ...r,
      msl: Number.isFinite(N) ? r.h - N : null,
      undulation: N,
      geoid: app.core.geoidName ?? 'EGM96',
      mgrs: app.core.mgrs(r.lat, r.lon, 5),
      // English in the measurement record (project data, log export); the toast shows warningText.
      warning: r.minConvergenceDeg < 10 ? `Weak geometry: the rays converge at ${r.minConvergenceDeg.toFixed(1)}° (under 10°)` : '',
      warningText: r.minConvergenceDeg < 10 ? t('Weak geometry: the rays converge at {deg}° (under 10°)', { deg: num(r.minConvergenceDeg, 1) }) : '',
      images: ls.map((l, i) => ({ layer: l.id, image: l.info.iid, model: l.modelName, x: meas[i].x, y: meas[i].y, sigmaPx: obs[i].sigma, vx: r.residuals[i][0], vy: r.residuals[i][1] })),
    };
  }
  function logMultiImagePoint(r, p = pane()) {
    const l = app.layers.get(r.images[0].layer);
    const row = app.measureApi.baseRow('Multi-image point', l, { lat: r.lat, lon: r.lon, h: r.h, heightSource: 'multi-image intersection' }, {
      value: r.mgrs,
      units: 'MGRS',
      method: `Multi-image intersection (${r.images.length} images, least squares)`,
      model: r.images.map((m) => m.model).join(' + '),
      coords: { lat: r.lat, lon: r.lon, hae: r.h, msl: r.msl, geoid: r.geoid, mgrs: r.mgrs, datum: 'WGS 84' },
      ce90: r.ce90,
      le90: r.le90,
      sigma: { method: r.ceMethod, covEnu: r.covEnu, sigma0: r.sigma0 },
      extra: { images: r.images, convergenceDeg: [r.minConvergenceDeg, r.maxConvergenceDeg] },
      errorNote: r.warning,
      geom: [[r.lon, r.lat, r.h]],
    });
    app.measureApi.logRow(row, p);
    if (r.warning) toast(r.warningText || r.warning, { kind: 'warn', ms: 6000 });
    return row;
  }

  app.tri = { blockLayers, points, importControl, measure, predict, autoTiePoints, descriptorAffine, solve, applySolution, removeSolution, supText, refitRpc, rpcText, multiImagePoint, logMultiImagePoint, rpcRecordOf, baseModelOf, recordModelOf };

  // ---- tools ----
  let activePoint = null;
  app.tools.register({
    id: 'tri.measure',
    cue: t('Measure block point: click the point in each image (the active image of the panel you click).'),
    onDown(p, e, sx, sy) {
      const l = p.geoLayer();
      if (!l || !activePoint) {
        toast(activePoint ? t('This panel has no image with a sensor model') : t('Choose a block point first (Triangulation dock)'), { kind: 'warn' });
        return true;
      }
      const q = p.imagePoint(sx, sy);
      measure(activePoint, l.id, q.x, q.y);
      p.invalidate();
      return true;
    },
    draw(p, g) {
      const l = p.geoLayer();
      if (!l) return;
      for (const pt of points()) {
        const o = pt.obs?.[l.id];
        const pr = predict(pt, l);
        const at = (x, y) => p.screenPoint(x, y);
        if (pr) {
          const s = at(pr.x, pr.y);
          g.strokeStyle = pt.id === activePoint ? '#ffd400' : '#9aa0a6';
          g.strokeRect(s.x - 6, s.y - 6, 12, 12);
        }
        if (o) {
          const s = at(o.x, o.y);
          g.strokeStyle = pt.kind === 'gcp' ? '#ff5252' : pt.kind === 'check' ? '#40c4ff' : '#69f0ae';
          g.beginPath();
          g.moveTo(s.x - 8, s.y);
          g.lineTo(s.x + 8, s.y);
          g.moveTo(s.x, s.y - 8);
          g.lineTo(s.x, s.y + 8);
          g.stroke();
          g.fillStyle = g.strokeStyle;
          pointText(g, 11);
          g.fillText(pt.name, s.x + 9, s.y - 9);
        }
      }
    },
  });

  app.tools.register({
    id: 'tri.mip',
    cue: t('Multi-Image Point: click the same point in two or more panels (one image each); Enter or a double-click computes it.'),
    onDown(p, e, sx, sy) {
      const g = groundOf(app, p, sx, sy);
      if (!g?.layer) {
        toast(t('Multi-Image Point needs an image with a sensor model in each panel'), { kind: 'warn' });
        return true;
      }
      const list = (this.state.meas ??= []).filter((m) => m.layer !== g.layer.id);
      list.push({ layer: g.layer.id, x: g.x, y: g.y, pane: p.id });
      this.state.meas = list;
      if (list.length >= 2) {
        try {
          const r = multiImagePoint(list);
          this.state.result = r;
          const vals = { mgrs: r.mgrs, h: height(r.h, 2), ce: length(r.ce90, 2), le: height(r.le90, 2), warning: r.warningText };
          toast(r.warning ? t('MIP {mgrs} · {h} HAE · CE90 {ce} · LE90 {le} · {warning} (Enter logs it)', vals) : t('MIP {mgrs} · {h} HAE · CE90 {ce} · LE90 {le} (Enter logs it)', vals), { kind: r.warning ? 'warn' : 'info' });
        } catch (err) {
          toast(msgOf(err), { kind: 'warn' });
        }
      }
      for (const mp of app.desktop.multiports) for (const q of mp.panes) q.invalidate();
      return true;
    },
    onDblClick(p) {
      this.onEnter(p);
      return true;
    },
    onEnter(p) {
      const r = this.state.result;
      this.state = {};
      if (r) logMultiImagePoint(r, p);
      app.tools.done();
    },
    draw(p, g, w, hh, s) {
      for (const m of s.meas ?? []) {
        if (m.pane !== p.id) continue;
        const sc = p.screenPoint(m.x, m.y);
        g.strokeStyle = '#ffd400';
        g.beginPath();
        g.arc(sc.x, sc.y, 7, 0, Math.PI * 2);
        g.moveTo(sc.x - 11, sc.y);
        g.lineTo(sc.x + 11, sc.y);
        g.moveTo(sc.x, sc.y - 11);
        g.lineTo(sc.x, sc.y + 11);
        g.stroke();
      }
    },
  });
  C.implement('tri.mip', { enabled: () => !!pane()?.geoLayer(), checked: () => app.tools.current?.id === 'tri.mip', run: () => app.tools.select('tri.mip') });

  // ---- the Triangulation dock ----
  const tiesText = (r) => t('{points, plural, one {# tie point} other {# tie points}} over {pairs, plural, one {# pair} other {# pairs}}', { points: r.points, pairs: r.pairs });
  let lastReport = null;
  let excluded = new Set();
  function dock(el) {
    const render = () => {
      clear(el);
      const ls = blockLayers();
      const pts = points();
      const kindSel = h('select', { class: 'inp', 'aria-label': t('Bias model'), 'data-id': 'tri:kind' }, ...Object.entries(KIND_NAMES).map(([k, n]) => h('option', { value: k, selected: k === (app.prefs.get('triKind') ?? 'shift') }, tr(n))));
      kindSel.addEventListener('change', () => app.prefs.set('triKind', kindSel.value));
      // A step that cannot run yet is greyed out and says why (GUI-032).
      const btn = (label, id, fn, why = null) => {
        const b = h('button', { class: 'btn btn-small', 'data-id': id, disabled: !!why, title: why ?? undefined }, label);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            await fn();
          } catch (e) {
            toast(msgOf(e), { kind: 'error', ms: 7000 });
          } finally {
            b.disabled = false;
            render();
          }
        });
        return b;
      };
      const imagesTbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Image'), t('Model'), t('Points'), t('Fixed')].map((x) => h('th', {}, x)))));
      const tb = h('tbody');
      for (const l of ls) {
        const fx = h('input', { type: 'checkbox', checked: !!l.rec?.blockFixed, 'aria-label': t('Hold {image} fixed', { image: l.info.iid }) });
        fx.addEventListener('change', () => S.transact(t('Hold image fixed'), (tx) => tx.set(l.id, 'blockFixed', fx.checked)));
        tb.appendChild(h('tr', {}, h('td', {}, l.info.iid), h('td', {}, modelLabel(l.modelName)), h('td', {}, String(pts.filter((p) => p.obs?.[l.id]).length)), h('td', {}, fx)));
      }
      imagesTbl.appendChild(tb);
      const ptTbl = h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Point'), t('Role'), t('Images'), ''].map((x) => h('th', {}, x)))));
      const pb = h('tbody');
      for (const p of pts.slice(0, 400)) {
        const sel = h('button', { class: 'btn btn-small', 'aria-pressed': String(activePoint === p.id) }, activePoint === p.id ? t('Measuring') : t('Measure'));
        sel.addEventListener('click', () => {
          activePoint = p.id;
          app.tools.select('tri.measure');
          render();
        });
        pb.appendChild(h('tr', {}, h('td', {}, p.name), h('td', {}, tr(ROLE_NAMES[p.kind] ?? p.kind)), h('td', {}, String(Object.keys(p.obs ?? {}).length)), h('td', {}, sel)));
      }
      ptTbl.appendChild(pb);
      const report = h('div', { class: 'tri-report', 'data-id': 'tri:report' });
      if (lastReport) report.appendChild(reportView(lastReport, render));
      el.append(
        section(t('Images'), imagesTbl),
        section(t('Block points'), h('div', { class: 'row' }, btn(t('Import Control…'), 'tri:import', async () => {
          const [f] = await pickFiles(app, { multiple: false, accept: ['.csv', '.txt', '.tsv'], description: t('Control points') });
          if (f) toast(t('{n, plural, one {# control point} other {# control points}} imported', { n: importControl(await f.text()) }), { kind: 'info' });
        }), btn(t('Automatic Tie Points'), 'tri:auto', async () => {
          const r = await app.activity.track(t('Finding tie points…'), (job) => autoTiePoints({ onProgress: (f) => job.set(f) }));
          toast(tiesText(r), { kind: 'info' });
        }, ls.length < 2 ? t('Open two or more images with sensor models first') : null), btn(t('New Tie Point'), 'tri:new', () => {
          S.transact(t('New tie point'), (tx) => (activePoint = tx.create('tripoint', { name: `TP${String(pts.filter((p) => p.kind === 'tie').length + 1).padStart(3, '0')}`, kind: 'tie', known: null, sigmaH: 0, sigmaV: 0, obs: {} })));
          app.tools.select('tri.measure');
        })), ptTbl),
        section(t('Solve'), field(t('Bias model'), kindSel), h('div', { class: 'row' }, btn(t('Solve'), 'tri:solve', async () => {
          lastReport = await solve({ kind: kindSel.value, fixed: ls.filter((l) => l.rec?.blockFixed).map((l) => l.id), exclude: excluded });
        }, !ls.length || !pts.length ? t('Open images with sensor models and add block points first') : null), btn(t('Apply'), 'tri:apply', async () => {
          if (!lastReport) throw new Error('solve the block first');
          toast(t('Solution {label} applied: the images now use their triangulated models', { label: applySolution(lastReport) }), { kind: 'info' });
        }, lastReport ? null : t('Solve the block first')), btn(t('Remove Solution'), 'tri:remove', async () => removeSolution(), ls.some((l) => l.rec?.triangulation) ? null : t('No triangulated solution is applied'))), report),
      );
    };
    render();
    const off = S.on('change', () => el.isConnected && !el.contains(document.activeElement) && render());
    return () => off?.();
  }

  function reportView(r, rerender) {
    const fmt = (v, d = 2) => (Number.isFinite(v) ? num(v, d) : '—');
    const stats = (s) => (s.n ? t('RMSE E {e} · N {n} · U {u} m (3-D {r3} m) · CE90 {ce} m · LE90 {le} m', { e: fmt(s.rmse[0]), n: fmt(s.rmse[1]), u: fmt(s.rmse[2]), r3: fmt(s.rmse3d), ce: fmt(s.ce90), le: fmt(s.le90) }) : t('no checkpoints'));
    const rows = r.residuals
      .slice()
      .sort((a, b) => b.normalized - a.normalized)
      .slice(0, 300)
      .map((v) => {
        const key = `${v.point}:${v.layer}`;
        const cb = h('input', { type: 'checkbox', checked: excluded.has(key), 'aria-label': t('Exclude {point} in {image}', { point: v.pointName, image: v.image }) });
        cb.addEventListener('change', () => {
          if (cb.checked) excluded.add(key);
          else excluded.delete(key);
        });
        return h('tr', { class: v.flagged ? 'warn' : '' }, h('td', {}, v.image), h('td', {}, v.pointName), h('td', {}, fmt(v.vx)), h('td', {}, fmt(v.vy)), h('td', {}, v.flagged ? t('blunder?') : v.rejected ? t('rejected') : ''), h('td', {}, cb));
      });
    return h(
      'div',
      {},
      h('p', {}, r.converged ? t('{images, plural, one {# image} other {# images}}, {gcps, plural, one {# GCP} other {# GCPs}}, {checks, plural, one {# checkpoint} other {# checkpoints}}, {ties, plural, one {# tie point} other {# tie points}}, {obs, plural, one {# observation} other {# observations}} · {kind} · σ₀ {s0} (dof {dof}, {iterations, plural, one {# iteration} other {# iterations}})', { images: r.counts.images, gcps: r.counts.gcps, checks: r.counts.checkpoints, ties: r.counts.ties, obs: r.counts.observations, kind: tr(KIND_NAMES[r.kind]), s0: fmt(r.sigma0, 3), dof: r.dof, iterations: r.iterations }) : t('{images, plural, one {# image} other {# images}}, {gcps, plural, one {# GCP} other {# GCPs}}, {checks, plural, one {# checkpoint} other {# checkpoints}}, {ties, plural, one {# tie point} other {# tie points}}, {obs, plural, one {# observation} other {# observations}} · {kind} · σ₀ {s0} (dof {dof}, {iterations, plural, one {# iteration} other {# iterations}}, not converged)', { images: r.counts.images, gcps: r.counts.gcps, checks: r.counts.checkpoints, ties: r.counts.ties, obs: r.counts.observations, kind: tr(KIND_NAMES[r.kind]), s0: fmt(r.sigma0, 3), dof: r.dof, iterations: r.iterations })),
      h('p', {}, t('Checkpoints before: {stats}', { stats: stats(r.before) })),
      h('p', {}, t('Checkpoints after: {stats}', { stats: stats(r.after) })),
      h('p', { class: 'hint' }, t('CE90 = 1.5175 · RMSE_r (circular approximation); LE90 = 1.6449 · RMSE_z. Tick observations to exclude and solve again.')),
      h('table', { class: 'grid-table', 'data-id': 'tri:residuals' }, h('thead', {}, h('tr', {}, [t('Image'), t('Point'), t('vx px'), t('vy px'), t('Flag'), t('Exclude')].map((x) => h('th', {}, x)))), h('tbody', {}, ...rows)),
    );
  }

  app.on('ready', (mp) => mp.docks.register({ id: 'triangulation', title: t('Triangulation'), icon: 'model', home: 'right', create: (a, m, el) => dock(el) }));
  C.implement('tri.adjust', { run: () => app.panels.show('triangulation', 'right') });
  C.implement('tri.tiepoints', {
    enabled: () => blockLayers().length >= 2,
    run: async () => {
      app.panels.show('triangulation', 'right');
      try {
        const r = await app.activity.track(t('Finding tie points…'), (job) => autoTiePoints({ onProgress: (f) => job.set(f) }));
        toast(tiesText(r), { kind: 'info' });
      } catch (e) {
        toast(msgOf(e), { kind: 'error' });
      }
    },
  });

  // ---- Solutions (REQ-SNS-15) ----
  C.implement('tri.solutions', {
    run: async () => {
      const list = h('div');
      const render = () => {
        clear(list);
        const sols = S.all('trisolution');
        if (!sols.length) list.appendChild(h('p', { class: 'muted' }, t('No solutions yet.')));
        for (const s of sols) list.appendChild(h('p', {}, h('b', {}, s.label), ' ', t('{created} · {kind} · σ₀ {s0} · checkpoints RMSE_r {rmse} m', { created: s.created ? dateTime(s.created) : '—', kind: tr(KIND_NAMES[s.kind]), s0: Number.isFinite(s.sigma0) ? num(s.sigma0, 3) : '—', rmse: Number.isFinite(s.after?.rmseR) ? num(s.after.rmseR, 2) : '—' })));
        for (const l of app.layers.values()) {
          if (!l.rec?.triangulation) continue;
          const sup = h('button', { class: 'btn btn-small' }, t('Save .sup'));
          sup.addEventListener('click', () => saveBlob(app, new Blob([supText(l)], { type: 'application/json' }), { name: `${l.info.iid || l.rec.name}.sup`, description: t('Support adjustment') }));
          const rpc = h('button', { class: 'btn btn-small' }, t('Write Updated RPC00B'));
          rpc.addEventListener('click', async () => {
            try {
              const f = await refitRpc(l);
              const vals = { rms: f.rmsPx.toExponential(2), max: f.maxPx.toExponential(2) };
              toast(f.poleFree ? t('Refitted RPC00B: RMS {rms} px, maximum {max} px', vals) : t('Refitted RPC00B: RMS {rms} px, maximum {max} px; WARNING: a denominator approaches zero inside the box', vals), { kind: f.poleFree ? 'info' : 'warn', ms: 8000 });
              await saveBlob(app, new Blob([rpcText(f.record)], { type: 'text/plain' }), { name: `${(l.info.fileName ?? l.rec.name).replace(/\.[^.]+$/, '')}_RPC.TXT`, description: t('RPC00B (GDAL text)') });
            } catch (e) {
              toast(msgOf(e), { kind: 'error' });
            }
          });
          list.appendChild(h('div', { class: 'wb-action' }, h('span', {}, `${l.info.iid}: ${l.rec.triangulation.solution} `), sup, rpc));
        }
      };
      render();
      await modal({ title: t('Triangulation Solutions'), body: h('div', {}, list, h('p', { class: 'hint' }, t('Solutions never change the support data in the file: each image keeps its RPC00B and gets a correction record. Undo removes an applied solution.'))), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 620, id: 'tri-solutions' });
    },
  });
}
