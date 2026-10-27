// R2 extraction (REQ-EXT-07/13/14/16/17/25, SCN-10): validation in a worker with a results dock,
// saved sessions and one-click fixes (snap dangles closed, trim overshoots); Drop to Ground
// (planimetric, topographic, geomorphic); 3D buildings (LOD1 extrusion; gable, hip, shed roofs)
// with the height method recorded and glTF/GLB, OBJ and CityJSON export; buildings and trees from
// a DSM, with building heights handed back to the DSM; and assisted digitising (region-grow magic
// wand and live-wire edge/road tracing on the image).

import { h, clear } from '../shell/dom.js';
import polygonClipping from 'polygon-clipping';
import { modal, field } from '../shell/dialogs.js';
import { saveBlob } from '../storage/files.js';
import { parts, fromParts, isPolygonal, isLinear, bbox, polygonGroups } from '../vector/geom.js';
import { buildingModel, writeGltf, writeObj, writeCityJson } from '../vector/mesh.js';
import { smrf } from './dem-tools.js';
import { converter } from '../geo/crs.js';

export const name = 'extract-r2';

/** Local metric frame about (lat0, lon0) (WGS 84 radii at the origin). */
export function frame(lat0, lon0) {
  const a = 6378137;
  const e2 = 6.69437999014e-3;
  const s = Math.sin((lat0 * Math.PI) / 180);
  const w = Math.sqrt(1 - e2 * s * s);
  const kx = (Math.PI / 180) * (a / w) * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * ((a * (1 - e2)) / (w * w * w));
  return { kx, ky, to: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky], from: (x, y) => [lon0 + x / kx, lat0 + y / ky] };
}

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const vlayers = () => S.all('vlayer');
  const activeLayerId = () => {
    const id = app.prefs.get('vlayerActive');
    return id && S.has(id) ? id : vlayers()[0]?.id ?? null;
  };
  const featuresOf = (id) => S.all('feature').filter((f) => f.vlayer === id);
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'error', ms: 8000 });
    }
  };

  // ---- validation (REQ-EXT-13) ----
  function layerFrame(fs) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const f of fs) {
      const b = bbox(f.geom);
      x0 = Math.min(x0, b[0]);
      y0 = Math.min(y0, b[1]);
      x1 = Math.max(x1, b[2]);
      y1 = Math.max(y1, b[3]);
    }
    return frame((y0 + y1) / 2 || 0, (x0 + x1) / 2 || 0);
  }

  /**
   * Gaps (REQ-EXT-13 Should): holes of the union of a layer's polygons that no polygon fills, up
   * to `maxArea` m² (larger holes are taken as intended: courtyards, lakes). The union comes from
   * polygon-clipping in the layer's local metric frame.
   */
  function gapIssues(fs, F, { maxArea = 500, minArea = 0.01 } = {}) {
    const polys = fs.filter((f) => isPolygonal(f.geom)).map((f) => {
      const ps = parts(f.geom).map((p) => {
        const ring = p.map((v) => F.to(v[0], v[1]));
        const a = ring[0];
        const z = ring.at(-1);
        if (a[0] !== z[0] || a[1] !== z[1]) ring.push([a[0], a[1]]);
        return ring;
      });
      return [ps];
    });
    if (polys.length < 2) return [];
    let u;
    try {
      u = polygonClipping.union(...polys);
    } catch {
      return [];
    }
    const area = (r) => Math.abs(r.reduce((s, p, i) => s + p[0] * r[(i + 1) % r.length][1] - r[(i + 1) % r.length][0] * p[1], 0)) / 2;
    const out = [];
    for (const poly of u) {
      for (const hole of poly.slice(1)) {
        const a = area(hole);
        if (a < minArea || a > maxArea) continue;
        // Area centroid (the ring is closed: its last vertex repeats the first).
        let cx = 0;
        let cy = 0;
        let a2 = 0;
        for (let k = 0; k < hole.length - 1; k++) {
          const [x0, y0] = hole[k];
          const [x1, y1] = hole[k + 1];
          const c = x0 * y1 - x1 * y0;
          a2 += c;
          cx += (x0 + x1) * c;
          cy += (y0 + y1) * c;
        }
        cx /= 3 * a2;
        cy /= 3 * a2;
        const [lon, lat] = F.from(cx, cy);
        // The polygons that border the gap.
        const near = fs.filter((f) => {
          const b = bbox(f.geom);
          const [x0, y0] = F.to(b[0], b[1]);
          const [x1, y1] = F.to(b[2], b[3]);
          return hole.some(([x, y]) => x >= x0 - 1 && x <= x1 + 1 && y >= y0 - 1 && y <= y1 + 1);
        });
        out.push({ check: 'gap', featureId: near[0]?.id ?? null, otherId: near[1]?.id ?? null, part: 0, lon, lat, value: a, message: `gap of ${a.toFixed(2)} m² between ${near.length} polygon(s)`, fix: null, ring: hole.map(([x, y]) => F.from(x, y)) });
      }
    }
    return out;
  }

  async function validate(layerId, { tol = 2, dupTol = 0.01, sliver = 0.05, sliverArea = 100, gapArea = 500, save = true } = {}) {
    const fs = featuresOf(layerId);
    const F = layerFrame(fs);
    const data = [fs.length];
    for (const f of fs) {
      const g = f.geom;
      const kind = isPolygonal(g) ? 2 : isLinear(g) ? 1 : 0;
      const ps = parts(g);
      data.push(kind, ps.length, kind === 2 ? (g.polys?.length ? g.polys.length : 1) : 0);
      if (kind === 2) data.push(...(g.polys?.length ? g.polys : [0]));
      for (const p of ps) {
        data.push(p.length);
        for (const v of p) data.push(...F.to(v[0], v[1]));
      }
    }
    const geo = await app.pool.run('validate', { prm: [tol, dupTol, sliver, sliverArea], data: Float64Array.from(data) }, { kind: 'analysis', label: 'validate features', timeout: 300000 });
    const issues = geo.map((i) => {
      const [lon, lat] = F.from(...i.at);
      const fix = i.fix ? { ...i.fix, to: F.from(...i.fix.to) } : null;
      return { check: i.check, featureId: fs[i.feature].id, otherId: i.other != null ? fs[i.other].id : null, part: i.part, lon, lat, value: i.value, message: i.message, fix };
    });
    if (gapArea > 0) issues.push(...gapIssues(fs, F, { maxArea: gapArea }));
    for (const a of app.attribution?.attributeIssues(layerId) ?? []) {
      const f = S.get(a.featureId);
      const [x0, y0, x1, y1] = bbox(f.geom);
      issues.push({ check: /required/.test(a.message) ? 'required' : 'domain', featureId: a.featureId, field: a.field, lon: (x0 + x1) / 2, lat: (y0 + y1) / 2, message: a.message, fix: null });
    }
    let sessionId = null;
    if (save) S.transact('Validation session', (tx) => (sessionId = tx.create('valsession', { layer: layerId, layerName: S.get(layerId)?.name, created: new Date().toISOString(), options: { tol, dupTol, sliver, sliverArea, gapArea }, issues, fixed: [] })));
    app.emit('validation', { sessionId });
    return { sessionId, issues };
  }

  /** Apply an issue's fix to its feature (one undoable edit). */
  function fixIssue(issue, sessionId = null) {
    const f = S.get(issue.featureId);
    if (!f || !issue.fix) return false;
    const ps = parts(f.geom);
    const p = ps[issue.fix.part];
    const z = (v) => v?.[2] ?? 0;
    if (issue.fix.kind === 'move') {
      const v = p[issue.fix.vertex];
      p[issue.fix.vertex] = [issue.fix.to[0], issue.fix.to[1], z(v)];
    } else {
      const zEnd = z(issue.fix.end === 0 ? p[0] : p.at(-1));
      ps[issue.fix.part] = issue.fix.end === 0 ? [[issue.fix.to[0], issue.fix.to[1], zEnd], ...p.slice(issue.fix.keep)] : [...p.slice(0, issue.fix.keep + 1), [issue.fix.to[0], issue.fix.to[1], zEnd]];
    }
    const g = fromParts(f.geom.type, ps, f.geom.polys);
    S.transact(`Fix ${issue.check}`, (tx) => {
      tx.set(f.id, 'geom', g);
      if (sessionId && S.has(sessionId)) tx.set(sessionId, 'fixed', [...(S.get(sessionId).fixed ?? []), `${issue.featureId}:${issue.check}:${issue.fix.part}:${issue.fix.vertex ?? issue.fix.end}`]);
    });
    return true;
  }

  app.on('ready', (mp) => mp.docks.register({ id: 'validation', title: 'Validation Results', icon: 'check', home: 'bottom', create: (a, m, el) => validationDock(el) }));
  function validationDock(el) {
    const bar = h('div', { class: 'grid-bar' });
    const wrap = h('div', { class: 'grid-wrap' });
    el.append(bar, wrap);
    const sessSel = h('select', { class: 'inp', 'aria-label': 'Validation session' });
    const count = h('span', { class: 'hint', 'aria-live': 'polite' });
    const fixAll = h('button', { class: 'btn btn-small' }, 'Fix All Dangles');
    bar.append(sessSel, fixAll, count);
    const render = () => {
      const ss = S.all('valsession').sort((a, b) => (a.created < b.created ? 1 : -1));
      const cur = sessSel.value;
      clear(sessSel);
      for (const s of ss) sessSel.appendChild(h('option', { value: s.id, selected: s.id === cur }, `${s.layerName} — ${s.created.replace('T', ' ').slice(0, 19)} (${s.issues.length})`));
      clear(wrap);
      const s = S.get(sessSel.value) ?? ss[0];
      if (!s) {
        wrap.appendChild(h('p', { class: 'muted pad' }, 'No validation sessions. Feature ▸ Validate checks geometry, topology, domains and required fields.'));
        count.textContent = '';
        return;
      }
      const t = h('table', { class: 'grid-table', role: 'grid', 'aria-label': 'Validation issues' }, h('thead', {}, h('tr', {}, ['Check', 'Feature', 'Message', ''].map((x) => h('th', { scope: 'col' }, x)))));
      const tb = h('tbody');
      for (const i of s.issues.slice(0, 2000)) {
        const f = S.get(i.featureId);
        const key = `${i.featureId}:${i.check}:${i.fix?.part}:${i.fix?.vertex ?? i.fix?.end}`;
        const done = (s.fixed ?? []).includes(key);
        const zoom = h('button', { class: 'btn btn-small' }, 'Zoom');
        zoom.addEventListener('click', () => {
          if (f) app.zoomToFeature(f);
        });
        const fx = h('button', { class: 'btn btn-small', disabled: !i.fix || done }, done ? 'Fixed' : 'Fix');
        fx.addEventListener('click', () => fixIssue(i, s.id));
        tb.appendChild(h('tr', {}, h('td', {}, i.check), h('td', {}, f?.name ?? f?.ufi?.slice(0, 8) ?? '(deleted)'), h('td', {}, i.message), h('td', {}, zoom, fx)));
      }
      t.appendChild(tb);
      wrap.appendChild(t);
      count.textContent = `${s.issues.length} issue(s), ${(s.fixed ?? []).length} fixed`;
    };
    fixAll.addEventListener('click', () => {
      const s = S.get(sessSel.value);
      if (s) for (const i of s.issues) if (i.fix && (i.check === 'dangle' || i.check === 'overshoot')) fixIssue(i, s.id);
    });
    sessSel.addEventListener('change', render);
    S.on('change', render);
    render();
    return { onShow: render };
  }
  C.implement('ext.validate', {
    enabled: () => vlayers().length > 0,
    run: run(async () => {
      const ls = vlayers();
      const layer = h('select', { class: 'inp', 'aria-label': 'Layer' }, ls.map((v) => h('option', { value: v.id }, v.name)));
      layer.value = activeLayerId();
      const tol = h('input', { class: 'inp inp-num', type: 'number', min: '0', step: 'any', value: '2', 'aria-label': 'Dangle tolerance (m)' });
      if ((await modal({ title: 'Validate Features', body: h('div', {}, field('Layer', layer), field('Dangle tolerance (m)', tol, 'Undershoots and overshoots shorter than this are reported with a fix.')), id: 'ext-validate' })) !== 'OK') return;
      const r = await validate(layer.value, { tol: Number(tol.value) || 2 });
      app.panels?.show?.('validation', 'bottom');
      app.toast(`${r.issues.length} issue(s) found`);
    }),
  });
  C.implement('ext.results', { run: () => app.panels.toggle('validation', 'bottom') });

  // ---- Drop to Ground (REQ-EXT-07) ----
  function dropToGround(featureId, mode = 'planimetric', { tolerance = 0.3 } = {}) {
    const f = S.get(featureId);
    if (!app.terrain?.available) throw new Error('Drop to Ground needs terrain (a DEM used as terrain)');
    const hAt = (lon, lat) => app.terrain.sample(lat, lon)?.hae;
    const d = app.terrain.covering(f.geom.xyz[1], f.geom.xyz[0]);
    const step = d ? Math.max(0.1, Math.min(d.grid.dlat * 110940, d.grid.dlon * 111320 * Math.cos((f.geom.xyz[1] * Math.PI) / 180))) : 30;
    const closed = isPolygonal(f.geom);
    const out = parts(f.geom).map((p) => {
      if (mode === 'planimetric' || f.geom.type === 'Point' || f.geom.type === 'MultiPoint') return p.map((v) => [v[0], v[1], hAt(v[0], v[1]) ?? v[2]]);
      // Densify at the DEM post spacing.
      const F = frame(p[0][1], p[0][0]);
      const dense = [];
      const n = p.length;
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = p[i];
        const b = p[(i + 1) % n];
        const [ax, ay] = F.to(a[0], a[1]);
        const [bx, by] = F.to(b[0], b[1]);
        const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let j = 0; j < k; j++) {
          const t = j / k;
          const [lon, lat] = F.from(ax + (bx - ax) * t, ay + (by - ay) * t);
          dense.push([lon, lat, hAt(lon, lat) ?? a[2], j === 0]);
        }
      }
      if (!closed) {
        const b = p[n - 1];
        dense.push([b[0], b[1], hAt(b[0], b[1]) ?? b[2], true]);
      }
      if (mode === 'topographic') return dense.map((v) => v.slice(0, 3));
      // Geomorphic: keep the original vertices and the slope breaks (3D Douglas–Peucker on the profile).
      const prof = [];
      let s = 0;
      for (let i = 0; i < dense.length; i++) {
        if (i) {
          const [x0, y0] = F.to(dense[i - 1][0], dense[i - 1][1]);
          const [x1, y1] = F.to(dense[i][0], dense[i][1]);
          s += Math.hypot(x1 - x0, y1 - y0);
        }
        prof.push([s, dense[i][2]]);
      }
      const keep = new Array(dense.length).fill(false);
      dense.forEach((v, i) => (keep[i] = v[3]));
      keep[0] = keep[dense.length - 1] = true;
      const stack = [[0, dense.length - 1]];
      while (stack.length) {
        const [a, b] = stack.pop();
        let worst = 0;
        let wi = -1;
        for (let i = a + 1; i < b; i++) {
          const t = (prof[i][0] - prof[a][0]) / Math.max(1e-9, prof[b][0] - prof[a][0]);
          const dz = Math.abs(prof[i][1] - (prof[a][1] + t * (prof[b][1] - prof[a][1])));
          if (dz > worst) {
            worst = dz;
            wi = i;
          }
        }
        if (wi >= 0 && worst > tolerance) {
          keep[wi] = true;
          stack.push([a, wi], [wi, b]);
        }
      }
      return dense.filter((_, i) => keep[i]).map((v) => v.slice(0, 3));
    });
    const g = fromParts(f.geom.type, out, f.geom.polys);
    S.transact(`Drop to ground (${mode})`, (tx) => {
      tx.set(f.id, 'geom', g);
      tx.set(f.id, 'prov', { ...(f.prov ?? {}), dropToGround: { mode, tolerance, at: new Date().toISOString() } });
    });
    return g;
  }
  C.implement('ext.droptoground', {
    enabled: () => [...app.selection].some((id) => S.get(id)?.type === 'feature') && app.terrain?.available,
    run: run(async () => {
      const mode = h('select', { class: 'inp', 'aria-label': 'Mode' }, h('option', { value: 'planimetric' }, 'Planimetric — vertices onto the DEM'), h('option', { value: 'topographic' }, 'Topographic — densified at the DEM spacing'), h('option', { value: 'geomorphic' }, 'Geomorphic — slope breaks kept'));
      if ((await modal({ title: 'Drop to Ground', body: field('Mode', mode), id: 'ext-drop' })) !== 'OK') return;
      for (const id of app.selection) if (S.get(id)?.type === 'feature') dropToGround(id, mode.value);
    }),
  });

  // ---- 3D buildings (REQ-EXT-14, REQ-EXT-25) ----
  /** Bare-earth height: a DTM when one covers the point, else any terrain. */
  const groundOf = (lon, lat) => {
    const T = app.terrain;
    if (!T?.available) return null;
    const d = T.dems.find((e) => e.kind === 'DTM' && lat <= e.bounds.north && lat >= e.bounds.south && lon >= e.bounds.west && lon <= e.bounds.east) ?? T.dems.find((e) => e.kind !== 'DSM' && lat <= e.bounds.north && lat >= e.bounds.south && lon >= e.bounds.west && lon <= e.bounds.east) ?? T.covering(lat, lon);
    if (!d) return null;
    const v = app.core.demHae(d.coreId, lat, lon);
    return Number.isFinite(v) ? v : null;
  };
  /** Record a building height and the method that gave it. */
  function setHeight(featureId, height, method, extra = {}) {
    const f = S.get(featureId);
    S.transact('Building height', (tx) => {
      tx.set(featureId, 'attrs', { ...f.attrs, HGT: Math.round(height * 100) / 100 });
      tx.set(featureId, 'prov', { ...(f.prov ?? {}), height: { value: height, method, ...extra, at: new Date().toISOString() } });
    });
  }
  /** Height from a DSM (median inside the footprint minus the ground under it). */
  function heightFromDsm(featureId, dsm) {
    const f = S.get(featureId);
    const ring = parts(f.geom)[0];
    const g = dsm.grid;
    const H = dsm.current ?? g.heights;
    const lons = ring.map((v) => v[0]);
    const lats = ring.map((v) => v[1]);
    const inside = (lon, lat) => {
      let c = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) if (ring[a][1] > lat !== ring[b][1] > lat && lon < ((ring[b][0] - ring[a][0]) * (lat - ring[a][1])) / (ring[b][1] - ring[a][1]) + ring[a][0]) c = !c;
      return c;
    };
    const v = [];
    for (let j = Math.floor((g.lat0 - Math.max(...lats)) / g.dlat); j <= Math.ceil((g.lat0 - Math.min(...lats)) / g.dlat); j++)
      for (let i = Math.floor((Math.min(...lons) - g.lon0) / g.dlon); i <= Math.ceil((Math.max(...lons) - g.lon0) / g.dlon); i++) {
        if (i < 0 || j < 0 || i >= g.width || j >= g.height) continue;
        if (inside(g.lon0 + i * g.dlon, g.lat0 - j * g.dlat) && Number.isFinite(H[j * g.width + i])) v.push(H[j * g.width + i]);
      }
    if (!v.length) throw new Error('the DSM has no posts inside the footprint');
    v.sort((a, b) => a - b);
    const roof = v[Math.floor(v.length / 2)];
    const base = Math.min(...ring.map((p) => groundOf(p[0], p[1]) ?? p[2]));
    setHeight(featureId, roof - base, 'DSM', { dsm: dsm.name, base });
    return roof - base;
  }
  /** Models for a layer's polygons: [{id, name, model, attrs, height}] and the origin. */
  function models(layerId) {
    const fs = featuresOf(layerId).filter((f) => isPolygonal(f.geom));
    if (!fs.length) throw new Error('the layer has no polygons');
    const F0 = layerFrame(fs);
    const [lon0, lat0] = F0.from(0, 0);
    const bases = [];
    const out = [];
    for (const f of fs) {
      const ring = polygonGroups(f.geom)[0][0];
      const base = Math.min(...ring.map((p) => groundOf(p[0], p[1]) ?? p[2]));
      bases.push(base);
      const hgt = Number(f.attrs?.HGT);
      const height = Number.isFinite(hgt) && hgt > 0 ? hgt : Number(f.prov?.height?.value) || 3;
      out.push({ f, ring, base, height, fromAttr: Number.isFinite(hgt) && hgt > 0 });
    }
    const h0 = Math.min(...bases);
    const origin = { lat: lat0, lon: lon0, h: h0 };
    return {
      origin,
      frame: F0,
      models: out.map(({ f, ring, base, height, fromAttr }) => {
        const roof = f.attrs?.roofType ?? f.prov?.roof ?? 'flat';
        const ridge = Number(f.attrs?.ridge ?? f.prov?.ridge) || 0;
        const model = buildingModel({ ring: ring.map((v) => F0.to(v[0], v[1])), base: base - h0, height, roof, ridge });
        return { id: f.ufi ?? f.id, name: f.name ?? f.attrs?.ZI005_FNA ?? f.ufi?.slice(0, 8), model, height, attrs: { F_CODE: f.attrs?.F_CODE ?? 'AL013', HGT: height, heightMethod: f.prov?.height?.method ?? (fromAttr ? 'attribute' : 'default 3 m') } };
      }),
    };
  }
  /**
   * Texture a layer's building models from an image (REQ-EXT-15): every vertex is projected into
   * the image through its sensor model (ortho or oblique, RPC or frame), the image window under
   * all of them becomes the texture, and the UVs follow. Faces the image does not see take
   * whatever pixels lie there (no occlusion test): roofs from orthos, facades from obliques.
   */
  async function texturedModels(layerId, image, { maxSize = 2048 } = {}) {
    const m = models(layerId);
    if (!image?.modelId) throw new Error('texturing needs an image with a sensor model');
    const px = [];
    for (const md of m.models)
      for (const v of md.model.vertices) {
        const [lon, lat] = m.frame.from(v[0], v[1]);
        const q = app.core.g2i(image.modelId, lat, lon, v[2] + m.origin.h);
        px.push([q.x, q.y]);
      }
    const xs = px.map((p) => p[0]);
    const ys = px.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const x1 = Math.min(image.width, Math.ceil(Math.max(...xs)) + 2);
    const y1 = Math.min(image.height, Math.ceil(Math.max(...ys)) + 2);
    if (x1 <= x0 || y1 <= y0) throw new Error('the buildings are outside the image');
    const step = Math.max(1, Math.ceil(Math.max(x1 - x0, y1 - y0) / maxSize));
    const cb = image.chain?.bands ?? [0];
    const bands = cb.length >= 3 ? cb.slice(0, 3) : [cb[0] ?? 0];
    const r = await app.pool.run('window', { handle: image.handle, x0, y0, w: Math.ceil((x1 - x0) / step), h: Math.ceil((y1 - y0) / step), step, bands }, { affinity: image.affinity, label: 'texture window' });
    const W = r.w;
    const H = r.h;
    const c = new OffscreenCanvas(W, H);
    const g = c.getContext('2d');
    const id = g.createImageData(W, H);
    const st = r.planes.map((pl) => {
      const v = Array.from(pl).sort((a, b) => a - b);
      return [v[Math.floor(v.length * 0.01)] ?? 0, v[Math.ceil(v.length * 0.99) - 1] ?? 1];
    });
    for (let i = 0; i < W * H; i++) {
      for (let k = 0; k < 3; k++) {
        const b = Math.min(k, r.planes.length - 1);
        const [lo, hi] = st[b];
        id.data[4 * i + k] = Math.max(0, Math.min(255, Math.round(((r.planes[b][i] - lo) / Math.max(1e-9, hi - lo)) * 255)));
      }
      id.data[4 * i + 3] = 255;
    }
    g.putImageData(id, 0, 0);
    const png = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
    // The glTF writer passes ENU (x east, y north, z up) relative to the origin.
    const uv = (x, y, z) => {
      const [lon, lat] = m.frame.from(x, y);
      const q = app.core.g2i(image.modelId, lat, lon, z + m.origin.h);
      return [(q.x - x0) / (W * step), (q.y - y0) / (H * step)];
    };
    return { ...m, texture: { png, uv, name: image.rec?.name ?? 'image', window: { x0, y0, w: W * step, h: H * step, step } } };
  }

  /** Export a layer's buildings: fmt 'glb' | 'gltf' | 'obj' | 'cityjson'. */
  function export3d(layerId, fmt = 'glb') {
    const m = models(layerId);
    const stem = (S.get(layerId)?.name ?? 'buildings').replace(/[^\w.-]+/g, '_');
    if (fmt === 'glb') return { bytes: writeGltf(m.models, m.origin, { glb: true }), name: `${stem}.glb`, type: 'model/gltf-binary', m };
    if (fmt === 'gltf') return { bytes: new TextEncoder().encode(writeGltf(m.models, m.origin, { glb: false })), name: `${stem}.gltf`, type: 'model/gltf+json', m };
    if (fmt === 'obj') return { bytes: new TextEncoder().encode(writeObj(m.models, m.origin)), name: `${stem}.obj`, type: 'text/plain', m };
    const zone = Math.floor((m.origin.lon + 180) / 6) + 1;
    const south = m.origin.lat < 0;
    const conv = converter({ def: `+proj=utm +zone=${zone}${south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs` });
    const text = writeCityJson(m.models, { toGeo: (x, y) => m.frame.from(x, y), project: (lon, lat) => conv.fromLonLat(lon, lat), crsUri: `https://www.opengis.net/def/crs/EPSG/0/${(south ? 32700 : 32600) + zone}`, origin: m.origin });
    return { bytes: new TextEncoder().encode(text), name: `${stem}.city.json`, type: 'application/city+json', m };
  }
  C.implement('ext.texture', {
    enabled: () => vlayers().some((v) => featuresOf(v.id).some((f) => isPolygonal(f.geom))) && [...app.layers.values()].some((l) => l.modelId && l.kind !== 'dem'),
    run: run(async () => {
      const ls = vlayers().filter((v) => featuresOf(v.id).some((f) => isPolygonal(f.geom)));
      const ims = [...app.layers.values()].filter((l) => l.modelId && l.kind !== 'dem');
      const layer = h('select', { class: 'inp', 'aria-label': 'Buildings' }, ls.map((v) => h('option', { value: v.id }, v.name)));
      const image = h('select', { class: 'inp', 'aria-label': 'Image' }, ims.map((l) => h('option', { value: l.id }, l.rec.name)));
      if ((await modal({ title: 'Texture Buildings', body: h('div', {}, field('Buildings', layer), field('Image (ortho or oblique)', image, 'Every vertex is projected into the image through its sensor model; faces the image does not see take whatever lies there.')), id: 'ext-texture' })) !== 'OK') return;
      const tm = await texturedModels(layer.value, app.layers.get(image.value));
      const glb = writeGltf(tm.models, tm.origin, { glb: true, texture: tm.texture });
      const v = await app.scene3d.ensureView();
      await v.addGltf(glb, `${S.get(layer.value)?.name ?? 'buildings'} (textured)`);
      await saveBlob(app, new Blob([glb], { type: 'model/gltf-binary' }), { name: `${(S.get(layer.value)?.name ?? 'buildings').replace(/[^\w.-]+/g, '_')}_textured.glb`, types: ['.glb'], description: 'Textured buildings' });
    }),
  });
  C.implement('ext.export3d', {
    enabled: () => vlayers().some((v) => featuresOf(v.id).some((f) => isPolygonal(f.geom))),
    run: run(async () => {
      const ls = vlayers().filter((v) => featuresOf(v.id).some((f) => isPolygonal(f.geom)));
      const layer = h('select', { class: 'inp', 'aria-label': 'Layer' }, ls.map((v) => h('option', { value: v.id }, v.name)));
      const fmt = h('select', { class: 'inp', 'aria-label': 'Format' }, [['glb', 'glTF binary (GLB)'], ['gltf', 'glTF (JSON, embedded buffer)'], ['obj', 'Wavefront OBJ'], ['cityjson', 'CityJSON 2.0 (LOD1/LOD2, UTM + HAE)']].map(([v, t]) => h('option', { value: v }, t)));
      if ((await modal({ title: 'Export 3D Buildings', body: h('div', {}, field('Layer', layer), field('Format', fmt, 'Heights from HGT (or the recorded height); bases on the terrain; roofType gable/hip/shed with a ridge attribute on four-cornered footprints.')), id: 'ext-export3d' })) !== 'OK') return;
      const r = export3d(layer.value, fmt.value);
      await saveBlob(app, new Blob([r.bytes], { type: r.type }), { name: r.name, types: [`.${r.name.split('.').pop()}`], description: '3D buildings' });
    }),
  });

  // ---- buildings and trees from a DSM (REQ-EXT-16) ----
  async function buildingsFromDsm({ dsm, dtm = null, params = {}, square = true } = {}) {
    dsm ??= app.terrain.dems.find((d) => d.kind === 'DSM');
    if (!dsm) throw new Error('no DSM: use a DSM as terrain first');
    const g = dsm.grid;
    const H = dsm.current ?? g.heights;
    const n = g.width * g.height;
    let ground;
    if (dtm) {
      ground = new Float32Array(n);
      for (let j = 0; j < g.height; j++) for (let i = 0; i < g.width; i++) ground[j * g.width + i] = app.core.demHae(dtm.coreId, g.lat0 - j * g.dlat, g.lon0 + i * g.dlon);
      // Both on the same vertical: HAE from the core; the DSM grid is in its own vertical.
      if (dsm.vertical !== 'hae') for (let j = 0; j < g.height; j++) for (let i = 0; i < g.width; i++) ground[j * g.width + i] -= app.core.undulation(g.lat0 - j * g.dlat, g.lon0 + i * g.dlon);
    } else ground = smrf(g, H, {}).dtm;
    const ndsm = new Float32Array(n);
    for (let k = 0; k < n; k++) ndsm[k] = H[k] - ground[k];
    const latM = g.lat0 - (g.height * g.dlat) / 2;
    const F = frame(latM, g.lon0);
    const cx = g.dlon * F.kx;
    const cy = g.dlat * F.ky;
    const p = { minHeight: 2.5, minArea: 25, minTreeArea: 3, roughness: 0.15, simplify: Math.max(0.5, 1.6 * Math.max(cx, cy)), ...params };
    const r = await app.pool.run('buildings', { prm: [g.width, g.height, cx, cy, p.minHeight, p.minArea, p.minTreeArea, p.roughness, p.simplify, square ? 1 : 0], dsm: Float32Array.from(H), ndsm }, { kind: 'analysis', label: 'buildings from DSM', timeout: 300000 });
    const toLL = (x, y) => [g.lon0 + (x / cx) * g.dlon, g.lat0 + (y / cy) * g.dlat];
    const bl = app.attribution.newSchemaLayer('AL013', { name: `Buildings from ${dsm.name.replace(/\s*\(.*$/, '')}`, activate: false });
    const tl = app.attribution.newSchemaLayer('EC005', { name: `Trees from ${dsm.name.replace(/\s*\(.*$/, '')}`, activate: false });
    const nowIso = new Date().toISOString();
    S.transact('Buildings and trees from the DSM', (tx) => {
      for (const b of r.buildings) {
        const ring = b.ring.map(([x, y]) => toLL(x, y));
        const [lc, la] = [ring.reduce((s, v) => s + v[0], 0) / ring.length, ring.reduce((s, v) => s + v[1], 0) / ring.length];
        const z = groundOf(lc, la) ?? 0;
        const geom = fromParts('Polygon', [ring.map(([lon, lat]) => [lon, lat, z])], [0]);
        const ufi = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        const attrs = { ...app.attribution.initialAttrs(bl, geom, { ufi, height: b.height }), HGT: Math.round(b.height * 100) / 100, ARA: Math.round(b.area * 100) / 100 };
        tx.create('feature', { vlayer: bl, ufi, geom, attrs, name: null, description: null, prov: { kind: 'dsm-extraction', dsm: dsm.name, created: nowIso, squared: b.squared, cornerErrorDeg: b.cornerErrorDeg, height: { value: b.height, method: 'DSM', dsm: dsm.name } } });
      }
      for (const t of r.trees) {
        const [lon, lat] = toLL(...t.at);
        const geom = fromParts('Point', [[[lon, lat, groundOf(lon, lat) ?? 0]]]);
        const ufi = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
        tx.create('feature', { vlayer: tl, ufi, geom, attrs: { ...app.attribution.initialAttrs(tl, geom, { ufi, height: t.height }), HGT: Math.round(t.height * 100) / 100, CRA: Math.round(t.crown * 10) / 10 }, name: null, description: null, prov: { kind: 'dsm-extraction', dsm: dsm.name, created: nowIso } });
      }
    });
    app.prefs.set('vlayerActive', bl);
    return { buildingLayer: bl, treeLayer: tl, buildings: r.buildings.length, trees: r.trees.length };
  }
  /** Hand building heights back to the DSM used for line of sight: flat roofs at ground + HGT. */
  async function heightsToDsm(layerId, dsm) {
    const fs = featuresOf(layerId).filter((f) => isPolygonal(f.geom) && Number.isFinite(Number(f.attrs?.HGT)));
    for (const f of fs) {
      const ring = parts(f.geom)[0];
      // The roof at the ground under the centre plus HGT (HGT is the roof's height over its local ground).
      const lon = ring.reduce((s, v) => s + v[0], 0) / ring.length;
      const lat = ring.reduce((s, v) => s + v[1], 0) / ring.length;
      const base = groundOf(lon, lat) ?? Math.min(...ring.map((v) => v[2]));
      await app.demEdit.edit('flatten', { ring: ring.map((v) => [v[0], v[1]]), h: base + Number(f.attrs.HGT) }, dsm);
    }
    return fs.length;
  }
  C.implement('ext.fromdsm', {
    enabled: () => app.terrain?.dems.some((d) => d.kind === 'DSM'),
    run: run(async () => {
      const dsms = app.terrain.dems.filter((d) => d.kind === 'DSM');
      const dtms = app.terrain.dems.filter((d) => d.kind === 'DTM');
      const a = h('select', { class: 'inp', 'aria-label': 'DSM' }, dsms.map((d) => h('option', { value: d.layerId }, d.name)));
      const b = h('select', { class: 'inp', 'aria-label': 'DTM' }, [h('option', { value: '' }, 'Ground filter of the DSM (SMRF)'), ...dtms.map((d) => h('option', { value: d.layerId }, d.name))]);
      const mh = h('input', { class: 'inp inp-num', type: 'number', step: 'any', value: '2.5', 'aria-label': 'Minimum height (m)' });
      if ((await modal({ title: 'Extract Buildings and Trees from DSM', body: h('div', {}, field('DSM', a), field('Ground', b), field('Lowest object height (m)', mh)), id: 'ext-fromdsm' })) !== 'OK') return;
      const r = await buildingsFromDsm({ dsm: app.terrain.entry(a.value), dtm: b.value ? app.terrain.entry(b.value) : null, params: { minHeight: Number(mh.value) || 2.5 } });
      app.toast(`${r.buildings} building(s) and ${r.trees} tree(s) extracted`);
    }),
  });

  // ---- assisted digitising (REQ-EXT-17) ----
  async function patchAround(l, x, y, rad, band = 0) {
    const w = 2 * rad;
    const r = await app.pool.run('patch', { handle: l.handle, x: x - rad, y: y - rad, w, h: w, band }, { affinity: l.affinity, timeout: 60000 });
    return r;
  }
  /** Region-grow magic wand on the image at screen (sx, sy): a polygon of similar pixels. */
  async function magicWand(p, sx, sy, { tolerance = 12, radius = 256, commit = true } = {}) {
    const l = p.geoLayer();
    const q = p.imagePoint(sx, sy);
    const pt = await patchAround(l, Math.round(q.x), Math.round(q.y), radius);
    const { x0, y0, w, h: hh, px } = pt;
    const s0 = Math.round(q.x) - x0;
    const t0 = Math.round(q.y) - y0;
    const seed = px[t0 * w + s0];
    const mask = new Uint8Array(w * hh);
    const stack = [t0 * w + s0];
    mask[stack[0]] = 1;
    let n = 0;
    while (stack.length) {
      const k = stack.pop();
      n++;
      const x = k % w;
      const y = (k / w) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
        const kk = yy * w + xx;
        if (!mask[kk] && Math.abs(px[kk] - seed) <= tolerance) {
          mask[kk] = 1;
          stack.push(kk);
        }
      }
    }
    const ring = traceMask(mask, w, hh).map(([x, y]) => l.groundWithTerrain(x0 + x, y0 + y)).filter(Boolean);
    if (ring.length < 3) throw new Error('the region is too small');
    const simp = simplifyRing(ring, 0.6);
    if (!commit) return simp;
    return app.commitFeature(p, 'Polygon', simp.map((g) => ({ lon: g.lon, lat: g.lat, h: g.h, zsrc: 'dem' })));
  }
  /** Outline of a mask (cell edges, cell corners at integer coordinates). */
  function traceMask(mask, w, hh) {
    let start = -1;
    for (let k = 0; k < w * hh; k++)
      if (mask[k]) {
        start = k;
        break;
      }
    if (start < 0) return [];
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < hh && mask[y * w + x] === 1;
    let cx = start % w;
    let cy = (start / w) | 0;
    const sx = cx;
    const sy = cy;
    let d = 0;
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    const out = [];
    for (let guard = 0; guard < 4 * (w + hh) * 8 + 4 * w * hh; guard++) {
      out.push([cx, cy]);
      let moved = false;
      for (const turn of [1, 0, -1, 2]) {
        const nd = (((d + turn) % 4) + 4) % 4;
        const [dx, dy] = dirs[nd];
        const [r, lft] = dx === 1 ? [[cx, cy], [cx, cy - 1]] : dy === 1 ? [[cx - 1, cy], [cx, cy]] : dx === -1 ? [[cx - 1, cy - 1], [cx - 1, cy]] : [[cx, cy - 1], [cx - 1, cy - 1]];
        if (inside(...r) && !inside(...lft)) {
          d = nd;
          cx += dx;
          cy += dy;
          moved = true;
          break;
        }
      }
      if (!moved || (cx === sx && cy === sy)) break;
    }
    return out;
  }
  function simplifyRing(ring, tolM) {
    const F = frame(ring[0].lat, ring[0].lon);
    const xy = ring.map((g) => F.to(g.lon, g.lat));
    const keep = new Array(xy.length).fill(false);
    keep[0] = true;
    const far = xy.reduce((b, p, i) => (Math.hypot(p[0] - xy[0][0], p[1] - xy[0][1]) > Math.hypot(xy[b][0] - xy[0][0], xy[b][1] - xy[0][1]) ? i : b), 0);
    keep[far] = true;
    const dp = (a, b) => {
      let worst = 0;
      let wi = -1;
      const [ax, ay] = xy[a];
      const [bx, by] = xy[b % xy.length];
      const L = Math.hypot(bx - ax, by - ay) || 1;
      for (let i = a + 1; i < b; i++) {
        const [px, py] = xy[i % xy.length];
        const dd = Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / L;
        if (dd > worst) {
          worst = dd;
          wi = i;
        }
      }
      if (wi >= 0 && worst > tolM) {
        keep[wi % xy.length] = true;
        dp(a, wi);
        dp(wi, b);
      }
    };
    dp(0, far);
    dp(far, xy.length);
    return ring.filter((_, i) => keep[i]);
  }
  /** Live-wire trace between two screen points: 'edge' follows strong gradients, 'road' similar tone. */
  async function liveWire(p, a, b, { mode = 'edge', commit = true, type = 'LineString' } = {}) {
    const l = p.geoLayer();
    const qa = p.imagePoint(a[0], a[1]);
    const qb = p.imagePoint(b[0], b[1]);
    const cxp = Math.round((qa.x + qb.x) / 2);
    const cyp = Math.round((qa.y + qb.y) / 2);
    const rad = Math.min(400, Math.ceil(Math.max(Math.abs(qa.x - qb.x), Math.abs(qa.y - qb.y)) / 2) + 40);
    const { x0, y0, w, h: hh, px } = await patchAround(l, cxp, cyp, rad);
    const n = w * hh;
    const cost = new Float32Array(n);
    const sa = Math.round(qa.y - y0) * w + Math.round(qa.x - x0);
    const sb = Math.round(qb.y - y0) * w + Math.round(qb.x - x0);
    if (mode === 'road') {
      const ref = (px[sa] + px[sb]) / 2;
      let sd = 0;
      for (let k = 0; k < n; k++) sd += (px[k] - ref) ** 2;
      sd = Math.sqrt(sd / n) || 1;
      // Tone similarity, with a mild pull towards the line between the clicks so that dark fields
      // beside the road do not capture the path (click more points for winding roads).
      const ax = qa.x - x0;
      const ay = qa.y - y0;
      const bx = qb.x - x0;
      const by = qb.y - y0;
      const Lp = Math.hypot(bx - ax, by - ay) || 1;
      const band = Math.max(15, 0.12 * Lp);
      for (let k = 0; k < n; k++) {
        const x = k % w;
        const y = (k / w) | 0;
        const d = Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / Lp;
        cost[k] = 0.05 + Math.abs(px[k] - ref) / sd + 0.5 * (d / band) ** 2;
      }
    } else {
      let gmax = 1e-6;
      const gm = new Float32Array(n);
      for (let y = 1; y < hh - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          const gx = px[k + 1] - px[k - 1];
          const gy = px[k + w] - px[k - w];
          gm[k] = Math.hypot(gx, gy);
          gmax = Math.max(gmax, gm[k]);
        }
      for (let k = 0; k < n; k++) cost[k] = 1 - gm[k] / gmax + 0.02;
    }
    // Dijkstra on the 8-neighbour grid (binary heap).
    const dist = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = [];
    const push = (k, d) => {
      heap.push([d, k]);
      let i = heap.length - 1;
      while (i > 0) {
        const pi = (i - 1) >> 1;
        if (heap[pi][0] <= heap[i][0]) break;
        [heap[pi], heap[i]] = [heap[i], heap[pi]];
        i = pi;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        let i = 0;
        for (;;) {
          const l2 = 2 * i + 1;
          const r2 = l2 + 1;
          let m = i;
          if (l2 < heap.length && heap[l2][0] < heap[m][0]) m = l2;
          if (r2 < heap.length && heap[r2][0] < heap[m][0]) m = r2;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    dist[sa] = 0;
    push(sa, 0);
    while (heap.length) {
      const [d, k] = pop();
      if (k === sb) break;
      if (d > dist[k]) continue;
      const x = k % w;
      const y = (k / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= hh) continue;
          const kk = yy * w + xx;
          const nd = d + cost[kk] * (dx && dy ? Math.SQRT2 : 1);
          if (nd < dist[kk]) {
            dist[kk] = nd;
            prev[kk] = k;
            push(kk, nd);
          }
        }
    }
    const path = [];
    for (let k = sb; k >= 0; k = prev[k]) {
      path.push(k);
      if (k === sa) break;
    }
    path.reverse();
    const ground = path.map((k) => l.groundWithTerrain(x0 + (k % w) + 0.5, y0 + ((k / w) | 0) + 0.5)).filter(Boolean);
    const simp = ground.length > 2 ? simplifyLine(ground, 0.5) : ground;
    if (!commit) return simp;
    return app.commitFeature(p, type, simp.map((g) => ({ lon: g.lon, lat: g.lat, h: g.h, zsrc: 'dem' })));
  }
  function simplifyLine(pts, tolM) {
    const F = frame(pts[0].lat, pts[0].lon);
    const xy = pts.map((g) => F.to(g.lon, g.lat));
    const keep = new Array(xy.length).fill(false);
    keep[0] = keep[xy.length - 1] = true;
    const stack = [[0, xy.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = xy[a];
      const [bx, by] = xy[b];
      const L = Math.hypot(bx - ax, by - ay) || 1;
      let worst = 0;
      let wi = -1;
      for (let i = a + 1; i < b; i++) {
        const dd = Math.abs((xy[i][0] - ax) * (by - ay) - (xy[i][1] - ay) * (bx - ax)) / L;
        if (dd > worst) {
          worst = dd;
          wi = i;
        }
      }
      if (wi >= 0 && worst > tolM) {
        keep[wi] = true;
        stack.push([a, wi], [wi, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  }
  app.tools.register({
    id: 'ext.wand',
    cue: 'Magic Wand: click inside a uniform area of the image; a polygon of similar pixels is captured.',
    onDown(p, e, sx, sy) {
      magicWand(p, sx, sy, { tolerance: app.prefs.get('wandTolerance') ?? 12 }).catch((er) => app.toast(er.message, { kind: 'error' }));
      return true;
    },
  });
  for (const [id, mode, label] of [['ext.edgetrace', 'edge', 'Edge Trace'], ['ext.roadtrace', 'road', 'Road Trace']])
    app.tools.register({
      id,
      cue: `${label}: click the start, then the end; the line follows ${mode === 'edge' ? 'the strongest edges' : 'the road surface'} between them.`,
      start() {
        this.state = {};
      },
      onDown(p, e, sx, sy) {
        const st = this.state;
        if (!st.a) st.a = [sx, sy];
        else {
          const a = st.a;
          st.a = null;
          liveWire(p, a, [sx, sy], { mode }).catch((er) => app.toast(er.message, { kind: 'error' }));
        }
        return true;
      },
    });
  C.implement('ext.wand', { enabled: () => !!pane()?.geoLayer()?.modelId, run: () => app.tools.select('ext.wand') });
  C.implement('ext.edgetrace', { enabled: () => !!pane()?.geoLayer()?.modelId, run: () => app.tools.select('ext.edgetrace') });
  C.implement('ext.roadtrace', { enabled: () => !!pane()?.geoLayer()?.modelId, run: () => app.tools.select('ext.roadtrace') });

  app.extractR2 = { validate, gapIssues, fixIssue, dropToGround, setHeight, heightFromDsm, models, texturedModels, writeGltf, export3d, buildingsFromDsm, heightsToDsm, magicWand, liveWire, frame };
}
