// 2D / 3D (2.0 plan P3; REQ-GLB-01, REQ-GLB-02): a floating button on a georeferenced image panel
// turns the view into an oblique 3D scene of the same place and back. The scene is built on the
// existing three.js 3D view (DN-35/36): terrain from a loaded DEM, else (Online) from the AWS
// Terrain Tiles (Terrarium), else level ground; the active image draped through its own sensor
// model; and the chosen basemap draped on the terrain around it. The camera keeps the 2D view's
// centre. A whole-earth globe at small scales is the remaining part of S-27 (DN-54).

import { h } from '../shell/dom.js';
import { BASEMAPS } from './basemaps.js';

export const name = 'globe';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const lat2y = (lat, n) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * n;
const lon2x = (lon, n) => ((lon + 180) / 360) * n;

export function install(app) {
  const C = app.commands;
  const pane = () => app.activePane();

  /** Decode Web Mercator tiles covering [s, w, n, e] at zoom z into one canvas (or heights). */
  async function mosaic(urlFor, purpose, [s, w, n, e], z, { heights = false, local = null } = {}) {
    const N = 2 ** z;
    const x0 = Math.floor(lon2x(w, N));
    const x1 = Math.floor(lon2x(e, N));
    const y0 = Math.floor(lat2y(n, N));
    const y1 = Math.floor(lat2y(s, N));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 36) throw new Error('the area is too large for the 3D drape');
    const W = (x1 - x0 + 1) * 256;
    const H = (y1 - y0 + 1) * 256;
    const cv = new OffscreenCanvas(W, H);
    const g = cv.getContext('2d', { willReadFrequently: heights });
    const fetch = app.netlog.fetchFor(purpose);
    const jobs = [];
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++)
        jobs.push(
          (async () => {
            let blob;
            if (local) {
              const r = await local.getZxy(z, tx, ty);
              if (!r?.data) return;
              blob = new Blob([r.data]);
            } else {
              const res = await fetch(urlFor(z, tx, ty), { credentials: 'omit' });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              blob = await res.blob();
            }
            const bmp = await createImageBitmap(blob);
            g.drawImage(bmp, (tx - x0) * 256, (ty - y0) * 256);
            bmp.close?.();
          })(),
        );
    await Promise.all(jobs);
    return { cv, g, x0, y0, z, N, W, H };
  }

  /** Mercator pixel of (lat, lon) in a mosaic. */
  const px = (m, lat, lon) => ({ x: (lon2x(lon, m.N) - m.x0) * 256, y: (lat2y(lat, m.N) - m.y0) * 256 });

  /** A (size × size) height grid over the box: DEM, else Terrarium tiles (Online), else level. */
  async function heightsFor(box, size, level) {
    const [s, w, n, e] = box;
    const dlat = (n - s) / (size - 1);
    const dlon = (e - w) / (size - 1);
    const out = new Float32Array(size * size);
    // The loaded DEM that overlaps the box most; past its edge it is held at the edge value, so a
    // local DEM under the image is used rather than going online for the margin around it.
    const overlap = (b) => Math.max(0, Math.min(n, b.north) - Math.max(s, b.south)) * Math.max(0, Math.min(e, b.east) - Math.max(w, b.west));
    const dem = (app.terrain?.dems ?? []).filter((d) => d.bounds && overlap(d.bounds) > 0).sort((a, b) => overlap(b.bounds) - overlap(a.bounds))[0];
    if (dem) {
      const b = dem.bounds;
      const inside = b.south <= s && b.north >= n && b.west <= w && b.east >= e;
      const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) out[j * size + i] = app.core.demHae(dem.coreId, clamp(n - j * dlat, b.south, b.north), clamp(w + i * dlon, b.west, b.east));
      return { heights: fill(out, level), source: inside ? dem.name : `${dem.name} (held level past its edge)` };
    }
    if (app.network?.isOnline()) {
      try {
        const span = Math.max(n - s, (e - w) * Math.cos(((s + n) / 2) * (Math.PI / 180)));
        const z = Math.max(1, Math.min(13, Math.round(Math.log2(360 / span)) + 2));
        const m = await mosaic((zz, x, y) => TERRARIUM.replace('{z}', zz).replace('{x}', x).replace('{y}', y), '3D terrain: AWS Terrain Tiles', box, z, { heights: true });
        const img = m.g.getImageData(0, 0, m.W, m.H).data;
        for (let j = 0; j < size; j++)
          for (let i = 0; i < size; i++) {
            const p = px(m, n - j * dlat, w + i * dlon);
            const k = 4 * (Math.min(m.H - 1, Math.max(0, Math.round(p.y))) * m.W + Math.min(m.W - 1, Math.max(0, Math.round(p.x))));
            // Terrarium: metres = R·256 + G + B/256 − 32768 (MSL); the geoid separation makes it HAE.
            const msl = img[k] * 256 + img[k + 1] + img[k + 2] / 256 - 32768;
            const lat = n - j * dlat;
            const lon = w + i * dlon;
            let und = 0;
            try {
              und = app.core.undulation(lat, lon);
            } catch {
              /* geoid not loaded yet */
            }
            out[j * size + i] = msl + (Number.isFinite(und) ? und : 0);
          }
        return { heights: fill(out, level), source: 'AWS Terrain Tiles (Terrarium)' };
      } catch (err) {
        app.log('warn', `3D terrain tiles: ${err.message}`);
      }
    }
    out.fill(level);
    return { heights: out, source: 'level ground (no DEM loaded; go online for terrain tiles)' };
  }
  const fill = (a, v) => {
    let f = NaN;
    for (const x of a) if (Number.isFinite(x)) {
      f = x;
      break;
    }
    for (let k = 0; k < a.length; k++) if (!Number.isFinite(a[k])) a[k] = Number.isFinite(f) ? f : v;
    return a;
  };

  async function meshFor(heights, size) {
    return app.pool.run('rtin', { z: heights.slice(), size, maxError: 1 }, { kind: 'analysis', label: '3D terrain mesh', timeout: 120000 });
  }

  /** Basemap drape (RGBA + per-vertex UV) over a grid from the chosen basemap. */
  async function basemapDrape(grid, mesh, box) {
    const b = BASEMAPS.find((x) => x.id === app.prefs.get('basemap')) ?? app.basemapCurrent?.();
    if (!b || (!b.local && !app.network?.isOnline())) return null;
    const [s, w, n, e] = box;
    const span = Math.max(n - s, (e - w) * Math.cos(((s + n) / 2) * (Math.PI / 180)));
    const z = Math.max(b.minZoom ?? 0, Math.min(b.maxZoom, Math.round(Math.log2(360 / span)) + 2));
    const m = await mosaic((zz, x, y) => b.url.replace('{z}', zz).replace('{x}', x).replace('{y}', y), `3D basemap: ${b.short}`, box, z, { local: b.local ? b.pm : null });
    const data = new Uint8Array(m.g.getImageData(0, 0, m.W, m.H).data.buffer.slice(0));
    const nv = mesh.xy.length / 2;
    const uv = new Float32Array(2 * nv);
    for (let k = 0; k < nv; k++) {
      const i = mesh.xy[2 * k];
      const j = mesh.xy[2 * k + 1];
      const p = px(m, grid.lat0 - j * grid.dlat, grid.lon0 + i * grid.dlon);
      uv[2 * k] = p.x / m.W;
      uv[2 * k + 1] = p.y / m.H;
    }
    return { data, width: m.W, height: m.H, uv, image: b.short, attribution: b.attribution };
  }

  /** Open the 3D scene of the active image (REQ-GLB-01). */
  async function open3d(p = pane()) {
    const l = p?.geoLayer?.();
    if (!l?.modelId) throw new Error('open a georeferenced image first');
    const W = l.width;
    const H = l.height;
    const corners = [[0, 0], [W, 0], [W, H], [0, H]].map(([x, y]) => l.groundAt(x, y)).filter((g) => g && Number.isFinite(g.lat));
    if (corners.length < 3) throw new Error('the image footprint cannot be placed on the ground');
    const lats = corners.map((c) => c.lat);
    const lons = corners.map((c) => c.lon);
    const pad = 0.15;
    const dLat = (Math.max(...lats) - Math.min(...lats)) * pad;
    const dLon = (Math.max(...lons) - Math.min(...lons)) * pad;
    const box = [Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon];
    const level = corners.reduce((a, c) => a + (c.h ?? 0), 0) / corners.length;
    const centre = { s: (box[0] + box[2]) / 2, w: (box[1] + box[3]) / 2 };
    // Context: the basemap on a box three times wider, laid first so the frame is centred on it.
    const size = 257;
    const outer = [centre.s - 1.5 * (box[2] - box[0]), centre.w - 1.5 * (box[3] - box[1]), centre.s + 1.5 * (box[2] - box[0]), centre.w + 1.5 * (box[3] - box[1])];
    const v = await app.scene3d.ensureView(p);
    const outerH = await heightsFor(outer, size, level);
    const outerGrid = { lat0: outer[2], lon0: outer[1], dlat: (outer[2] - outer[0]) / (size - 1), dlon: (outer[3] - outer[1]) / (size - 1), size };
    const outerMesh = await meshFor(outerH.heights, size);
    let skirt = null;
    try {
      skirt = await basemapDrape(outerGrid, outerMesh, outer);
    } catch (err) {
      app.log('warn', `3D basemap: ${err.message}`);
    }
    // Sink the skirt a little so the image drape always wins where they overlap.
    const sunk = outerH.heights.map((x) => x - 2);
    v.addTerrain({ grid: outerGrid, heights: sunk, mesh: outerMesh, drape: skirt, name: skirt ? `Basemap: ${skirt.image}` : 'Terrain' });
    const inner = await heightsFor(box, 513, level);
    const grid = { lat0: box[2], lon0: box[1], dlat: (box[2] - box[0]) / 512, dlon: (box[3] - box[1]) / 512, size: 513 };
    const mesh = await meshFor(inner.heights, 513);
    const drape = await app.scene3d.drapeFor(l, grid, inner.heights, mesh, 2048);
    v.addTerrain({ grid, heights: inner.heights, mesh, drape, name: l.rec?.name ?? 'image' });
    // Look at the 2D view's centre, obliquely.
    let c = null;
    try {
      c = l.groundAt(p.view.cx, p.view.cy);
    } catch {
      /* fall back to the box centre */
    }
    const [e0, n0] = v.toLocal(c?.lat ?? centre.s, c?.lon ?? centre.w);
    const r = Math.max(200, ((box[2] - box[0]) * 111320) / 1.5);
    v.lookAtLocal(e0, n0, c?.h ?? level, r);
    p.globe = { terrain: inner.source, basemap: skirt?.image ?? null, attribution: skirt?.attribution ?? null };
    app.toast(`3D: terrain from ${inner.source}${skirt ? `; ${skirt.image} basemap around the image` : ''}. Drag to orbit, right-drag to pan, wheel to zoom.`);
    app.emit('state');
    return v;
  }

  function close3d(p = pane()) {
    if (!p?.view3d) return;
    app.pc?.close(p);
    p.globe = null;
    app.emit('state');
  }

  C.implement('glb.toggle', {
    enabled: () => !!pane()?.geoLayer?.()?.modelId || !!pane()?.view3d,
    checked: () => !!pane()?.view3d,
    run: async () => {
      const p = pane();
      if (p.view3d) return close3d(p);
      try {
        app.toast('Building the 3D view…');
        await open3d(p);
      } catch (err) {
        if (/js-three|3D library|leaves out/.test(err.message)) throw new Error('3D needs the Standard file (GIS Workbench Lite leaves the 3D module out)');
        throw err;
      }
    },
  });
  app.globe = { open: open3d, close: close3d };

  // The floating 2D / 3D button (REQ-GLB-02), Modern layout.
  const fabs = new Map();
  const refresh = () => {
    for (const mp of app.desktop.multiports)
      for (const p of mp.panes) {
        let b = fabs.get(p);
        if (!b || !b.isConnected) {
          b = h('button', { class: 'fab-3d', type: 'button', 'data-id': `pane:${p.id}:3d`, 'aria-label': '2D or 3D view' });
          for (const t of ['pointerdown', 'dblclick', 'wheel']) b.addEventListener(t, (e) => e.stopPropagation());
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            mp.setActivePane(p);
            C.run('glb.toggle');
          });
          p.el.appendChild(b);
          fabs.set(p, b);
        }
        // Not in the Lite file, which leaves the 3D module out (GUI-046).
        const can = app.layoutMode() === 'modern' && (!!p.geoLayer?.()?.modelId || !!p.globe) && !p.video && !C.liteGap('glb.toggle');
        b.hidden = !can;
        const t = p.view3d && p.globe ? '2D' : '3D';
        if (b.textContent !== t) b.textContent = t;
        b.title = t === '3D' ? 'See this place in 3D: terrain, the image draped on it and the basemap around it' : 'Back to the 2D view';
      }
  };
  let t = 0;
  const schedule = () => {
    if (!t) t = setTimeout(() => ((t = 0), refresh()), 40);
  };
  app.on('state', schedule);
  app.on('layout', schedule);
}
