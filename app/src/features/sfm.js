// UAV structure from motion through the sidecar (2.6, REQ-GAP-29, SCN-63; the lazy js-sfm block). The
// work is the sidecar's sfm-block profile: this dialog chooses the folder, shows the profile's
// options, starts the job, opens the four results and says what the run measured. Full only: Lite
// has no sidecar. The numbers shown come from the run's own report and are never restated as
// accuracy: without ground control the block is only as well placed as its GPS.

import { h } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { t, gwError } from '../i18n/index.js';
import { pickFiles, download } from '../storage/files.js';
import { parseControl, controlCsv, readModelHeader, candidates, readiness } from './sfm-gcp.js';

const PROFILE = 'sfm-block';
const STAGE_ONE = 'sfm-model';
const STAGE_TWO = 'sfm-control';
const IMAGE = /\.jpe?g$/i;

/** What to open, in the order they stack: the frames on top of the orthomosaic, on top of the DSM. */
export const OPEN_ORDER = [/\.dsm\.tif$/i, /\.ortho\.tif$/i, /\.copc\.laz$/i, /\.frames\.geojson$/i];

/** The rows of the summary, from `<stem>.sfm-report.json`. Exported for the unit test. */
export function summaryRows(r) {
  const g = r?.georef ?? {};
  const c = g.control;
  const adj = c?.adjustment;
  const rows = [];
  if (g.images != null) rows.push([t('Photographs oriented'), t('{done} of {all}', { done: g.registered, all: g.images })]);
  if (adj?.reprojection_px_after != null) rows.push([t('Reprojection error after the adjustment with the control (RMS)'), t('{px} px', { px: adj.reprojection_px_after.toFixed(2) })]);
  else if (g.reprojection_px?.mean != null) rows.push([t('Mean reprojection error'), t('{px} px', { px: g.reprojection_px.mean.toFixed(2) })]);
  if (g.gps_rms_m) rows.push([t('Fit to the GPS (RMS east, north, up)'), t('{e} m, {n} m, {u} m', { e: g.gps_rms_m.east.toFixed(2), n: g.gps_rms_m.north.toFixed(2), u: g.gps_rms_m.up.toFixed(2) })]);
  if (c?.rmse_check_m) rows.push([t('Checkpoints ({n}, RMS east, north, up)', { n: c.checks }), t('{e} m, {n} m, {u} m', { e: c.rmse_check_m.east.toFixed(3), n: c.rmse_check_m.north.toFixed(3), u: c.rmse_check_m.up.toFixed(3) })]);
  if (c?.rmse_gcp_m) rows.push([t('Ground control points ({n}, RMS east, north, up)', { n: c.gcps }), t('{e} m, {n} m, {u} m', { e: c.rmse_gcp_m.east.toFixed(3), n: c.rmse_gcp_m.north.toFixed(3), u: c.rmse_gcp_m.up.toFixed(3) })]);
  const lens = adj?.lens;
  if (lens) rows.push([t('Focal length after the adjustment with the control'), t('{px} px (was {was} px)', { px: lens.after[0].toFixed(1), was: lens.before[0].toFixed(1) })]);
  const worst = (c?.points ?? []).filter((p) => p.marks_px).sort((a, b) => b.marks_px.max_px - a.marks_px.max_px)[0];
  if (worst) rows.push([t('Mark farthest from where its survey puts it'), t('{px} px, on {id} in {photo}', { px: worst.marks_px.max_px.toFixed(1), id: worst.id, photo: worst.marks_px.max_image })]);
  if (g.focal && !lens) rows.push([t('Focal length'), g.focal.refined ? t('{px} px, refined from the photographs', { px: g.focal.px.toFixed(1) }) : t('{px} px, held at the EXIF value', { px: g.focal.px.toFixed(1) })]);
  if (r?.cloud_points != null) rows.push([t('Dense cloud'), t('{n, plural, one {# point} other {# points}}', { n: r.cloud_points })]);
  if (r?.dsm) rows.push([t('DSM cell'), t('{m} m', { m: r.dsm.resolution_m })]);
  if (r?.ortho) rows.push([t('Orthomosaic pixel'), t('{m} m', { m: r.ortho.resolution_m })]);
  return rows;
}

/** The window of the photograph shown around a point, in photograph pixels. */
const VIEW = { w: 640, h: 440 };

/**
 * The marking dialog (REG-075): for each control point, the photographs it should appear in, each
 * shown at full resolution around where the model puts the point; a click (or the arrow keys and
 * Enter) marks where it really is. Returns the control with its marks, or null when cancelled.
 */
export async function markControl(header, control, photos) {
  const byName = new Map(photos.map((f) => [f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name, f]));
  for (const f of photos) if (!byName.has(f.name)) byName.set(f.name, f);
  const pts = control.points.map((p) => ({ ...p, marks: [...p.marks], cands: candidates(header, p) }));
  let pi = 0;
  let ci = 0;
  let cursor = null;
  let bitmap = null;
  const status = h('p', { role: 'status', 'aria-live': 'polite', 'data-id': 'sfm:markstatus' });
  const list = h('select', { class: 'inp', size: 10, 'aria-label': t('Control points'), 'data-id': 'sfm:points' });
  const caption = h('p', { class: 'hint', 'data-id': 'sfm:photo' });
  const canvas = h('canvas', { width: VIEW.w, height: VIEW.h, tabindex: 0, 'aria-label': t('Photograph: click where the point is, or move the cross with the arrow keys and press Enter'), style: { cursor: 'crosshair', maxWidth: '100%', background: '#222' }, 'data-id': 'sfm:canvas' });
  const btn = (label, fn, id) => {
    const b = h('button', { class: 'btn', type: 'button', 'data-id': id }, label);
    b.addEventListener('click', fn);
    return b;
  };
  const cand = () => pts[pi].cands[ci];
  const origin = () => {
    const c = cand();
    return [Math.round(c.px - VIEW.w / 2), Math.round(c.py - VIEW.h / 2)];
  };
  const markOf = () => pts[pi].marks.find((m) => m.image === cand()?.image);
  function refreshList() {
    const sel = list.value;
    list.replaceChildren(...pts.map((p, i) => h('option', { value: String(i) }, t('{id} ({role}): {n, plural, =0 {not marked} one {# mark} other {# marks}}', { id: p.id, role: p.check ? t('checkpoint') : t('control point'), n: p.marks.length }))));
    list.value = sel || String(pi);
    const r = readiness({ points: pts });
    status.textContent = t('{n} of {all} control points marked in two or more photographs, and {c} checkpoints. At least 3 control points are needed.', { n: r.marked, all: pts.filter((p) => !p.check).length, c: r.checks });
  }
  function draw() {
    const g = canvas.getContext('2d');
    g.fillStyle = '#222';
    g.fillRect(0, 0, VIEW.w, VIEW.h);
    const c = cand();
    if (!c) {
      caption.textContent = t('{id} falls in none of the photographs the model holds.', { id: pts[pi].id });
      return;
    }
    const [ox, oy] = origin();
    if (bitmap) g.drawImage(bitmap, 0, 0);
    const cross = (x, y, colour, r) => {
      g.strokeStyle = colour;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x - r, y);
      g.lineTo(x + r, y);
      g.moveTo(x, y - r);
      g.lineTo(x, y + r);
      g.stroke();
    };
    g.setLineDash([4, 4]);
    cross(c.px - ox, c.py - oy, '#ffd400', 18);
    g.setLineDash([]);
    const m = markOf();
    if (m) cross(m.px - ox, m.py - oy, '#00e5ff', 12);
    if (cursor) cross(cursor[0] - ox, cursor[1] - oy, '#ffffff', 6);
    caption.textContent = t('{id} in {photo} (photograph {i} of {n}). The dashed cross is where the model puts it; {state}', { id: pts[pi].id, photo: c.image, i: ci + 1, n: pts[pi].cands.length, state: m ? t('marked at {x}, {y}.', { x: m.px.toFixed(1), y: m.py.toFixed(1) }) : t('not marked in this photograph.') });
  }
  async function load() {
    bitmap?.close?.();
    bitmap = null;
    cursor = null;
    const c = cand();
    if (c) {
      const f = byName.get(c.image);
      if (!f) {
        caption.textContent = t('{photo} is not in the folder opened in the browser.', { photo: c.image });
      } else {
        const [ox, oy] = origin();
        try {
          bitmap = await createImageBitmap(f, ox, oy, VIEW.w, VIEW.h, { imageOrientation: 'none' });
        } catch (e) {
          caption.textContent = t('{photo} could not be read: {msg}', { photo: c.image, msg: e?.message ?? String(e) });
        }
      }
    }
    draw();
  }
  function setMark(x, y) {
    const c = cand();
    if (!c) return;
    const p = pts[pi];
    p.marks = p.marks.filter((m) => m.image !== c.image).concat([{ image: c.image, px: x, py: y }]);
    refreshList();
    draw();
  }
  canvas.addEventListener('click', (e) => {
    const r = canvas.getBoundingClientRect();
    const [ox, oy] = origin();
    setMark(ox + ((e.clientX - r.left) * VIEW.w) / r.width, oy + ((e.clientY - r.top) * VIEW.h) / r.height);
  });
  canvas.addEventListener('keydown', (e) => {
    const c = cand();
    if (!c) return;
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      const m = markOf();
      const at = cursor ?? (m ? [m.px, m.py] : [c.px, c.py]);
      cursor = [at[0] + d[0], at[1] + d[1]];
      draw();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const at = cursor ?? [c.px, c.py];
      cursor = null;
      setMark(at[0], at[1]);
    }
  });
  list.addEventListener('change', () => {
    pi = Number(list.value);
    ci = 0;
    load();
  });
  const go = (d) => () => {
    const n = pts[pi].cands.length;
    if (!n) return;
    ci = (ci + d + n) % n;
    load();
  };
  const unmark = () => {
    const c = cand();
    if (!c) return;
    pts[pi].marks = pts[pi].marks.filter((m) => m.image !== c.image);
    refreshList();
    draw();
  };
  const body = h(
    'div',
    {},
    h('p', { class: 'hint' }, t('Choose a point, then mark it in each photograph: the more photographs, the better, and at least two. Checkpoints are marked the same way and kept out of the adjustment, to measure it.')),
    h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-start', flexWrap: 'wrap' } }, h('div', { style: { minWidth: '220px', flex: '1 1 220px' } }, list), h('div', { style: { flex: '3 1 640px' } }, canvas, caption, h('div', { class: 'row' }, btn(t('Previous photograph'), go(-1), 'sfm:prev'), btn(t('Next photograph'), go(1), 'sfm:next'), btn(t('Remove this mark'), unmark, 'sfm:unmark')))),
    status,
  );
  refreshList();
  setTimeout(load, 0);
  const r = await modal({ title: t('Mark the ground control points'), body, buttons: [{ label: t('Run with these marks'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 980, id: 'sidecar-sfm-mark' });
  bitmap?.close?.();
  if (r !== 'run') return null;
  return { ...control, points: pts.map(({ cands, ...p }) => p) };
}

export function install(app) {
  async function sfm(args = {}) {
    const caps = await app.sidecar.ready();
    const p = caps.profiles.find((x) => x.id === PROFILE);
    if (!p) throw gwError('the sidecar has no {profile} profile', { profile: PROFILE }, 'E_SIDECAR_NO_PROFILE');
    if (!p.available) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: p.module, title: p.title }, 'E_SIDECAR_NO_MODULE');
    const client = app.sidecar.client;
    const folder = args.folder ?? (await client.pick('folder', t('Choose the folder of UAV photographs'))).files[0];
    if (!folder) return null;
    const count = (folder.entries ?? []).filter((n) => IMAGE.test(n)).length;
    const form = app.sidecar.optionsForm(p, caps);
    const body = h(
      'div',
      {},
      h('p', {}, t('{folder}: {n, plural, one {# JPEG photograph} other {# JPEG photographs}}. One camera, with GPS in EXIF.', { folder: folder.name, n: count })),
      h('p', { class: 'hint' }, t('Orients the photographs, then makes a dense cloud, a DSM and an orthomosaic. It runs on the CPU, and a block of 100 photographs can take an hour or more.')),
      h('p', { class: 'hint' }, t('The result is placed by the GPS in the photographs, so it is only as accurate as that GPS, and heights are as the GPS recorded them. A height above the ground is only as good as the focal length in EXIF: 1 % wrong is 1 % of the flying height. Ground control points are not used here: Structure from Motion with Ground Control uses them.')),
      form.el,
    );
    const r = args.yes ? 'run' : await modal({ title: t('Structure from Motion with Sidecar'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'sidecar-sfm' });
    if (r !== 'run') return null;
    const fin = await app.sidecar.convert({ files: [folder.id], profile: PROFILE, options: { ...form.read(), ...(args.options ?? {}) }, open: false, reason: t('Structure from Motion with Sidecar'), outputName: folder.name, label: folder.name });
    return finish(fin, args);
  }
  /** Open the results of a run and show what it measured (both routes). */
  async function finish(fin, args) {
    const client = app.sidecar.client;
    const opened = [];
    for (const re of OPEN_ORDER) {
      const out = fin.outputs?.find((o) => re.test(o.name));
      if (!out) continue;
      try {
        await app.sidecar.openOutput(out);
        opened.push(out.name);
      } catch (e) {
        app.toast(t('Opening {file}: {msg}', { file: out.name, msg: e?.message ?? String(e) }), { kind: 'error', ms: 9000 });
      }
    }
    let report = null;
    const rep = fin.outputs?.find((o) => /\.sfm-report\.json$/i.test(o.name));
    if (rep) {
      const res = await client.request('GET', `/v1/files/${rep.id}`, { raw: true });
      if (res.ok) report = await res.json();
    }
    if (report && !args.yes) {
      const control = !!report.georef?.control;
      const rows = summaryRows(report).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v)));
      await modal({ title: t('Structure from Motion with Sidecar'), body: h('div', {}, h('table', { class: 'kv', 'data-id': 'sidecar:sfmsummary' }, h('caption', { class: 'hint' }, control ? t('What this run measured. Heights are those of the ground control points.') : t('What this run measured. Heights are as the GPS recorded them.')), h('tbody', {}, ...rows))), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 520, id: 'sidecar-sfm-result' });
    }
    return { job: fin, opened, report };
  }

  /**
   * REG-075, decision 0018: a block placed by ground control, in two jobs. The first orients the
   * photographs and publishes the model; the analyst marks the points in the photographs, opened in
   * the browser; the second places and adjusts the block on them and makes the products.
   */
  async function sfmControl(args = {}) {
    const caps = await app.sidecar.ready();
    const need = (id) => {
      const p = caps.profiles.find((x) => x.id === id);
      if (!p) throw gwError('the sidecar has no {profile} profile', { profile: id }, 'E_SIDECAR_NO_PROFILE');
      if (!p.available) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: p.module, title: p.title }, 'E_SIDECAR_NO_MODULE');
      return p;
    };
    const [one, two] = [need(STAGE_ONE), need(STAGE_TWO)];
    const client = app.sidecar.client;
    const folder = args.folder ?? (await client.pick('folder', t('Choose the folder of UAV photographs'))).files[0];
    if (!folder) return null;
    const ctlFile = args.control ?? (await client.pick('file', t('Choose the ground control file (CSV or gcp_list.txt)'))).files[0];
    if (!ctlFile) return null;
    const ctlRes = await client.request('GET', `/v1/files/${ctlFile.id}`, { raw: true });
    if (!ctlRes.ok) throw gwError('the sidecar could not read {file}', { file: ctlFile.name }, 'E_SIDECAR_JOB');
    const control = parseControl(await ctlRes.text());
    const form1 = app.sidecar.optionsForm(one, caps);
    const form2 = app.sidecar.optionsForm(two, caps);
    const count = (folder.entries ?? []).filter((n) => IMAGE.test(n)).length;
    const body = h(
      'div',
      {},
      h('p', {}, t('{folder}: {n, plural, one {# JPEG photograph} other {# JPEG photographs}}, and {c, plural, one {# point} other {# points}} in {file}.', { folder: folder.name, n: count, c: control.points.length, file: ctlFile.name })),
      h('p', { class: 'hint' }, t('Runs in two stages. The first orients the photographs and places them by their GPS; then you mark each ground control point in the photographs; then the second places the block on the points, adjusts it with them, and makes a dense cloud, a DSM and an orthomosaic.')),
      form1.el,
      form2.el,
    );
    const r = args.yes ? 'run' : await modal({ title: t('Structure from Motion with Ground Control'), body, buttons: [{ label: t('Run the first stage'), value: 'run', primary: true }, { label: t('Use a model from an earlier run'), value: 'reuse' }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'sidecar-sfm-gcp' });
    if (r !== 'run' && r !== 'reuse') return null;
    let model = args.model;
    // The first stage takes hours: a model it published before (a cancelled marking, a failed second
    // stage) starts the run again from the marking. The sidecar keeps its outputs, so they are offered
    // first; a model saved elsewhere is picked as a file.
    if (!model && r === 'reuse') {
      const kept = ((await client.request('GET', '/v1/files')) ?? []).filter((f) => f.origin === 'output' && /\.sfm-model$/i.test(f.name)).reverse();
      const pickFile = async () => (await client.pick('file', t('Choose the model file an earlier first stage published (.sfm-model)'))).files[0];
      if (!kept.length) model = await pickFile();
      else {
        const sel = h('select', { class: 'inp', 'data-id': 'sfm:models' }, ...kept.map((f) => h('option', { value: f.id }, t('{file} ({mb} MB)', { file: f.name, mb: Math.round(f.size / 1e6) }))));
        const how = await modal({ title: t('Use a model from an earlier run'), body: h('label', { class: 'field' }, t('Models the first stage published on this sidecar, newest first (it keeps them for 14 days)'), sel), buttons: [{ label: t('Use this model'), value: 'use', primary: true }, { label: t('Choose a file…'), value: 'file' }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'sidecar-sfm-models' });
        model = how === 'use' ? kept.find((f) => f.id === sel.value) : how === 'file' ? await pickFile() : null;
      }
      if (!model) return null;
    }
    if (!model) {
      const fin = await app.sidecar.convert({ files: [folder.id], profile: STAGE_ONE, options: { ...form1.read(), ...(args.options ?? {}) }, open: false, reason: t('Structure from Motion with Ground Control'), outputName: folder.name, label: folder.name });
      model = fin.outputs?.find((o) => /\.sfm-model$/i.test(o.name));
      if (!model) throw gwError('the first stage published no model file', {}, 'E_SIDECAR_JOB');
    }
    // Whatever stops the run from here on, the model stays for the next try, and so do the marks.
    let marked = control;
    let markedByHand = false;
    const kept = () => {
      app.toast(t('The first stage is kept as {file}: run again and choose it with “Use a model from an earlier run”.', { file: model.name }), { ms: 12000 });
      if (markedByHand) {
        try {
          download(app, new Blob([controlCsv(marked)], { type: 'text/csv' }), `${folder.name}.gcp.csv`);
        } catch {
          /* a name the CSV cannot carry: nothing to save */
        }
      }
    };
    try {
      const res = await client.request('GET', `/v1/files/${model.id}`, { raw: true });
      if (!res.ok) throw gwError('the sidecar could not read {file}', { file: model.name }, 'E_SIDECAR_JOB');
      const header = await readModelHeader(res);
      const epsg = header.georef?.epsg;
      if (epsg !== control.epsg) throw gwError('the control file is in EPSG:{a} and the photographs were placed in EPSG:{b}; give the control points in EPSG:{b}', { a: control.epsg, b: epsg }, 'E_SFM_CONTROL_CRS');
      if (!args.yes) {
        const photos = args.photos ?? (await pickFiles(app, { dir: true, description: t('UAV photographs') }));
        if (!photos.length) return kept(), null;
        // Back to the marks until enough points are marked, with what was marked kept.
        for (;;) {
          const m = await markControl(header, marked, photos);
          if (!m) return kept(), null;
          marked = m;
          markedByHand = true;
          const now = readiness(marked);
          if (now.ready) break;
          app.toast(t('{n} control points are marked in two or more photographs; at least 3 are needed', { n: now.marked }), { kind: 'error', ms: 9000 });
        }
      }
      const ready = readiness(marked);
      if (!ready.ready) throw gwError('{n} control points are marked in two or more photographs; at least 3 are needed', { n: ready.marked }, 'E_SFM_CONTROL_MARKS');
      const csv = await client.upload(new File([controlCsv(marked)], `${folder.name}.gcp.csv`, { type: 'text/csv' }));
      const fin = await app.sidecar.convert({ files: [folder.id, model.id, csv.id], profile: STAGE_TWO, options: { ...form2.read(), ...(args.options2 ?? {}) }, open: false, reason: t('Structure from Motion with Ground Control'), outputName: folder.name, label: folder.name });
      return { ...(await finish(fin, args)), model, control: marked };
    } catch (e) {
      kept();
      throw e;
    }
  }

  app.commands.implement('sidecar.sfm', { run: app.sidecar.guard((a) => sfm(a)) });
  app.commands.implement('sidecar.sfmcontrol', { run: app.sidecar.guard((a) => sfmControl(a)) });
}
