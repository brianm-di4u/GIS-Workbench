// Aerial triangulation (REQ-GAP-22): the dialog, the job and the report. In the lazy js-aero
// block (lazy/aero.lazy.js); features/aero.js holds the commands and the model sync.
//
// The block's frame images (frame-camera models from the Frame Import Wizard, EXIF/XMP or
// SENSRB) and the Triangulation dock's block points go to the photo bundle's bundle adjustment
// (crates/gw-aero/src/aero.rs) as one job in the analysis worker, stepped with progress and
// cancel. Images that share a camera share its interior orientation, solved with self-calibration
// when asked; positions and attitudes become GNSS and IMU observations with σ, with a lever arm
// and boresight when asked; film images bring their fiducial interior orientation. Applying the
// solution gives each image a "Frame camera (aerial triangulation …)" model kept in the project
// (rec.aeroModel), which undo removes.

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { t, tr, N_, gwError, msgOf } from '../i18n/index.js';
import { num, int, list } from '../i18n/format.js';
import { aeroJob, resectJob, fiducialJob, cameraOfRecord, cameraKey, parseFilmReport, summarize, IO_NAMES } from '../analysis/aero.js';

const MOUNT_NAMES = [N_('lever arm x'), N_('lever arm y'), N_('lever arm z'), N_('boresight x'), N_('boresight y'), N_('boresight z')];
const EO_NAMES = [N_('X'), N_('Y'), N_('Z'), N_('rotation x'), N_('rotation y'), N_('rotation z')];
const IO_UNITS = ['mm', 'mm', 'mm', 'mm⁻²', 'mm⁻⁴', 'mm⁻⁶', 'mm⁻⁸', 'mm⁻¹', 'mm⁻¹', '', '']; // i18n-ignore: units

/** The frame record an image's adjustment starts from: its wizard or open-time model, not an earlier solution. */
export function baseRecordOf(l) {
  const ms = (l.models ?? []).filter((m) => m.record?.type === 3 && !m.aero && !m.error);
  return (ms.find((m) => m.wizard) ?? ms.find((m) => m.id === l.modelId) ?? ms[0])?.record.rec ?? null;
}

export function install(app, { saveBlob }) {
  const C = app.commands;
  const S = app.store;
  const toast = (m, o) => app.toast(m, o);
  const frameLayers = () => [...app.layers.values()].filter((l) => l.kind === 'image' && baseRecordOf(l) && !l.rec?.blockExcluded).sort((a, b) => String(a.rec?.name ?? '').localeCompare(String(b.rec?.name ?? '')));

  /**
   * Gather the block: cameras (grouped), images, points and measurements, with `opts` {selfCal:
   * {f, pp, radial, k4, tangential, affinity}, projection ('auto' | 'brown' | 'fisheye'), nadir,
   * gnss: {use, sigmaH, sigmaV}, imu: {use, sigma}, lever, boresight, robust, maxReject,
   * maxIterations}.
   */
  function collect(opts = {}) {
    const ls = frameLayers();
    if (!ls.length) throw gwError('aerial triangulation: open images with frame-camera models first (Frame Import Wizard, EXIF/XMP or SENSRB)', null, 'E_AERO_NONE');
    const sc = opts.selfCal ?? {};
    const cams = [];
    const keyIndex = new Map();
    const images = [];
    for (const l of ls) {
      const rec = baseRecordOf(l);
      const fio = l.rec?.fiducialIo ?? null;
      let cam;
      if (fio) {
        const c = fio.camera;
        cam = { projection: 'brown', film: true, pixelMm: 0, width: 0, height: 0, io: [c.focalMm, c.x0 ?? 0, c.y0 ?? 0, ...(c.k ?? [0, 0, 0]).slice(0, 3), 0, ...(c.p ?? [0, 0]), 0, 0] };
      } else {
        cam = { ...cameraOfRecord(rec), film: false };
        if (opts.projection === 'fisheye' || opts.projection === 'brown') cam.projection = opts.projection;
      }
      const key = cameraKey(cam, l.exif?.meta?.Model ?? '');
      if (!keyIndex.has(key)) {
        const free = Array(11).fill(false);
        if (sc.f) free[0] = true;
        if (sc.pp) free[1] = free[2] = true;
        if (sc.radial) free[3] = free[4] = free[5] = true;
        if (sc.k4) free[6] = true;
        if (sc.tangential) free[7] = free[8] = true;
        if (sc.affinity) free[9] = free[10] = true;
        keyIndex.set(key, cams.length);
        cams.push({ ...cam, free, sigma: Array(11).fill(0), lever: [0, 0, 0], boresight: [0, 0, 0], mountFree: [!!opts.lever, !!opts.lever, !!opts.lever, !!opts.boresight, !!opts.boresight, !!opts.boresight], mountSigma: Array(6).fill(0), layers: [] });
      }
      const ci = keyIndex.get(key);
      cams[ci].layers.push(l.id);
      const cov = (l.models ?? []).find((m) => m.record?.rec === rec)?.frame?.eo?.cov ?? null;
      const g = opts.gnss?.use ? [opts.gnss.sigmaH ?? (cov ? Math.sqrt(cov[0]) : 5), opts.gnss.sigmaH ?? (cov ? Math.sqrt(cov[8]) : 5), opts.gnss.sigmaV ?? (cov ? Math.sqrt(cov[16]) : 10)] : null;
      const u = opts.imu?.use && !opts.nadir ? [opts.imu.sigma ?? 2, opts.imu.sigma ?? 2, opts.imu.sigma ?? 2] : null;
      images.push({ camera: ci, fixed: !!l.rec?.blockFixed, attitudeKnown: !opts.nadir, gnss: g, imu: u, film: fio?.mmToPx ?? null, record: rec });
    }
    const index = new Map(ls.map((l, i) => [l.id, i]));
    const pts = [];
    const obs = [];
    const obsIndex = [];
    for (const p of app.tri?.points?.() ?? []) {
      const mine = Object.entries(p.obs ?? {}).filter(([lid]) => index.has(lid));
      if (!mine.length) continue;
      const j = pts.length;
      pts.push(p);
      for (const [lid, o] of mine) {
        obs.push({ image: index.get(lid), point: j, x: o.x, y: o.y, sigma: o.sigma ?? 0.5 });
        obsIndex.push({ point: p.id, layer: lid });
      }
    }
    if (!obs.length) throw gwError('aerial triangulation: no block points are measured in the frame images (add tie points and GCPs in the Triangulation dock)', null, 'E_AERO_NOPOINTS');
    const input = {
      cameras: cams,
      images,
      points: pts.map((p) => ({ kind: p.kind, known: p.known ?? null, sigmaH: p.sigmaH, sigmaV: p.sigmaV })),
      obs,
      options: { maxIterations: opts.maxIterations ?? 60, robust: opts.robust ?? 'none', robustK: opts.robustK ?? 0, rejectK: opts.rejectK ?? 4, maxReject: opts.maxReject ?? 0, corrFlag: 0.9 },
    };
    return { input, layers: ls.map((l) => l.id), points: pts.map((p) => p.id), obsIndex, cameras: cams.map((c) => ({ layers: c.layers, film: c.film, projection: c.projection, initial: c.io, free: c.free })) };
  }

  /** Solve in the analysis worker. Returns {report, setup, meta, summary}; `onProgress(p, partial)`; the promise has .cancel(). */
  function solve(opts = {}, { onProgress } = {}) {
    const meta = collect(opts);
    const job = aeroJob(meta.input);
    const run = app.pool.run('aero', { job, maxIterations: meta.input.options.maxIterations }, { kind: 'analysis', transfer: [job.buffer], timeout: 3600000, label: t('Aerial triangulation ({n, plural, one {# image} other {# images}})', { n: meta.layers.length }), onProgress });
    const p = run.then((r) => ({ ...r, meta, summary: summarize(r.report), options: opts }));
    p.cancel = run.cancel;
    return p;
  }

  /** Apply a solution: every image whose camera can be expressed gets its triangulated model (one undo step). */
  function apply(res) {
    const n = S.all('aerosolution').length + 1;
    const label = `AT-${String(n).padStart(3, '0')}`; // i18n-ignore: solution identifier
    let applied = 0;
    S.transact(t('Apply aerial triangulation {label}', { label }), (tx) => {
      tx.create('aerosolution', { label, created: new Date().toISOString(), sigma0: res.report.sigma0, dof: res.report.dof, layers: res.meta.layers, checks: res.report.checkMulti, checksSingle: res.report.checkSingle, cameras: res.report.cameras.map((c) => ({ io: c.io, sigma: c.sigma, mount: c.mount })) });
      res.meta.layers.forEach((lid, i) => {
        const rec = res.report.images[i]?.record;
        if (!rec || !app.layers.get(lid)) return;
        // The model name is an identifier (code and tests match /^Frame camera/): not translated.
        tx.set(lid, 'aeroModel', { label, name: `Frame camera (aerial triangulation ${label})`, rec });
        applied++;
      });
    });
    return { label, applied };
  }

  /** Space resection of one image from the block points with known ground coordinates measured in it. */
  async function resect(l, { robust = true } = {}) {
    const rec = baseRecordOf(l);
    if (!rec) throw gwError('{layer}: resection needs a frame-camera model (Frame Import Wizard)', { layer: l.rec?.name ?? '' }, 'E_AERO_RESECT_MODEL');
    const fio = l.rec?.fiducialIo ?? null;
    const cam = fio ? { projection: 'brown', film: true, io: [fio.camera.focalMm, fio.camera.x0 ?? 0, fio.camera.y0 ?? 0, ...(fio.camera.k ?? [0, 0, 0]).slice(0, 3), 0, ...(fio.camera.p ?? [0, 0]), 0, 0] } : cameraOfRecord(rec);
    const pts = (app.tri?.points?.() ?? []).filter((p) => p.known && p.obs?.[l.id]).map((p) => ({ id: p.id, name: p.name, lat: p.known.lat, lon: p.known.lon, hae: p.known.hae, x: p.obs[l.id].x, y: p.obs[l.id].y, sigma: p.obs[l.id].sigma ?? 0.5 }));
    if (pts.length < 4) throw gwError('{layer}: resection needs four or more control points measured in the image ({n} now)', { layer: l.rec?.name ?? '', n: pts.length }, 'E_AERO_RESECT_POINTS');
    const job = resectJob(cam, { film: fio?.mmToPx ?? null, robust, record: rec, points: pts });
    const r = await app.pool.run('resect', { job }, { kind: 'analysis', transfer: [job.buffer], timeout: 120000, label: t('Space resection of {layer}', { layer: l.rec?.name ?? '' }) });
    return { ...r, points: pts, layer: l.id };
  }

  /** Fiducial interior orientation: marks [{id, col, row, x, y}], model 'affine' | 'similarity'. */
  async function fiducials(marks, model = 'affine') {
    const job = fiducialJob(model, marks);
    return app.pool.run('fiducialio', { job }, { kind: 'analysis', transfer: [job.buffer], timeout: 60000, label: t('Fiducial interior orientation') });
  }

  /** The solution report as JSON text (names, parameters, residuals). */
  function reportText(res) {
    const names = res.meta.layers.map((id) => app.layers.get(id)?.rec?.name ?? id);
    return JSON.stringify({ kind: 'gisworkbench-aerial-triangulation', version: 1, images: names, ioNames: IO_NAMES, options: res.options, setup: res.setup, summary: res.summary, report: { ...res.report, residuals: res.report.residuals.map((r, k) => ({ point: S.get(res.meta.obsIndex[k].point)?.name, image: app.layers.get(res.meta.obsIndex[k].layer)?.rec?.name, vx: r[0], vy: r[1], normalized: r[2], weight: r[3], used: r[4], rejected: r[5] })) } }, null, 1);
  }

  app.aero = Object.assign(app.aero ?? {}, { collect, solve, apply, resect, fiducials, reportText, frameLayers });

  // ---- the report ----
  const fmt = (v, d = 3) => (Number.isFinite(v) ? num(v, d) : '–');
  const sci = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1e-3 && Math.abs(v) < 1e4 ? num(v, 6) : v.toExponential(3)) : '–');
  const paramName = ([kind, owner, which]) => (kind === 0 ? t('image {n} {param}', { n: owner + 1, param: tr(EO_NAMES[which]) }) : kind === 1 ? t('camera {n} {param}', { n: owner + 1, param: IO_NAMES[which] }) : t('camera {n} {param}', { n: owner + 1, param: tr(MOUNT_NAMES[which]) }));
  const statsText = (s) => (s.n ? t('{n, plural, one {# point} other {# points}}: RMSE E {e} · N {nn} · U {u} m', { n: s.n, e: fmt(s.rmse[0]), nn: fmt(s.rmse[1]), u: fmt(s.rmse[2]) }) : t('none'));

  function reportView(res) {
    const r = res.report;
    const s = res.summary;
    const head = h('p', { 'data-id': 'aero:summary' }, r.converged ? t('σ₀ {s0} (dof {dof}) · {iterations, plural, one {# iteration} other {# iterations}} · residual RMS x {rx} px, y {ry} px · {n, plural, one {# measurement} other {# measurements}} · {rej, plural, one {# rejected} other {# rejected}}', { s0: fmt(r.sigma0), dof: int(r.dof), iterations: r.iterations, rx: fmt(s.residualRms[0], 2), ry: fmt(s.residualRms[1], 2), n: s.measurements, rej: s.rejected }) : t('Not converged after {iterations, plural, one {# iteration} other {# iterations}}; σ₀ {s0}', { iterations: r.iterations, s0: fmt(r.sigma0) }));
    const cams = r.cameras.map((c, k) => {
      const rows = IO_NAMES.map((n, q) => h('tr', {}, h('td', {}, n), h('td', {}, sci(res.meta.cameras[k].initial[q])), h('td', {}, sci(c.io[q])), h('td', {}, c.free.includes(q) ? sci(c.sigma[q]) : t('held')), h('td', {}, c.free.includes(q) ? fmt(c.global[q], 4) : ''), h('td', {}, IO_UNITS[q])));
      const mount = c.mountSigma.some(Number.isFinite) ? MOUNT_NAMES.map((n, q) => h('tr', {}, h('td', {}, tr(n)), h('td', {}, ''), h('td', {}, fmt(c.mount[q], 5)), h('td', {}, Number.isFinite(c.mountSigma[q]) ? fmt(c.mountSigma[q], 5) : t('held')), h('td', {}, Number.isFinite(c.mountGlobal[q]) ? fmt(c.mountGlobal[q], 4) : ''), h('td', {}, q < 3 ? 'm' : '°'))) : []; // i18n-ignore: units
      return section(t('Camera {n} ({images, plural, one {# image} other {# images}})', { n: k + 1, images: res.meta.cameras[k].layers.length }), h('table', { class: 'grid-table', 'data-id': `aero:camera-${k}` }, h('thead', {}, h('tr', {}, [t('Parameter'), t('Given'), t('Solved'), t('σ'), t('Global correlation'), t('Unit')].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows, ...mount)));
    });
    const weak = [...r.weak.map(([p, g]) => t('{param}: global correlation {g}', { param: paramName(p), g: fmt(g, 5) })), ...r.pairs.slice(0, 12).map(([a, b, rho]) => t('{a} and {b}: correlation {r}', { a: paramName(a), b: paramName(b), r: fmt(rho, 4) }))];
    const g = s.gnssRms;
    const u = s.imuRms;
    return h(
      'div',
      { 'data-id': 'aero:report' },
      head,
      ...cams,
      section(t('Checkpoints'), h('p', {}, t('Multi-ray: {stats}', { stats: statsText(r.checkMulti) })), h('p', {}, t('Single ray at the known height: {stats}', { stats: statsText(r.checkSingle) })), h('p', {}, r.checkImage[0] ? t('In the images: {n, plural, one {# measurement} other {# measurements}}, RMS x {x} px, y {y} px', { n: r.checkImage[0], x: fmt(r.checkImage[1], 2), y: fmt(r.checkImage[2], 2) }) : t('In the images: none'))),
      g || u ? section(t('Navigation residuals'), g ? h('p', {}, t('GNSS RMS E {e} · N {n} · U {u} m', { e: fmt(g[0]), n: fmt(g[1]), u: fmt(g[2]) })) : null, u ? h('p', {}, t('IMU RMS {a} · {b} · {c}°', { a: fmt(u[0], 4), b: fmt(u[1], 4), c: fmt(u[2], 4) })) : null) : null,
      section(t('Weak geometry'), weak.length ? h('ul', { 'data-id': 'aero:weak' }, ...weak.map((w) => h('li', {}, w))) : h('p', {}, t('No parameter is strongly correlated.'))),
      r.notes.length ? h('p', { class: 'hint' }, list(r.notes)) : null,
    );
  }

  /** A dialog placed at open grows with its report: move it up so its buttons stay on screen. */
  const keepOnScreen = (el) => {
    const dlg = el.closest('.dlg');
    if (!dlg) return;
    const r = dlg.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 10) dlg.style.top = `${Math.max(10, window.innerHeight - r.height - 10)}px`;
  };

  // ---- the dialog ----
  C.implement('tri.aero', {
    enabled: () => frameLayers().length > 0,
    run: async () => {
      const chk = (id, label, on = false) => {
        const c = h('input', { type: 'checkbox', checked: on, 'data-id': `aero:${id}` });
        return [c, h('label', { class: 'chk' }, c, ' ', label)];
      };
      const numIn = (id, v, label) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', min: '0', value: String(v), 'aria-label': label, 'data-id': `aero:${id}` });
      const [cF, lF] = chk('f', t('Focal length'));
      const [cPP, lPP] = chk('pp', t('Principal point'));
      const [cK, lK] = chk('radial', t('Radial k1–k3'));
      const [cK4, lK4] = chk('k4', t('Radial k4'));
      const [cP, lP] = chk('tangential', t('Decentring p1, p2'));
      const [cB, lB] = chk('affinity', t('Affinity b1, b2'));
      const proj = h('select', { class: 'inp', 'aria-label': t('Lens model'), 'data-id': 'aero:projection' }, h('option', { value: 'auto' }, t('As the frame models')), h('option', { value: 'brown' }, t('Brown (pinhole)')), h('option', { value: 'fisheye' }, t('Fisheye (equidistant)')));
      const [cG, lG] = chk('gnss', t('Weight the positions as GNSS observations'), true);
      const gH = numIn('gnss-h', 5, t('GNSS σ horizontal (m)'));
      const gV = numIn('gnss-v', 10, t('GNSS σ vertical (m)'));
      const [cI, lI] = chk('imu', t('Weight the attitudes as IMU observations'));
      const iS = numIn('imu-s', 2, t('IMU σ (°)'));
      const [cN, lN] = chk('nadir', t('Attitude unknown: assume nadir and fit the heading'));
      const [cL, lL] = chk('lever', t('Solve the GNSS lever arm'));
      const [cBo, lBo] = chk('boresight', t('Solve the IMU boresight'));
      const robust = h('select', { class: 'inp', 'aria-label': t('Robust weighting'), 'data-id': 'aero:robust' }, h('option', { value: 'none' }, t('None (least squares)')), h('option', { value: 'huber' }, t('Huber')), h('option', { value: 'cauchy' }, t('Cauchy')));
      const rej = numIn('reject', 0, t('Reject up to this many blunders'));
      const iters = numIn('iterations', 60, t('Maximum iterations'));
      const bar = h('progress', { max: '100', value: '0', 'aria-label': t('Aerial triangulation progress'), 'data-id': 'aero:progress' });
      const status = h('p', { class: 'hint', 'aria-live': 'polite', 'data-id': 'aero:status' });
      // The report scrolls inside the dialog, so its buttons stay on screen (keyboard: focusable).
      const out = h('div', { 'data-id': 'aero:out', tabindex: '0', role: 'region', 'aria-label': t('Aerial triangulation report'), style: { maxHeight: '42vh', overflow: 'auto' } });
      let last = null;
      let running = null;
      const btn = (label, id) => h('button', { class: 'btn', type: 'button', 'data-id': id }, label);
      const bSolve = btn(t('Solve'), 'aero:solve');
      const bStop = btn(t('Stop'), 'aero:stop');
      const bApply = btn(t('Apply'), 'aero:apply');
      const bSave = btn(t('Save Report…'), 'aero:save');
      bStop.disabled = bApply.disabled = bSave.disabled = true;
      const options = () => ({ selfCal: { f: cF.checked, pp: cPP.checked, radial: cK.checked, k4: cK4.checked, tangential: cP.checked, affinity: cB.checked }, projection: proj.value, nadir: cN.checked, gnss: { use: cG.checked, sigmaH: Number(gH.value) || 5, sigmaV: Number(gV.value) || 10 }, imu: { use: cI.checked, sigma: Number(iS.value) || 2 }, lever: cL.checked, boresight: cBo.checked, robust: robust.value, maxReject: Math.max(0, Math.round(Number(rej.value) || 0)), maxIterations: Math.max(1, Math.round(Number(iters.value) || 60)) });
      bSolve.addEventListener('click', async () => {
        bSolve.disabled = bApply.disabled = bSave.disabled = true;
        bStop.disabled = false;
        clear(out);
        status.textContent = t('Solving…');
        bar.value = 0;
        try {
          running = solve(options(), {
            onProgress: (p, part) => {
              bar.value = Math.round(p * 100);
              if (part?.phase === 'iterate') status.textContent = t('Iteration {n}: cost {c}{rej, plural, =0 {} one {, # rejected} other {, # rejected}}', { n: part.iteration, c: fmt(part.cost, 1), rej: part.rejected ?? 0 });
            },
          });
          last = await running;
          bar.value = 100;
          status.textContent = t('Solved.');
          out.appendChild(reportView(last));
          keepOnScreen(out);
          bApply.disabled = bSave.disabled = false;
        } catch (e) {
          status.textContent = e?.cancelled ? t('Stopped.') : msgOf(e);
        } finally {
          running = null;
          bSolve.disabled = false;
          bStop.disabled = true;
        }
      });
      bStop.addEventListener('click', () => running?.cancel?.());
      bApply.addEventListener('click', () => {
        if (!last) return;
        const a = apply(last);
        toast(t('Solution {label} applied to {n, plural, one {# image} other {# images}}', { label: a.label, n: a.applied }), { kind: 'info' });
        bApply.disabled = true;
      });
      bSave.addEventListener('click', () => last && saveBlob(app, new Blob([reportText(last)], { type: 'application/json' }), { name: 'aerial-triangulation.json', description: t('Aerial triangulation report') }));
      const n = frameLayers().length;
      const body = h(
        'div',
        {},
        h('p', {}, t('{n, plural, one {# frame image} other {# frame images}} and the Triangulation dock’s block points (GCPs, checkpoints and tie points).', { n })),
        section(t('Self-calibration'), field(t('Lens model'), proj), h('div', { class: 'tb-row' }, lF, lPP, lK), h('div', { class: 'tb-row' }, lK4, lP, lB)),
        section(t('Navigation data'), lG, h('div', { class: 'tb-row' }, field(t('GNSS σ horizontal (m)'), gH), field(t('GNSS σ vertical (m)'), gV)), lI, field(t('IMU σ (°)'), iS), lN, h('div', { class: 'tb-row' }, lL, lBo)),
        section(t('Solve'), h('div', { class: 'tb-row' }, field(t('Robust weighting'), robust), field(t('Reject up to this many blunders'), rej), field(t('Maximum iterations'), iters)), h('div', { class: 'tb-row' }, bSolve, bStop, bApply, bSave), bar, status),
        out,
      );
      await modal({ title: t('Aerial Triangulation'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 760, id: 'aero' });
      running?.cancel?.();
    },
  });

  C.implement('tri.resect', {
    enabled: () => !!app.activePane()?.geoLayer?.() && !!baseRecordOf(app.activePane().geoLayer()),
    run: async () => {
      const l = app.activePane()?.geoLayer?.();
      if (!l) return;
      let r;
      try {
        r = await resect(l);
      } catch (e) {
        toast(msgOf(e), { kind: 'error', ms: 9000 });
        return;
      }
      const rows = r.points.map((p, k) => h('tr', {}, h('td', {}, p.name), h('td', {}, fmt(r.residuals[k][0], 2)), h('td', {}, fmt(r.residuals[k][1], 2)), h('td', {}, fmt(r.residuals[k][2], 2))));
      const body = h(
        'div',
        { 'data-id': 'aero:resection' },
        h('p', {}, t('{n, plural, one {# point} other {# points}} · {method} · σ₀ {s0} (dof {dof})', { n: r.points.length, method: r.method, s0: fmt(r.sigma0), dof: r.dof })),
        h('p', {}, t('Centre {lat}, {lon}, {h} m HAE · ω {o}° φ {p}° κ {k}°', { lat: num(r.lat, 7), lon: num(r.lon, 7), h: fmt(r.h, 2), o: fmt(r.opk[0], 4), p: fmt(r.opk[1], 4), k: fmt(r.opk[2], 4) })),
        h('p', {}, t('σ: X {x} · Y {y} · Z {z} m; rotations {a} · {b} · {c}°; largest correlation {r}', { x: fmt(r.sigma[0]), y: fmt(r.sigma[1]), z: fmt(r.sigma[2]), a: fmt(r.sigma[3], 4), b: fmt(r.sigma[4], 4), c: fmt(r.sigma[5], 4), r: fmt(r.maxCorr, 3) })),
        h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Point'), t('vx px'), t('vy px'), t('Weight')].map((x) => h('th', { scope: 'col' }, x)))), h('tbody', {}, ...rows)),
      );
      const v = await modal({ title: t('Space Resection: {layer}', { layer: l.rec?.name ?? '' }), body, buttons: [{ label: t('Apply'), value: 'apply', primary: true }, { label: t('Close'), value: 'close' }], width: 620, id: 'aero-resect' });
      if (v === 'apply' && r.record) {
        S.transact(t('Apply space resection'), (tx) => tx.set(l.id, 'aeroModel', { label: 'resection', name: 'Frame camera (space resection)', rec: r.record })); // i18n-ignore: model identifier
        toast(t('{layer} now uses its resected frame model', { layer: l.rec?.name ?? '' }), { kind: 'info' });
      }
    },
  });

  C.implement('tri.fiducials', {
    enabled: () => !!app.activePane()?.geoLayer?.() || [...app.layers.values()].some((x) => x.kind === 'image'),
    run: async () => {
      const l = app.activePane()?.geoLayer?.() ?? [...app.layers.values()].find((x) => x.kind === 'image');
      if (!l) return;
      const rep = h('textarea', { class: 'inp mono', rows: '6', 'aria-label': t('Camera calibration report text'), 'data-id': 'aero:fid-report', placeholder: t('Paste the calibration report text: calibrated focal length, principal point, distortion and the fiducial table') });
      const tb = h('tbody');
      const model = h('select', { class: 'inp', 'aria-label': t('Transform'), 'data-id': 'aero:fid-model' }, h('option', { value: 'affine' }, t('Affine (6 parameters)')), h('option', { value: 'similarity' }, t('Similarity (4 parameters)')));
      const note = h('p', { class: 'hint', 'aria-live': 'polite', 'data-id': 'aero:fid-note' });
      let camera = l.rec?.fiducialIo?.camera ?? null;
      let result = null;
      const rowsOf = (fids) => {
        // Measurements already typed in the table (or kept with the layer) stay with their mark.
        const typed = new Map([...tb.querySelectorAll('tr')].map((r) => [r.dataset.fid, { col: Number(r.querySelector('[data-k="col"]').value || NaN), row: Number(r.querySelector('[data-k="row"]').value || NaN) }]));
        clear(tb);
        for (const f of fids) {
          const inp = (k, v, label) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: Number.isFinite(v) ? String(v) : '', 'aria-label': label, 'data-k': k });
          const old = typed.get(f.id) ?? l.rec?.fiducialIo?.marks?.find((m) => m.id === f.id);
          tb.appendChild(h('tr', { 'data-fid': f.id }, h('td', {}, f.id), h('td', {}, inp('x', f.x, t('Fiducial {id} x (mm)', { id: f.id }))), h('td', {}, inp('y', f.y, t('Fiducial {id} y (mm)', { id: f.id }))), h('td', {}, inp('col', old?.col, t('Fiducial {id} column (px)', { id: f.id }))), h('td', {}, inp('row', old?.row, t('Fiducial {id} row (px)', { id: f.id })))));
        }
      };
      rowsOf(l.rec?.fiducialIo?.marks ?? []);
      let parsed = '';
      rep.addEventListener('change', () => {
        if (rep.value === parsed) return; // the blur after a scripted change: nothing new
        parsed = rep.value;
        try {
          const c = parseFilmReport(rep.value);
          camera = { focalMm: c.focalMm, x0: c.x0, y0: c.y0, k: c.k, p: c.p };
          rowsOf(c.fiducials);
          note.textContent = t('Focal length {f} mm, principal point {x}, {y} mm, {n, plural, one {# fiducial} other {# fiducials}}', { f: fmt(c.focalMm, 3), x: fmt(c.x0), y: fmt(c.y0), n: c.fiducials.length });
        } catch (e) {
          note.textContent = msgOf(e);
        }
      });
      const marks = () => [...tb.querySelectorAll('tr')].map((tr0) => {
        const v = (k) => Number(tr0.querySelector(`[data-k="${k}"]`).value);
        return { id: tr0.dataset.fid, x: v('x'), y: v('y'), col: v('col'), row: v('row') };
      }).filter((m) => [m.x, m.y, m.col, m.row].every(Number.isFinite) && tb.querySelector(`[data-fid="${m.id}"] [data-k="col"]`).value !== '');
      const compute = h('button', { class: 'btn', type: 'button', 'data-id': 'aero:fid-compute' }, t('Compute'));
      compute.addEventListener('click', async () => {
        try {
          result = await fiducials(marks(), model.value);
          note.textContent = t('RMS {rms} µm, largest {max} µm · scan pixel {px} × {py} µm · rotation {rot}°{mirror, select, true {, mirrored} other {}}', { rms: fmt(result.rmsUm, 2), max: fmt(result.maxUm, 2), px: fmt(result.pixelUm[0], 3), py: fmt(result.pixelUm[1], 3), rot: fmt(result.rotationDeg, 3), mirror: String(result.mirrored) });
        } catch (e) {
          result = null;
          note.textContent = msgOf(e);
        }
      });
      const body = h('div', {}, section(t('Calibration'), rep), section(t('Fiducial marks'), h('table', { class: 'grid-table' }, h('thead', {}, h('tr', {}, [t('Mark'), t('x mm'), t('y mm'), t('Column'), t('Row')].map((x) => h('th', { scope: 'col' }, x)))), tb), field(t('Transform'), model), compute, note));
      const v = await modal({ title: t('Film Interior Orientation: {layer}', { layer: l.rec?.name ?? '' }), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 680, id: 'aero-fiducials' });
      if (v !== 'ok') return;
      if (!camera) {
        toast(t('Paste the camera calibration report first'), { kind: 'warn' });
        return;
      }
      if (!result) result = await fiducials(marks(), model.value).catch((e) => (toast(msgOf(e), { kind: 'warn' }), null));
      if (!result) return;
      S.transact(t('Film interior orientation'), (tx) => tx.set(l.id, 'fiducialIo', { model: model.value, mmToPx: result.mmToPx, pxToMm: result.pxToMm, rmsUm: result.rmsUm, pixelUm: result.pixelUm, marks: marks(), camera }));
      toast(t('{layer}: film interior orientation kept (RMS {rms} µm)', { layer: l.rec?.name ?? '', rms: fmt(result.rmsUm, 2) }), { kind: 'info' });
    },
  });
}
