// Frame and line-scanner imagery (REQ-SNS-04, REQ-SNS-14, REQ-GAP-23) and RSM (REQ-SNS-03,
// REQ-GAP-18): the frame import wizard — a camera calibration (typed, or read from a USGS
// calibration report, Agisoft or Pix4D XML, PAT-B or OpenCV JSON file) and an exterior
// orientation (an EO list: image, latitude, longitude, height, ω, φ, κ; or each image's own
// EXIF/XMP position and drone angles) — gives each matching open image a frame-camera model,
// kept with the layer so the project restores it. RSM TREs (every polynomial or grid section with
// its RSMPIA/RSMGIA index, adjustable parameters and error covariance) become "RSM polynomial" and
// "RSM grid" models on open. Frame, pushbroom and RSM models adjust in the block adjustment, in
// image space or through their sensor parameters (REQ-SNS-12, REQ-GAP-18/19).

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { parseCsv } from '../vector/csv.js';
import { parseRsm } from '../sensor/rsm.js';
import { parseCameraFile, frameParams, DEFAULT_CAMERA as CAMERA } from '../sensor/camera.js';
import { droneFrame } from '../sensor/exif.js';
import { pickFiles } from '../storage/files.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { list, num as fmt } from '../i18n/format.js';

export const name = 'frames';

export const DEFAULT_CAMERA = CAMERA;

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(msgOf(e), { kind: 'error', ms: 8000 });
    }
  };
  const stem = (s) => String(s ?? '').replace(/\.[^.]+$/, '').toLowerCase();

  /**
   * Give a layer a frame model and make it active. eo = {lat, lon, h, omega, phi, kappa} (ENU
   * ω φ κ) or {kind: 'gimbal', lat, lon, h, yaw, pitch, roll} (drone angles, NED); eo.cov is an
   * optional 7 × 7 a priori covariance of the frame parameters.
   */
  function applyFrame(l, camera, eo, { save = true } = {}) {
    const cam = { ...DEFAULT_CAMERA, ...camera, width: l.width, height: l.height };
    cam.cx ??= l.width / 2;
    cam.cy ??= l.height / 2;
    const orient = eo.kind === 'gimbal' ? { kind: 'gimbal', yaw: eo.yaw, pitch: eo.pitch, roll: eo.roll } : { kind: 'opk', omega: eo.omega ?? 0, phi: eo.phi ?? 0, kappa: eo.kappa ?? 0 };
    const prm = frameParams(cam, { lat: eo.lat, lon: eo.lon, hae: eo.h }, orient, eo.cov ?? null);
    // The model name is an identifier (code and tests match /^Frame camera/): not translated.
    const id = app.core.frameModelEx(prm, `Frame camera (${eo.source ?? 'EO import'})`);
    const info = app.core.modelInfo(id);
    // The wizard's model replaces its earlier one, and an open-time model of the same name (EXIF/XMP).
    l.models = [...(l.models ?? []).filter((m) => !m.wizard && m.name !== info.name), { name: info.name, id, info, wizard: true, record: { type: 3, rec: prm }, frame: { camera: cam, eo } }];
    l.modelId = id;
    l.modelName = info.name;
    l.modelInfo = info;
    if (save)
      S.transact(t('Frame model'), (tx) => {
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

  /**
   * Frame models from each open image's own EXIF/XMP (drone position and angles), with `camera`
   * replacing the image's own calibration when given. Returns [{layer, id}].
   */
  function importExif(camera = null) {
    const out = [];
    for (const l of app.layers.values()) {
      const ex = l.exif;
      if (l.kind !== 'image' || !ex?.meta) continue;
      const f = droneFrame(ex.meta, camera ? { ...camera, width: l.width, height: l.height } : null);
      const dh = ex.centre.hae - f.position.alt; // the geoid separation applied on open
      out.push({ layer: l, id: applyFrame(l, f.camera, { kind: 'gimbal', lat: f.position.lat, lon: f.position.lon, h: f.position.alt + (f.position.datum === 'MSL' ? dh : 0), yaw: f.orientation.yaw, pitch: f.orientation.pitch, roll: f.orientation.roll, cov: f.cov, source: camera ? `EXIF/XMP, ${camera.source ?? 'camera file'}` : `EXIF/XMP, ${f.source}` }) });
    }
    return out;
  }

  /** The RSM of a NITF image subheader's TREs (read by `describe`), every section. */
  app.rsmFromSubheader = (ish) => {
    if (!ish?.rsmTres?.RSMIDA) return null;
    if (!ish._rsm) ish._rsm = parseRsm(ish.rsmTres);
    return ish._rsm;
  };

  /**
   * Fit an RSM to a layer's model in the analysis worker (REQ-GAP-18; the synthetic RSMs the
   * reader is validated against): polynomial sections, or grid sections with `grid`. Returns the
   * RSM object (sensor/rsm.js) with the fit's RMS and maximum error against the model (pixels).
   */
  async function fitRsm(l, { sections = [1, 1], grid = false, powers = [3, 3, 2], nodes = [21, 21], planes = 8, intord = 3, margin = 0.1, heights = null } = {}) {
    const m = (l.models ?? []).find((x) => x.id === l.modelId);
    const rpc = app.tri?.rpcRecordOf?.(l);
    const rec = m?.record ?? (rpc ? { type: 0, rec: rpc } : null);
    if (!rec) throw gwError('{layer}: its model ({model}) cannot be refitted as an RSM', { layer: l.rec?.name ?? '', model: l.modelName ?? '' }, 'E_RSM_FIT_MODEL');
    const [h0, h1] = heights ?? [Math.max(l.modelInfo?.hmin ?? -100, -500), Math.min(l.modelInfo?.hmax ?? 1000, 9000)];
    const job = Float64Array.from([rec.type, rec.rec.length, ...rec.rec, l.height, l.width, h0, h1, sections[0], sections[1], grid ? 1 : 0, ...powers, ...nodes, planes, intord, margin]);
    const r = await app.pool.run('fitrsm', { job }, { kind: 'analysis', transfer: [job.buffer], timeout: 300000, label: t('fit RSM to {layer}', { layer: l.rec?.name ?? '' }) });
    return { ...r, iid: String(l.info?.iid ?? 'GIS WORKBENCH').slice(0, 80), grp: null, origin: [0, 0, 0], axes: [0, 0, 0, 0, 0, 0, 0, 0, 0], applied: null, adjustable: null, cov: null, unmodelled: null, errorSource: null, notes: [] };
  }

  app.frames = { applyFrame, importEO, importExif, fitRsm, DEFAULT_CAMERA, parseCameraFile };

  C.implement('tri.frame', {
    enabled: () => app.layers.size > 0,
    run: run(async () => {
      const numIn = (v, lbl, step = 'any') => h('input', { class: 'inp inp-num', type: 'number', step, value: String(v), 'aria-label': lbl });
      const f = numIn(100, t('Focal length (mm)'));
      const px = numIn(0.0046, t('Pixel size (mm)'));
      const cx = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: t('centre'), 'aria-label': t('Principal point x (px)') });
      const cy = h('input', { class: 'inp inp-num', type: 'number', step: 'any', placeholder: t('centre'), 'aria-label': t('Principal point y (px)') });
      const k = [numIn(0, 'k1'), numIn(0, 'k2'), numIn(0, 'k3')];
      const p = [numIn(0, 'p1'), numIn(0, 'p2')];
      let aff = [0, 0];
      let loaded = null;
      const camNote = h('p', { class: 'hint', 'aria-live': 'polite' });
      const fill = (c) => {
        f.value = String(c.focalMm);
        px.value = String(c.pixelMm);
        cx.value = String(c.cx);
        cy.value = String(c.cy);
        c.k.forEach((v, i) => (k[i].value = String(v)));
        c.p.forEach((v, i) => (p[i].value = String(v)));
        aff = c.aff ?? [0, 0];
      };
      const open = [...app.layers.values()].filter((l) => l.kind === 'image');
      const size = open[0] ? { width: open[0].width, height: open[0].height } : {};
      const load = h('button', { class: 'btn', type: 'button', 'data-id': 'tri-frame-load' }, t('Load Camera File…'));
      load.addEventListener('click', async () => {
        const [file] = await pickFiles(app, { multiple: false, accept: ['.xml', '.txt', '.cam', '.json', '.patb', '.dat'] });
        if (!file) return;
        try {
          const c = parseCameraFile(await file.text(), file.name, { ...size, pixelMm: Number(px.value) });
          fill(c);
          loaded = c.source;
          camNote.textContent = t('{file}: {source} calibration, focal length {f} mm, pixel {px} mm', { file: file.name, source: c.source, f: fmt(c.focalMm, 4), px: fmt(c.pixelMm, 5) }) + (c.notes?.length ? ` (${list(c.notes)})` : '');
        } catch (e) {
          camNote.textContent = msgOf(e);
        }
      });
      // The placeholder is the CSV format itself (column names and a sample row): not translated.
      const eo = h('textarea', { class: 'inp mono', rows: '8', placeholder: 'image,lat,lon,h,omega,phi,kappa\nframe_001,34.5,-116.5,3650,0.1,-0.2,90', 'aria-label': t('Exterior orientation CSV') }); // i18n-ignore
      const nExif = open.filter((l) => l.exif?.meta).length;
      const useExif = h('input', { type: 'checkbox', checked: nExif > 0, disabled: nExif === 0, 'data-id': 'tri-frame-exif', 'aria-label': t('Use each image’s EXIF/XMP position and angles') });
      const body = h(
        'div',
        {},
        section(t('Camera calibration'), h('div', { class: 'tb-row' }, load), camNote, field(t('Focal length (mm)'), f), field(t('Pixel size (mm)'), px), field(t('Principal point (px)'), h('div', { class: 'tb-row' }, cx, cy), t('Empty: the image centre')), field(t('Radial distortion k1 k2 k3 (mm⁻², mm⁻⁴, mm⁻⁶)'), h('div', { class: 'tb-row' }, k)), field(t('Decentring p1 p2'), h('div', { class: 'tb-row' }, p))),
        section(t('Exterior orientation (GPS/IMU)'), h('label', { class: 'chk' }, useExif, ' ', t('Use each image’s EXIF/XMP position and angles ({n, plural, one {# image has them} other {# images have them}})', { n: nExif })), eo, h('p', { class: 'hint' }, t('Angles in degrees: ω about east, φ about north, κ about up, from the local east-north-up frame at the camera to the camera frame (camera looking down −z). Heights above the ellipsoid.'))),
      );
      if ((await modal({ title: t('Frame Import Wizard'), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 620, id: 'tri-frame' })) !== 'ok') return;
      const cam = { focalMm: Number(f.value), pixelMm: Number(px.value), cx: cx.value === '' ? null : Number(cx.value), cy: cy.value === '' ? null : Number(cy.value), k: k.map((x) => Number(x.value) || 0), p: p.map((x) => Number(x.value) || 0), aff, source: loaded ? `${loaded} file` : 'typed calibration' };
      const r = importEO(eo.value, cam);
      const done = new Set(r.map((x) => x.layer));
      // EXIF/XMP images keep their own calibration unless a camera file was loaded.
      if (useExif.checked) for (const x of importExif(loaded ? cam : null)) if (!done.has(x.layer)) r.push(x);
      app.toast(r.length ? t('Frame models for {n, plural, one {# image} other {# images}}: {names}', { n: r.length, names: list(r.map((x) => x.layer.rec.name)) }) : t('No exterior orientation matched an open image (match is by file name)'), { kind: r.length ? 'info' : 'warn' });
    }),
  });
}
