// OSSIM rigorous models through the sidecar (REQ-GAP-21; the lazy js-ossim block, Full only). The
// sidecar's OSSIM samples the sensor's model over the image's footprint (profile ossim-rpc); this
// block fits an RPC00B to those samples in the analysis worker and adds it to the active image, beside
// the models it has. The fit's error is measured against OSSIM on points the fit did not see, and the
// model says so in its notes.

import { h, fmtNum } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, N_, gwError, msgOf } from '../i18n/index.js';

const NAME = N_('RPC fitted to OSSIM {model}');
const ACCEPT_RMS_PX = 1;

/** The job for gw_fit_rpc_samples from the tool's JSON. */
export function sampleJob(g) {
  const rows = [...g.fit, ...g.check];
  const job = new Float64Array(10 + rows.length * 5);
  job.set([g.box.lat[0], g.box.lat[1], g.box.lon[0], g.box.lon[1], g.box.h[0], g.box.h[1], g.width, g.height, g.fit.length, g.check.length]);
  rows.forEach((r, i) => job.set(r, 10 + i * 5));
  return job;
}

/** What the sidecar's tool returned, checked before anything is fitted. */
export function checkGrid(g, layer) {
  const ok = g?.tool === 'gwb-ossim-model' && Array.isArray(g.fit) && Array.isArray(g.check) && g.fit.length >= 39 && g.check.length > 0 && Number.isFinite(g.width) && Number.isFinite(g.height);
  if (!ok) throw gwError('the sidecar returned no usable OSSIM samples', {}, 'E_OSSIM_OUTPUT');
  if (g.width !== layer.width || g.height !== layer.height) throw gwError('the OSSIM model is for an image of {w} × {h} pixels, and {layer} has {lw} × {lh}', { w: g.width, h: g.height, layer: layer.rec?.name ?? '', lw: layer.width, lh: layer.height }, 'E_OSSIM_SIZE');
  return g;
}

export function install(app) {
  const image = () => {
    const l = app.activeLayer?.();
    return l && l.kind === 'image' && l.handle ? l : null;
  };

  async function fit(layer, grid) {
    checkGrid(grid, layer);
    const job = sampleJob(grid);
    const f = await app.pool.run('fitrpcsamples', { job }, { kind: 'analysis', transfer: [job.buffer], timeout: 300000, label: t('Fitting an RPC to the OSSIM model') });
    if (!f.poleFree) throw gwError('the RPC fitted to the OSSIM model has a pole inside the image; try a narrower height range', {}, 'E_OSSIM_POLE');
    if (!(f.rmsPx <= ACCEPT_RMS_PX)) throw gwError('the RPC does not follow the OSSIM model: {rms} px RMS at the check points, above the limit of {limit} px', { rms: fmtNum(f.rmsPx, 3), limit: ACCEPT_RMS_PX }, 'E_OSSIM_FIT');
    const name = t(NAME, { model: grid.model });
    const rec = Array.from(f.record);
    const notes = [t('OSSIM {version}, {model}; RPC error against that model {rms} px RMS, {max} px at most, on {n} points the fit did not use', { version: grid.ossim, model: grid.model, rms: fmtNum(f.rmsPx, 3), max: fmtNum(f.maxPx, 3), n: grid.check.length }), t('Valid for heights from {h0} to {h1} m above the ellipsoid. The stated error is the fit to OSSIM, not an accuracy on the ground.', { h0: grid.box.h[0], h1: grid.box.h[1] })];
    const id = app.addOssimRpc(layer, { name, rec, notes }, { activate: true });
    app.store.transact(t('OSSIM model'), (tx) => {
      tx.set(layer.id, 'ossimRpc', { name, rec, notes });
      tx.set(layer.id, 'model', name);
    });
    return { name, id, rmsPx: f.rmsPx, maxPx: f.maxPx, minDenominator: f.minDenominator, model: grid.model, ossim: grid.ossim, checks: grid.check.length };
  }

  /** The sample file of a finished job. */
  async function readOutput(job) {
    const out = job?.outputs?.find((o) => o.name.endsWith('.json') && !o.name.endsWith('.gwb-provenance.json'));
    if (!out) throw gwError('the sidecar returned no usable OSSIM samples', {}, 'E_OSSIM_OUTPUT');
    const r = await app.sidecar.client.request('GET', `/v1/files/${out.id}`, { raw: true });
    return JSON.parse(await r.text());
  }

  /** `args`: {file: a sidecar file id, h_min, h_max} for scripts and tests; otherwise a dialog. */
  async function run(args = {}) {
    const l = image();
    if (!l) throw gwError('open an image first', {}, 'E_OSSIM_NO_IMAGE');
    const caps = await app.sidecar.ready();
    const p = caps.profiles.find((x) => x.id === 'ossim-rpc');
    if (!p?.available) throw gwError("the sidecar's {module} module is not installed (needed for {title})", { module: 'OSSIM', title: t('Load OSSIM Rigorous Model') }, 'E_SIDECAR_NO_MODULE');
    let { file, h_min: hMin, h_max: hMax } = args;
    if (!file) {
      const low = h('input', { type: 'number', value: '-100', 'data-id': 'ossim:hmin' });
      const high = h('input', { type: 'number', value: '3000', 'data-id': 'ossim:hmax' });
      const body = h('div', {}, h('p', {}, t('The sidecar opens the sensor metadata with OSSIM and samples its rigorous model, and an RPC is fitted to the samples here. Choose the heights the scene covers, then pick the file OSSIM reads for this sensor, such as a RADARSAT-2 product.xml.')), field(t('Lowest ground height (m above the ellipsoid)'), low), field(t('Highest ground height (m above the ellipsoid)'), high));
      const r = await modal({ title: t('Load OSSIM Rigorous Model'), body, buttons: [{ label: t('Pick in Sidecar…'), value: 'pick', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'ossim-model' });
      if (r !== 'pick') return null;
      hMin = Number(low.value);
      hMax = Number(high.value);
      const picked = await app.sidecar.client.pick('file', t('Sensor metadata for OSSIM'));
      file = picked?.files?.[0]?.id;
      if (!file) return null;
    }
    const options = {};
    if (hMin != null) options.h_min = hMin;
    if (hMax != null) options.h_max = hMax;
    const job = await app.sidecar.convert({ files: [file], profile: 'ossim-rpc', options, open: false, reason: t('Load OSSIM Rigorous Model') });
    if (job?.state !== 'succeeded') return null;
    const grid = await readOutput(job);
    try {
      const r = await fit(l, grid);
      app.toast(t('{model} added to {layer}', { model: r.name, layer: l.rec?.name ?? '' }), { kind: 'info' });
      return r;
    } catch (e) {
      await modal({ title: t('Load OSSIM Rigorous Model'), body: h('p', { role: 'alert' }, msgOf(e)), buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'ossim-model' });
      return null;
    }
  }

  app.commands.implement('model.ossim', { enabled: () => !!image(), run: app.sidecar.guard(run) });
}
