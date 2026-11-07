// UAV structure from motion through the sidecar (2.6, REQ-GAP-29, SCN-63; the lazy js-sfm block). The
// work is the sidecar's sfm-block profile: this dialog chooses the folder, shows the profile's
// options, starts the job, opens the four results and says what the run measured. Full only: Lite
// has no sidecar. The numbers shown come from the run's own report and are never restated as
// accuracy: without ground control the block is only as well placed as its GPS.

import { h } from '../shell/dom.js';
import { modal } from '../shell/dialogs.js';
import { t, gwError } from '../i18n/index.js';

const PROFILE = 'sfm-block';
const IMAGE = /\.jpe?g$/i;

/** What to open, in the order they stack: the frames on top of the orthomosaic, on top of the DSM. */
export const OPEN_ORDER = [/\.dsm\.tif$/i, /\.ortho\.tif$/i, /\.copc\.laz$/i, /\.frames\.geojson$/i];

/** The rows of the summary, from `<stem>.sfm-report.json`. Exported for the unit test. */
export function summaryRows(r) {
  const g = r?.georef ?? {};
  const rows = [];
  if (g.images != null) rows.push([t('Photographs oriented'), t('{done} of {all}', { done: g.registered, all: g.images })]);
  if (g.reprojection_px?.mean != null) rows.push([t('Mean reprojection error'), t('{px} px', { px: g.reprojection_px.mean.toFixed(2) })]);
  if (g.gps_rms_m) rows.push([t('Fit to the GPS (RMS east, north, up)'), t('{e} m, {n} m, {u} m', { e: g.gps_rms_m.east.toFixed(2), n: g.gps_rms_m.north.toFixed(2), u: g.gps_rms_m.up.toFixed(2) })]);
  if (g.focal) rows.push([t('Focal length'), g.focal.refined ? t('{px} px, refined from the photographs', { px: g.focal.px.toFixed(1) }) : t('{px} px, held at the EXIF value', { px: g.focal.px.toFixed(1) })]);
  if (r?.cloud_points != null) rows.push([t('Dense cloud'), t('{n, plural, one {# point} other {# points}}', { n: r.cloud_points })]);
  if (r?.dsm) rows.push([t('DSM cell'), t('{m} m', { m: r.dsm.resolution_m })]);
  if (r?.ortho) rows.push([t('Orthomosaic pixel'), t('{m} m', { m: r.ortho.resolution_m })]);
  return rows;
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
      h('p', { class: 'hint' }, t('The result is placed by the GPS in the photographs, so it is only as accurate as that GPS, and heights are as the GPS recorded them. A height above the ground is only as good as the focal length in EXIF: 1 % wrong is 1 % of the flying height. Ground control points are not used.')),
      form.el,
    );
    const r = args.yes ? 'run' : await modal({ title: t('Structure from Motion with Sidecar'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 640, id: 'sidecar-sfm' });
    if (r !== 'run') return null;
    const fin = await app.sidecar.convert({ files: [folder.id], profile: PROFILE, options: { ...form.read(), ...(args.options ?? {}) }, open: false, reason: t('Structure from Motion with Sidecar'), outputName: folder.name, label: folder.name });
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
      const rows = summaryRows(report).map(([k, v]) => h('tr', {}, h('th', { scope: 'row' }, k), h('td', {}, v)));
      await modal({ title: t('Structure from Motion with Sidecar'), body: h('div', {}, h('table', { class: 'kv', 'data-id': 'sidecar:sfmsummary' }, h('caption', { class: 'hint' }, t('What this run measured. Heights are as the GPS recorded them.')), h('tbody', {}, ...rows))), buttons: [{ label: t('Close'), value: 'close', primary: true }], width: 520, id: 'sidecar-sfm-result' });
    }
    return { job: fin, opened, report };
  }
  app.commands.implement('sidecar.sfm', { run: app.sidecar.guard((a) => sfm(a)) });
}
