// Route and flight planning (REQ-GAP-74; lazy js-aviation block). A flight plan is a GPS route
// graphic (Draw ▸ GPS ▸ Route, or an imported GPX or KML route) with a `flight` record: the
// waypoint names and, per leg, the altitude (MSL) and ground speed. Flight Plan shows the legs'
// distance, true course and time, the altitude profile against the loaded terrain with clearance
// warnings, and exports the plan as KML and GPX.

import { h } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { num, int, dateTime } from '../i18n/format.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import * as FP from '../analysis/flight-plan.js';

const { FT, NM, KT } = FP;

export function install(app) {
  const S = app.store;
  const C = app.commands;
  const toast = (m, o) => app.toast(m, o);
  const geod = { inverse: (a, b, c, d) => app.core.inverse(a, b, c, d), direct: (a, b, c, d) => app.core.direct(a, b, c, d) };
  const ground = (lat, lon) => app.terrain.sample(lat, lon)?.msl ?? NaN;
  const haeOf = (lat, lon, m) => m + (app.core.undulation(lat, lon) || 0);
  const defaults = () => ({ alt: 1500 * FT, speed: 100 * KT, clearance: 500 * FT, ...(app.prefs.get('flightPlan') ?? {}) });

  const routes = () => S.all('graphic').filter((g) => g.anchor === 'ground' && (g.gps === 'route' || g.flight) && g.coords?.length >= 2);

  /** The plan of a route graphic. */
  function planOf(id) {
    const g = S.get(id);
    if (!g?.coords?.length) throw gwError('no route: draw one with Draw ▸ GPS ▸ Route, or import one', null, 'E_ROUTE_NONE');
    const f = g.flight ?? {};
    const d = defaults();
    const waypoints = g.coords.map(([lon, lat], i) => ({ name: f.names?.[i] ?? `WP${i + 1}`, lat, lon }));
    return { name: f.name ?? g.text ?? t('Route'), waypoints, legs: FP.fitLegs(waypoints, f.legs ?? [], d), clearance: f.clearance ?? d.clearance, departure: f.departure ?? null };
  }

  /** Store a plan on its route graphic (one undo step); the route's vertices follow the waypoints. */
  function setPlan(id, plan) {
    const probs = FP.planProblems(plan);
    if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_PLAN_INVALID');
    const g = S.get(id);
    const coords = plan.waypoints.map((w, i) => {
      const old = g.coords[i];
      const same = old && Math.abs(old[0] - w.lon) < 1e-12 && Math.abs(old[1] - w.lat) < 1e-12;
      return [w.lon, w.lat, same ? old[2] : haeOf(w.lat, w.lon, ground(w.lat, w.lon) || 0)];
    });
    S.transact(t('Flight plan {name}', { name: plan.name }), (tx) => {
      tx.set(id, 'coords', coords);
      tx.set(id, 'text', plan.name);
      tx.set(id, 'flight', { name: plan.name, names: plan.waypoints.map((w) => w.name), legs: plan.legs.map((l) => ({ alt: l.alt, speed: l.speed })), clearance: plan.clearance, departure: plan.departure });
    });
  }

  /** A new route graphic for a plan in pane p → its id. */
  function create(plan, p = app.activePane()) {
    const probs = FP.planProblems(plan);
    if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_PLAN_INVALID');
    if (!p) throw gwError('open an image or map first', null, 'E_NO_PANE');
    let id;
    S.transact(t('Flight plan {name}', { name: plan.name }), (tx) => {
      let gl = p.rec?.graphicsLayer ?? null;
      if (!gl) {
        gl = tx.create('glayer', { pane: p.id, name: 'Graphics', visible: true, saved: false });
        tx.set(p.id, 'graphicsLayer', gl);
      }
      id = tx.create('graphic', {
        glayer: gl,
        pane: p.id,
        shape: 'polyline',
        anchor: 'ground',
        coords: plan.waypoints.map((w) => [w.lon, w.lat, haeOf(w.lat, w.lon, ground(w.lat, w.lon) || 0)]),
        text: plan.name,
        gps: 'route',
        style: { stroke: '#ff00ff', width: 2, fill: '#ff00ff40' },
        flight: { name: plan.name, names: plan.waypoints.map((w) => w.name), legs: plan.legs, clearance: plan.clearance, departure: plan.departure },
        created: new Date().toISOString(),
        provenance: { kind: 'flight-plan' },
      });
    });
    return id;
  }

  /** Leg table and terrain profile of a plan. */
  function compute(plan) {
    const probs = FP.planProblems(plan);
    if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_PLAN_INVALID');
    return { table: FP.legTable(plan, geod), profile: FP.terrainProfile(plan, geod, ground) };
  }

  const writers = {
    kml: (plan) => ({ text: FP.toKml(plan), type: 'application/vnd.google-earth.kml+xml', ext: '.kml' }),
    gpx: (plan) => ({ text: FP.toGpx(plan), type: 'application/gpx+xml', ext: '.gpx' }),
  };
  function exportText(plan, fmt) {
    const w = writers[fmt];
    if (!w) throw gwError('unknown export format {fmt}', { fmt }, 'E_ROUTE_FORMAT');
    return w(plan);
  }
  async function exportPlan(plan, fmt) {
    const w = exportText(plan, fmt);
    const name = `${(plan.name || 'route').replace(/[^\w.-]+/g, '_')}${w.ext}`;
    return saveBlob(app, textBlob(w.text, w.type), { name, types: [w.ext], description: fmt.toUpperCase() });
  }

  // ---- import: GPX routes and tracks, KML line strings (GIS Workbench plans losslessly) ----
  function parseXml(text) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw gwError('XML with a DTD or entities is refused', null, 'E_XML_DTD');
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw gwError('the file is not well-formed XML', null, 'E_XML_PARSE');
    return doc;
  }
  const kids = (el, name) => [...el.children].filter((c) => c.localName === name);
  const first = (el, name) => el.getElementsByTagNameNS('*', name)[0] ?? null;
  const txt = (el, name) => kids(el, name)[0]?.textContent?.trim() ?? '';

  /** Plans in a GPX or KML text: [plan]. Refuses by name what holds no route. */
  function readRoutes(text, fileName = '') {
    const doc = parseXml(text);
    const root = doc.documentElement.localName;
    const d = defaults();
    const out = [];
    const num0 = (v) => (v === '' || v == null ? NaN : Number(v));
    const okPt = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    if (root === 'gpx') {
      const lists = [...kids(doc.documentElement, 'rte').map((r) => ({ name: txt(r, 'name'), pts: kids(r, 'rtept') })), ...kids(doc.documentElement, 'trk').flatMap((tr) => kids(tr, 'trkseg').map((sg) => ({ name: txt(tr, 'name'), pts: kids(sg, 'trkpt') })))];
      for (const L of lists) {
        const pts = L.pts
          .map((p) => ({ lat: num0(p.getAttribute('lat')), lon: num0(p.getAttribute('lon')), ele: num0(txt(p, 'ele')), name: txt(p, 'name'), speed: num0(first(p, 'speed')?.textContent?.trim()) }))
          .filter((p) => okPt(p.lat, p.lon));
        if (pts.length >= 2) out.push(FP.planFromPoints(L.name || fileName, pts.slice(0, 5000), d));
      }
    } else if (root === 'kml') {
      for (const pm of [...doc.getElementsByTagNameNS('*', 'Placemark')]) {
        const data = [...pm.getElementsByTagNameNS('*', 'Data')].find((x) => x.getAttribute('name') === 'gw:flightplan');
        const own = data ? FP.planFromJson(first(data, 'value')?.textContent ?? '') : null;
        if (own) {
          out.push(own);
          continue;
        }
        const ls = first(pm, 'LineString');
        if (!ls) continue;
        const coords = (first(ls, 'coordinates')?.textContent ?? '').trim().split(/\s+/).map((c) => c.split(',').map(Number));
        const pts = coords.filter((c) => okPt(c[1], c[0])).map((c) => ({ lon: c[0], lat: c[1], ele: Number.isFinite(c[2]) && first(ls, 'altitudeMode')?.textContent?.trim() === 'absolute' ? c[2] : NaN, name: '' }));
        if (pts.length >= 2) out.push(FP.planFromPoints(txt(pm, 'name') || fileName, pts.slice(0, 5000), d));
      }
    } else throw gwError('{file} is not a GPX or KML route', { file: fileName || 'XML' }, 'E_ROUTE_FORMAT');
    if (!out.length) throw gwError('{file} holds no route with two or more points', { file: fileName || 'XML' }, 'E_ROUTE_EMPTY');
    return out;
  }

  /** Import routes from files (GPX, KML, KMZ is not read here) or {text, name} → new graphic ids. */
  async function importRoutes(src, p = app.activePane()) {
    const items = Array.isArray(src) ? src : [src];
    const ids = [];
    for (const it of items) {
      const text = typeof it.text === 'function' ? await it.text() : it.text;
      for (const plan of readRoutes(text, it.name ?? '')) ids.push(create(plan, p));
    }
    return ids;
  }

  app.flightPlan = Object.assign(app.flightPlan ?? {}, { routes, planOf, setPlan, create, compute, exportText, exportPlan, readRoutes, importRoutes, show: (id) => showPlan(id) });

  // ---- the dialog ----
  const fmtNm = (m) => num(m / NM, 1);
  const fmtTime = (s) => {
    const m = Math.round(s / 60);
    return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
  };

  function profileCanvas(prof, plan) {
    const W = 760;
    const H = 220;
    const cv = h('canvas', { width: String(W), height: String(H), class: 'profile-canvas', 'aria-label': t('Altitude profile of the route against the terrain'), 'data-id': 'fp:profile' });
    const g = cv.getContext('2d');
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const v = prof.samples;
    const zs = v.flatMap((q) => [q.alt, q.ground]).filter(Number.isFinite);
    const lo = Math.min(...zs);
    const hi = Math.max(...zs);
    const pad = (hi - lo) * 0.08 + 30;
    const X = (d) => 50 + (d / (prof.total || 1)) * (W - 60);
    const Y = (z) => H - 22 - ((z - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 34);
    g.fillStyle = css('--c-content-bg') || '#fff';
    g.fillRect(0, 0, W, H);
    g.fillStyle = css('--c-chart-terrain') || '#8a6a2a';
    g.beginPath();
    g.moveTo(X(0), H - 22);
    for (const q of v) g.lineTo(X(q.d), Number.isFinite(q.ground) ? Y(q.ground) : H - 22);
    g.lineTo(X(prof.total), H - 22);
    g.closePath();
    g.fill();
    // The flight path, red where it is lower than the minimum clearance above the ground.
    for (let k = 1; k < v.length; k++) {
      const a = v[k - 1];
      const b = v[k];
      const low = [a, b].some((q) => Number.isFinite(q.ground) && q.alt - q.ground < plan.clearance);
      g.strokeStyle = css(low ? '--c-chart-losBlocked' : '--c-chart-losOk') || (low ? '#d00' : '#090');
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(X(a.d), Y(a.alt));
      g.lineTo(X(b.d), Y(a.leg === b.leg ? b.alt : a.alt));
      if (a.leg !== b.leg) g.lineTo(X(b.d), Y(b.alt));
      g.stroke();
    }
    g.fillStyle = css('--c-content-text') || '#000';
    app.aviation.pointText(g, 11); // the app's i18n/fonts.js (features/aviation.js); chart axes do not mirror
    g.fillText(t('{ft} ft MSL', { ft: int((hi + pad) / FT) }), 2, 12);
    g.fillText(int((lo - pad) / FT), 2, H - 24);
    g.fillText(t('{nm} NM', { nm: fmtNm(prof.total) }), W - 70, H - 6);
    return cv;
  }

  async function showPlan(id) {
    let plan = planOf(id);
    for (;;) {
      const tbl = h('tbody', {});
      const nameIn = h('input', { class: 'inp', value: plan.name, 'aria-label': t('Route name'), 'data-id': 'fp:name' });
      const clr = h('input', { class: 'inp inp-num', type: 'number', min: '0', step: '50', value: String(Math.round(plan.clearance / FT)), 'aria-label': t('Minimum terrain clearance (ft)'), 'data-id': 'fp:clearance' });
      const dep = h('input', { class: 'inp', value: plan.departure ?? '', placeholder: '2026-11-03T14:00:00Z', 'aria-label': t('Departure time (UTC, ISO 8601)'), 'data-id': 'fp:departure' }); // i18n-ignore: ISO 8601 example
      const inputs = [];
      plan.waypoints.forEach((w, i) => {
        const nm = h('input', { class: 'inp', value: w.name, size: '8', 'aria-label': t('Name of waypoint {n}', { n: i + 1 }), 'data-id': `fp:wp:${i}` });
        const leg = i < plan.legs.length;
        const alt = leg ? h('input', { class: 'inp inp-num', type: 'number', step: '100', value: String(Math.round(plan.legs[i].alt / FT)), 'aria-label': t('Altitude of leg {n} (ft MSL)', { n: i + 1 }), 'data-id': `fp:alt:${i}` }) : '';
        const spd = leg ? h('input', { class: 'inp inp-num', type: 'number', step: '5', min: '1', value: String(Math.round(plan.legs[i].speed / KT)), 'aria-label': t('Ground speed of leg {n} (kt)', { n: i + 1 }), 'data-id': `fp:speed:${i}` }) : '';
        inputs.push({ nm, alt, spd });
      });
      const cells = plan.waypoints.map((w, i) => {
        const c = { dist: h('td', { 'data-id': `fp:dist:${i}` }), course: h('td', { 'data-id': `fp:course:${i}` }), time: h('td', { 'data-id': `fp:time:${i}` }), eta: h('td', {}), clear: h('td', { 'data-id': `fp:clear:${i}` }) };
        c.tr = h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, inputs[i].nm), h('td', { class: 'mono' }, `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`), h('td', {}, inputs[i].alt), h('td', {}, inputs[i].spd), c.dist, c.course, c.time, c.eta, c.clear);
        tbl.append(c.tr);
        return c;
      });
      const read = () => {
        const p = {
          name: nameIn.value.trim() || t('Route'),
          waypoints: plan.waypoints.map((w, i) => ({ ...w, name: inputs[i].nm.value.trim() || `WP${i + 1}` })),
          legs: plan.legs.map((l, i) => ({ alt: Number(inputs[i].alt.value) * FT, speed: Number(inputs[i].spd.value) * KT })),
          clearance: Math.max(0, Number(clr.value) || 0) * FT,
          departure: dep.value.trim() && Number.isFinite(Date.parse(dep.value.trim())) ? new Date(Date.parse(dep.value.trim())).toISOString() : null,
        };
        return p;
      };
      const out = h('div', {});
      const render = () => {
        let p;
        let r;
        try {
          p = read();
          r = compute(p);
        } catch (e) {
          out.replaceChildren(h('p', { class: 'hint', role: 'alert' }, msgOf(e)));
          return;
        }
        p.waypoints.forEach((w, i) => {
          const L = r.table.legs[i];
          const P = r.profile.legs[i];
          const warn = L ? r.profile.warnings.filter((x) => x.leg === i && x.kind !== 'nodata') : [];
          const c = cells[i];
          c.tr.className = warn.length ? 'warn' : '';
          c.dist.textContent = L ? fmtNm(L.distance) : '';
          c.course.textContent = L ? `${String(Math.round(L.course) % 360).padStart(3, '0')}°` : '';
          c.time.textContent = L ? fmtTime(L.time) : '';
          c.eta.textContent = L?.eta ? dateTime(L.eta, { seconds: false }) : '';
          c.clear.textContent = L ? (P?.at ? `${int(P.minClearance / FT)}${warn.length ? ' ⚠' : ''}` : '—') : '';
        });
        const msgs = r.profile.warnings.map((x) => {
          const L = r.table.legs[x.leg];
          if (x.kind === 'terrain') return t('Leg {n} ({from} → {to}): the terrain reaches {over} ft above the leg altitude {nm} NM along the route.', { n: x.leg + 1, from: L.from, to: L.to, over: int(-x.clearance / FT), nm: fmtNm(x.d) });
          if (x.kind === 'clearance') return t('Leg {n} ({from} → {to}): {c} ft above the terrain {nm} NM along the route, under the {min} ft minimum.', { n: x.leg + 1, from: L.from, to: L.to, c: int(x.clearance / FT), nm: fmtNm(x.d), min: int(p.clearance / FT) });
          return t('Leg {n} ({from} → {to}): no terrain under {share} of the leg; clearance not checked there.', { n: x.leg + 1, from: L.from, to: L.to, share: `${Math.round(x.fraction * 100)} %` });
        });
        out.replaceChildren(
          profileCanvas(r.profile, p),
          h('p', { 'data-id': 'fp:totals' }, t('{nm} NM in {time} (h:min), {n, plural, one {# leg} other {# legs}}; terrain sampled every {step} m.', { nm: fmtNm(r.table.distance), time: fmtTime(r.table.time), n: r.table.legs.length, step: int(r.profile.step) })),
          ...(msgs.length ? msgs.map((m) => h('p', { class: 'hint', role: 'alert', 'data-id': 'fp:warning' }, m)) : [h('p', { class: 'hint', 'data-id': 'fp:ok' }, t('Every leg clears the terrain by the minimum.'))]),
        );
        plan = p;
      };
      const table = h('table', { class: 'tbl', 'data-id': 'fp:legs' }, h('thead', {}, h('tr', {}, ...['#', t('Waypoint'), t('Position'), t('Leg altitude (ft MSL)'), t('Speed (kt)'), t('Distance (NM)'), t('Course (°T)'), t('Time'), t('ETA'), t('Min clearance (ft)')].map((x) => h('th', {}, x)))), tbl);
      const body = h('div', {}, h('div', { class: 'btn-row' }, field(t('Route name'), nameIn), field(t('Minimum terrain clearance (ft)'), clr), field(t('Departure time (UTC, ISO 8601)'), dep)), h('div', { class: 'scroll', style: 'max-height: 260px; overflow: auto' }, table), out, h('p', { class: 'hint' }, t('Legs are flown level at their altitude and change level at the waypoints; times are ground speed without wind. Heights MSL (EGM96); courses true, on the WGS 84 geodesic.')));
      body.addEventListener('input', render);
      render();
      const v = await modal({ title: t('Flight Plan'), body, buttons: [{ label: t('Save'), value: 'save', primary: true }, { label: t('Export KML'), value: 'kml' }, { label: t('Export GPX'), value: 'gpx' }, { label: t('Close'), value: 'close' }], width: 980, id: 'flight-plan' });
      if (!v || v === 'close') return;
      try {
        if (v === 'save') {
          setPlan(id, read());
          return;
        }
        await exportPlan(read(), v);
      } catch (e) {
        toast(msgOf(e), { kind: e?.code === 'E_PLAN_INVALID' ? 'warn' : 'error' });
      }
    }
  }

  C.implement('gps.flightplan', {
    run: async () => {
      const sel = [...(app.selection ?? [])].map((x) => S.get(x)).find((g) => g?.shape === 'polyline' && g.anchor === 'ground');
      const id = sel?.id ?? routes().at(-1)?.id;
      if (id) return showPlan(id);
      const v = await modal({ title: t('Flight Plan'), body: h('p', {}, t('No route yet. Draw one (click the waypoints, double-click the last), or import a GPX or KML route.')), buttons: [{ label: t('Draw Route'), value: 'draw', primary: true }, { label: t('Import Route…'), value: 'import' }, { label: t('Cancel'), value: 'cancel' }], id: 'flight-plan-start' });
      try {
        if (v === 'draw') return app.tools.select('gps.route');
        if (v === 'import') {
          const files = await pickFiles(app, { multiple: true, accept: ['.gpx', '.kml', '.xml'], description: t('Routes') });
          if (!files?.length) return;
          const ids = await importRoutes(files);
          if (ids.length) return showPlan(ids[0]);
        }
      } catch (e) {
        toast(msgOf(e), { kind: ['E_ROUTE_EMPTY', 'E_ROUTE_FORMAT'].includes(e?.code) ? 'warn' : 'error', ms: 8000 });
      }
      return undefined;
    },
  });
}
