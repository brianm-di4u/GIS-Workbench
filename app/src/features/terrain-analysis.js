// Terrain analysis (R2.6, Research/08 §5–6): viewsheds — 360°, range fans, range limits,
// inverse and multi-observer overlap, with earth curvature and refraction (REQ-DEM-13) — and
// helicopter landing zones from a DSM with editable doctrine presets (REQ-DEM-14), DEM
// differences and co-registration (REQ-DEM-15), and raster-to-vector polygons (REQ-DEM-18).

import { h } from '../shell/dom.js';
import { gpuViewshed } from '../analysis/gpu-viewshed.js';
import { modal, field } from '../shell/dialogs.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import { openImageFile } from '../formats/open.js';
import { fromParts } from '../vector/geom.js';
import { groundOf } from '../tools/tools.js';
import { contourLines } from './dem-tools.js';

export const name = 'terrain-analysis';

export const DOCTRINES = {
  light: { label: 'Light helicopter (one aircraft)', zone: 25, buffer: 10, slopeSuitable: 7, slopeMarginal: 15, obstructionH: 1, objectW: 30 },
  medium: { label: 'Medium helicopter', zone: 35, buffer: 15, slopeSuitable: 7, slopeMarginal: 15, obstructionH: 1, objectW: 40 },
  heavy: { label: 'Heavy helicopter', zone: 80, buffer: 20, slopeSuitable: 5, slopeMarginal: 10, obstructionH: 1, objectW: 60 },
};

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();
  const toast = (m, o) => app.toast(m, o);
  const core = app.core;

  /** Kind of a terrain: 'DSM', 'DTM' or 'DEM' (unknown), from what made it or its name. */
  const kindOf = (d) => d.kind ?? (/dtm|bare/i.test(d.name) ? 'DTM' : /dsm/i.test(d.name) ? 'DSM' : 'DEM');
  app.terrainKind = kindOf;
  const entry = () => {
    const al = pane()?.activeLayer();
    return (al && app.terrain.entry(al.id)) || app.terrain.dems[0] || null;
  };
  const heights = (d) => d.current ?? d.grid.heights;
  const cellM = (g, lat) => [g.dlon * core.inverse(lat, 0, lat, 1).distance, g.dlat * core.inverse(lat - 0.5, 0, lat + 0.5, 0).distance];
  const postOf = (g, lat, lon) => ({ i: Math.round((lon - g.lon0) / g.dlon), j: Math.round((g.lat0 - lat) / g.dlat) });

  /** A crop of a terrain grid around a point (radius m), or the whole grid. */
  function crop(d, centre, radius) {
    const g = d.grid;
    const H = heights(d);
    if (!radius) return { g, z: H, i0: 0, j0: 0 };
    const [cx, cy] = cellM(g, centre.lat);
    const c = postOf(g, centre.lat, centre.lon);
    const ri = Math.ceil(radius / cx) + 2;
    const rj = Math.ceil(radius / cy) + 2;
    const i0 = Math.max(0, c.i - ri);
    const i1 = Math.min(g.width - 1, c.i + ri);
    const j0 = Math.max(0, c.j - rj);
    const j1 = Math.min(g.height - 1, c.j + rj);
    const w = i1 - i0 + 1;
    const hh = j1 - j0 + 1;
    const z = new Float32Array(w * hh);
    for (let j = 0; j < hh; j++) z.set(H.subarray((j0 + j) * g.width + i0, (j0 + j) * g.width + i0 + w), j * w);
    return { g: { ...g, lat0: g.lat0 - j0 * g.dlat, lon0: g.lon0 + i0 * g.dlon, width: w, height: hh }, z, i0, j0 };
  }

  /**
   * Viewshed from one or more observers [{lat, lon}]. opts: observerH (2), targetH (0),
   * curvature (true; cc 0.87), minDist, maxDist, azStart/azEnd (a fan), inverse, engine ('auto':
   * WebGPU where available (REQ-PRF-07) and the pref allows, else the worker; 'gpu'; 'worker').
   * Returns {grid, vis (Uint8Array: 0/1, or counts for several observers; 255 outside), stats}.
   */
  async function viewshed(observers, { observerH = 2, targetH = 0, curvature = true, cc = 0.87, minDist = 0, maxDist = 0, azStart = 0, azEnd = 0, inverse = false, engine = 'auto', d = entry() } = {}) {
    if (!d?.grid) throw new Error('a viewshed needs terrain loaded as a grid');
    const t0 = performance.now();
    const obs = Array.isArray(observers) ? observers : [observers];
    const c = crop(d, obs[0], maxDist > 0 && obs.length === 1 ? maxDist : 0);
    const g = c.g;
    const [cx, cy] = cellM(g, obs[0].lat);
    const [oh, th] = inverse ? [targetH, observerH] : [observerH, targetH];
    const prm = [g.width, g.height, cx, cy];
    for (const o of obs) {
      const p = postOf(g, o.lat, o.lon);
      if (p.i < 0 || p.j < 0 || p.i >= g.width || p.j >= g.height) throw new Error('the observer is outside the terrain');
      prm.push(p.i, p.j, oh, th, curvature ? cc : 0, minDist, maxDist, azStart, azEnd);
    }
    let vis = null;
    let used = 'worker';
    if (engine === 'gpu' || (engine === 'auto' && app.prefs.get('webgpu') !== false)) {
      try {
        vis = await gpuViewshed(Float64Array.from(prm), c.z);
        if (vis) used = 'webgpu';
      } catch (e) {
        app.log('warn', `WebGPU viewshed failed, using the worker: ${e.message}`);
      }
      if (!vis && engine === 'gpu') throw new Error('WebGPU is not available for the viewshed');
    }
    if (!vis) {
      const z = c.z.slice();
      vis = await app.pool.run('viewshed', { prm: Float64Array.from(prm), z }, { kind: 'analysis', transfer: [z.buffer], priority: 'interactive' });
    }
    let inside = 0;
    let seen = 0;
    for (const v of vis)
      if (v !== 255) {
        inside++;
        if (v > 0) seen++;
      }
    return { grid: g, vis, observers: obs, stats: { posts: inside, visible: seen, visibleFraction: inside ? seen / inside : 0, ms: Math.round(performance.now() - t0), engine: used, curvature: curvature ? cc : 0, inverse, terrain: d.name } };
  }

  /** Landing zones on a DSM. Returns {grid, classes, slope, obstruction, warnings, polygons}. */
  async function hlz({ doctrine = 'light', params = null, d = entry(), aoi = null } = {}) {
    if (!d?.grid) throw new Error('HLZ needs a DSM loaded as terrain');
    const warnings = [];
    const kind = kindOf(d);
    if (kind === 'DTM') warnings.push(`${d.name} is tagged as a DTM (bare earth): obstructions such as buildings and trees are not in it, so zones may be unsafe. Use a DSM.`);
    else if (kind !== 'DSM') warnings.push(`${d.name} is not tagged as a DSM; obstructions are only found if it is one.`);
    const dc = { ...DOCTRINES[doctrine], ...(app.prefs.get('hlzDoctrines')?.[doctrine] ?? {}), ...(params ?? {}) };
    const c = aoi ? crop(d, aoi.centre, aoi.radius) : crop(d, null, 0);
    const g = c.g;
    const lat = g.lat0 - (g.height * g.dlat) / 2;
    const [cx, cy] = cellM(g, lat);
    const z = c.z.slice();
    const r = await app.pool.run('hlz', { prm: Float64Array.from([g.width, g.height, cx, cy, dc.zone, dc.buffer, dc.slopeSuitable, dc.slopeMarginal, dc.obstructionH, dc.objectW]), z }, { kind: 'analysis', transfer: [z.buffer], timeout: 600000 });
    let suitable = 0;
    for (const v of r.classes) if (v === 2) suitable++;
    return { grid: g, ...r, doctrine: dc, kind, warnings, stats: { suitablePosts: suitable } };
  }

  /** Polygons of a class raster's regions equal to `value` (marching squares on a padded mask). */
  function rasterToPolygons(grid, raster, value, { minArea = 0 } = {}) {
    const w = grid.width + 2;
    const hh = grid.height + 2;
    const m = new Float32Array(w * hh);
    for (let j = 0; j < grid.height; j++) for (let i = 0; i < grid.width; i++) m[(j + 1) * w + i + 1] = raster[j * grid.width + i] === value ? 1 : 0;
    const pg = { lat0: grid.lat0 + grid.dlat, lon0: grid.lon0 - grid.dlon, dlat: grid.dlat, dlon: grid.dlon, width: w, height: hh };
    const rings = contourLines(pg, m, 0.5, { indexEvery: 1, maxLines: 50000, levels: [0.5] }).filter((l) => l.pts.length >= 4).map((l) => l.pts.map(([lon, lat]) => [lon, lat]));
    const area = (r) => core.polygonArea(r.map(([lon, lat]) => [lat, lon])).area;
    return rings.filter((r) => !minArea || area(r) >= minArea);
  }

  /** Coloured overlay layer for a class raster (geographic posts). colours: value → [r, g, b]. */
  async function openOverlay(grid, raster, colours, fname) {
    const n = grid.width * grid.height;
    const rgb = new Uint8Array(n * 3);
    for (let k = 0; k < n; k++) {
      const c = colours[raster[k]];
      if (c) rgb.set(c, k * 3);
    }
    const bytes = await writeGeoTiff({ width: grid.width, height: grid.height, bands: 3, type: 'u8', data: rgb }, { epsg: 4326, geotransform: [grid.lon0 - grid.dlon / 2, grid.dlon, 0, grid.lat0 + grid.dlat / 2, 0, -grid.dlat], nodata: 0, photometric: 'rgb', description: fname });
    const { layers } = await openImageFile(app, new File([bytes], fname, { type: 'image/tiff' }));
    app.store.transact('Overlay opacity', (tx) => tx.set(layers[0].id, 'opacity', 0.55), { kind: 'edit' });
    return layers[0];
  }

  function addPolygons(name, rings, attrs) {
    let id;
    app.store.transact(`Raster to vector: ${name}`, (tx) => {
      id = tx.create('vlayer', { name, visible: true, style: { stroke: '#30d070', width: 2, fill: '#30d07030', outline: '#30d070' }, fields: Object.keys(attrs).map((k) => ({ name: k, type: typeof attrs[k] === 'number' ? 'real' : 'text' })), source: { format: 'raster-to-vector' }, created: new Date().toISOString() });
      for (const r of rings) tx.create('feature', { vlayer: id, geom: fromParts('Polygon', [r.map(([lon, lat]) => [lon, lat, 0])]), attrs, name, prov: { kind: 'raster-to-vector' } });
    });
    return id;
  }

  /** DEM difference A − B on A's grid, with an optional co-registration (vertical bias and a shift of up to ±3 posts). */
  function demDifference(a, b, { coregister = false } = {}) {
    const g = a.grid;
    const A = heights(a);
    const sampleB = (lat, lon) => core.demHae(b.coreId, lat, lon) - (a.vertical === 'hae' ? 0 : core.undulation(lat, lon));
    let shift = [0, 0];
    let bias = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((g.width * g.height) / 20000)));
    const rms = (si, sj, bz) => {
      let s = 0;
      let n = 0;
      for (let j = 3; j < g.height - 3; j += step)
        for (let i = 3; i < g.width - 3; i += step) {
          const va = A[j * g.width + i];
          const vb = sampleB(g.lat0 - (j + sj) * g.dlat, g.lon0 + (i + si) * g.dlon);
          if (Number.isFinite(va) && Number.isFinite(vb)) {
            s += (va - vb - bz) ** 2;
            n++;
          }
        }
      return n ? Math.sqrt(s / n) : Infinity;
    };
    if (coregister) {
      let best = { r: Infinity };
      for (let sj = -3; sj <= 3; sj++)
        for (let si = -3; si <= 3; si++) {
          // Bias for this shift: the mean difference.
          let s = 0;
          let n = 0;
          for (let j = 3; j < g.height - 3; j += step)
            for (let i = 3; i < g.width - 3; i += step) {
              const va = A[j * g.width + i];
              const vb = sampleB(g.lat0 - (j + sj) * g.dlat, g.lon0 + (i + si) * g.dlon);
              if (Number.isFinite(va) && Number.isFinite(vb)) {
                s += va - vb;
                n++;
              }
            }
          const bz = n ? s / n : 0;
          const r = rms(si, sj, bz);
          if (r < best.r) best = { r, si, sj, bz };
        }
      shift = [best.si, best.sj];
      bias = best.bz;
    }
    const diff = new Float32Array(g.width * g.height).fill(NaN);
    let s = 0;
    let s2 = 0;
    let n = 0;
    let mn = Infinity;
    let mx = -Infinity;
    for (let j = 0; j < g.height; j++)
      for (let i = 0; i < g.width; i++) {
        const va = A[j * g.width + i];
        const vb = sampleB(g.lat0 - (j + shift[1]) * g.dlat, g.lon0 + (i + shift[0]) * g.dlon);
        if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
        const v = va - vb - bias;
        diff[j * g.width + i] = v;
        s += v;
        s2 += v * v;
        n++;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      }
    return { grid: g, diff, stats: { n, mean: s / n, rms: Math.sqrt(s2 / n), min: mn, max: mx, shiftPosts: shift, bias } };
  }

  app.terrainAnalysis = { viewshed, hlz, rasterToPolygons, openOverlay, addPolygons, demDifference };
  let lastRaster = null;

  // ---- commands ----
  const pickPoint = (cue) =>
    new Promise((res) => {
      app.tools.register({ id: 'ta.pick', cue, onDown(p, e, sx, sy) {
        res(groundOf(app, p, sx, sy));
        app.tools.done();
        return true;
      } });
      app.tools.select('ta.pick');
    });
  async function viewshedDialog(fan) {
    const num = (v, lab) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: v, 'aria-label': lab });
    const oh = num('2', 'Observer height');
    const th = num('0', 'Target height');
    const mn = num('0', 'Minimum range');
    const mx = num(fan ? '3000' : '0', 'Maximum range');
    const a0 = num('0', 'Azimuth from');
    const a1 = num('90', 'Azimuth to');
    const curv = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Earth curvature and refraction' });
    const inv = h('input', { type: 'checkbox', 'aria-label': 'Inverse' });
    const body = h('div', {}, field('Observer height above ground (m)', oh), field('Target height above ground (m)', th), field('Range (m)', h('span', {}, mn, ' to ', mx), '0 = unlimited.'), ...(fan ? [field('Azimuths (° from north)', h('span', {}, a0, ' to ', a1))] : []), h('label', { class: 'fld fld-inline' }, curv, h('span', {}, 'Earth curvature and refraction (k = 0.13, as gdal_viewshed -cc 0.87)')), h('label', { class: 'fld fld-inline' }, inv, h('span', {}, 'Inverse: where the point can be seen from')));
    if ((await modal({ title: fan ? 'Range Fan' : '360° Viewshed', body, buttons: ['Pick Observer', 'Cancel'], id: 'viewshed' })) !== 'Pick Observer') return;
    const g = await pickPoint('Click the observer.');
    if (!g) return;
    try {
      const r = await viewshed([{ lat: g.lat, lon: g.lon }], { observerH: +oh.value, targetH: +th.value, minDist: +mn.value, maxDist: +mx.value, azStart: fan ? +a0.value : 0, azEnd: fan ? +a1.value : 0, curvature: curv.checked, inverse: inv.checked });
      lastRaster = { grid: r.grid, raster: r.vis, value: 1, name: 'Visible area' };
      await openOverlay(r.grid, r.vis, { 0: [200, 40, 40], 1: [40, 200, 60] }, `VIEWSHED_${g.lat.toFixed(5)}_${g.lon.toFixed(5)}.tif`);
      toast(`Viewshed: ${(r.stats.visibleFraction * 100).toFixed(1)} % of ${r.stats.posts} posts visible (${r.stats.ms} ms)`);
    } catch (e) {
      toast(e.message, { kind: 'error' });
    }
  }
  C.implement('los.viewshed', { enabled: () => app.terrain.available, run: () => viewshedDialog(false) });
  C.implement('los.fan', { enabled: () => app.terrain.available, run: () => viewshedDialog(true) });
  C.implement('los.hlz', {
    enabled: () => app.terrain.available,
    run: async () => {
      const presets = { ...DOCTRINES };
      const sel = h('select', { class: 'inp', 'aria-label': 'Doctrine' }, ...Object.entries(presets).map(([k, v]) => h('option', { value: k }, v.label)));
      const num = (lab) => h('input', { class: 'inp inp-num', type: 'number', step: 'any', 'aria-label': lab });
      const f = { zone: num('Zone diameter'), buffer: num('Buffer'), slopeSuitable: num('Suitable slope'), slopeMarginal: num('Marginal slope'), obstructionH: num('Obstruction height') };
      const fill = () => {
        const d = { ...presets[sel.value], ...(app.prefs.get('hlzDoctrines')?.[sel.value] ?? {}) };
        for (const k of Object.keys(f)) f[k].value = d[k];
      };
      sel.addEventListener('change', fill);
      fill();
      const body = h('div', {}, field('Doctrine', sel), field('Touchdown zone diameter (m)', f.zone), field('Clear buffer (m)', f.buffer), field('Suitable slope ≤ (°)', f.slopeSuitable), field('Marginal slope ≤ (°)', f.slopeMarginal), field('Obstruction height (m)', f.obstructionH), h('p', { class: 'hint' }, 'Changes are kept as this doctrine’s preset. HLZ needs a DSM: a DTM has no obstructions.'));
      if ((await modal({ title: 'HLZ', body, buttons: ['Run', 'Cancel'], id: 'hlz' })) !== 'Run') return;
      const params = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, Number(v.value)]));
      app.prefs.set('hlzDoctrines', { ...(app.prefs.get('hlzDoctrines') ?? {}), [sel.value]: params });
      try {
        const r = await hlz({ doctrine: sel.value, params });
        for (const w of r.warnings) toast(w, { kind: 'warn', ms: 9000 });
        lastRaster = { grid: r.grid, raster: r.classes, value: 2, name: 'HLZ suitable' };
        await openOverlay(r.grid, r.classes, { 0: [200, 40, 40], 1: [230, 200, 40], 2: [40, 200, 60] }, `HLZ_${sel.value}.tif`);
        toast(`HLZ: ${r.stats.suitablePosts} suitable zone centres`);
      } catch (e) {
        toast(e.message, { kind: 'error' });
      }
    },
  });
  C.implement('dem.r2v', {
    enabled: () => !!lastRaster,
    run: () => {
      const rings = rasterToPolygons(lastRaster.grid, lastRaster.raster, lastRaster.value, { minArea: 25 });
      addPolygons(lastRaster.name, rings, { CLASS: lastRaster.name });
      toast(`${rings.length} polygon(s) from ${lastRaster.name}`);
    },
  });
  C.implement('dem.diff', {
    enabled: () => app.terrain.dems.length >= 2,
    run: async () => {
      const ds = app.terrain.dems;
      const a = h('select', { class: 'inp', 'aria-label': 'DEM A' }, ...ds.map((d, i) => h('option', { value: String(i) }, d.name)));
      const b = h('select', { class: 'inp', 'aria-label': 'DEM B' }, ...ds.map((d, i) => h('option', { value: String(i), selected: i === 1 }, d.name)));
      const co = h('input', { type: 'checkbox', 'aria-label': 'Co-register' });
      if ((await modal({ title: 'DEM Difference', body: h('div', {}, field('A', a), field('minus B', b), h('label', { class: 'fld fld-inline' }, co, h('span', {}, 'Co-register first (vertical bias and a shift of up to ±3 posts)'))), buttons: ['Run', 'Cancel'], id: 'dem-diff' })) !== 'Run') return;
      const r = demDifference(ds[+a.value], ds[+b.value], { coregister: co.checked });
      const g = r.grid;
      const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: r.diff }, { epsg: 4326, geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: 'DEM difference A − B (m)' });
      await openImageFile(app, new File([bytes], 'DEM_DIFF.tif', { type: 'image/tiff' }));
      toast(`A − B: mean ${r.stats.mean.toFixed(2)} m, RMS ${r.stats.rms.toFixed(2)} m, range ${r.stats.min.toFixed(1)} to ${r.stats.max.toFixed(1)} m${co.checked ? `; shift ${r.stats.shiftPosts.join(', ')} posts, bias ${r.stats.bias.toFixed(2)} m` : ''}`, { ms: 9000 });
    },
  });
}
