// Medial axis and line centre point (REQ-MEN-08), and linked cursors (REQ-IMG-17).
// Medial Axis measures a selected polygon (graphic or feature) along its medial axis: length
// end to end and mean, minimum and maximum width, logged in the Mensuration Log with the axis
// drawn. Line Centre Point logs the point halfway along a selected line (geodesic length).
// Linked panels show the ground cursor of the panel under the mouse, and a roam cursor while
// it roams, in a configurable shape and colour.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { screenOfGround, halo } from '../tools/tools.js';

export const name = 'measure-extras';

export function install(app) {
  const C = app.commands;
  const S = app.store;
  const pane = () => app.activePane();

  /** The selected polygon or line as [[lon, lat, h], …] with its kind, or null. */
  function selectedShape(kind) {
    for (const id of app.selection ?? []) {
      const r = S.get(id);
      if (!r) continue;
      if (r.type === 'feature') {
        const t = r.geom.type;
        const n = r.geom.parts[1] ?? r.geom.xyz.length / 3;
        const pts = Array.from({ length: n }, (_, i) => [r.geom.xyz[3 * i], r.geom.xyz[3 * i + 1], r.geom.xyz[3 * i + 2]]);
        if (kind === 'polygon' && /Polygon/.test(t)) return { rec: r, pts, label: r.name || 'feature' };
        if (kind === 'line' && /LineString/.test(t)) return { rec: r, pts, label: r.name || 'feature' };
      } else if (r.type === 'graphic' && r.anchor === 'ground') {
        if (kind === 'polygon' && r.shape === 'polygon') return { rec: r, pts: r.coords.map((c) => [c[0], c[1], c[2] ?? 0]), label: r.text || 'graphic' };
        if (kind === 'line' && (r.shape === 'polyline' || r.shape === 'line' || r.shape === 'arrow')) return { rec: r, pts: r.coords.map((c) => [c[0], c[1], c[2] ?? 0]), label: r.text || 'graphic' };
      }
    }
    return null;
  }

  /** Medial axis of a ring [[lon, lat, h], …]; logs a row and draws the axis. */
  app.measureMedial = (ring, { label = 'polygon', p = pane() } = {}) => {
    const m = app.core.medialAxis(ring, 600);
    const l = p.geoLayer();
    const c = ring.reduce((a, q) => [a[0] + q[0] / ring.length, a[1] + q[1] / ring.length, a[2] + q[2] / ring.length], [0, 0, 0]);
    const row = app.measureApi.baseRow('Medial axis', l, { lat: c[1], lon: c[0], h: c[2], heightSource: 'feature vertices' }, {
      object: label,
      value: Number(m.length.toFixed(2)),
      units: 'm',
      method: `medial axis (distance transform, ${m.cellM.toFixed(2)} m cells); geodesic-equivalent local ENU`,
      coords: null,
      extra: { meanWidth: m.meanWidth, minWidth: m.minWidth, maxWidth: m.maxWidth, cellM: m.cellM },
      ce90: NaN,
      le90: NaN,
      sigmaText: `length ± ${(2 * m.cellM).toFixed(2)} m, width ± ${m.cellM.toFixed(2)} m (grid); the model error of the vertices adds`,
    });
    app.measureApi.logRow(row, p);
    S.transact('Medial axis', (tx) => {
      let gl = p.rec.graphicsLayer;
      if (!gl) {
        gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
        tx.set(p.id, 'graphicsLayer', gl);
      }
      tx.create('graphic', { glayer: gl, pane: p.id, shape: 'polyline', anchor: 'ground', coords: m.path.map(([lon, lat]) => [lon, lat, c[2]]), text: `${m.length.toFixed(1)} m × ${m.meanWidth.toFixed(1)} m`, style: { stroke: '#00e5ff', width: 2, fill: '#00000000', dash: 'dashed' }, provenance: { kind: 'medial-axis' } });
    });
    app.toast(`Medial axis: ${m.length.toFixed(1)} m long, ${m.meanWidth.toFixed(1)} m wide (${m.minWidth.toFixed(1)}–${m.maxWidth.toFixed(1)} m)`);
    return m;
  };

  /** The point halfway along a line [[lon, lat, h], …] by geodesic length. */
  app.lineCentre = (pts) => {
    const legs = pts.slice(1).map((q, i) => app.core.inverse(pts[i][1], pts[i][0], q[1], q[0]));
    const total = legs.reduce((s, x) => s + x.distance, 0);
    let half = total / 2;
    for (let i = 0; i < legs.length; i++) {
      if (half <= legs[i].distance) {
        const d = app.core.direct(pts[i][1], pts[i][0], legs[i].azi1, half);
        const t = legs[i].distance ? half / legs[i].distance : 0;
        return { lat: d.lat, lon: d.lon, h: pts[i][2] + t * (pts[i + 1][2] - pts[i][2]), total };
      }
      half -= legs[i].distance;
    }
    const e = pts.at(-1);
    return { lat: e[1], lon: e[0], h: e[2], total };
  };

  /**
   * Cut and fill inside a ring [[lon, lat, h], …] on the terrain (REQ-DEM-15) against a reference:
   * 'plane' (least squares through the vertices' terrain heights), 'lowest' (the lowest vertex) or
   * 'constant' (`height` HAE). Cells of `cell` m (default: about 250 000 samples at most).
   */
  app.measureVolume = (ring, { reference = 'plane', height = NaN, cell = 0, label = 'polygon', p = pane(), log = true } = {}) => {
    if (!app.terrain.available) throw new Error('Volume needs a DEM or DSM used as terrain');
    const lat0 = ring.reduce((s, q) => s + q[1], 0) / ring.length;
    const lon0 = ring.reduce((s, q) => s + q[0], 0) / ring.length;
    const ky = 111132.954 - 559.822 * Math.cos((2 * lat0 * Math.PI) / 180);
    const kx = 111412.84 * Math.cos((lat0 * Math.PI) / 180);
    const xy = ring.map((q) => [(q[0] - lon0) * kx, (q[1] - lat0) * ky]);
    const hAt = (x, y) => app.terrain.sample(lat0 + y / ky, lon0 + x / kx)?.hae;
    const vz = xy.map(([x, y]) => hAt(x, y));
    if (!vz.every(Number.isFinite)) throw new Error('the terrain does not cover every vertex');
    let ref;
    let refText;
    if (reference === 'constant') {
      if (!Number.isFinite(height)) throw new Error('give the reference height');
      ref = () => height;
      refText = `constant ${height.toFixed(2)} m HAE`;
    } else if (reference === 'lowest') {
      const m = Math.min(...vz);
      ref = () => m;
      refText = `lowest vertex ${m.toFixed(2)} m HAE`;
    } else {
      // z = a + b·x + c·y through the vertices (normal equations, Cramer's rule).
      const n = xy.length;
      const S1 = [0, 0, 0, 0, 0, 0, 0, 0];
      xy.forEach(([x, y], i) => {
        const z = vz[i];
        [x, y, x * x, y * y, x * y, z, x * z, y * z].forEach((v, k) => (S1[k] += v));
      });
      const [sx, sy, sxx, syy, sxy, sz, sxz, syz] = S1;
      const A = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
      const B = [sz, sxz, syz];
      const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      const D = det(A);
      const col = (k) => A.map((r, i) => r.map((v, j) => (j === k ? B[i] : v)));
      const [a, b, c] = Math.abs(D) > 1e-9 ? [0, 1, 2].map((k) => det(col(k)) / D) : [sz / n, 0, 0];
      ref = (x, y) => a + b * x + c * y;
      refText = 'plane through the vertices';
    }
    const xs = xy.map((q) => q[0]);
    const ys = xy.map((q) => q[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const step = cell > 0 ? cell : Math.max(0.25, Math.sqrt(((x1 - x0) * (y1 - y0)) / 250000));
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) if (xy[i][1] > y !== xy[j][1] > y && x < ((xy[j][0] - xy[i][0]) * (y - xy[i][1])) / (xy[j][1] - xy[i][1]) + xy[i][0]) c = !c;
      return c;
    };
    let cut = 0;
    let fill = 0;
    let n = 0;
    let voids = 0;
    for (let y = y0 + step / 2; y < y1; y += step)
      for (let x = x0 + step / 2; x < x1; x += step) {
        if (!inside(x, y)) continue;
        const z = hAt(x, y);
        if (!Number.isFinite(z)) {
          voids++;
          continue;
        }
        const d = z - ref(x, y);
        if (d > 0) cut += d * step * step;
        else fill -= d * step * step;
        n++;
      }
    const out = { cut, fill, net: cut - fill, area: n * step * step, cell: step, cells: n, voids, reference: refText };
    if (log && p?.geoLayer()) {
      const l = p.geoLayer();
      const row = app.measureApi.baseRow('Volume', l, { lat: lat0, lon: lon0, h: ref(0, 0), heightSource: app.terrain.sample(lat0, lon0)?.name ?? 'terrain' }, {
        object: label,
        value: Number(out.net.toFixed(1)),
        units: 'm³',
        method: `DEM volume against the ${refText}: cut (above) ${cut.toFixed(1)} m³, fill (below) ${fill.toFixed(1)} m³ over ${out.area.toFixed(1)} m² in ${n} cells of ${step.toFixed(2)} m`,
        coords: null,
        tag: 'relative',
        ce90: NaN,
        le90: NaN,
        sigmaText: `the terrain's vertical error times the area; ${voids} void cells skipped`,
        extra: out,
        geom: ring.map((q) => [q[0], q[1], q[2]]),
      });
      app.measureApi.logRow(row, p);
    }
    return out;
  };
  C.implement('dem.volume', {
    enabled: () => app.terrain.available && !!selectedShape('polygon'),
    run: async () => {
      const s = selectedShape('polygon');
      if (!s) return app.toast('Select a polygon (graphic or feature) first', { kind: 'warn' });
      const kind = h('select', { class: 'inp', 'aria-label': 'Reference' }, [['plane', 'Plane through the vertices'], ['lowest', 'Lowest vertex'], ['constant', 'Constant height (HAE)']].map(([v, t]) => h('option', { value: v }, t)));
      const hh = h('input', { class: 'inp inp-num', type: 'number', step: '0.01', 'aria-label': 'Reference height' });
      if ((await modal({ title: 'Volume', body: h('div', {}, field('Reference surface', kind), field('Height (m HAE, for a constant reference)', hh)), id: 'dem-volume' })) !== 'OK') return;
      try {
        const r = app.measureVolume(s.pts, { reference: kind.value, height: Number(hh.value), label: s.label });
        app.toast(`Volume: cut ${r.cut.toFixed(0)} m³, fill ${r.fill.toFixed(0)} m³`);
      } catch (e) {
        app.toast(`Volume: ${e.message}`, { kind: 'warn' });
      }
    },
  });
  C.implement('men.medial', {
    enabled: () => !!selectedShape('polygon'),
    run: () => {
      const s = selectedShape('polygon');
      if (!s) return app.toast('Select a polygon (graphic or feature) first', { kind: 'warn' });
      try {
        app.measureMedial(s.pts, { label: s.label });
      } catch (e) {
        app.toast(`Medial axis: ${e.message}`, { kind: 'warn' });
      }
    },
  });
  C.implement('men.centre', {
    enabled: () => !!selectedShape('line'),
    run: () => {
      const s = selectedShape('line');
      if (!s) return app.toast('Select a line (graphic or feature) first', { kind: 'warn' });
      const p = pane();
      const l = p.geoLayer();
      const c = app.lineCentre(s.pts);
      const q = l.imageAt(c.lat, c.lon, c.h);
      const g = { ...c, heightSource: 'line vertices', x: q?.x, y: q?.y };
      const err = q ? app.measureApi.errorFor(l, q.x, q.y, g) : null;
      const row = app.measureApi.pointRow(l, { x: q?.x ?? NaN, y: q?.y ?? NaN }, g, err);
      app.measureApi.logRow({ ...row, object: `centre of ${s.label}`, method: `${row.method}; halfway along ${c.total.toFixed(2)} m (geodesic)` }, p);
      app.toast(`Centre point: ${app.core.mgrs(c.lat, c.lon, 5)} (line ${c.total.toFixed(1)} m)`);
    },
  });

  // ---- linked cursors ----
  const cur = () => ({ shape: 'crosshair', colour: '#ffd400', size: 14, ...(app.prefs.get('linkCursor') ?? {}) });
  const drawCursor = (g, s, roam) => {
    const c = cur();
    const r = c.size;
    g.save();
    g.strokeStyle = c.colour;
    g.lineWidth = 2;
    halo(g, () => {
      g.beginPath();
      if (c.shape === 'circle' || roam) {
        g.arc(s.x, s.y, r * 0.7, 0, Math.PI * 2);
      }
      if (c.shape === 'box') g.rect(s.x - r * 0.6, s.y - r * 0.6, r * 1.2, r * 1.2);
      if (c.shape === 'crosshair' || c.shape === 'cross' || roam) {
        const gap = c.shape === 'crosshair' ? r * 0.3 : 0;
        g.moveTo(s.x - r, s.y);
        g.lineTo(s.x - gap, s.y);
        g.moveTo(s.x + gap, s.y);
        g.lineTo(s.x + r, s.y);
        g.moveTo(s.x, s.y - r);
        g.lineTo(s.x, s.y - gap);
        g.moveTo(s.x, s.y + gap);
        g.lineTo(s.x, s.y + r);
      }
    });
    if (roam) {
      g.font = 'bold 10px Arial, sans-serif';
      g.fillStyle = c.colour;
      g.fillText('ROAM', s.x + r + 3, s.y - 3);
    }
    g.restore();
  };
  /** Screen point of the linked cursor in panel p (or null). */
  app.linkedCursorIn = (p) => {
    const cg = app.cursorGround;
    if (!cg || cg.pane === p || !app.links?.groups) return null;
    const gid = app.links.groups.get(cg.pane.id);
    if (!gid || app.links.groups.get(p.id) !== gid || cur().shape === 'off') return null;
    const s = screenOfGround(p, cg.lat, cg.lon, cg.h);
    return s ? { ...s, roam: !!cg.pane.roam || !!cg.pane.fullRoam } : null;
  };
  const prev = app.graphics.drawPane;
  app.graphics.drawPane = (p, g) => {
    prev(p, g);
    if (p.source) return; // products show no cursors
    const s = app.linkedCursorIn(p);
    if (s) drawCursor(g, s, s.roam);
  };
  C.implement('link.cursors', {
    run: async () => {
      const c = cur();
      const shape = h('select', { class: 'inp', 'aria-label': 'Shape' }, ...[['crosshair', 'Crosshair'], ['cross', 'Cross'], ['circle', 'Circle'], ['box', 'Box'], ['off', 'Off']].map(([v, t]) => h('option', { value: v }, t)));
      shape.value = c.shape;
      const colour = h('input', { class: 'inp', type: 'color', value: c.colour, 'aria-label': 'Colour' });
      const size = h('input', { class: 'inp inp-small', type: 'number', min: '6', max: '40', value: String(c.size), 'aria-label': 'Size (px)' });
      if ((await modal({ title: 'Linked Cursors', body: h('div', {}, field('Shape', shape), field('Colour', colour), field('Size (px)', size), h('p', { class: 'hint' }, 'Linked panels (Link Manager) show the ground point under the mouse; a roaming panel shows a roam cursor.')), buttons: ['OK', 'Cancel'], id: 'link-cursors' })) !== 'OK') return;
      app.prefs.set('linkCursor', { shape: shape.value, colour: colour.value, size: Number(size.value) || 14 });
    },
  });
}
