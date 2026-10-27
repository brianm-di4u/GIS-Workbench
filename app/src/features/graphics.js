// Graphics set (REQ-IMG-26, REQ-IMG-27, REQ-IMG-29, REQ-IMG-30): click and box selection, the
// Common Properties window (line, fill, transparency, dash, text, font, anchor conversion
// between ground, image and screen), numbered sequences, counts, copy/paste, a legend, and
// graphics files as GeoJSON (Z = HAE) or KML/KMZ (absolute altitudes as EGM96 heights,
// REQ-EXT-23). KML from files is parsed without DTDs or entities (REQ-SEC-03).

import { h, clear } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { groundOf, screenOfGround, halo, poly } from '../tools/tools.js';

export const name = 'graphics';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** '#rrggbb' or '#rrggbbaa' → KML aabbggrr. */
export function kmlColour(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex ?? '#e00000');
  if (!m) return 'ff0000e0';
  return `${m[4] ?? 'ff'}${m[3]}${m[2]}${m[1]}`.toLowerCase();
}
export function fromKmlColour(abgr) {
  const m = /^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(abgr ?? '').trim());
  if (!m) return null;
  return `#${m[4]}${m[3]}${m[2]}${m[1] === 'ff' ? '' : m[1]}`.toLowerCase();
}

/** Graphics → KML document. `msl(lat, lon, hae)` converts heights to EGM96 for absolute altitudes. */
export function toKml(graphics, msl, name = 'GIS Workbench graphics') {
  const styles = new Map();
  const styleId = (st) => {
    const k = JSON.stringify([st.stroke, st.width, st.fill]);
    if (!styles.has(k)) styles.set(k, { id: `s${styles.size + 1}`, st });
    return styles.get(k).id;
  };
  const coord = ([lon, lat, h]) => `${lon.toFixed(9)},${lat.toFixed(9)},${msl(lat, lon, h ?? 0).toFixed(3)}`;
  const placemarks = graphics.map((g) => {
    const st = g.style ?? {};
    const sid = styleId(st);
    let geom;
    if (g.coords.length === 1) geom = `<Point><altitudeMode>absolute</altitudeMode><coordinates>${coord(g.coords[0])}</coordinates></Point>`;
    else if (g.shape === 'polygon') geom = `<Polygon><altitudeMode>absolute</altitudeMode><outerBoundaryIs><LinearRing><coordinates>${[...g.coords, g.coords[0]].map(coord).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`;
    else geom = `<LineString><altitudeMode>absolute</altitudeMode><coordinates>${g.coords.map(coord).join(' ')}</coordinates></LineString>`;
    const ext = { shape: g.shape, radius_m: g.radius ?? '', seq: g.seq ?? '', dash: st.dash ?? '', fontSize: st.fontSize ?? '', created: g.created ?? '' };
    return `<Placemark><name>${esc(g.text || g.shape)}</name><styleUrl>#${sid}</styleUrl><ExtendedData>${Object.entries(ext)
      .map(([k, v]) => `<Data name="${k}"><value>${esc(v)}</value></Data>`)
      .join('')}</ExtendedData>${geom}</Placemark>`;
  });
  const styleXml = [...styles.values()].map(({ id, st }) => `<Style id="${id}"><LineStyle><color>${kmlColour(st.stroke)}</color><width>${st.width ?? 2}</width></LineStyle><PolyStyle><color>${kmlColour(st.fill ?? '#e0000040')}</color></PolyStyle><IconStyle><color>${kmlColour(st.stroke)}</color></IconStyle></Style>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${esc(name)}</name>${styleXml.join('')}${placemarks.join('')}</Document></kml>\n`;
}

/** KML text → [{shape, coords [[lon, lat, alt]], text, style, ext}] (no DTD, no entities). */
export function parseKml(text, hae = (lat, lon, alt) => alt) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('KML with a DTD or entities is refused (REQ-SEC-03)');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');
  const styles = new Map();
  for (const s of doc.getElementsByTagName('Style')) {
    const id = s.getAttribute('id');
    const line = s.getElementsByTagName('LineStyle')[0];
    const polyS = s.getElementsByTagName('PolyStyle')[0];
    styles.set(`#${id}`, {
      stroke: fromKmlColour(line?.getElementsByTagName('color')[0]?.textContent) ?? '#e00000',
      width: Number(line?.getElementsByTagName('width')[0]?.textContent) || 2,
      fill: fromKmlColour(polyS?.getElementsByTagName('color')[0]?.textContent) ?? '#e0000040',
    });
  }
  // StyleMap → its "normal" style.
  for (const m of doc.getElementsByTagName('StyleMap')) {
    for (const p of m.getElementsByTagName('Pair')) if (p.getElementsByTagName('key')[0]?.textContent === 'normal') styles.set(`#${m.getAttribute('id')}`, styles.get(p.getElementsByTagName('styleUrl')[0]?.textContent?.trim()));
  }
  const parseCoords = (el, absolute) =>
    (el?.textContent ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => {
        const [lon, lat, alt = 0] = t.split(',').map(Number);
        return [lon, lat, absolute ? hae(lat, lon, alt) : 0];
      })
      .filter((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
  const out = [];
  for (const pm of doc.getElementsByTagName('Placemark')) {
    const ext = {};
    for (const d of pm.getElementsByTagName('Data')) ext[d.getAttribute('name')] = d.getElementsByTagName('value')[0]?.textContent ?? '';
    const style = styles.get(pm.getElementsByTagName('styleUrl')[0]?.textContent?.trim()) ?? { stroke: '#e00000', width: 2, fill: '#e0000040' };
    if (ext.dash) style.dash = ext.dash;
    if (ext.fontSize) style.fontSize = Number(ext.fontSize);
    const text = pm.getElementsByTagName('name')[0]?.textContent ?? '';
    const desc = pm.getElementsByTagName('description')[0]?.textContent ?? '';
    const absolute = (pm.getElementsByTagName('altitudeMode')[0]?.textContent ?? '').trim() === 'absolute';
    const pt = pm.getElementsByTagName('Point')[0];
    const ls = pm.getElementsByTagName('LineString')[0];
    const pg = pm.getElementsByTagName('Polygon')[0];
    let shape;
    let coords;
    if (pg) {
      coords = parseCoords(pg.getElementsByTagName('outerBoundaryIs')[0]?.getElementsByTagName('coordinates')[0], absolute);
      if (coords.length > 1 && coords[0][0] === coords.at(-1)[0] && coords[0][1] === coords.at(-1)[1]) coords.pop();
      shape = 'polygon';
    } else if (ls) {
      coords = parseCoords(ls.getElementsByTagName('coordinates')[0], absolute);
      shape = ext.shape && ['line', 'arrow', 'polyline', 'callout', 'circle', 'ellipse', 'rect'].includes(ext.shape) ? ext.shape : coords.length === 2 ? 'line' : 'polyline';
    } else if (pt) {
      coords = parseCoords(pt.getElementsByTagName('coordinates')[0], absolute);
      shape = ext.shape && ['point', 'marker', 'text'].includes(ext.shape) ? ext.shape : 'marker';
    } else continue;
    if (!coords.length) continue;
    out.push({ shape, coords, text: ext.shape && text === ext.shape ? '' : text, description: desc, style, ext });
  }
  return out;
}

/**
 * GPX 1.0/1.1 (REQ-IMG-31): waypoints, routes and track segments → [{shape, coords, text, gps}].
 * Elevations are MSL (`toHae` makes them HAE); a point without one gets h = NaN for the caller.
 */
export function parseGpx(text, toHae) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('the GPX is not well-formed XML');
  if (doc.documentElement.localName !== 'gpx') throw new Error('not a GPX file');
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
  const txt = (el, name) => kids(el, name)[0]?.textContent?.trim() ?? '';
  const pt = (el) => {
    const lat = Number(el.getAttribute('lat'));
    const lon = Number(el.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    const e = kids(el, 'ele')[0];
    const h = e ? toHae(lat, lon, Number(e.textContent)) : NaN;
    return [lon, lat, h];
  };
  const out = [];
  const root = doc.documentElement;
  for (const w of kids(root, 'wpt')) {
    const c = pt(w);
    if (c) out.push({ shape: 'marker', coords: [c], text: txt(w, 'name'), description: txt(w, 'desc'), gps: 'waypoint', time: txt(w, 'time') || undefined });
  }
  for (const r of kids(root, 'rte')) {
    const cs = kids(r, 'rtept').map(pt).filter(Boolean);
    if (cs.length >= 2) out.push({ shape: 'polyline', coords: cs, text: txt(r, 'name'), description: txt(r, 'desc'), gps: 'route' });
  }
  for (const t of kids(root, 'trk'))
    kids(t, 'trkseg').forEach((sg, i, all) => {
      const cs = kids(sg, 'trkpt').map(pt).filter(Boolean);
      const nm = txt(t, 'name');
      if (cs.length >= 2) out.push({ shape: 'polyline', coords: cs, text: all.length > 1 ? `${nm} (${i + 1})` : nm, description: txt(t, 'desc'), gps: 'track' });
    });
  return out;
}

/** GPX 1.1 of ground graphics: points and markers → wpt, lines → rte (MSL elevations from `toMsl`). */
export function toGpx(list, toMsl) {
  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
  const ele = (c) => (Number.isFinite(c[2]) ? `<ele>${toMsl(c[1], c[0], c[2]).toFixed(2)}</ele>` : '');
  const at = (c) => `lat="${c[1].toFixed(8)}" lon="${c[0].toFixed(8)}"`;
  const w = [];
  const r = [];
  for (const g of list) {
    if (g.anchor !== 'ground') continue;
    if ((g.shape === 'point' || g.shape === 'marker' || g.shape === 'text') && g.coords.length) w.push(`  <wpt ${at(g.coords[0])}>${ele(g.coords[0])}<name>${esc(g.text)}</name></wpt>`);
    else if (['line', 'polyline', 'arrow'].includes(g.shape) && g.coords.length >= 2) r.push(`  <rte><name>${esc(g.text)}</name>\n${g.coords.map((c) => `    <rtept ${at(c)}>${ele(c)}</rtept>`).join('\n')}\n  </rte>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GIS Workbench" xmlns="http://www.topografix.com/GPX/1/1">\n${[...w, ...r].join('\n')}\n</gpx>\n`;
}

export function install(app) {
  const C = app.commands;
  const tools = app.tools;
  const pane = () => app.activePane();
  const sel = () => [...app.selection].map((id) => app.store.get(id)).filter(Boolean);
  const ensureGlayer = (tx, p) => {
    let gl = p.rec.graphicsLayer;
    if (!gl) {
      gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
      tx.set(p.id, 'graphicsLayer', gl);
    }
    return gl;
  };

  // ---- hit testing and selection ----
  const segDist = (p, a, b) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const inside = (p, ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  app.graphicAt = (pn, sx, sy) => {
    const { w, h: hh } = pn.size();
    const p = { x: sx, y: sy };
    const recs = app.store.all('graphic').filter((g) => g.pane === pn.id).reverse();
    for (const r of recs) {
      const pts = app.graphics.screenPoints(pn, r, w, hh);
      if (!pts || pts.some((q) => !q)) continue;
      if (pts.length === 1 && Math.hypot(pts[0].x - sx, pts[0].y - sy) < 10) return r;
      if (r.shape === 'circle' && pts.length === 2) {
        const rr = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        if (Math.abs(Math.hypot(sx - pts[0].x, sy - pts[0].y) - rr) < 6 || Math.hypot(sx - pts[0].x, sy - pts[0].y) < rr) return r;
        continue;
      }
      const ring = r.shape === 'rect' && pts.length === 2 ? [pts[0], { x: pts[1].x, y: pts[0].y }, pts[1], { x: pts[0].x, y: pts[1].y }] : pts;
      for (let i = 1; i < ring.length; i++) if (segDist(p, ring[i - 1], ring[i]) < 6) return r;
      if (['polygon', 'rect'].includes(r.shape) && (segDist(p, ring.at(-1), ring[0]) < 6 || inside(p, ring))) return r;
      if (r.shape === 'callout' && segDist(p, pts[0], pts[1]) < 6) return r;
    }
    return null;
  };
  tools.register({
    id: 'sel.pick',
    cue: 'Select Graphics: click a graphic (Shift adds or removes); drag a box to select everything inside. Delete removes; Common Properties edits.',
    onDown(pn, e, sx, sy) {
      const r = app.graphicAt(pn, sx, sy);
      if (r) {
        if (!e.shiftKey) app.selection.clear();
        if (app.selection.has(r.id) && e.shiftKey) app.selection.delete(r.id);
        else app.selection.add(r.id);
        pn.invalidate();
        app.emit('state');
        return true;
      }
      this.state = { a: { sx, sy }, b: { sx, sy }, add: e.shiftKey };
      return true;
    },
    onMove(pn, e, sx, sy) {
      if (!this.state.a) return;
      this.state.b = { sx, sy };
      pn.invalidate();
    },
    onUp(pn) {
      const { a, b, add } = this.state;
      this.state = {};
      if (!a) return;
      if (!add) app.selection.clear();
      const [x0, x1] = [Math.min(a.sx, b.sx), Math.max(a.sx, b.sx)];
      const [y0, y1] = [Math.min(a.sy, b.sy), Math.max(a.sy, b.sy)];
      if (x1 - x0 > 3 && y1 - y0 > 3) {
        const { w, h: hh } = pn.size();
        for (const r of app.store.all('graphic').filter((g) => g.pane === pn.id)) {
          const pts = app.graphics.screenPoints(pn, r, w, hh);
          if (pts?.length && pts.every((q) => q && q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1)) app.selection.add(r.id);
        }
      }
      pn.invalidate();
      app.emit('state');
    },
    draw(pn, g, w, hh, s) {
      if (!s.a) return;
      g.strokeStyle = '#e000e0';
      g.setLineDash([4, 3]);
      g.strokeRect(s.a.sx, s.a.sy, s.b.sx - s.a.sx, s.b.sy - s.a.sy);
      g.setLineDash([]);
    },
  });
  C.implement('sel.graphics', { run: () => tools.select('sel.pick', { sticky: true }), checked: () => tools.current?.id === 'sel.pick', enabled: () => !!pane() });

  // ---- Common Properties (REQ-IMG-27) ----
  C.implement('gfx.props', {
    run: async () => {
      const list = sel();
      const p = pane();
      const first = list[0];
      const base = first?.style ?? { stroke: '#e00000', width: 2, fill: '#e0000040', ...(app.prefs.get('graphicStyle') ?? {}) };
      const hex6 = (c) => (c ?? '#e00000').slice(0, 7);
      const alpha = (c) => (c && c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 0.25);
      const stroke = h('input', { type: 'color', value: hex6(base.stroke), 'aria-label': 'Line colour' });
      const width = h('input', { class: 'inp inp-num', type: 'number', min: '0.5', max: '20', step: '0.5', value: String(base.width ?? 2), 'aria-label': 'Line width' });
      const dash = h('select', { class: 'inp inp-short', 'aria-label': 'Line style' }, ['solid', 'dashed', 'dotted'].map((d) => h('option', { value: d }, d)));
      dash.value = base.dash ?? 'solid';
      const fill = h('input', { type: 'color', value: hex6(base.fill), 'aria-label': 'Fill colour' });
      const op = h('input', { type: 'range', min: '0', max: '100', value: String(Math.round(alpha(base.fill) * 100)), 'aria-label': 'Fill opacity (100 − transparency)' });
      const font = h('input', { class: 'inp inp-num', type: 'number', min: '8', max: '48', value: String(base.fontSize ?? 12), 'aria-label': 'Font size' });
      const text = h('input', { class: 'inp', value: list.length === 1 ? first.text ?? '' : '', placeholder: list.length > 1 ? '(unchanged)' : '', spellcheck: 'true', 'aria-label': 'Text' });
      const anchor = h('select', { class: 'inp', 'aria-label': 'Anchor' }, [['', '(unchanged)'], ['ground', 'Ground (moves with the terrain)'], ['image', 'Image (pixels)'], ['screen', 'Screen (fixed in the panel)']].map(([v, t]) => h('option', { value: v }, t)));
      const body = h(
        'div',
        {},
        h('p', { class: 'hint' }, list.length ? `${list.length} graphic(s) selected.` : 'Nothing selected: these become the defaults for new graphics.'),
        section('Line', field('Colour', stroke), field('Width', width), field('Style', dash)),
        section('Fill', field('Colour', fill), field('Opacity', op)),
        section('Text', field('Text', text), field('Font size', font)),
        list.length ? section('Anchor', field('Anchor in', anchor)) : null,
      );
      if ((await modal({ title: 'Common Properties', body, buttons: ['OK', 'Cancel'], width: 480, id: 'gfx-props' })) !== 'OK') return;
      const st = { stroke: stroke.value, width: Number(width.value) || 2, dash: dash.value, fill: `${fill.value}${Math.round((Number(op.value) / 100) * 255).toString(16).padStart(2, '0')}`, fontSize: Number(font.value) || 12 };
      if (!list.length) {
        app.prefs.set('graphicStyle', st);
        return app.toast('Default graphic style updated');
      }
      app.store.transact('Graphic properties', (tx) => {
        for (const g of list) {
          tx.set(g.id, 'style', { ...g.style, ...st });
          if (list.length === 1 || text.value) tx.set(g.id, 'text', text.value);
          if (anchor.value && anchor.value !== g.anchor) {
            const conv = convertAnchor(p, g, anchor.value);
            if (conv) {
              tx.set(g.id, 'coords', conv);
              tx.set(g.id, 'anchor', anchor.value);
            }
          }
        }
      });
      p?.invalidate();
    },
  });

  /** Coordinates of a graphic in another anchor space, through the pane's view and model. */
  function convertAnchor(p, g, to) {
    const { w, h: hh } = p.size();
    const scr = app.graphics.screenPoints(p, g, w, hh);
    if (!scr || scr.some((q) => !q)) return null;
    const l = p.geoLayer();
    if (to === 'screen') return scr.map((q) => [q.x / w, q.y / hh]);
    const img = scr.map((q) => p.imagePoint(q.x, q.y));
    if (to === 'image') return img.map((q) => [q.x, q.y]);
    if (!l?.modelId) return null;
    return img.map((q) => {
      const gr = l.groundWithTerrain(q.x, q.y);
      return gr ? [gr.lon, gr.lat, gr.h] : null;
    }).every(Boolean)
      ? img.map((q) => {
          const gr = l.groundWithTerrain(q.x, q.y);
          return [gr.lon, gr.lat, gr.h];
        })
      : null;
  }

  // ---- numbered sequence and count (REQ-IMG-26) ----
  tools.register({
    id: 'draw.sequence',
    cue: 'Numbered Sequence: each click places the next number. Esc finishes.',
    onDown(pn, e, sx, sy) {
      const gr = groundOf(app, pn, sx, sy);
      const ip = pn.imagePoint(sx, sy);
      const seq = (app.store.all('graphic').filter((g) => g.pane === pn.id && g.seq).reduce((a, g) => Math.max(a, g.seq), 0) || 0) + 1;
      app.store.transact(`Sequence ${seq}`, (tx) => {
        const gl = ensureGlayer(tx, pn);
        tx.create('graphic', { glayer: gl, pane: pn.id, shape: 'marker', seq, text: String(seq), anchor: gr ? 'ground' : 'image', coords: [gr ? [gr.lon, gr.lat, gr.h] : [ip.x, ip.y]], style: { stroke: '#ffd400', width: 2, fill: '#ffd40040', ...(app.prefs.get('graphicStyle') ?? {}) }, created: new Date().toISOString(), provenance: { kind: 'user' } });
      });
      pn.invalidate();
      return true;
    },
  });
  C.implement('draw.sequence', { run: () => tools.select('draw.sequence', { sticky: true }), checked: () => tools.current?.id === 'draw.sequence', enabled: () => !!pane()?.layers().length });

  tools.register({
    id: 'draw.count',
    cue: 'Count: click each object; the running total shows by the cursor. Enter or double-click logs the count; Esc cancels.',
    onDown(pn, e, sx, sy) {
      const gr = groundOf(app, pn, sx, sy);
      (this.state.pts ??= []).push(gr ?? { ...pn.imagePoint(sx, sy), image: true });
      pn.invalidate();
      return true;
    },
    onDblClick(pn) {
      this.state.pts?.pop();
      this.onEnter(pn);
      return true;
    },
    onEnter(pn) {
      const pts = this.state.pts ?? [];
      this.state = {};
      if (!pts.length) return tools.done();
      const l = pn.geoLayer();
      app.store.transact(`Count ${pts.length}`, (tx) => {
        const gl = ensureGlayer(tx, pn);
        pts.forEach((p, i) => tx.create('graphic', { glayer: gl, pane: pn.id, shape: 'point', text: '', countOf: pts.length, countIndex: i + 1, anchor: p.image ? 'image' : 'ground', coords: [p.image ? [p.x, p.y] : [p.lon, p.lat, p.h]], style: { stroke: '#00e5ff', width: 2, fill: '#00e5ff40' }, created: new Date().toISOString(), provenance: { kind: 'user' } }));
      });
      if (l?.modelId && !pts[0].image) {
        const row = app.measureApi.baseRow('Count', l, pts[0], { value: pts.length, units: 'objects', method: 'Manual count', tag: 'N/A', ce90: null, le90: null, errorNote: 'a count has no positional error', geom: pts.map((p) => [p.lon, p.lat, p.h]), coords: { from: app.core.mgrs(pts[0].lat, pts[0].lon, 5), to: app.core.mgrs(pts.at(-1).lat, pts.at(-1).lon, 5), datum: 'WGS 84' } });
        app.measureApi.logRow(row, pn);
      }
      app.toast(`Counted ${pts.length}`);
      tools.done();
    },
    draw(pn, g, w, hh, s) {
      if (!s.pts?.length) return;
      g.fillStyle = '#00e5ff';
      for (const p of s.pts) {
        const q = p.image ? pn.screenPoint(p.x, p.y) : screenOfGround(pn, p.lat, p.lon, p.h);
        if (!q) continue;
        g.beginPath();
        g.arc(q.x, q.y, 4, 0, Math.PI * 2);
        g.fill();
      }
      const c = pn.cursor;
      if (c) {
        g.font = 'bold 13px Arial, sans-serif';
        g.lineWidth = 3;
        g.strokeStyle = '#000';
        g.strokeText(String(s.pts.length), c.sx + 12, c.sy - 10);
        g.fillText(String(s.pts.length), c.sx + 12, c.sy - 10);
      }
    },
  });
  C.implement('draw.count', { run: () => tools.select('draw.count'), checked: () => tools.current?.id === 'draw.count', enabled: () => !!pane()?.layers().length });

  // ---- copy / paste (REQ-IMG-27) ----
  let clip = null;
  C.implement('edit.copy', {
    enabled: () => app.selection.size > 0,
    run: async () => {
      clip = sel().map(({ id, type, glayer, pane: pn, ...g }) => structuredClone(g));
      const ground = clip.filter((g) => g.anchor === 'ground');
      try {
        if (ground.length) await navigator.clipboard.writeText(JSON.stringify({ type: 'FeatureCollection', features: ground.map((g) => ({ type: 'Feature', geometry: g.coords.length === 1 ? { type: 'Point', coordinates: g.coords[0] } : { type: 'LineString', coordinates: g.coords }, properties: { shape: g.shape, text: g.text } })) }));
      } catch {
        /* the system clipboard is optional */
      }
      app.toast(`Copied ${clip.length} graphic(s)`);
    },
  });
  C.implement('edit.paste', {
    enabled: () => !!clip?.length && !!pane(),
    run: () => {
      const p = pane();
      const ids = [];
      app.store.transact(`Paste ${clip.length} graphic(s)`, (tx) => {
        const gl = ensureGlayer(tx, p);
        for (const g of clip) {
          // Ground graphics paste in place (the same ground); image and screen ones offset a little.
          const coords = g.anchor === 'ground' ? g.coords : g.anchor === 'image' ? g.coords.map(([x, y]) => [x + 10 / p.view.zoom, y + 10 / p.view.zoom]) : g.coords.map(([x, y]) => [Math.min(1, x + 0.02), Math.min(1, y + 0.02)]);
          ids.push(tx.create('graphic', { ...structuredClone(g), coords, glayer: gl, pane: p.id, created: new Date().toISOString(), provenance: { kind: 'paste' } }));
        }
      });
      app.selection = new Set(ids);
      p.invalidate();
    },
  });

  // ---- legend (REQ-IMG-30) ----
  C.implement('gfx.legend', {
    enabled: () => !!pane(),
    run: async () => {
      const p = pane();
      const groups = new Map();
      for (const g of app.store.all('graphic').filter((x) => x.pane === p.id)) {
        const k = `${g.shape}|${g.style?.stroke}|${g.style?.fill}`;
        if (!groups.has(k)) groups.set(k, { shape: g.shape, style: g.style ?? {}, n: 0 });
        groups.get(k).n++;
      }
      const body = h('div', { class: 'legend' });
      if (!groups.size) body.appendChild(h('p', {}, 'No graphics in this panel.'));
      for (const gr of groups.values()) {
        const sw = h('canvas', { width: '28', height: '16', 'aria-hidden': 'true' });
        const g = sw.getContext('2d');
        g.fillStyle = gr.style.fill ?? '#0000';
        g.strokeStyle = gr.style.stroke ?? '#e00000';
        g.lineWidth = Math.min(4, gr.style.width ?? 2);
        if (['polygon', 'rect', 'ellipse', 'circle'].includes(gr.shape)) {
          g.fillRect(3, 3, 22, 10);
          g.strokeRect(3, 3, 22, 10);
        } else if (gr.shape === 'point' || gr.shape === 'marker') {
          g.beginPath();
          g.arc(14, 8, 5, 0, Math.PI * 2);
          g.stroke();
        } else {
          g.beginPath();
          g.moveTo(2, 12);
          g.lineTo(26, 4);
          g.stroke();
        }
        body.appendChild(h('div', { class: 'legend-row' }, sw, h('span', {}, `${gr.shape} (${gr.n})`)));
      }
      await modal({ title: `Legend — Panel ${p.mp.panes.indexOf(p) + 1}`, body, buttons: ['Close'], width: 320, modeless: true, id: 'gfx-legend' });
    },
  });

  // ---- files: GeoJSON and KML/KMZ (REQ-IMG-29) ----
  const msl = (lat, lon, hae) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? hae - N : hae;
  };
  const toHae = (lat, lon, alt) => {
    const N = app.core.undulation(lat, lon);
    return Number.isFinite(N) ? alt + N : alt;
  };
  const featureOf = (g) => ({
    type: 'Feature',
    geometry: g.shape === 'polygon' ? { type: 'Polygon', coordinates: [[...g.coords, g.coords[0]]] } : g.coords.length === 1 ? { type: 'Point', coordinates: g.coords[0] } : { type: 'LineString', coordinates: g.coords },
    properties: { shape: g.shape, text: g.text || null, radius_m: g.radius ?? null, seq: g.seq ?? null, stroke: g.style?.stroke, 'stroke-width': g.style?.width, fill: g.style?.fill, dash: g.style?.dash ?? null, fontSize: g.style?.fontSize ?? null, created: g.created },
  });
  app.graphicsGeoJson = (list) => ({ type: 'FeatureCollection', name: 'GIS Workbench graphics', features: list.map(featureOf) });
  C.implement('gfx.save', {
    enabled: () => app.store.all('graphic').some((g) => g.anchor === 'ground'),
    run: async () => {
      const fmt = h('select', { class: 'inp' }, h('option', { value: 'geojson' }, 'GeoJSON (WGS 84, Z = HAE)'), h('option', { value: 'kml' }, 'KML (absolute altitudes, EGM96)'), h('option', { value: 'kmz' }, 'KMZ (zipped KML)'), h('option', { value: 'gpx' }, 'GPX 1.1 (waypoints and routes, MSL)'));
      const which = h('select', { class: 'inp' }, h('option', { value: 'all' }, 'All ground graphics'), h('option', { value: 'sel' }, 'Selected graphics'));
      if ((await modal({ title: 'Save Graphics', body: h('div', {}, field('Format', fmt), field('Graphics', which)), buttons: ['Save', 'Cancel'], id: 'gfx-save' })) !== 'Save') return;
      const list = (which.value === 'sel' ? sel() : app.store.all('graphic')).filter((g) => g.anchor === 'ground');
      if (!list.length) return app.toast('No ground-anchored graphics to save', { kind: 'warn' });
      if (fmt.value === 'geojson') return saveBlob(app, textBlob(JSON.stringify(app.graphicsGeoJson(list), null, 1), 'application/geo+json'), { name: 'graphics.geojson', types: ['.geojson'], description: 'GeoJSON' });
      if (fmt.value === 'gpx') return saveBlob(app, textBlob(app.graphicsGpx(list), 'application/gpx+xml'), { name: 'graphics.gpx', types: ['.gpx'], description: 'GPX' });
      const kml = toKml(list, msl);
      if (fmt.value === 'kml') return saveBlob(app, textBlob(kml, 'application/vnd.google-earth.kml+xml'), { name: 'graphics.kml', types: ['.kml'], description: 'KML' });
      const zip = zipSync({ 'doc.kml': strToU8(kml) });
      return saveBlob(app, new Blob([zip], { type: 'application/vnd.google-earth.kmz' }), { name: 'graphics.kmz', types: ['.kmz'], description: 'KMZ' });
    },
  });
  C.implement('gfx.load', {
    enabled: () => !!pane(),
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.geojson', '.json', '.kml', '.kmz'], description: 'Graphics' });
      if (!f) return;
      if (f.size > 64 << 20) return app.toast('Graphics files larger than 64 MB are not loaded', { kind: 'warn' });
      try {
        const n = await app.loadGraphicsFile(f, pane());
        app.toast(`Loaded ${n} graphic(s) from ${f.name}`);
      } catch (e) {
        app.toast(`${f.name}: ${e.message}`, { kind: 'error' });
      }
    },
  });
  app.graphicsGpx = (list = app.store.all('graphic')) => toGpx(list, (lat, lon, hh) => hh - (app.core.undulation(lat, lon) || 0));
  /** GPX waypoints, routes and tracks → a graphics layer named after the file (REQ-IMG-31). */
  app.loadGpx = async (f, p = pane()) => {
    if (f.size > 64 << 20) throw new Error('GPX files larger than 64 MB are not loaded');
    const items = parseGpx(await f.text(), toHae);
    if (!items.length) throw new Error('no waypoints, routes or tracks');
    let glId = null;
    app.store.transact(`Load ${f.name}`, (tx) => {
      glId = tx.create('glayer', { pane: p.id, name: f.name, visible: true, saved: false, source: 'gpx' });
      if (!p.rec.graphicsLayer) tx.set(p.id, 'graphicsLayer', glId);
      for (const it of items) {
        const coords = it.coords.map(([lon, lat, hh]) => [lon, lat, Number.isFinite(hh) ? hh : app.terrain.sample?.(lat, lon)?.hae ?? 0]);
        tx.create('graphic', { glayer: glId, pane: p.id, shape: it.shape, anchor: 'ground', coords, text: it.text, description: it.description || undefined, gps: it.gps, style: { stroke: it.gps === 'track' ? '#00e5ff' : '#ff00ff', width: 2, fill: '#ff00ff40' }, created: it.time ?? new Date().toISOString(), provenance: { kind: 'import', file: f.name, format: 'GPX' } });
      }
    });
    p.invalidate();
    return { layer: glId, waypoints: items.filter((x) => x.gps === 'waypoint').length, routes: items.filter((x) => x.gps === 'route').length, tracks: items.filter((x) => x.gps === 'track').length };
  };
  C.implement('gps.load', {
    enabled: () => !!pane()?.geoLayer()?.modelId,
    run: async () => {
      const [f] = await pickFiles(app, { multiple: false, accept: ['.gpx'], description: 'GPX' });
      if (!f) return;
      try {
        const r = await app.loadGpx(f);
        app.toast(`${f.name}: ${r.waypoints} waypoint(s), ${r.routes} route(s), ${r.tracks} track segment(s)`);
      } catch (e) {
        app.toast(`${f.name}: ${e.message}`, { kind: 'error' });
      }
    },
  });
  app.loadGraphicsFile = async (f, p) => {
    let items = [];
    // Sniff the content: a file name may lack or misstate its extension.
    const head = new Uint8Array(await f.slice(0, 64).arrayBuffer());
    const isZip = head[0] === 0x50 && head[1] === 0x4b;
    const isXml = !isZip && /^\s*(﻿)?</.test(new TextDecoder().decode(head));
    if (isZip) {
      let total = 0;
      const files = unzipSync(new Uint8Array(await f.arrayBuffer()), {
        filter: (x) => {
          total += x.originalSize;
          if (total > 256 << 20) throw new Error('the KMZ expands to more than 256 MB');
          return /\.kml$/i.test(x.name) && !x.name.includes('..');
        },
      });
      const name = Object.keys(files).find((k) => /(^|\/)doc\.kml$/i.test(k)) ?? Object.keys(files)[0];
      if (!name) throw new Error('the KMZ holds no KML');
      items = parseKml(strFromU8(files[name]), toHae);
    } else if (isXml) items = parseKml(await f.text(), toHae);
    else {
      const fc = JSON.parse(await f.text(), (k, v) => (k === '__proto__' || k === 'constructor' ? undefined : v));
      for (const ft of fc.features ?? []) {
        const g = ft.geometry;
        if (!g) continue;
        const pr = ft.properties ?? {};
        const coords = g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? g.coordinates : g.type === 'Polygon' ? g.coordinates[0].slice(0, -1) : null;
        if (!coords) continue;
        items.push({ shape: pr.shape ?? (g.type === 'Point' ? 'point' : g.type === 'Polygon' ? 'polygon' : 'polyline'), coords: coords.map((c) => [c[0], c[1], c[2] ?? 0]), text: pr.text ?? '', radius: pr.radius_m ?? null, seq: pr.seq ?? null, style: { stroke: pr.stroke ?? '#e00000', width: pr['stroke-width'] ?? 2, fill: pr.fill ?? '#e0000040', ...(pr.dash ? { dash: pr.dash } : {}), ...(pr.fontSize ? { fontSize: pr.fontSize } : {}) }, created: pr.created });
      }
    }
    app.store.transact(`Load ${f.name}`, (tx) => {
      const gl = ensureGlayer(tx, p);
      for (const it of items)
        tx.create('graphic', {
          glayer: gl,
          pane: p.id,
          shape: it.shape,
          anchor: 'ground',
          coords: it.coords,
          radius: it.radius ?? (it.ext?.radius_m ? Number(it.ext.radius_m) : null),
          seq: it.seq ?? (it.ext?.seq ? Number(it.ext.seq) : null) ?? null,
          text: it.text ?? '',
          description: it.description || undefined,
          style: it.style,
          created: it.created ?? it.ext?.created ?? new Date().toISOString(),
          provenance: { kind: 'import', file: f.name },
        });
    });
    p.invalidate();
    return items.length;
  };
}
