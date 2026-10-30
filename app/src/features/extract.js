// Feature extraction (REQ-EXT-01/02/04/05/06/08/12/21/23, SCN-10, SCN-17): vector layers in the
// project's feature store, drawn on every pane; a ToolBox drawer with point, polyline, polygon,
// 3-point rectangle and n-gon tools, single-use or repeat; modifiers (snap, orthogonal, square,
// constant elevation, close) run as a staged pipeline; vertex editing with Snap Guard, an Edit
// Vertices table, split, merge, reshape and square; the attribute table with sort, filter, edit
// and zoom-to; queries by attribute and location; open and save GeoJSON, Shapefile, KML/KMZ
// with a round-trip report.

import { minOf, maxOf, errorText } from '../core/util.js';
import { h, clear } from '../shell/dom.js';
import { modal, field, section, confirmBox, promptBox } from '../shell/dialogs.js';
import { saveBlob, pickFiles, textBlob } from '../storage/files.js';
import { zipSync, unzipSync, gunzipSync, strToU8 } from 'fflate';
import polygonClipping from 'polygon-clipping';
import { groundOf, screenOfGround, halo } from '../tools/tools.js';
import { FeatureIndex, snapAt, edges } from '../vector/index.js';
import { parts, partRanges, partOf, vertex, fromParts, setVertex, insertVertex, deleteVertex, isPolygonal, isLinear, bbox, polygonGroups, pointInPolygonal, toGeoJSON, fromGeoJSON, coincident } from '../vector/geom.js';
import { readGeoJSON, writeGeoJSON, readShapefile, writeShapefile, shapefileSets, readKml, writeKml, readGml, inferFields } from '../vector/io.js';
import { readFgb, readGeoParquet } from '../vector/columnar.js';
import { crsOf, converter } from '../geo/crs.js';
import { parseGpx } from './graphics.js';

export const name = 'extract';

// .json is GeoJSON here: app files (.gwt.json, .gwrecipe.json) and tile-set JSON are routed before this.
const VECTOR_RE = /\.(geojson|geojsonl|geojsons|ndjson|json|kml|kmz|shp|zip|gpkg|csv|gml|gpx|fgb|parquet)$/i;
const SIDE_RE = /\.(dbf|shx|cpg)$/i;
const STYLE = { stroke: '#ff2020', width: 2, fill: '#ff202040', outline: '#2060ff' };
const SEL = '#e000e0';
const VTX = '#08b0f0';
const VECTOR_FILE_CAP = 512 * 2 ** 20; // bytes read whole (TE-024)
const VECTOR_ZIP_CAP = 256 * 2 ** 20;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);

/** Local metric frame about an origin: meridian and prime-vertical radii of WGS 84 (exact scale
 * at the origin, so angles are right to second order over building-scale extents). */
const frame = (lat0, lon0) => {
  const a = 6378137;
  const e2 = 6.69437999014e-3;
  const s = Math.sin((lat0 * Math.PI) / 180);
  const w = Math.sqrt(1 - e2 * s * s);
  const M = (a * (1 - e2)) / (w * w * w);
  const N = a / w;
  const kx = (Math.PI / 180) * N * Math.cos((lat0 * Math.PI) / 180);
  const ky = (Math.PI / 180) * M;
  return { to: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky], from: (x, y) => [lon0 + x / kx, lat0 + y / ky] };
};

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();
  const index = new FeatureIndex(app);
  app.featureIndex = index;
  const prefs = () => ({ snap: true, tol: 10, ortho: false, square: false, constZ: false, z: 0, close: false, repeat: false, ngon: 16, snapGuard: 'warn', ...(app.prefs.get('extract') ?? {}) });
  const setPref = (patch) => app.prefs.set('extract', { ...prefs(), ...patch });
  const vlayers = () => S.all('vlayer');
  const activeLayerId = () => {
    const id = app.prefs.get('vlayerActive');
    return id && S.has(id) ? id : vlayers()[0]?.id ?? null;
  };
  const toScreenFor = (p) => (v) => screenOfGround(p, v[1], v[0], v[2]);
  const sel = () => [...app.selection].map((id) => S.get(id)).filter((r) => r?.type === 'feature');
  const invalidateAll = () => {
    for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
  };
  S.on('change', () => {
    index.dirty = true;
    invalidateAll();
  });

  function ensureLayer(tx, nameHint = 'Features') {
    let id = activeLayerId();
    if (!id) {
      id = tx.create('vlayer', { name: nameHint, visible: true, style: { ...STYLE }, fields: [], source: { format: 'new' }, created: new Date().toISOString() });
      app.prefs.set('vlayerActive', id);
    }
    return id;
  }

  /** Add a layer in transit ({name, fields, features}) to the store in one transaction. */
  function addLayer(layer, source) {
    let id;
    S.transact(`Open ${layer.name}`, (tx) => {
      id = tx.create('vlayer', { name: layer.name, visible: true, style: { ...STYLE }, fields: layer.fields ?? inferFields(layer.features), source, assets: layer.assets ?? {}, created: new Date().toISOString() });
      for (const f of layer.features) tx.create('feature', { vlayer: id, ufi: f.ufi ?? uuid(), fid: f.fid ?? null, geom: f.geom, attrs: f.attrs ?? {}, name: f.name ?? null, description: f.description ?? null, style: f.style ?? null, prov: { kind: 'import', format: source.format } });
    });
    app.prefs.set('vlayerActive', id);
    return id;
  }
  app.addVectorLayer = addLayer;

  /** The layer in transit for a stored layer. */
  function layerOut(id) {
    const v = S.get(id);
    const feats = S.all('feature').filter((f) => f.vlayer === id);
    const fields = v.fields?.length ? v.fields : inferFields(feats);
    // Fields added by editing.
    for (const f of inferFields(feats)) if (!fields.some((x) => x.name === f.name)) fields.push(f);
    return { name: v.name, fields, features: feats.map((f) => ({ geom: f.geom, attrs: f.attrs, name: f.name, description: f.description, style: f.style ?? (app.attribution?.ruleStyle(v, f) ? { ...v.style, ...app.attribution.ruleStyle(v, f) } : v.style), fid: f.fid, ufi: f.ufi })), assets: v.assets ?? {} };
  }
  app.vectorLayerOut = layerOut;

  // ---- rendering ----
  app.vectors = {
    drawPane(p, g) {
      const l = p.geoLayer?.();
      if (!l?.modelId || !vlayers().some((v) => v.visible !== false)) return;
      const { w, h: hh } = p.size();
      const corners = [
        [0, 0],
        [w, 0],
        [w, hh],
        [0, hh],
      ].map(([x, y]) => {
        const q = p.imagePoint(x, y);
        return l.groundAt(q.x, q.y);
      });
      if (corners.some((c) => !c)) return;
      const lons = corners.map((c) => c.lon);
      const lats = corners.map((c) => c.lat);
      const pad = (maxOf(lons) - minOf(lons)) * 0.05;
      const ids = index.search(minOf(lons) - pad, minOf(lats) - pad, maxOf(lons) + pad, maxOf(lats) + pad);
      const ts = toScreenFor(p);
      for (const id of ids) {
        const f = S.get(id);
        if (!f) continue;
        const v = S.get(f.vlayer);
        const st = { ...STYLE, ...(v?.style ?? {}), ...(app.attribution?.ruleStyle(v, f) ?? {}), ...(f.style ?? {}) };
        const selected = app.selection.has(id);
        g.save();
        g.lineWidth = st.width ?? 2;
        const ps = parts(f.geom).map((pt) => pt.map(ts));
        if (ps.some((pt) => pt.some((s) => !s))) {
          g.restore();
          continue;
        }
        if (f.geom.type === 'Point' || f.geom.type === 'MultiPoint') {
          for (const [s] of ps) {
            g.strokeStyle = selected ? SEL : st.stroke;
            halo(g, () => {
              g.beginPath();
              g.arc(s.x, s.y, 5, 0, Math.PI * 2);
            });
          }
        } else {
          const poly = isPolygonal(f.geom);
          g.beginPath();
          for (const pt of ps) {
            pt.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
            if (poly) g.closePath();
          }
          if (poly) {
            g.fillStyle = st.fill;
            g.fill('evenodd');
          }
          g.strokeStyle = selected ? SEL : poly ? st.outline ?? st.stroke : st.stroke;
          halo(g, () => {
            g.beginPath();
            for (const pt of ps) {
              pt.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
              if (poly) g.closePath();
            }
          });
        }
        // Labels from an attribute (contour elevations, REQ-DEM-11): at the middle of the first part.
        const lab = st.labelField && f.attrs?.[st.labelField];
        if (lab !== undefined && lab !== null && lab !== '' && (!st.labelWhen || f.attrs?.[st.labelWhen]) && ps[0]?.length) {
          const m = ps[0][Math.floor(ps[0].length / 2)];
          g.font = `${st.labelSize ?? 11}px Arial, sans-serif`;
          g.lineWidth = 3;
          g.strokeStyle = '#000';
          g.strokeText(String(lab), m.x + 3, m.y - 3);
          g.fillStyle = st.labelColour ?? st.stroke;
          g.fillText(String(lab), m.x + 3, m.y - 3);
        }
        if (selected) {
          g.fillStyle = VTX;
          for (const pt of ps) for (const s of pt) g.fillRect(s.x - 3, s.y - 3, 6, 6);
          // Midpoint handles (click to insert).
          g.fillStyle = '#ffffff';
          for (const [i, j] of edges(f.geom)) {
            const a = ts(vertex(f.geom, i));
            const b = ts(vertex(f.geom, j));
            if (a && b) g.fillRect((a.x + b.x) / 2 - 2, (a.y + b.y) / 2 - 2, 4, 4);
          }
        }
        g.restore();
      }
    },
  };

  // ---- capture pipeline ----
  /** Input stage for one cursor sample: snap → constrain → Z source. */
  function sample(p, sx, sy, pts, { exclude = null } = {}) {
    const pr = prefs();
    let s = pr.snap ? snapAt(app, index, p, sx, sy, { tol: pr.tol, extra: pts, exclude, toScreen: toScreenFor(p) }) : null;
    let q;
    if (s) q = { lon: s.lon, lat: s.lat, h: s.h, zsrc: 'snap', snap: s };
    else {
      const gr = groundOf(app, p, sx, sy);
      if (!gr) return null;
      q = { lon: gr.lon, lat: gr.lat, h: gr.h, zsrc: app.terrain?.sample?.(gr.lat, gr.lon) ? 'dem' : 'model' };
      // Orthogonal: parallel or perpendicular to the first segment, from the last vertex.
      if (pr.ortho && pts.length >= 2) {
        const F = frame(pts[0].lat, pts[0].lon);
        const [ax, ay] = F.to(pts[0].lon, pts[0].lat);
        const [bx, by] = F.to(pts[1].lon, pts[1].lat);
        const L = Math.hypot(bx - ax, by - ay) || 1;
        const u = [(bx - ax) / L, (by - ay) / L];
        const nrm = [-u[1], u[0]];
        const last = pts.at(-1);
        const [lx, ly] = F.to(last.lon, last.lat);
        const [cx, cy] = F.to(q.lon, q.lat);
        const du = (cx - lx) * u[0] + (cy - ly) * u[1];
        const dn = (cx - lx) * nrm[0] + (cy - ly) * nrm[1];
        const [x, y] = Math.abs(du) >= Math.abs(dn) ? [lx + du * u[0], ly + du * u[1]] : [lx + dn * nrm[0], ly + dn * nrm[1]];
        const [lon, lat] = F.from(x, y);
        const t = app.terrain?.sample?.(lat, lon);
        q = { lon, lat, h: t ? t.hae : q.h, zsrc: t ? 'dem' : q.zsrc, ortho: true };
      }
    }
    if (pr.constZ) q = { ...q, h: Number(pr.z) || 0, zsrc: 'constant' };
    return q;
  }

  /** Feature stage: close, square; then the record. */
  function commitFeature(p, type, pts, extra = {}) {
    const pr = prefs();
    let ring = pts.map((q) => [q.lon, q.lat, q.h]);
    let note = '';
    let gtype = type;
    if (type === 'LineString' && pr.close && ring.length > 2) ring = [...ring, ring[0]];
    if (type === 'Polygon' && (pr.square || extra.square)) {
      try {
        const r = app.core.squareRing(ring, false);
        ring = r.ring;
        note = `Squared (${r.method}): corners 90° ± ${r.maxCornerErrorDeg.toExponential(1)}°.`;
      } catch (e) {
        note = `Not squared: ${e.message}. The outline is kept as drawn.`;
      }
    }
    const geom = gtype === 'Point' ? fromParts('Point', [[ring[0]]]) : fromParts(gtype, [ring]);
    const l = p.geoLayer?.();
    let id;
    S.transact(`Capture ${gtype}`, (tx) => {
      const vl = ensureLayer(tx);
      const ufi = uuid();
      id = tx.create('feature', {
        vlayer: vl,
        ufi,
        geom,
        attrs: app.attribution?.initialAttrs(vl, geom, { ufi, layer: l, pane: p, height: extra.height }) ?? {},
        name: null,
        description: null,
        prov: { kind: 'capture', image: l?.info?.iid ?? null, model: l?.modelName ?? null, zsrc: pts.map((q) => q.zsrc), snapped: pts.filter((q) => q.snap).length, created: new Date().toISOString() },
      });
    });
    app.selection.clear();
    app.selection.add(id);
    if (note) app.cue?.(note);
    if (note) app.toast(note, { kind: /^Not/.test(note) ? 'warn' : 'info' });
    return id;
  }
  app.commitFeature = commitFeature;

  const cursorShape = (g, s) => {
    if (!s) return;
    g.save();
    g.strokeStyle = '#ffff00';
    g.lineWidth = 2;
    const { x, y } = s.screen;
    g.beginPath();
    if (s.kind === 'vertex') g.rect(x - 6, y - 6, 12, 12);
    else if (s.kind === 'intersection') {
      g.moveTo(x - 7, y - 7);
      g.lineTo(x + 7, y + 7);
      g.moveTo(x + 7, y - 7);
      g.lineTo(x - 7, y + 7);
    } else {
      g.moveTo(x, y - 7);
      g.lineTo(x + 7, y);
      g.lineTo(x, y + 7);
      g.lineTo(x - 7, y);
      g.closePath();
    }
    g.stroke();
    g.font = '11px Arial, sans-serif';
    g.lineWidth = 3;
    g.strokeStyle = '#000';
    g.strokeText(s.label, x + 10, y - 10);
    g.fillStyle = '#ffff00';
    g.fillText(s.label, x + 10, y - 10);
    g.restore();
  };

  const KINDS = {
    'ext.point': { type: 'Point', n: 1, label: 'Point', cue: 'Point: click to place a point. Snapping and constant elevation apply.' },
    'ext.polyline': { type: 'LineString', n: Infinity, label: 'Polyline', cue: 'Polyline: click vertices; double-click or Enter finishes; Backspace removes the last vertex; Esc cancels.' },
    'ext.polygon': { type: 'Polygon', n: Infinity, label: 'Polygon', cue: 'Polygon: click vertices; Enter, a double-click or a click on the first vertex closes it. Square makes right angles.' },
    'ext.rect3': { type: 'Polygon', n: 3, label: '3-Point Rectangle', cue: '3-Point Rectangle: click the start and end of one edge, then a point on the opposite side. Corners are exact right angles.' },
    'ext.ngon': { type: 'Polygon', n: 2, label: 'Circle / N-gon', cue: 'Circle / N-gon: click the centre, then a point on the circle. The vertex count is in the ToolBox.' },
  };

  /** 3-point rectangle and n-gon geometry from their clicks. */
  function shapeOf(id, pts) {
    if (id === 'ext.rect3') {
      const [a, b, c] = pts;
      const F = frame(a.lat, a.lon);
      const A = F.to(a.lon, a.lat);
      const B = F.to(b.lon, b.lat);
      const P = F.to(c.lon, c.lat);
      const L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      const n = [-(B[1] - A[1]) / L, (B[0] - A[0]) / L];
      const w = (P[0] - A[0]) * n[0] + (P[1] - A[1]) * n[1];
      const D = [B[0] + n[0] * w, B[1] + n[1] * w];
      const E = [A[0] + n[0] * w, A[1] + n[1] * w];
      const hz = prefs().constZ ? Number(prefs().z) || 0 : (a.h + b.h + c.h) / 3;
      let ring = [A, B, D, E].map(([x, y]) => [...F.from(x, y), hz]);
      // Exact right angles in ENU (the local frame is right only to second order).
      try {
        ring = app.core.squareRing(ring).ring;
      } catch {
        /* keep the frame rectangle */
      }
      return ring.map(([lon, lat]) => ({ lon, lat, h: hz, zsrc: prefs().constZ ? 'constant' : a.zsrc }));
    }
    if (id === 'ext.ngon') {
      const [c, e] = pts;
      const r = app.core.inverse(c.lat, c.lon, e.lat, e.lon).distance;
      const n = Math.max(3, Math.min(360, Math.round(prefs().ngon)));
      return Array.from({ length: n }, (_, i) => {
        const d = app.core.direct(c.lat, c.lon, (i * 360) / n, r);
        return { lon: d.lon, lat: d.lat, h: c.h, zsrc: c.zsrc };
      });
    }
    return pts;
  }

  for (const [id, def] of Object.entries(KINDS)) {
    app.tools.register({
      id,
      cue: def.cue,
      start() {
        this.state = { pts: [] };
      },
      onDown(p, e, sx, sy) {
        const st = this.state;
        st.pts ??= [];
        const q = sample(p, sx, sy, st.pts);
        if (!q) {
          app.toast('No ground position here (the image has no sensor model)', { kind: 'warn' });
          return true;
        }
        // A click on the first vertex closes a polygon.
        if (def.type === 'Polygon' && def.n === Infinity && st.pts.length >= 3 && q.snap?.fid === null && q.snap?.vi === 0) {
          finish(p);
          return true;
        }
        st.pts.push(q);
        if (st.pts.length >= def.n) finish(p);
        p.invalidate();
        return true;
      },
      onMove(p, e, sx, sy) {
        const st = this.state;
        const q = sample(p, sx, sy, st.pts ?? []);
        st.hover = q;
        st.snapView = q?.snap ? { ...q.snap, screen: screenOfGround(p, q.lat, q.lon, q.h) ?? { x: sx, y: sy } } : null;
        p.invalidate();
      },
      onDblClick(p) {
        if (def.n === Infinity) finish(p, true);
        return true;
      },
      onEnter(p) {
        if (def.n === Infinity) finish(p);
      },
      onKey(p, e) {
        if (e.key === 'Backspace' && this.state.pts?.length) {
          this.state.pts.pop();
          p.invalidate();
          return true;
        }
        return false;
      },
      draw(p, g, w, hh, st) {
        const all = [...(st.pts ?? [])];
        if (st.hover) all.push(st.hover);
        const shown = def.n !== Infinity && all.length === def.n ? shapeOf(id, all) : all;
        const scr = shown.map((q) => screenOfGround(p, q.lat, q.lon, q.h)).filter(Boolean);
        g.save();
        g.strokeStyle = '#ffff00';
        g.lineWidth = 2;
        halo(g, () => {
          g.beginPath();
          scr.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
          if (def.type === 'Polygon' && scr.length > 2) g.closePath();
        });
        g.fillStyle = VTX;
        for (const s of scr) g.fillRect(s.x - 3, s.y - 3, 6, 6);
        g.restore();
        cursorShape(g, st.snapView);
      },
    });
    const finish = (p, dbl = false) => {
      const t = app.tools.current;
      if (t?.id !== id) return;
      let pts = t.state.pts ?? [];
      // A double-click adds the same point twice; drop the duplicate.
      if (dbl && pts.length > 1) {
        const [a, b] = pts.slice(-2);
        if (Math.abs(a.lon - b.lon) < 1e-10 && Math.abs(a.lat - b.lat) < 1e-10) pts = pts.slice(0, -1);
      }
      const min = def.type === 'Polygon' ? (def.n === Infinity ? 3 : def.n) : def.type === 'LineString' ? 2 : 1;
      if (pts.length < min) return;
      const shape = shapeOf(id, pts);
      t.state = { pts: [] };
      commitFeature(p, def.type, shape);
      app.tools.done(); // repeat mode selected the tool sticky
      p.invalidate();
    };
  }
  const selectTool = (id) => app.tools.select(id, { sticky: prefs().repeat });
  app.selectExtractTool = selectTool;

  // ---- editing: select, vertex move/insert/delete with Snap Guard ----
  function hitFeature(p, sx, sy, tol = 8) {
    const l = p.geoLayer?.();
    if (!l?.modelId) return null;
    const q = p.imagePoint(sx, sy);
    const gr = l.groundAt(q.x, q.y);
    if (!gr) return null;
    const ts = toScreenFor(p);
    const b = p.imagePoint(sx + 30, sy + 30);
    const gb = l.groundAt(b.x, b.y);
    const r = gb ? Math.max(Math.abs(gb.lat - gr.lat), Math.abs(gb.lon - gr.lon)) : 1e-3;
    let best = null;
    for (const id of index.search(gr.lon - r, gr.lat - r, gr.lon + r, gr.lat + r)) {
      const f = S.get(id);
      if (!f) continue;
      let d = Infinity;
      for (const [i, j] of edges(f.geom)) {
        const a = ts(vertex(f.geom, i));
        const c = ts(vertex(f.geom, j));
        if (!a || !c) continue;
        const dx = c.x - a.x;
        const dy = c.y - a.y;
        const L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((sx - a.x) * dx + (sy - a.y) * dy) / L)) : 0;
        d = Math.min(d, Math.hypot(sx - a.x - t * dx, sy - a.y - t * dy));
      }
      if (f.geom.type === 'Point' || f.geom.type === 'MultiPoint') for (let i = 0; i < f.geom.xyz.length / 3; i++) {
        const s = ts(vertex(f.geom, i));
        if (s) d = Math.min(d, Math.hypot(s.x - sx, s.y - sy));
      }
      if (isPolygonal(f.geom) && pointInPolygonal([gr.lon, gr.lat], f.geom)) d = Math.min(d, tol - 0.01);
      if (d <= tol && (!best || d < best.d)) best = { f, d };
    }
    return best?.f ?? null;
  }
  app.hitFeature = hitFeature;

  /** Handle under the cursor of a selected feature: {f, kind: 'vertex'|'mid', i, j}. */
  function handleAt(p, sx, sy) {
    const ts = toScreenFor(p);
    for (const f of sel()) {
      for (let i = 0; i < f.geom.xyz.length / 3; i++) {
        const s = ts(vertex(f.geom, i));
        if (s && Math.hypot(s.x - sx, s.y - sy) <= 6) return { f, kind: 'vertex', i };
      }
      for (const [i, j] of edges(f.geom)) {
        const a = ts(vertex(f.geom, i));
        const b = ts(vertex(f.geom, j));
        if (a && b && Math.hypot((a.x + b.x) / 2 - sx, (a.y + b.y) / 2 - sy) <= 5) return { f, kind: 'mid', i, j };
      }
    }
    return null;
  }

  /** Other features' vertices coincident with vertex i of f (Snap Guard). */
  function sharedWith(f, i) {
    const v = vertex(f.geom, i);
    return index
      .vertices(v[0], v[1], 1e-9)
      .filter(([fid]) => fid !== f.id)
      .map(([fid, vi]) => ({ fid, vi }));
  }

  app.tools.register({
    id: 'sel.features',
    cue: 'Select Features: click a feature (Shift adds). Drag a cyan vertex to move it, click a white midpoint to insert one, Delete removes the picked vertex.',
    onDown(p, e, sx, sy) {
      const hd = handleAt(p, sx, sy);
      if (hd?.kind === 'mid') {
        const f = hd.f;
        const a = vertex(f.geom, hd.i);
        const b = vertex(f.geom, hd.j);
        const part = partOf(f.geom, hd.i);
        const at = hd.j > hd.i ? hd.j : partRanges(f.geom)[part][1];
        S.transact('Insert vertex', (tx) => tx.set(f.id, 'geom', insertVertex(f.geom, part, at, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2])));
        this.state.pick = { fid: f.id, i: at };
        return true;
      }
      if (hd?.kind === 'vertex') {
        const shared = sharedWith(hd.f, hd.i);
        this.state.pick = { fid: hd.f.id, i: hd.i };
        if (shared.length && prefs().snapGuard === 'warn' && !this.state.guardOk?.[`${hd.f.id}:${hd.i}`]) {
          // Snap Guard: warn before breaking a shared vertex; the next drag follows the choice.
          void confirmBox('Snap Guard', `This vertex is shared with ${shared.length} other feature(s). Move them together, or move only this feature's vertex (breaking the coincidence)?`, { ok: 'Move together', cancel: 'Only this feature' }).then((together) => {
            this.state.guardOk = { ...(this.state.guardOk ?? {}), [`${hd.f.id}:${hd.i}`]: together ? 'together' : 'break' };
          });
          return true;
        }
        const mode = prefs().snapGuard === 'together' ? 'together' : this.state.guardOk?.[`${hd.f.id}:${hd.i}`] ?? 'break';
        this.state.drag = { fid: hd.f.id, i: hd.i, shared: mode === 'together' ? shared : [], orig: hd.f.geom };
        return true;
      }
      const f = hitFeature(p, sx, sy);
      if (!e.shiftKey) for (const id of [...app.selection]) if (S.get(id)?.type === 'feature') app.selection.delete(id);
      if (f) app.selection.add(f.id);
      this.state.pick = null;
      app.emit('selection');
      invalidateAll();
      return !!f;
    },
    onMove(p, e, sx, sy) {
      const d = this.state.drag;
      if (!d || !(e.buttons & 1)) return;
      const q = sample(p, sx, sy, [], { exclude: d.fid });
      if (!q) return;
      d.to = [q.lon, q.lat, q.h];
      d.preview = setVertex(d.orig, d.i, d.to);
      invalidateAll();
    },
    onUp() {
      const d = this.state.drag;
      this.state.drag = null;
      if (!d?.to) return;
      S.transact('Move vertex', (tx) => {
        tx.set(d.fid, 'geom', setVertex(S.get(d.fid).geom, d.i, d.to));
        for (const s of d.shared) tx.set(s.fid, 'geom', setVertex(S.get(s.fid).geom, s.vi, d.to));
      }, { mergeKey: `vtx:${d.fid}:${d.i}` });
    },
    onKey(p, e) {
      const pk = this.state.pick;
      if ((e.key === 'Delete' || e.key === 'Backspace') && pk && S.has(pk.fid)) {
        try {
          S.transact('Delete vertex', (tx) => tx.set(pk.fid, 'geom', deleteVertex(S.get(pk.fid).geom, pk.i)));
          this.state.pick = null;
        } catch (er) {
          app.toast(er.message, { kind: 'warn' });
        }
        return true;
      }
      return false;
    },
    draw(p, g, w, hh, st) {
      const d = st.drag;
      if (d?.preview) {
        const ts = toScreenFor(p);
        g.save();
        g.strokeStyle = '#ffff00';
        g.setLineDash([4, 3]);
        for (const pt of parts(d.preview)) {
          g.beginPath();
          pt.map(ts).filter(Boolean).forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
          if (isPolygonal(d.preview)) g.closePath();
          g.stroke();
        }
        g.restore();
      }
      if (st.pick && S.has(st.pick.fid)) {
        const s = toScreenFor(p)(vertex(S.get(st.pick.fid).geom, st.pick.i));
        if (s) {
          g.strokeStyle = '#ffff00';
          g.lineWidth = 2;
          g.strokeRect(s.x - 6, s.y - 6, 12, 12);
        }
      }
    },
  });
  C.implement('sel.features', { enabled: () => S.all('feature').length > 0, checked: () => app.tools.current?.id === 'sel.features', run: () => app.tools.select('sel.features', { sticky: true }) });

  // ---- geometry operations ----
  const one = (pred, what) => {
    const s = sel().filter(pred);
    if (!s.length) throw new Error(`select ${what} first (Select Features)`);
    return s;
  };
  const run = (fn) => async () => {
    try {
      await fn();
    } catch (e) {
      app.toast(e.message, { kind: 'warn' });
    }
  };

  C.implement('ext.square', {
    enabled: () => sel().some((f) => isPolygonal(f.geom)),
    run: run(() => {
      const fs = one((f) => isPolygonal(f.geom), 'a polygon');
      const notes = [];
      S.transact(`Square ${fs.length}`, (tx) => {
        for (const f of fs) {
          const groups = polygonGroups(f.geom).map((rs) =>
            rs.map((r) => {
              try {
                const q = app.core.squareRing(r, prefs().diagonals === true);
                notes.push(q.maxCornerErrorDeg);
                return q.ring;
              } catch (e) {
                notes.push(e.message);
                return r;
              }
            }),
          );
          const flat = groups.flat();
          const polys = [];
          let k = 0;
          for (const gr of groups) {
            polys.push(k);
            k += gr.length;
          }
          tx.set(f.id, 'geom', fromParts(f.geom.type, flat, polys));
        }
      });
      const errs = notes.filter((n) => typeof n === 'string');
      const ok = notes.filter((n) => typeof n === 'number');
      const msg = `${ok.length} ring(s) squared${ok.length ? `: corners 90° ± ${Math.max(...ok).toExponential(1)}°` : ''}${errs.length ? `; ${errs.length} kept as drawn (${errs[0]})` : ''}`;
      app.cue?.(msg);
      app.toast(msg, { kind: errs.length ? 'warn' : 'info' });
    }),
  });

  /** Split: a selected line at the clicked point, or a selected polygon along a drawn line. */
  app.tools.register({
    id: 'ext.split',
    cue: 'Split: for a line, click where to split it. For a polygon, click a cutting line across it and press Enter.',
    onDown(p, e, sx, sy) {
      const target = sel()[0];
      if (!target) return true;
      const q = sample(p, sx, sy, this.state.pts ?? []);
      if (!q) return true;
      if (isLinear(target.geom)) {
        splitLine(target, [q.lon, q.lat, q.h]);
        app.tools.done();
        return true;
      }
      (this.state.pts ??= []).push(q);
      p.invalidate();
      return true;
    },
    onEnter() {
      const target = sel()[0];
      const pts = this.state.pts ?? [];
      if (target && isPolygonal(target.geom) && pts.length >= 2) {
        try {
          splitPolygon(target, pts.map((q) => [q.lon, q.lat]));
        } catch (e) {
          app.toast(e.message, { kind: 'warn' });
        }
      }
      app.tools.done();
    },
    draw(p, g, w, hh, st) {
      const scr = (st.pts ?? []).map((q) => screenOfGround(p, q.lat, q.lon, q.h)).filter(Boolean);
      g.strokeStyle = '#ffff00';
      g.lineWidth = 2;
      halo(g, () => {
        g.beginPath();
        scr.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
      });
    },
  });

  /** A feature's fields without its store identity (for a split-off copy). */
  const copyOf = (f) => {
    const { id, type, ...rest } = structuredClone(f);
    return rest;
  };

  function splitLine(f, at) {
    // Nearest point on the line (local metric frame), split there; attributes are copied.
    const ps = parts(f.geom);
    const F = frame(at[1], at[0]);
    const P = F.to(at[0], at[1]);
    let best = null;
    ps.forEach((pt, k) =>
      pt.slice(0, -1).forEach((a, i) => {
        const b = pt[i + 1];
        const A = F.to(a[0], a[1]);
        const B = F.to(b[0], b[1]);
        const dx = B[0] - A[0];
        const dy = B[1] - A[1];
        const L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L)) : 0;
        const d = Math.hypot(P[0] - A[0] - t * dx, P[1] - A[1] - t * dy);
        if (!best || d < best.d) best = { d, k, i, t, v: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])] };
      }),
    );
    if (!best) throw new Error('the line has no segment there');
    const pt = ps[best.k];
    const first = [...pt.slice(0, best.i + 1), best.v];
    const second = [best.v, ...pt.slice(best.i + 1)];
    if (first.length < 2 || second.length < 2) throw new Error('split at an end leaves an empty line');
    const others = ps.filter((_, k) => k !== best.k);
    S.transact('Split line', (tx) => {
      tx.set(f.id, 'geom', fromParts(others.length ? 'MultiLineString' : 'LineString', [first, ...others]));
      tx.create('feature', { ...copyOf(f), ufi: uuid(), geom: fromParts('LineString', [second]), prov: { ...(f.prov ?? {}), kind: 'split', from: f.ufi } });
    });
  }

  const toPC = (g) => polygonGroups(g).map((rs) => rs.map((r) => [...r.map((v) => [v[0], v[1]]), [r[0][0], r[0][1]]]));
  const fromPC = (mp, h) => {
    const flat = [];
    const polys = [];
    for (const poly of mp) {
      polys.push(flat.length);
      for (const r of poly) flat.push(r.slice(0, -1).map(([x, y]) => [x, y, h]));
    }
    return fromParts(mp.length > 1 ? 'MultiPolygon' : 'Polygon', flat, mp.length > 1 ? polys : [0]);
  };
  const meanH = (g) => {
    let s = 0;
    for (let i = 2; i < g.xyz.length; i += 3) s += g.xyz[i];
    return s / (g.xyz.length / 3);
  };

  function splitPolygon(f, line) {
    // The half-plane left of the extended cutting line, intersected and subtracted.
    const [x0, y0, x1, y1] = bbox(f.geom);
    const D = Math.hypot(x1 - x0, y1 - y0) * 4 + 1e-6;
    const dir = (a, b) => {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    };
    const u0 = dir(line[1], line[0]);
    const u1 = dir(line.at(-2), line.at(-1));
    const e0 = [line[0][0] + u0[0] * D, line[0][1] + u0[1] * D];
    const e1 = [line.at(-1)[0] + u1[0] * D, line.at(-1)[1] + u1[1] * D];
    const n1 = [-u1[1], u1[0]];
    const side = [e0, ...line, e1, [e1[0] + n1[0] * D, e1[1] + n1[1] * D], [e0[0] + n1[0] * D, e0[1] + n1[1] * D], e0];
    const poly = toPC(f.geom);
    const a = polygonClipping.intersection(poly, [[side]]);
    const b = polygonClipping.difference(poly, [[side]]);
    if (!a.length || !b.length) throw new Error('the cutting line does not cross the polygon');
    const h0 = meanH(f.geom);
    S.transact('Split polygon', (tx) => {
      tx.set(f.id, 'geom', fromPC(a, h0));
      tx.create('feature', { ...copyOf(f), ufi: uuid(), geom: fromPC(b, h0), prov: { ...(f.prov ?? {}), kind: 'split', from: f.ufi } });
    });
  }
  app.splitPolygon = splitPolygon;
  app.splitLine = splitLine;
  C.implement('ext.split', { enabled: () => sel().length === 1 && !(sel()[0].geom.type === 'Point'), run: () => app.tools.select('ext.split') });

  C.implement('ext.merge', {
    enabled: () => sel().length >= 2,
    run: run(() => {
      const fs = sel();
      if (new Set(fs.map((f) => f.vlayer)).size > 1) throw new Error('merge features of one layer');
      const keep = fs[0];
      let geom;
      if (fs.every((f) => isPolygonal(f.geom))) geom = fromPC(polygonClipping.union(...fs.map((f) => toPC(f.geom))), meanH(keep.geom));
      else if (fs.every((f) => isLinear(f.geom))) {
        // Join lines end to end where they meet; otherwise a MultiLineString.
        let lines = fs.flatMap((f) => parts(f.geom));
        const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
        for (let changed = true; changed; ) {
          changed = false;
          outer: for (let i = 0; i < lines.length; i++)
            for (let j = 0; j < lines.length; j++) {
              if (i === j) continue;
              const a = lines[i];
              const b = lines[j];
              let m = null;
              if (same(a.at(-1), b[0])) m = [...a, ...b.slice(1)];
              else if (same(a.at(-1), b.at(-1))) m = [...a, ...[...b].reverse().slice(1)];
              if (m) {
                lines = lines.filter((_, k) => k !== i && k !== j).concat([m]);
                changed = true;
                break outer;
              }
            }
        }
        geom = fromParts(lines.length > 1 ? 'MultiLineString' : 'LineString', lines);
      } else if (fs.every((f) => f.geom.type === 'Point' || f.geom.type === 'MultiPoint')) geom = fromParts('MultiPoint', fs.flatMap((f) => parts(f.geom)));
      else throw new Error('merge features of one geometry type');
      S.transact(`Merge ${fs.length}`, (tx) => {
        tx.set(keep.id, 'geom', geom);
        for (const f of fs.slice(1)) tx.delete(f.id);
      });
      app.selection.clear();
      app.selection.add(keep.id);
    }),
  });

  /** Reshape: draw a new path whose ends land on the selected feature's boundary. */
  app.tools.register({
    id: 'ext.reshape',
    cue: 'Reshape: click a new path from one point on the selected boundary to another, then press Enter. The run of vertices between the two points is replaced.',
    onDown(p, e, sx, sy) {
      const q = sample(p, sx, sy, this.state.pts ?? []);
      if (q) (this.state.pts ??= []).push(q);
      p.invalidate();
      return true;
    },
    onEnter() {
      const f = sel()[0];
      try {
        if (!f || f.geom.type === 'Point') throw new Error('select a line or polygon first');
        reshape(f, (this.state.pts ?? []).map((q) => [q.lon, q.lat, q.h]));
      } catch (e) {
        app.toast(e.message, { kind: 'warn' });
      }
      app.tools.done();
    },
    draw(p, g, w, hh, st) {
      const scr = (st.pts ?? []).map((q) => screenOfGround(p, q.lat, q.lon, q.h)).filter(Boolean);
      g.strokeStyle = '#ffff00';
      g.lineWidth = 2;
      halo(g, () => {
        g.beginPath();
        scr.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
      });
    },
  });

  function reshape(f, path) {
    if (path.length < 2) throw new Error('the new path needs at least two points');
    const near = (v) => {
      let best = null;
      for (let i = 0; i < f.geom.xyz.length / 3; i++) {
        const w = vertex(f.geom, i);
        const d = Math.hypot(w[0] - v[0], w[1] - v[1]);
        if (!best || d < best.d) best = { i, d };
      }
      return best.i;
    };
    const i = near(path[0]);
    const j = near(path.at(-1));
    const pi = partOf(f.geom, i);
    if (pi !== partOf(f.geom, j)) throw new Error('both ends of the path must be on the same ring or line');
    const ps = parts(f.geom);
    const [a] = partRanges(f.geom)[pi];
    const ring = ps[pi];
    let li = i - a;
    let lj = j - a;
    let np = path;
    let out;
    if (isPolygonal(f.geom)) {
      // Keep the longer side of the ring; replace the shorter run between the two ends.
      const n = ring.length;
      const fwd = (lj - li + n) % n;
      if (fwd > n / 2) {
        [li, lj] = [lj, li];
        np = [...path].reverse();
      }
      const kept = [];
      for (let k = lj; k !== li; k = (k + 1) % n) kept.push(ring[k]);
      kept.push(ring[li]);
      out = [...kept.slice(0, -1), ...np];
    } else {
      if (li > lj) {
        [li, lj] = [lj, li];
        np = [...path].reverse();
      }
      out = [...ring.slice(0, li), ...np, ...ring.slice(lj + 1)];
    }
    ps[pi] = out;
    S.transact('Reshape', (tx) => tx.set(f.id, 'geom', fromParts(f.geom.type, ps, f.geom.polys)));
  }
  app.reshapeFeature = reshape;
  C.implement('ext.reshape', { enabled: () => sel().length === 1, run: () => app.tools.select('ext.reshape') });
  C.implement('ext.repeat', { checked: () => prefs().repeat, run: () => setPref({ repeat: !prefs().repeat }) });

  // ---- Edit Vertices table (REQ-EXT-06) ----
  C.implement('ext.vertices', {
    enabled: () => sel().length === 1,
    run: run(async () => {
      const f = sel()[0];
      const rows = [];
      const tb = h('tbody');
      for (let i = 0; i < f.geom.xyz.length / 3; i++) {
        const v = vertex(f.geom, i);
        const inp = (x, label, d) => h('input', { class: 'cell-input', type: 'number', step: 'any', value: x.toFixed(d), 'aria-label': `${label} of vertex ${i + 1}` });
        const lon = inp(v[0], 'Longitude', 9);
        const lat = inp(v[1], 'Latitude', 9);
        const hh = inp(v[2], 'Height (HAE)', 3);
        let mg = '';
        try {
          mg = app.core.mgrs(v[1], v[0], 5);
        } catch {}
        const tr = h('tr', { tabindex: '0' }, h('td', {}, String(i + 1)), h('td', {}, String(partOf(f.geom, i) + 1)), h('td', {}, lon), h('td', {}, lat), h('td', {}, hh), h('td', { class: 'mono small' }, mg));
        tr.addEventListener('click', (e) => {
          if (e.target.tagName === 'INPUT') return;
          const l = pane()?.geoLayer();
          const q = l?.imageAt(v[1], v[0], v[2]);
          if (q) pane().centreOn(q.x, q.y);
        });
        rows.push({ lon, lat, hh });
        tb.appendChild(tr);
      }
      const t = h('table', { class: 'grid-table', 'aria-label': 'Vertices' }, h('thead', {}, h('tr', {}, ['#', 'Part', 'Longitude', 'Latitude', 'Height (m HAE)', 'MGRS'].map((x) => h('th', { scope: 'col' }, x)))), tb);
      const body = h('div', {}, h('div', { class: 'grid-wrap', style: { maxHeight: '50vh', overflow: 'auto' }, tabindex: '0', role: 'region', 'aria-label': 'Vertex table' }, t), h('p', { class: 'hint' }, 'WGS 84; heights above the ellipsoid. Click a row to centre the panel on the vertex.'));
      if ((await modal({ title: 'Edit Vertices', body, buttons: ['Apply', 'Cancel'], width: 640, id: 'ext-vertices' })) !== 'Apply') return;
      const xyz = rows.flatMap((r) => [Number(r.lon.value), Number(r.lat.value), Number(r.hh.value)]);
      if (xyz.some((v) => !Number.isFinite(v))) throw new Error('every cell needs a number');
      S.transact('Edit vertices', (tx) => tx.set(f.id, 'geom', { ...f.geom, xyz }));
    }),
  });

  // ---- attribute table dock and queries (REQ-EXT-12) ----
  app.on('ready', (mp) => mp.docks.register({ id: 'attrtable', title: 'Feature Attributes', icon: 'table', home: 'bottom', create: (a, m, el) => attrTable(el) }));
  C.implement('ext.attrtable', { run: () => app.panels.toggle('attrtable', 'bottom') });

  function attrTable(el) {
    const bar = h('div', { class: 'grid-bar' });
    const wrap = h('div', { class: 'grid-wrap' });
    el.append(bar, wrap);
    const layerSel = h('select', { class: 'inp', 'aria-label': 'Layer' });
    const filter = h('input', { class: 'inp', type: 'search', placeholder: 'Filter', 'aria-label': 'Filter rows' });
    const count = h('span', { class: 'hint', 'aria-live': 'polite' });
    const addField = h('button', { class: 'btn btn-small' }, 'Add Field…');
    bar.append(layerSel, filter, addField, count);
    let sortKey = null;
    let sortDir = 1;
    addField.addEventListener('click', async () => {
      const id = layerSel.value;
      if (!id) return;
      const n = await promptBox('Add Field', 'Field name', '');
      if (!n) return;
      const v = S.get(id);
      S.transact('Add field', (tx) => tx.set(id, 'fields', [...(v.fields ?? []), { name: n, type: 'string' }]));
    });
    const render = () => {
      const ls = vlayers();
      const cur = layerSel.value || activeLayerId();
      clear(layerSel);
      for (const v of ls) layerSel.appendChild(h('option', { value: v.id, selected: v.id === cur }, v.name));
      clear(wrap);
      const id = layerSel.value;
      if (!id) {
        wrap.appendChild(h('p', { class: 'muted pad' }, 'No vector layers. Capture features with the ToolBox or open GeoJSON, Shapefile or KML (File ▸ Open Vector).'));
        count.textContent = '';
        return;
      }
      const v = S.get(id);
      const fs = S.all('feature').filter((f) => f.vlayer === id);
      const fields = [...(v.fields ?? [])];
      for (const f of inferFields(fs)) if (!fields.some((x) => x.name === f.name)) fields.push(f);
      const q = filter.value.trim().toLowerCase();
      let rows = q ? fs.filter((f) => [f.name, ...Object.values(f.attrs ?? {})].some((x) => String(x ?? '').toLowerCase().includes(q))) : fs;
      if (sortKey) rows = [...rows].sort((a, b) => {
        const x = sortKey === 'name' ? a.name : a.attrs?.[sortKey];
        const y = sortKey === 'name' ? b.name : b.attrs?.[sortKey];
        return (x === y ? 0 : x === null || x === undefined ? 1 : y === null || y === undefined ? -1 : x < y ? -1 : 1) * sortDir;
      });
      const cols = [['name', 'Name'], ...fields.map((f) => [f.name, f.name])];
      const t = h('table', { class: 'grid-table', role: 'grid', 'aria-label': `Attributes of ${v.name}` });
      t.appendChild(
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            h('th', { scope: 'col' }, 'Type'),
            cols.map(([k, l]) => {
              const b = h('button', { class: 'th-sort', 'aria-label': `Sort by ${l}` }, `${l}${sortKey === k ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}`);
              b.addEventListener('click', () => {
                sortDir = sortKey === k ? -sortDir : 1;
                sortKey = k;
                render();
              });
              return h('th', { scope: 'col', 'aria-sort': sortKey === k ? (sortDir > 0 ? 'ascending' : 'descending') : 'none' }, b);
            }),
            h('th', { scope: 'col' }, ''),
          ),
        ),
      );
      const tb = h('tbody');
      for (const f of rows.slice(0, 2000)) {
        const cells = cols.map(([k]) => {
          const val = k === 'name' ? f.name : f.attrs?.[k];
          const inp = h('input', { class: 'cell-input', value: val === null || val === undefined ? '' : String(val), 'aria-label': `${k} of feature ${f.ufi?.slice(0, 8)}` });
          inp.addEventListener('change', () => {
            const ty = fields.find((x) => x.name === k)?.type;
            const nv = inp.value === '' ? null : ty === 'integer' || ty === 'number' ? Number(inp.value) : ty === 'boolean' ? inp.value === 'true' : inp.value;
            const bad = k !== 'name' && app.attribution?.checkEdit(f, k, nv);
            if (bad) {
              app.toast(bad, { kind: 'error', ms: 8000 });
              inp.value = val === null || val === undefined ? '' : String(val);
              return;
            }
            S.transact(`Edit ${k}`, (tx) => (k === 'name' ? tx.set(f.id, 'name', nv) : tx.set(f.id, 'attrs', { ...f.attrs, [k]: nv })));
          });
          return h('td', {}, inp);
        });
        const zoom = h('button', { class: 'btn btn-small', 'aria-label': `Zoom to feature ${f.ufi?.slice(0, 8)}` }, 'Zoom');
        zoom.addEventListener('click', () => zoomTo(f));
        const tr = h('tr', { 'data-id': `feature:${f.id}`, class: app.selection.has(f.id) ? 'selected' : null }, h('td', {}, f.geom.type), ...cells, h('td', {}, zoom));
        tr.addEventListener('click', (e) => {
          if (e.target.closest('input,button')) return;
          if (!e.shiftKey) for (const id2 of [...app.selection]) if (S.get(id2)?.type === 'feature') app.selection.delete(id2);
          app.selection.add(f.id);
          invalidateAll();
          render();
        });
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      wrap.appendChild(t);
      count.textContent = `${rows.length} of ${fs.length} feature(s)${rows.length > 2000 ? ' (first 2000 shown)' : ''}; ${fs.filter((f) => app.selection.has(f.id)).length} selected`;
    };
    layerSel.addEventListener('change', () => {
      app.prefs.set('vlayerActive', layerSel.value);
      render();
    });
    filter.addEventListener('input', render);
    S.on('change', render);
    app.on('selection', render);
    render();
    return { onShow: render };
  }

  function zoomTo(f) {
    const p = pane();
    const l = p?.geoLayer();
    if (!l) return;
    const [x0, y0, x1, y1] = bbox(f.geom);
    const c = l.imageAt((y0 + y1) / 2, (x0 + x1) / 2, meanH(f.geom));
    if (c) p.centreOn(c.x, c.y);
    app.selection.add(f.id);
    invalidateAll();
  }
  app.zoomToFeature = zoomTo;

  const OPS = { '=': (a, b) => String(a) === String(b), '≠': (a, b) => String(a) !== String(b), '<': (a, b) => Number(a) < Number(b), '>': (a, b) => Number(a) > Number(b), contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()), 'is empty': (a) => a === null || a === undefined || a === '' };
  /** Select features of a layer by an attribute test. */
  app.selectByAttribute = (layerId, fieldName, op, value) => {
    const fs = S.all('feature').filter((f) => f.vlayer === layerId);
    const hit = fs.filter((f) => OPS[op]?.(fieldName === 'name' ? f.name : f.attrs?.[fieldName], value));
    for (const id of [...app.selection]) if (S.get(id)?.type === 'feature') app.selection.delete(id);
    for (const f of hit) app.selection.add(f.id);
    invalidateAll();
    app.emit('selection');
    return hit.length;
  };
  const queryDialog = async () => {
    const ls = vlayers();
    if (!ls.length) throw new Error('there are no vector layers');
    const layer = h('select', { class: 'inp', 'aria-label': 'Layer' }, ...ls.map((v) => h('option', { value: v.id }, v.name)));
    layer.value = activeLayerId();
    const fieldSel = h('select', { class: 'inp', 'aria-label': 'Field' });
    const fillFields = () => {
      clear(fieldSel);
      const fs = S.all('feature').filter((f) => f.vlayer === layer.value);
      for (const f of ['name', ...new Set([...(S.get(layer.value).fields ?? []).map((x) => x.name), ...inferFields(fs).map((x) => x.name)])]) fieldSel.appendChild(h('option', { value: f }, f));
    };
    fillFields();
    layer.addEventListener('change', fillFields);
    const op = h('select', { class: 'inp', 'aria-label': 'Operator' }, ...Object.keys(OPS).map((o) => h('option', { value: o }, o)));
    const val = h('input', { class: 'inp', 'aria-label': 'Value' });
    if ((await modal({ title: 'Select by Attribute', body: h('div', {}, field('Layer', layer), field('Field', fieldSel), field('Test', op), field('Value', val)), buttons: ['Select', 'Cancel'], id: 'sel-byattr' })) !== 'Select') return;
    const n = app.selectByAttribute(layer.value, fieldSel.value, op.value, val.value);
    app.toast(`${n} feature(s) selected`);
  };
  C.implement('sel.byattr', { enabled: () => vlayers().length > 0, run: run(queryDialog) });
  C.implement('ext.query', { enabled: () => vlayers().length > 0, run: run(queryDialog) });

  /** Select by location: in the view, within d metres of the selection, or inside selected polygons. */
  app.selectByLocation = (layerId, mode, metres = 0) => {
    const p = pane();
    const fs = S.all('feature').filter((f) => f.vlayer === layerId);
    const centroid = (f) => {
      const [x0, y0, x1, y1] = bbox(f.geom);
      return [(x0 + x1) / 2, (y0 + y1) / 2];
    };
    let test;
    if (mode === 'view') {
      const l = p.geoLayer();
      const { w, h: hh } = p.size();
      const ring = [
        [0, 0],
        [w, 0],
        [w, hh],
        [0, hh],
      ].map(([x, y]) => {
        const q = p.imagePoint(x, y);
        const g = l.groundAt(q.x, q.y);
        return [g.lon, g.lat];
      });
      test = (f) => {
        for (let i = 0; i < f.geom.xyz.length; i += 3) if (pointInPolygonal([f.geom.xyz[i], f.geom.xyz[i + 1]], fromParts('Polygon', [ring.map((v) => [...v, 0])]))) return true;
        return false;
      };
    } else {
      const ref = sel();
      if (!ref.length) throw new Error('select the reference features first');
      if (mode === 'inside') {
        const polys = ref.filter((f) => isPolygonal(f.geom));
        if (!polys.length) throw new Error('select one or more polygons first');
        test = (f) => !ref.includes(f) && polys.some((pg) => pointInPolygonal(centroid(f), pg.geom));
      } else {
        const refPts = ref.flatMap((f) => parts(f.geom).flat());
        test = (f) => !ref.some((r) => r.id === f.id) && parts(f.geom).flat().some((v) => refPts.some((q) => app.core.inverse(v[1], v[0], q[1], q[0]).distance <= metres));
      }
    }
    const hit = fs.filter(test);
    for (const id of [...app.selection]) if (S.get(id)?.type === 'feature') app.selection.delete(id);
    for (const f of hit) app.selection.add(f.id);
    invalidateAll();
    app.emit('selection');
    return hit.length;
  };
  C.implement('sel.byloc', {
    enabled: () => vlayers().length > 0,
    run: run(async () => {
      const ls = vlayers();
      const layer = h('select', { class: 'inp', 'aria-label': 'Layer' }, ...ls.map((v) => h('option', { value: v.id }, v.name)));
      layer.value = activeLayerId();
      const mode = h('select', { class: 'inp', 'aria-label': 'Relation' }, h('option', { value: 'view' }, 'In the current view'), h('option', { value: 'within' }, 'Within a distance of the selection'), h('option', { value: 'inside' }, 'Inside the selected polygons'), h('option', { value: 'aoi' }, 'Inside the panel AOI'));
      const dist = h('input', { class: 'inp', type: 'number', min: '0', step: 'any', value: '50', 'aria-label': 'Distance (m)' });
      if ((await modal({ title: 'Select by Location', body: h('div', {}, field('Layer', layer), field('Relation', mode), field('Distance (m)', dist)), buttons: ['Select', 'Cancel'], id: 'sel-byloc' })) !== 'Select') return;
      app.toast(`${app.selectByLocation(layer.value, mode.value, Number(dist.value))} feature(s) selected`);
    }),
  });

  // ---- open and save (REQ-EXT-21) ----
  const reproject = (wkt) => {
    const crs = crsOf({ wkt });
    if (!crs) return null;
    const c = converter(crs);
    return (x, y) => c.toLonLat(x, y);
  };
  const toHae = (lat, lon, alt) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? alt + N : alt;
  };
  const toMsl = (lat, lon, hae) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? hae - N : hae;
  };

  /** Read vector files (GeoJSON, KML/KMZ, Shapefile sets or a zip of them) into layers. */
  /**
   * FlatGeobuf parsed in a worker of its own, stopped after a size-scaled time: the library loops for
   * ever, synchronously, on a cut file, which froze the whole app (TE 2.0.4 cross, damaged-file pass).
   */
  async function fgbInWorker(bytes) {
    const code = await app.gw.text('js-fgb');
    const glue = `;onmessage = async (ev) => { const { deserialize } = globalThis.__lib['js-fgb']; let header = null; const got = []; try { for await (const f of deserialize(new Blob([ev.data]).stream(), undefined, (h) => (header = h))) got.push(f); postMessage({ ok: true, header: header && { crs: header.crs ? { org: header.crs.org, code: header.crs.code } : null }, got }); } catch (e) { postMessage({ ok: false, message: String((e && e.message) || e) }); } };`;
    const url = URL.createObjectURL(new Blob([code, glue], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    const ms = 20000 + Math.ceil(bytes.length / 5e6) * 1000;
    try {
      return await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('it is cut short or damaged: the reader did not finish')), ms);
        w.onmessage = (ev) => (clearTimeout(t), ev.data.ok ? res(ev.data) : rej(new Error(ev.data.message)));
        w.onerror = (ev) => (clearTimeout(t), rej(new Error(ev.message || 'the reader failed')));
        w.postMessage(bytes);
      });
    } finally {
      w.terminate();
    }
  }

  async function openVectorFiles(files) {
    const out = [];
    const bytes = {};
    files = files.filter((f) => {
      // Vector files are parsed whole in memory (a GeoPackage inside SQLite's WASM heap), so very
      // large ones are refused by name instead of exhausting the page (TE-024; streaming them is
      // owner decision OD-07). A zip unpacks to several times its size.
      const cap = /\.zip$/i.test(f.name) ? VECTOR_ZIP_CAP : VECTOR_FILE_CAP;
      if (f.size <= cap) return true;
      const msg = (`${(f.size / 2 ** 20).toFixed(0)} MB: vector files are read whole into memory and this release opens up to ${VECTOR_FILE_CAP / 2 ** 20} MB (${VECTOR_ZIP_CAP / 2 ** 20} MB zipped) — clip or split it first (e.g. ogr2ogr -spat, or one layer per file)`);
      app.toast(`${f.name}: ${msg}`, { kind: 'error', ms: 10000 });
      app.importLog?.push({ file: f.name, errors: [msg], warnings: [] });
      return false;
    });
    const zipped = new Map(); // ZIP name → its entry names, to report a ZIP nothing could be read from
    const fromZip = new Set(); // entries that came out of a ZIP
    const log0 = app.importLog?.length ?? 0;
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        let z;
        try {
          z = unzipSync(new Uint8Array(await f.arrayBuffer()));
        } catch (e) {
          app.importLog?.push({ file: f.name, errors: [`not a readable ZIP (${e.message})`], warnings: [] });
          app.toast(`${f.name}: not a readable ZIP`, { kind: 'error', ms: 9000 });
          continue;
        }
        zipped.set(f.name, Object.keys(z).filter((k) => !k.endsWith('/')));
        // The companions GIS Workbench writes into a shapefile ZIP (Save As ▸ Shapefile) are not data:
        // the DBF field-name map (original,dbf) and the export report. Reading them back as CSV and
        // GeoJSON raised two errors on reopening the app's own export (TE 2.0.4 round trip).
        for (const k of Object.keys(z)) {
          const head = new TextDecoder().decode(z[k].subarray(0, 64));
          if ((/_fieldnames\.csv$/i.test(k) && /^original,dbf\r?\n/.test(head)) || (/_report\.json$/i.test(k) && /"direction"|"features_in"/.test(new TextDecoder().decode(z[k].subarray(0, 400))))) delete z[k];
        }
        for (const k of Object.keys(z)) fromZip.add(k);
        Object.assign(bytes, z);
      } else {
        bytes[f.name] = new Uint8Array(await f.arrayBuffer());
        if (f.fromZip) fromZip.add(f.name);
      }
    }
    for (const set of shapefileSets(bytes)) {
      // A damaged set is reported like any other file, not thrown to the caller (TE 2.0.4 cross, c56).
      try {
        const { layer, report } = readShapefile(set, { name: set.stem, reproject });
        out.push({ id: addLayer(layer, { format: 'Shapefile', file: `${set.stem}.shp`, report }), report });
      } catch (e) {
        app.toast(`${set.stem}.shp: ${errorText(e)}`, { kind: 'error' });
        app.importLog?.push({ file: `${set.stem}.shp`, errors: [errorText(e)], warnings: [] });
      }
    }
    for (const [nm, b] of Object.entries(bytes)) {
      try {
        if (/\.(geojson|geojsonl|geojsons|ndjson|json)$/i.test(nm) && !/\.(gwt|gwb)\.json$/i.test(nm)) {
          const { layer, report } = readGeoJSON(new TextDecoder().decode(b), { name: nm.replace(/\.\w+$/, ''), reproject: (n) => {
            const m = /EPSG:+(\d+)/.exec(n);
            const crs = m ? crsOf({ epsg: Number(m[1]) }) : null;
            if (!crs) return null;
            const c = converter(crs);
            return (x, y) => c.toLonLat(x, y);
          } });
          out.push({ id: addLayer(layer, { format: 'GeoJSON', file: nm, report }), report });
        } else if (/\.(gpkg|csv)$/i.test(nm) && app.vectorReaders) {
          const ext = /\.(\w+)$/.exec(nm)[1].toLowerCase();
          const got = await app.vectorReaders[ext](b, nm);
          // TE-006: an empty result must not be silent.
          if (!got.length && !got.tilesOpened) throw new Error(`no feature layers or tile pyramids found in the ${ext.toUpperCase()} file`);
          for (const o of got) out.push({ id: o.id, report: o.report ?? { format: ext.toUpperCase(), features_out: S.all('feature').filter((f) => f.vlayer === o.id).length, warnings: [] } });
        } else if (/\.(fgb|parquet)$/i.test(nm)) {
          // FlatGeobuf and GeoParquet (what Convert writes) come in as GeoJSON with their CRS.
          const fgb = /\.fgb$/i.test(nm);
          const lib = await app.gw.runScript(fgb ? 'js-fgb' : 'js-parquet');
          const { fc, notes } = fgb ? await readFgb(lib, b, { run: fgbInWorker }) : await readGeoParquet(lib, b, { gunzip: gunzipSync });
          const { layer, report } = readGeoJSON(fc, { name: nm.replace(/\.\w+$/, ''), reproject: (n) => {
            const m = /EPSG:+(\d+)/.exec(n);
            const crs = m ? crsOf({ epsg: Number(m[1]) }) : null;
            if (!crs) return null;
            const c = converter(crs);
            return (x, y) => c.toLonLat(x, y);
          } });
          report.format = fgb ? 'FlatGeobuf' : 'GeoParquet';
          report.warnings.unshift(...notes);
          out.push({ id: addLayer(layer, { format: report.format, file: nm, report }), report });
        } else if (/\.gml$/i.test(nm)) {
          const { layer, report } = readGml(new TextDecoder().decode(b), { name: nm.replace(/\.\w+$/, ''), reproject: (epsg) => {
            const crs = crsOf({ epsg });
            if (!crs) return null;
            const c = converter(crs);
            return (x, y) => c.toLonLat(x, y);
          } });
          out.push({ id: addLayer(layer, { format: 'GML', file: nm, report }), report });
        } else if (/\.gpx$/i.test(nm)) {
          // Convert reads GPX as features (waypoints → points, routes and track segments → lines, Z = HAE);
          // a GPX dropped on the map is drawn as ground graphics instead (REQ-IMG-31).
          // Points without <ele> have h = NaN: such a geometry is written 2D rather than given a made-up height.
          const dims = (cs) => (cs.every((c) => Number.isFinite(c[2])) ? cs : cs.map(([x, y]) => [x, y]));
          const features = parseGpx(new TextDecoder().decode(b), toHae).map((g) => ({
            type: 'Feature',
            geometry: g.shape === 'marker' ? { type: 'Point', coordinates: dims(g.coords)[0] } : { type: 'LineString', coordinates: dims(g.coords) },
            properties: { name: g.text, description: g.description, gpx: g.gps, ...(g.time ? { time: g.time } : {}) },
          }));
          if (!features.length) throw new Error('the GPX has no waypoints, routes or tracks');
          const { layer, report } = readGeoJSON(JSON.stringify({ type: 'FeatureCollection', features }), { name: nm.replace(/\.\w+$/, '') });
          report.format = 'GPX';
          out.push({ id: addLayer(layer, { format: 'GPX', file: nm, report }), report });
        } else if (/\.kml$/i.test(nm)) {
          const { layer, report } = readKml(new TextDecoder().decode(b), { name: nm.replace(/\.\w+$/, ''), toHae });
          out.push({ id: addLayer(layer, { format: 'KML', file: nm, report }), report });
        } else if (/\.kmz$/i.test(nm)) {
          const z = unzipSync(b);
          const doc = Object.keys(z).find((k) => /(^|\/)doc\.kml$/i.test(k)) ?? Object.keys(z).find((k) => /\.kml$/i.test(k));
          if (!doc) throw new Error('the KMZ has no KML document');
          const { layer, report } = readKml(new TextDecoder().decode(z[doc]), { name: nm.replace(/\.\w+$/, ''), toHae });
          layer.assets = Object.fromEntries(Object.entries(z).filter(([k]) => k !== doc && !k.endsWith('/')));
          report.warnings.push(`${Object.keys(layer.assets).length} file(s) kept from the KMZ (icons and overlays)`);
          out.push({ id: addLayer(layer, { format: 'KMZ', file: nm, report }), report });
        }
      } catch (e) {
        // A .json beside the data in a ZIP that is not GeoJSON (a chip record, STAC or other metadata)
        // is a companion, not a failed layer (TE 2.0.4: the app's own chip ZIP reopened with an error).
        if (fromZip.has(nm) && /\.json$/i.test(nm) && /^not GeoJSON/.test(e.message)) {
          app.importLog?.push({ file: nm, errors: [], warnings: [`${nm}: not GeoJSON; left out (${e.message.slice(12)})`] });
          continue;
        }
        app.toast(`${nm}: ${errorText(e)}`, { kind: 'error' });
        app.importLog?.push({ file: nm, errors: [errorText(e)], warnings: [] });
      }
    }
    // TE archive: a ZIP with neither vectors nor imagery used to end with no message at all.
    if (!out.length && (app.importLog?.length ?? 0) === log0)
      for (const [zn, names] of zipped) {
        const msg = `the ZIP holds no vector data or imagery GIS Workbench reads (${names.length} file(s): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''})`;
        app.importLog?.push({ file: zn, errors: [msg], warnings: [] });
        app.toast(`${zn}: ${msg}`, { kind: 'error', ms: 9000 });
      }
    for (const o of out) {
      app.importLog?.push({ file: o.report.format, errors: [], warnings: o.report.warnings });
      app.toast(`${S.get(o.id).name}: ${o.report.features_out} feature(s) from ${o.report.format}${o.report.warnings.length ? ` (${o.report.warnings.length} note(s))` : ''}`);
    }
    if (out.length) zoomToLayer(out.at(-1).id);
    return out;
  }
  app.openVectorFiles = openVectorFiles;
  app.encodeLayer = (id, fmt) => encodeLayer(id, fmt); // Convert (features/convert.js)
  app.vectorLayerOut = (id) => layerOut(id);
  /** Split a file list into vector inputs and the rest (images and their sidecars). */
  app.splitVectorFiles = (files) => {
    const hasShp = files.some((f) => /\.shp$/i.test(f.name));
    const hasCsv = files.some((f) => /\.csv$/i.test(f.name));
    // A GDAL .csvt column-type sidecar travels with its CSV (not read; the reader infers types).
    const isVec = (f) => VECTOR_RE.test(f.name) || (hasShp && (SIDE_RE.test(f.name) || /\.prj$/i.test(f.name))) || (hasCsv && /\.csvt$/i.test(f.name));
    return { vector: files.filter(isVec), rest: files.filter((f) => !isVec(f)) };
  };

  function zoomToLayer(id) {
    const fs = S.all('feature').filter((f) => f.vlayer === id);
    const p = pane();
    const l = p?.geoLayer();
    if (!fs.length || !l) return;
    const b = fs.map((f) => bbox(f.geom));
    const c = l.imageAt((Math.min(...b.map((x) => x[1])) + Math.max(...b.map((x) => x[3]))) / 2, (Math.min(...b.map((x) => x[0])) + Math.max(...b.map((x) => x[2]))) / 2, 0);
    if (c && c.x >= 0 && c.y >= 0 && c.x <= l.width && c.y <= l.height) p.centreOn(c.x, c.y);
  }

  C.implement('file.openvector', {
    run: run(async () => {
      const fs = await pickFiles(app, { accept: ['.geojson', '.json', '.kml', '.kmz', '.shp', '.shx', '.dbf', '.prj', '.cpg', '.zip', '.gpkg', '.csv', '.fgb', '.parquet'], description: 'Vector data' });
      if (fs.length) await openVectorFiles(fs);
    }),
  });

  /** Encode a stored layer: {blob, name, types, report}. */
  function encodeLayer(id, fmt) {
    const layer = layerOut(id);
    if (!layer.features.length) throw new Error(`${layer.name || 'the layer'} has no features to save`);
    const stem = (layer.name || 'layer').replace(/[^\w.-]+/g, '_');
    if (fmt === 'geojson') {
      const { text, report } = writeGeoJSON(layer);
      return { blob: textBlob(text, 'application/geo+json'), name: `${stem}.geojson`, types: ['.geojson'], report };
    }
    if (fmt === 'shp') {
      const { files, report } = writeShapefile(layer);
      files[`${stem}_report.json`] = strToU8(JSON.stringify(report, null, 1));
      return { blob: new Blob([zipSync(files)], { type: 'application/zip' }), name: `${stem}_shp.zip`, types: ['.zip'], report, files };
    }
    if (fmt === 'kml' || fmt === 'kmz') {
      const { text, report } = writeKml(layer, { toMsl });
      if (fmt === 'kml') return { blob: textBlob(text, 'application/vnd.google-earth.kml+xml'), name: `${stem}.kml`, types: ['.kml'], report };
      const files = { 'doc.kml': strToU8(text) };
      for (const [k, v] of Object.entries(layer.assets ?? {})) files[k] = v instanceof Uint8Array ? v : new Uint8Array(Object.values(v));
      return { blob: new Blob([zipSync(files)], { type: 'application/vnd.google-earth.kmz' }), name: `${stem}.kmz`, types: ['.kmz'], report };
    }
    if (fmt === 'csv') {
      const { text, report } = app.attribution.writeCsv(layer);
      return { blob: textBlob(text, 'text/csv'), name: `${stem}.csv`, types: ['.csv'], report };
    }
    throw new Error(`unknown format ${fmt}`);
  }
  app.encodeVectorLayer = encodeLayer;

  const reportView = (r) =>
    h(
      'div',
      { class: 'small' },
      h('p', {}, `${r.format} ${r.direction}: ${r.features_in} in, ${r.features_out} out. ${Object.entries(r.by_geometry).map(([k, v]) => `${k} ${v}`).join(', ')}.`),
      h('p', {}, `CRS: ${r.crs}. Heights: ${r.vertical}. Encoding: ${r.encoding}.`),
      r.fields_renamed.length ? h('p', {}, `Fields renamed: ${r.fields_renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}`) : null,
      Object.keys(r.text_truncated).length ? h('p', {}, `Text truncated: ${Object.entries(r.text_truncated).map(([k, v]) => `${k} (${v})`).join(', ')}`) : null,
      r.warnings.length ? h('ul', {}, ...r.warnings.map((w) => h('li', {}, w))) : null,
    );

  C.implement('ext.saveas', {
    enabled: () => vlayers().length > 0,
    run: run(async () => {
      const ls = vlayers();
      const layer = h('select', { class: 'inp', 'aria-label': 'Layer' }, ...ls.map((v) => h('option', { value: v.id }, v.name)));
      layer.value = activeLayerId();
      const fmt = h('select', { class: 'inp', 'aria-label': 'Format' }, h('option', { value: 'geojson' }, 'GeoJSON (WGS 84, Z = HAE)'), h('option', { value: 'shp' }, 'Shapefile (zip: .shp .shx .dbf .prj .cpg)'), h('option', { value: 'kml' }, 'KML (absolute altitudes, EGM96)'), h('option', { value: 'kmz' }, 'KMZ (KML with icons)'), h('option', { value: 'gpkg' }, 'GeoPackage 1.4 (with domains and R*Tree)'), h('option', { value: 'gpkg-mgcp' }, 'GeoPackage, MGCP cross-walk'), h('option', { value: 'csv' }, 'CSV with WKT'));
      fmt.value = app.prefs.get('vectorFormat') ?? 'geojson';
      if ((await modal({ title: 'Save Features As', body: h('div', {}, field('Layer', layer), field('Format', fmt), h('p', { class: 'hint' }, 'GeoPackage keeps Z, field types, coded domains and an R*Tree index.')), buttons: ['Save', 'Cancel'], id: 'ext-saveas' })) !== 'Save') return;
      app.prefs.set('vectorFormat', fmt.value);
      let out;
      if (fmt.value.startsWith('gpkg')) {
        if (!layerOut(layer.value).features.length) throw new Error(`${S.get(layer.value).name || 'the layer'} has no features to save`);
        const { bytes, report } = await app.attribution.gpkgBytes([layer.value], { mgcp: fmt.value === 'gpkg-mgcp' });
        out = { blob: new Blob([bytes], { type: 'application/geopackage+sqlite3' }), name: `${(S.get(layer.value).name || 'layer').replace(/[^\w.-]+/g, '_')}.gpkg`, types: ['.gpkg'], report };
      } else out = encodeLayer(layer.value, fmt.value);
      await saveBlob(app, out.blob, { name: out.name, types: out.types, description: out.report.format });
      const r = await modal({ title: 'Round-Trip Report', body: reportView(out.report), buttons: ['Close', 'Save Report…'], id: 'ext-report' });
      if (r === 'Save Report…') await saveBlob(app, textBlob(JSON.stringify(out.report, null, 1), 'application/json'), { name: `${out.name}.report.json`, types: ['.json'], description: 'Report' });
    }),
  });

  // ---- ToolBox drawer ----
  app.extractDrawer = () => {
    const pr = prefs();
    const layerSel = h('select', { class: 'inp', 'aria-label': 'Active vector layer' });
    const fillLayers = () => {
      clear(layerSel);
      const cur = activeLayerId();
      for (const v of vlayers()) layerSel.appendChild(h('option', { value: v.id, selected: v.id === cur }, v.name));
      if (!vlayers().length) layerSel.appendChild(h('option', { value: '' }, '(new layer on first capture)'));
    };
    fillLayers();
    S.on('change', fillLayers);
    layerSel.addEventListener('change', () => app.prefs.set('vlayerActive', layerSel.value));
    const newLayer = h('button', { class: 'btn btn-small' }, 'New Layer…');
    newLayer.addEventListener('click', async () => {
      const n = await promptBox('New Vector Layer', 'Name', 'Buildings');
      if (!n) return;
      let id;
      S.transact('New vector layer', (tx) => (id = tx.create('vlayer', { name: n, visible: true, style: { ...STYLE }, fields: [], source: { format: 'new' }, created: new Date().toISOString() })));
      app.prefs.set('vlayerActive', id);
    });
    const btn = (id, label, iconText) => {
      const b = h('button', { class: 'tb-tool tb-text', title: label, 'aria-label': label, 'data-id': `tool:${id}` }, iconText);
      b.addEventListener('click', () => (id.startsWith('ext.') && KINDS[id] ? selectTool(id) : app.commands.run(id)));
      b.addEventListener('dblclick', () => app.tools.select(id, { sticky: true }));
      return b;
    };
    const chk = (key, label) => {
      const c = h('input', { type: 'checkbox', checked: !!pr[key], 'aria-label': label });
      c.addEventListener('change', () => setPref({ [key]: c.checked }));
      return h('label', { class: 'tb-mod' }, c, ` ${label}`);
    };
    const num = (key, label, attrs) => {
      const i = h('input', { class: 'inp inp-small', type: 'number', value: String(pr[key]), 'aria-label': label, ...attrs });
      i.addEventListener('change', () => setPref({ [key]: Number(i.value) }));
      return i;
    };
    const guard = h('select', { class: 'inp inp-small', 'aria-label': 'Snap Guard' }, h('option', { value: 'warn' }, 'warn'), h('option', { value: 'together' }, 'move together'));
    guard.value = pr.snapGuard;
    guard.addEventListener('change', () => setPref({ snapGuard: guard.value }));
    return h(
      'div',
      { class: 'tb-drawer' },
      h('div', { class: 'tb-drawer-head' }, 'Features'),
      h('div', { class: 'tb-row' }, layerSel, newLayer),
      h('div', { class: 'tb-grid' }, btn('ext.point', 'Point', '•'), btn('ext.polyline', 'Polyline', '⌇'), btn('ext.polygon', 'Polygon', '⬠'), btn('ext.rect3', '3-Point Rectangle', '▭'), btn('ext.ngon', 'Circle / N-gon', '◯'), btn('sel.features', 'Select Features', '⬚')),
      h('div', { class: 'tb-mods', role: 'group', 'aria-label': 'Modifiers' }, chk('snap', 'Snap'), h('label', { class: 'tb-mod' }, 'tolerance ', num('tol', 'Snap tolerance (px)', { min: '2', max: '40', step: '1' }), ' px'), chk('ortho', 'Orthogonal'), chk('square', 'Square'), chk('constZ', 'Constant elevation'), h('label', { class: 'tb-mod' }, 'Z ', num('z', 'Constant elevation (m HAE)', { step: 'any' }), ' m HAE'), chk('close', 'Close lines'), h('label', { class: 'tb-mod' }, 'n-gon ', num('ngon', 'N-gon vertices', { min: '3', max: '360', step: '1' })), chk('repeat', 'Repeat'), h('label', { class: 'tb-mod' }, 'Snap Guard ', guard)),
      h('div', { class: 'tb-grid' }, btn('ext.vertices', 'Edit Vertices', '⋮'), btn('ext.split', 'Split', '✂'), btn('ext.merge', 'Merge', '⊕'), btn('ext.reshape', 'Reshape', '∿'), btn('ext.square', 'Square', '⊡'), btn('ext.attrtable', 'Attribute Table', '▦')),
    );
  };
}
