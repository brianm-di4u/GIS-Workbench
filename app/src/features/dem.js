// Surface Tools (REQ-DEM-10, REQ-DEM-11, REQ-DEM-02): hillshade, slope, aspect and colour
// relief drawn by the GPU from the DEM layer's own pixels, contour lines, the illumination
// settings, and "Use as Terrain" for DEM GeoTIFFs with their vertical datum recorded and
// converted to HAE.

import { h } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';

export const name = 'dem';

const MODES = { 'dem.hillshade': 'hillshade', 'dem.slope': 'slope', 'dem.aspect': 'aspect', 'dem.relief': 'relief' };

/** Vertical datum from GeoTIFF keys, GDAL metadata or the file name (REQ-DEM-02). */
export function guessVertical(l) {
  const keys = l.info.meta?.geoKeys ?? {};
  const v = keys.VerticalCSTypeGeoKey ?? keys.VerticalDatumGeoKey;
  if (v === 5773 || v === 5171) return 'egm96';
  if (v === 3855 || v === 1027) return 'egm2008';
  if (v === 5703 || v === 5103) return 'navd88';
  if (v === 4979 || v === 6326 || v === 4326) return 'hae';
  const n = `${l.rec?.name ?? ''} ${l.info.meta?.gdalMetadata ?? ''}`;
  if (/copernicus|COP[-_]?DEM|COP30|COP90|EGM2008|EGM08/i.test(n)) return 'egm2008';
  if (/NAVD\s?88/i.test(n)) return 'navd88';
  if (/ellipsoid|HAE\b|WGS84 ellipsoid/i.test(n)) return 'hae';
  return 'egm96'; // SRTM, DTED and most global DEMs
}

export function install(app) {
  const C = app.commands;
  const layer = () => app.activeLayer();
  const isDemLike = (l) => !!l?.chain && l.bands === 1 && (l.kind === 'dem' || l.sampleType === 'f32' || l.sampleType === 'i16');

  for (const [cmd, mode] of Object.entries(MODES)) {
    C.implement(cmd, {
      enabled: () => isDemLike(layer()),
      checked: () => layer()?.chain?.dem?.mode === mode,
      run: () => {
        const on = layer()?.chain?.dem?.mode !== mode;
        app.setChain((c) => {
          c.dem = { ...c.dem, mode: on ? mode : 'none' };
          if (mode === 'relief' && c.colour.palette === 'grey') c.colour.palette = 'terrain';
        }, `Surface: ${mode}`);
        // TE-055: say which north aspect and the sun azimuth are measured from.
        if (on && mode === 'aspect') app.toast('Aspect: clockwise from true north (grid north turned by the meridian convergence; gdaldem uses grid north)');
      },
      menu: () => [
        { label: `${mode[0].toUpperCase()}${mode.slice(1)}`, checked: layer()?.chain?.dem?.mode === mode, run: () => C.run(cmd) },
        '-',
        { label: 'Illumination and Z Factor…', run: () => settings() },
      ],
    });
  }

  async function settings() {
    const l = layer();
    if (!l) return;
    const d = l.chain.dem;
    const num = (v, min, max, step, lbl) => h('input', { class: 'inp inp-num', type: 'number', value: String(v), min: String(min), max: String(max), step: String(step), 'aria-label': lbl });
    const az = num(d.az, 0, 360, 1, 'Sun azimuth');
    const el = num(d.el, 0, 90, 1, 'Sun elevation');
    const z = num(d.z, 0.1, 20, 0.1, 'Z factor');
    const fromImage = h('button', { class: 'btn btn-small' }, 'Use the image’s sun');
    fromImage.addEventListener('click', () => {
      const img = app.activePane()?.layers().find((x) => x.info.sun);
      if (!img) return app.toast('No image in this panel carries sun angles', { kind: 'warn' });
      az.value = img.info.sun.azimuth.toFixed(1);
      el.value = img.info.sun.elevation.toFixed(1);
    });
    const body = h('div', {}, section('Illumination', field('Sun azimuth (°, clockwise from true north)', az), field('Sun elevation (°)', el), fromImage), section('Relief', field('Z factor (vertical exaggeration)', z)), h('p', { class: 'hint' }, 'Gradients use the DEM cell size measured through its geolocation at the centre. Defaults: azimuth 315°, elevation 45°.'));
    if ((await modal({ title: 'Surface Settings', body, buttons: ['OK', 'Cancel'], id: 'surface-settings' })) !== 'OK') return;
    app.setChain((c) => (c.dem = { ...c.dem, az: +az.value, el: +el.value, z: +z.value || 1 }), 'Surface settings');
  }

  C.implement('dem.contours', {
    enabled: () => isDemLike(layer()),
    checked: () => (layer()?.chain?.dem?.contour ?? 0) > 0,
    run: async () => {
      const l = layer();
      const cur = l.chain.dem.contour;
      if (cur > 0) return app.setChain((c) => (c.dem = { ...c.dem, contour: 0 }), 'Contours off');
      const st = l.stats?.[0];
      const range = st?.count ? st.max - st.min : 100;
      const auto = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => range / v <= 25) ?? 1000;
      const inp = h('input', { class: 'inp inp-num', type: 'number', min: '0.1', step: 'any', value: String(auto), 'aria-label': 'Contour interval in metres' });
      if ((await modal({ title: 'Contours', body: field('Interval (m, DEM units)', inp), buttons: ['OK', 'Cancel'], id: 'contours' })) !== 'OK') return;
      app.setChain((c) => (c.dem = { ...c.dem, contour: Math.max(0.1, Number(inp.value) || auto) }), 'Contours');
    },
  });

  /** Use a DEM-like image layer as terrain (REQ-DEM-02). */
  app.useAsTerrain = async (l, vertical) => {
    const m = l.models?.find((x) => x.id === l.modelId);
    const r = await app.pool.run('grid', { handle: l.handle, band: l.chain.bands[0] ?? 0 }, { affinity: l.affinity, label: `terrain ${l.rec.name}`, timeout: 300000 });
    let grid;
    const gt = l.info.meta?.geotransform;
    if (/EPSG:4326/.test(m?.name ?? '') && gt && gt[2] === 0 && gt[4] === 0) {
      // Geographic grid: posts at pixel centres.
      grid = { lat0: gt[3] + gt[5] / 2, lon0: gt[0] + gt[1] / 2, dlat: -gt[5], dlon: gt[1], width: r.width, height: r.height, heights: r.heights };
    } else {
      // Any other geolocation: resample onto a geographic grid through the model.
      const fp = l.footprint();
      if (!fp) throw new Error('the layer has no geolocation');
      const lats = fp.map((p) => p[0]);
      const lons = fp.map((p) => p[1]);
      const [n, s, w, e] = [Math.max(...lats), Math.min(...lats), Math.min(...lons), Math.max(...lons)];
      const cell = l.demCell();
      const dlat = Math.max(cell[1] / 111000, (n - s) / 2047);
      const dlon = Math.max(cell[0] / (111000 * Math.cos(((n + s) / 2) * (Math.PI / 180))), (e - w) / 2047);
      const W = Math.min(2048, Math.ceil((e - w) / dlon) + 1);
      const H = Math.min(2048, Math.ceil((n - s) / dlat) + 1);
      const pts = new Float64Array(W * H * 3);
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) pts.set([n - j * dlat, w + i * dlon, 0], (j * W + i) * 3);
      const xy = app.core.g2iBatch(l.modelId, pts);
      const out = new Float32Array(W * H).fill(NaN);
      const src = r.heights;
      for (let k = 0; k < W * H; k++) {
        const x = xy[2 * k] - 0.5;
        const y = xy[2 * k + 1] - 0.5;
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        if (x0 < 0 || y0 < 0 || x0 >= r.width - 1 || y0 >= r.height - 1) continue;
        const fx = x - x0;
        const fy = y - y0;
        const at = (a, b) => src[b * r.width + a];
        out[k] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
      }
      grid = { lat0: n, lon0: w, dlat, dlon, width: W, height: H, heights: out, resampled: true };
    }
    const nd = l.nodata;
    if (Number.isFinite(nd)) for (let i = 0; i < grid.heights.length; i++) if (grid.heights[i] === nd) grid.heights[i] = NaN;
    app.terrain.addGrid(l, grid, { vertical, label: l.info.format, aligned: !grid.resampled });
    app.store.transact('Use as terrain', (tx) => tx.set(l.id, 'terrain', { vertical }), { kind: 'edit' });
    app.toast(`${l.rec.name} is now terrain (${vertical === 'hae' ? 'heights above the ellipsoid' : vertical === 'navd88' ? 'NAVD88, not converted' : `${vertical.toUpperCase()} heights converted to HAE`})`);
    return grid;
  };

  // Use as Terrain as a command, so the palette, the Ribbon and the open suggestion reach it; the
  // Layer Manager row menu was its only way in (GUI-056).
  const elevationLike = (l) => !!l && l.kind !== 'dem' && l.bands === 1 && ['f32', 'f64', 'i16', 'i32'].includes(l.sampleType) && !!l.modelId && !l.rec?.terrain;
  app.elevationLike = elevationLike;
  C.implement('dem.useterrain', { enabled: () => elevationLike(app.activeLayer?.()), run: () => app.terrainDialog(app.activeLayer()) });

  app.terrainDialog = async (l) => {
    const sel = h('select', { class: 'inp' }, [['egm96', 'Orthometric, EGM96 (SRTM, DTED, most global DEMs)'], ['egm2008', 'Orthometric, EGM2008 (Copernicus DEM; converted with EGM96)'], ['hae', 'Ellipsoidal (HAE, WGS 84)'], ['navd88', 'NAVD88 (not converted)']].map(([v, t]) => h('option', { value: v }, t)));
    sel.value = guessVertical(l);
    const body = h('div', {}, field('Vertical datum of the heights', sel), h('p', { class: 'hint' }, 'Heights convert to HAE before any sensor-model call (REQ-GEO-03). The choice is recorded with the terrain and shown wherever its heights are used.'));
    if ((await modal({ title: `Use as Terrain — ${l.rec.name}`, body, buttons: ['OK', 'Cancel'], id: 'use-terrain' })) !== 'OK') return;
    try {
      await app.useAsTerrain(l, sel.value);
    } catch (e) {
      app.toast(`${l.rec.name}: ${e.message}`, { kind: 'error' });
    }
  };
}
