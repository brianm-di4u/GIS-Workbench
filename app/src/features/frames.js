// Frame and line-scanner imagery (REQ-SNS-04, REQ-SNS-14) and RSM (REQ-SNS-03): the frame import
// wizard — a camera calibration (focal length, pixel size, principal point, Brown distortion) and
// an exterior-orientation list (GPS/IMU: image, latitude, longitude, height, ω, φ, κ) — gives each
// matching open image a frame-camera model, kept with the layer so the project restores it; RSM
// polynomial TREs become an "RSM polynomial (experimental)" model on open. Frame, pushbroom and
// RSM models adjust in the block adjustment like RPCs (image-space corrections over any model,
// REQ-SNS-12).

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { parseCsv } from '../vector/csv.js';
import { rsmRecord } from '../sensor/rsm.js';

export const name = 'frames';

export const DEFAULT_CAMERA = { focalMm: 100, pixelMm: 0.0046, cx: null, cy: null, k: [0, 0, 0], p: [0, 0] };

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };
  const stem = (s) => String(s ?? '').replace(/\.[^.]+$/, '').toLowerCase();

  /** Give a layer a frame model and make it active. */
  function applyFrame(l, camera, eo, { save = true } = {}) {
    const cam = { ...DEFAULT_CAMERA, ...camera, width: l.width, height: l.height };
    cam.cx ??= l.width / 2;
    cam.cy ??= l.height / 2;
    const id = app.core.frameModel(cam, eo, `Frame camera (${eo.source ?? 'EO import'})`);
    const info = app.core.modelInfo(id);
    l.models = [...(l.models ?? []).filter((m) => !/^Frame camera/.test(m.name)), { name: info.name, id, info, frame: { camera: cam, eo } }];
    l.modelId = id;
    l.modelName = info.name;
    l.modelInfo = info;
    if (save) S.transact('Frame model', (tx) => {
      tx.set(l.id, 'frameModel', { camera: cam, eo });
      tx.set(l.id, 'model', info.name);
    });
    app.activePane()?.applyOrientation?.();
    app.emit('state');
    return id;
  }
  // Restore frame models saved with layers (project reload).
  app.restoreFrameModel = (l) => {
    if (l.rec?.frameModel) applyFrame(l, l.rec.frameModel.camera, l.rec.frameModel.eo, { save: false });
  };

  /**
   * Import EO for open images: CSV rows "image, lat, lon, h, omega, phi, kappa" (a header row is
   * allowed), matched to layers by file name (without extension). Returns [{layer, id}].
   */
  function importEO(csvText, camera) {
    const rows = parseCsv(csvText).filter((r) => r.length >= 7 && r.slice(1, 7).every((v) => Number.isFinite(Number(v))));
    const layers = [...app.layers.values()].filter((l) => l.kind === 'image');
    const out = [];
    for (const r of rows) {
      const l = layers.find((x) => stem(x.info.fileName ?? x.rec.name) === stem(r[0]) || stem(x.rec.name).startsWith(stem(r[0])));
      if (!l) continue;
      const [lat, lon, hh, omega, phi, kappa] = r.slice(1, 7).map(Number);
      out.push({ layer: l, id: applyFrame(l, camera, { lat, lon, h: hh, omega, phi, kappa, source: 'EO import' }) });
    }
    return out;
  }

  /** RSM from a NITF image subheader's TREs (read by `describe`). */
  app.rsmFromSubheader = (ish) => {
    if (!ish?.rsmTres?.RSMIDA || !ish.rsmTres.RSMPCA) return null;
    return rsmRecord(ish.rsmTres.RSMIDA, ish.rsmTres.RSMPCA);
  };

  app.frames = { applyFrame, importEO, DEFAULT_CAMERA };

  C.implement('tri.frame', {
    enabled: () => app.layers.size > 0,
    run: run(async () => {
      const num = (v, lbl, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: String(v), 'aria-label': lbl });
      const f = num(100, 'Focal length (mm)');
      const px = num(0.0046, 'Pixel size (mm)');
      const cx = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: 'centre', 'aria-label': 'Principal point x (px)' });
      const cy = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: 'centre', 'aria-label': 'Principal point y (px)' });
      const k = [num(0, 'k1'), num(0, 'k2'), num(0, 'k3')];
      const p = [num(0, 'p1'), num(0, 'p2')];
      const eo = h('textarea', { class: 'inp mono', rows: '8', placeholder: 'image,lat,lon,h,omega,phi,kappa\nframe_001,34.5,-116.5,3650,0.1,-0.2,90', 'aria-label': 'Exterior orientation CSV' });
      const body = h('div', {}, section('Camera calibration', field('Focal length (mm)', f), field('Pixel size (mm)', px), field('Principal point (px)', h('div', { class: 'tb-row' }, cx, cy), 'Empty: the image centre'), field('Radial distortion k1 k2 k3 (mm⁻², mm⁻⁴, mm⁻⁶)', h('div', { class: 'tb-row' }, k)), field('Decentring p1 p2', h('div', { class: 'tb-row' }, p))), section('Exterior orientation (GPS/IMU)', eo, h('p', { class: 'hint' }, 'Angles in degrees: ω about east, φ about north, κ about up, from the local east-north-up frame at the camera to the camera frame (camera looking down −z). Heights above the ellipsoid.')));
      if ((await modal({ title: 'Frame Import Wizard', body, width: 620, id: 'tri-frame' })) !== 'OK') return;
      const cam = { focalMm: Number(f.value), pixelMm: Number(px.value), cx: cx.value === '' ? null : Number(cx.value), cy: cy.value === '' ? null : Number(cy.value), k: k.map((x) => Number(x.value) || 0), p: p.map((x) => Number(x.value) || 0) };
      const r = importEO(eo.value, cam);
      app.toast(r.length ? `Frame models for ${r.length} image(s): ${r.map((x) => x.layer.rec.name).join(', ')}` : 'No exterior orientation matched an open image (match is by file name)', { kind: r.length ? 'info' : 'warn' });
    }),
  });
}
