// SAR geocoding and terrain correction (REQ-GAP-90, REG-085, SDP-2.7 §4.21; lazy js-sargeo block):
// SAR ▸ Terrain Correction and app.sarTerrain. A Sentinel-1 SAFE layer is geocoded onto a terrain
// grid by range-Doppler with its orbit (the annotation's, or a POEORB or RESORB .EOF file the user
// opens: the app downloads nothing), with γ⁰ terrain flattening by projected area and layover and
// shadow masks. The work runs in an analysis worker in the `sargeo` bundle, a few DEM rows per
// step with progress and a cancel between steps. The result is a new raster on the DEM's grid.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { pickOrbit, imageGeometry, windowOver, looks, sargeoParams } from '../analysis/sargeo-job.js';
import { t, gwError } from '../i18n/index.js';
import { int } from '../i18n/format.js';
import { s1Layer } from '../analysis/s1-layer.js';

/** β⁰ (dB) among the decode worker's SAR bands (workers/decode/sicd.js SAR_BANDS). */
const BETA0 = 5;
/** The largest DEM a run takes: the worker holds the heights, values, times and window. */
const MAX_POSTS = 16e6;
/** The largest radar window read at full resolution before looks are taken. */
const MAX_WINDOW = 64e6;

export function install(app) {
  const C = app.commands;
  const core = app.core;
  const demOf = () => {
    const al = app.activePane?.()?.activeLayer?.();
    return (al && app.terrain.entry(al.id)) || app.terrain.dems?.[0] || null;
  };
  const sarOf = () => {
    const al = app.activeLayer?.();
    return s1Layer(al) ? al : [...app.layers.values()].find(s1Layer) ?? null;
  };

  /** A POEORB or RESORB .EOF file → its parsed orbit (kept for the next run). */
  async function readOrbit(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const o = await app.pool.run('safeXml', { kind: 'orbit', bytes }, { label: t('Orbit file {file}', { file: file.name }) });
    if (!(o?.orbit?.t?.length >= 4)) throw gwError('{file} holds no usable orbit state vectors', { file: file.name }, 'E_SAR_ORBIT');
    app.sarTerrain.orbit = { ...o, file: file.name };
    return app.sarTerrain.orbit;
  }

  /**
   * Terrain-correct SAR layer `layer` onto terrain `dem`. opts: flatten (γ⁰, default true; else β⁰),
   * masks (layover and shadow, default true), orbit (a parsed .EOF; default the last one read),
   * looks [lines, pixels] (default about one DEM post). Returns {layer, maskLayer, stats}.
   */
  async function run({ layer = sarOf(), dem = demOf(), flatten = true, masks = true, orbit = app.sarTerrain.orbit ?? null, looks: lk = null } = {}) {
    if (!s1Layer(layer)) throw gwError('terrain correction needs a Sentinel-1 SAFE layer opened with its annotation', null, 'E_SAR_NO_S1');
    if (!dem?.grid) throw gwError('terrain correction needs an elevation model loaded as terrain', null, 'E_SAR_NO_DEM');
    const ann = layer.info.meta.s1.annotation;
    const g = dem.grid;
    if (g.width * g.height > MAX_POSTS) throw gwError('terrain correction: {n} posts is more than the 16 million it takes; crop or resample the elevation model first', { n: int(g.width * g.height) }, 'E_SAR_SIZE');
    let orb;
    try {
      orb = pickOrbit(ann, orbit);
    } catch (e) {
      if (e.code === 'E_SAR_ORBIT_MISSION') throw gwError('the orbit file is for {orbit}, the image is {image}', { orbit: e.orbit, image: e.image }, e.code);
      throw e;
    }
    if (!orb) throw gwError('{layer} has no orbit state vectors, and no orbit file covers it', { layer: layer.rec?.name ?? '' }, 'E_SAR_ORBIT');
    const geom = imageGeometry(ann);
    if (!geom) throw gwError('{layer}: the annotation lacks the timing or range sampling geocoding needs', { layer: layer.rec?.name ?? '' }, 'E_SAR_TIMING');
    const bounds = { north: g.lat0, south: g.lat0 - (g.height - 1) * g.dlat, west: g.lon0, east: g.lon0 + (g.width - 1) * g.dlon };
    const w = windowOver(ann, bounds);
    if (!w) throw gwError('{dem} does not overlap {layer}', { dem: dem.name, layer: layer.rec?.name ?? '' }, 'E_SAR_NO_OVERLAP');
    if (w.w * w.h > MAX_WINDOW) throw gwError('terrain correction: the radar window over {dem} is {n} pixels, more than the 64 million it reads; use a smaller elevation model', { dem: dem.name, n: int(w.w * w.h) }, 'E_SAR_SIZE');
    // Looks: about one DEM post of ground per look, at the scene's incidence. Sentinel-1 orbits are
    // near-polar, so azimuth runs about north-south (the post's dy) and range about east-west (dx).
    const lat = (bounds.north + bounds.south) / 2;
    const dy = g.dlat * core.inverse(lat - 0.5, 0, lat + 0.5, 0).distance;
    const dx = g.dlon * core.inverse(lat, -0.5, lat, 0.5).distance;
    const sinInc = Math.sin(((ann.incidenceMid ?? 35) * Math.PI) / 180);
    const groundRange = geom.range.kind === 'slant' ? geom.range.dr / sinInc : geom.range.dg;
    const [kl, ks] = lk ?? [Math.max(1, Math.round(dy / geom.azSpacing)), Math.max(1, Math.round(dx / groundRange))];
    const label = t('Terrain correction of {layer}', { layer: layer.rec?.name ?? '' });
    let task = null;
    return app.activity.track(
      label,
      async (job) => {
        const read = await app.pool.run('window', { handle: layer.handle, x0: w.x0, y0: w.y0, w: w.w, h: w.h, bands: [BETA0], maxSamples: MAX_WINDOW }, { affinity: layer.affinity, label, timeout: 600000 });
        const L = looks(read.planes[0], w.w, w.h, kl, ks);
        if (!L.nl || !L.ns) throw gwError('terrain correction: the radar window over {dem} is smaller than one look', { dem: dem.name }, 'E_SAR_NO_OVERLAP');
        const z = app.terrain.haeHeights(dem);
        const prm = sargeoParams(orb, ann.t0, geom, g, { l0: w.y0, s0: w.x0, kl, ks, nl: L.nl, ns: L.ns }, { flatten, maskStride: masks ? 1 : 0, maskStep: Math.max(1, dy / 2), maskTol: 0.5, look: 1 });
        task = app.pool.run('sargeo.run', { prm, z, beta: L.beta }, { kind: 'analysis', transfer: [prm.buffer, z.buffer, L.beta.buffer], timeout: 3600000, label, part: true, onProgress: (p) => job.set(p) });
        const r = await task;
        const db = Float32Array.from(r.value, (v) => (v > 0 ? 10 * Math.log10(v) : NaN));
        const base = (layer.rec?.name ?? 'sar').replace(/\.[^.]+$/, '');
        const what = flatten ? 'GAMMA0' : 'BETA0';
        const gt = [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat];
        const desc = `GIS Workbench terrain correction (range-Doppler, ${orb.source} orbit${flatten ? ', gamma-nought by projected area' : ''}) of ${layer.rec?.name ?? ''} on ${dem.name}, dB`;
        const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: db }, { epsg: 4326, geotransform: gt, nodata: NaN, description: desc });
        const { layers } = await openImageFile(app, new File([bytes], `${what}_TC_${base}.tif`, { type: 'image/tiff' }));
        let maskLayer = null;
        if (masks) {
          const mb = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'u8', data: r.mask }, { epsg: 4326, geotransform: gt, description: `GIS Workbench layover (1) and shadow (2) mask of ${layer.rec?.name ?? ''} on ${dem.name}` });
          maskLayer = (await openImageFile(app, new File([mb], `MASK_TC_${base}.tif`, { type: 'image/tiff' }))).layers[0];
        }
        const stats = { posts: g.width * g.height, valued: r.counts[0], layover: r.counts[1], shadow: r.counts[2], orbit: orb.source, looks: [kl, ks] };
        app.sarTerrain.last = stats;
        return { layer: layers[0], maskLayer, stats };
      },
      { cancel: () => task?.cancel() },
    );
  }

  app.sarTerrain.run = run;
  app.sarTerrain.readOrbit = readOrbit;

  C.implement('sar.terrain', {
    enabled: () => s1Layer(app.activeLayer?.()),
    run: async () => {
      const layer = sarOf();
      const dems = app.terrain.dems ?? [];
      if (!dems.length) return app.toast(t('Terrain Correction needs an elevation model: open one and choose Use as Terrain.'), { kind: 'warn', ms: 6000 });
      const demSel = h('select', { class: 'inp', 'aria-label': t('Elevation model') }, ...dems.map((d, k) => h('option', { value: String(k), selected: d === demOf() }, d.name)));
      const out = h('select', { class: 'inp', 'aria-label': t('Output') }, h('option', { value: 'gamma' }, t('γ⁰, terrain-flattened')), h('option', { value: 'beta' }, t('β⁰, geocoded only')));
      const mk = h('input', { type: 'checkbox', checked: true, 'aria-label': t('Layover and shadow mask') });
      const orbitName = h('span', { class: 'hint' }, app.sarTerrain.orbit ? app.sarTerrain.orbit.file : t('The annotation’s own orbit'));
      const file = h('input', { type: 'file', accept: '.EOF,.eof,.xml', hidden: true });
      file.addEventListener('change', async () => {
        const f = file.files?.[0];
        if (!f) return;
        try {
          await readOrbit(f);
          orbitName.textContent = f.name;
        } catch (e) {
          app.toast(e.message, { kind: 'error', ms: 6000 });
        }
      });
      const pick = h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, t('Orbit File…'));
      const body = h(
        'div',
        {},
        field(t('Image'), h('span', {}, layer?.rec?.name ?? '')),
        field(t('Elevation model'), demSel),
        field(t('Output'), out),
        field(t('Orbit'), h('div', {}, orbitName, ' ', pick, file)),
        h('label', { class: 'fld fld-inline' }, mk, h('span', {}, t('Layover and shadow mask'))),
        h('p', { class: 'hint' }, t('A precise (POEORB) or restituted (RESORB) orbit file is used when it covers the image; GIS Workbench does not download one.')),
      );
      const r = await modal({ title: t('Terrain Correction'), body, buttons: [{ label: t('Run'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'sar-terrain' });
      if (r !== 'run') return;
      const res = await run({ layer, dem: dems[Number(demSel.value)], flatten: out.value === 'gamma', masks: mk.checked });
      app.toast(t('Terrain correction: {n} posts with a value, {lay} in layover, {sh} in shadow ({orbit} orbit).', { n: int(res.stats.valued), lay: int(res.stats.layover), sh: int(res.stats.shadow), orbit: res.stats.orbit }), { kind: 'info', ms: 8000 });
    },
  });
}
