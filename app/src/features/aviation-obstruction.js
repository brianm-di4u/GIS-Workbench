// Airports and runways, and airfield obstruction analysis (REQ-GAP-73; lazy js-aviation block).
// Airports are `airport` store records (entered by hand, drawn on the map, or imported from the FAA
// NASR CSV files); Obstruction Surfaces builds the FAA Part 77 or ICAO Annex 14 surfaces in the
// `aviation` WASM bundle on the analysis workers, evaluates every DSM post or point-cloud point
// against them, and reports the penetrations as a graphics layer, an overlay, a table and files.

import { h } from '../shell/dom.js';
import { modal, field, promptBox } from '../shell/dialogs.js';
import { t, gwError, msgOf } from '../i18n/index.js';
import { num, int, height, list } from '../i18n/format.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { listZip, entryFile } from '../formats/zip-container.js';
import { writeGeoTiff } from '../formats/geotiff-writer.js';
import * as OB from '../analysis/obstruction.js';

const { designator } = OB;

const P77_LABELS = { 'A(V)': 'A(V)', 'A(NP)': 'A(NP)', 'B(V)': 'B(V)', C: 'C', D: 'D', PIR: 'PIR' }; // i18n-ignore: NASR Part 77 category codes
/** Rows of the grid sent to one worker job. */
const STRIP_POSTS = 2 ** 22;
const POINT_BATCH = 2 ** 20;
const WORKING = () => t('Evaluating the obstruction surfaces…');
/** Posts further apart than this (m) cannot be trusted to hold a pole or a mast. */
const COARSE_POST_M = 5;

export function install(app) {
  const S = app.store;
  const C = app.commands;
  const toast = (m, o) => app.toast(m, o);
  const airports = () => S.all('airport');
  const tpl = (p) => t(p.src, p.params ?? undefined);
  /** The Annex 14 edition, in the reader's language; English in the files written. */
  const editionLabel = () => t('Follows ICAO Annex 14 Volume I as amended by Amendment 18, Chapter 4 as applicable until 20 November 2030.');

  /** Display name of surface i of a model. */
  function surfaceNames(model, ap) {
    return model.surfaces.map((s) => {
      const r = ap.runways[s.runway];
      const e = r?.ends[s.end];
      switch (s.kind) {
        case 'primary':
          return t('Primary surface {rwy}', { rwy: r.id });
        case 'strip':
          return t('Runway strip {rwy}', { rwy: r.id });
        case 'transitional':
          return t('Transitional surface {rwy}', { rwy: r.id });
        case 'approach':
          return t('Approach surface {end}', { end: e.id });
        case 'takeoff':
          // Beyond end k: the climb-out of take-offs on the other end's runway.
          return t('Take-off climb surface, departures on {end}', { end: r.ends[1 - s.end].id });
        case 'horizontal':
          return t('Horizontal surface');
        case 'innerHorizontal':
          return t('Inner horizontal surface');
        case 'conical':
          return t('Conical surface');
        case 'innerApproach':
          return t('Inner approach surface {end}', { end: e.id });
        case 'innerTransitional':
          return t('Inner transitional surface {end}', { end: e.id });
        case 'balkedLanding':
          return t('Balked landing surface {end}', { end: e.id });
        case 'ofzStrip':
          return t('Strip inside the obstacle-free zone {end}', { end: e.id });
        default:
          return s.kind;
      }
    });
  }

  // ---- airports ----
  function addAirport(ap) {
    const probs = (ap.runways ?? []).length ? OB.airportProblems(ap) : [];
    if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_AIRPORT_INVALID');
    let id;
    S.transact(t('Add airport {ident}', { ident: ap.ident }), (tx) => (id = tx.create('airport', { ...ap, created: new Date().toISOString() })));
    return id;
  }

  /** NASR CSV texts from picked files: a NASR CSV zip, or the three CSV files. */
  async function nasrTexts(files) {
    const out = {};
    // NASR CSV text is Latin-1 (windows-1252).
    const dec = new TextDecoder('windows-1252');
    const take = async (name, blob) => {
      const key = { 'APT_BASE.CSV': 'base', 'APT_RWY.CSV': 'rwy', 'APT_RWY_END.CSV': 'end' }[name.replace(/^.*[\\/]/, '').toUpperCase()];
      if (key) out[key] = dec.decode(await blob.arrayBuffer());
    };
    for (const f of files) {
      if (/\.zip$/i.test(f.name)) {
        for (const e of await listZip(f)) if (/(^|\/)APT_(BASE|RWY|RWY_END)\.csv$/i.test(e.path)) await take(e.path, await entryFile(f, e));
      } else await take(f.name, f);
    }
    if (!out.base || !out.rwy || !out.end) throw gwError('NASR needs APT_BASE.csv, APT_RWY.csv and APT_RWY_END.csv (or the NASR APT CSV zip)', null, 'E_NASR_FILES');
    return out;
  }

  /** Import airports by identifier from NASR ({base, rwy, end} texts or files). Returns the new record ids. */
  async function importNasr(src, idents) {
    const texts = Array.isArray(src) ? await nasrTexts(src) : src;
    const ids = [];
    const missing = [];
    for (const id of idents) {
      let ap;
      try {
        ap = OB.nasrAirport(texts, id);
      } catch (e) {
        if (e.code === 'E_NASR_IDENT') throw gwError('"{ident}" is not an airport identifier', { ident: id }, 'E_NASR_IDENT');
        if (e.code === 'E_NASR_COLUMNS') throw gwError('not a NASR APT CSV file', null, 'E_NASR_COLUMNS');
        throw e;
      }
      if (!ap) {
        missing.push(id);
        continue;
      }
      ids.push(addAirport({ ...ap, source: `FAA NASR ${ap.eff}` }));
      app.importLog?.push({ file: `NASR ${ap.ident}`, errors: [], warnings: ap.notes.map(tpl) });
    }
    if (missing.length) toast(t('Not in the NASR files: {ids}', { ids: list(missing) }), { kind: 'warn' });
    return ids;
  }

  // ---- surfaces and evaluation ----
  const def = (ap, regime, ihsDatum, codeF) => OB.encodeAirport(ap, regime, { ihsDatum, codeF });
  async function surfaces(airport, regime = 'part77', { ihsDatum = NaN, codeF = false } = {}) {
    const ap = typeof airport === 'string' ? S.get(airport) : airport;
    if (!ap) throw gwError('no airport: add one with Airports and Runways', null, 'E_AIRPORT_NONE');
    const probs = OB.airportProblems(ap, regime);
    if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_AIRPORT_INVALID');
    const model = await app.pool.run('obs.surfaces', { def: def(ap, regime, ihsDatum, codeF) }, { kind: 'analysis', label: t('Obstruction surfaces') });
    return { ...model, names: surfaceNames(model, ap), hasZone: model.surfaces.some((s) => OB.ZONE_KINDS.includes(s.kind)), regime, airport: ap };
  }

  /**
   * Undulation of the active geoid at a position, from a 0.005° lattice of the core's values (bilinear): the geoid
   * varies by under 1 cm over a lattice cell, and a cloud or DSM of millions of positions needs only
   * a few hundred core calls.
   */
  function undulationLattice() {
    const memo = new Map();
    const q = 200;
    const at = (a, b) => {
      const k = a * 400000 + b;
      let v = memo.get(k);
      if (v === undefined) memo.set(k, (v = app.core.undulation(a / q, b / q)));
      return v;
    };
    return (lat, lon) => {
      const fa = lat * q;
      const fb = lon * q;
      const a = Math.floor(fa);
      const b = Math.floor(fb);
      const u = fa - a;
      const v = fb - b;
      return (at(a, b) * (1 - v) + at(a, b + 1) * v) * (1 - u) + (at(a + 1, b) * (1 - v) + at(a + 1, b + 1) * v) * u;
    };
  }

  /** Orthometric heights of a terrain's crop: the source datum, or HAE less the active geoid's undulation. */
  function orthometric(d, z, g) {
    if (d.vertical !== 'hae' || d.gridV) return { z, note: null };
    const N = undulationLattice();
    const o = new Float32Array(z.length);
    for (let j = 0; j < g.height; j++) {
      const lat = g.lat0 - j * g.dlat;
      for (let i = 0; i < g.width; i++) {
        const k = j * g.width + i;
        o[k] = z[k] - N(lat, g.lon0 + i * g.dlon);
      }
    }
    return { z: o, note: t('{dem} holds ellipsoidal heights: converted to {geoid} heights for the surfaces.', { dem: d.name, geoid: app.core.geoidName ?? 'EGM96' }) };
  }

  /** A terrain's posts inside the surfaces' box: {g, z}. */
  function cropTo(d, bbox) {
    const G = d.grid;
    const H = d.current ?? G.heights;
    const [s, w, n, e] = bbox;
    const i0 = Math.max(0, Math.floor((w - G.lon0) / G.dlon));
    const i1 = Math.min(G.width - 1, Math.ceil((e - G.lon0) / G.dlon));
    const j0 = Math.max(0, Math.floor((G.lat0 - n) / G.dlat));
    const j1 = Math.min(G.height - 1, Math.ceil((G.lat0 - s) / G.dlat));
    if (i1 < i0 || j1 < j0) return null;
    const W = i1 - i0 + 1;
    const Hh = j1 - j0 + 1;
    const z = new Float32Array(W * Hh);
    for (let j = 0; j < Hh; j++) z.set(H.subarray((j0 + j) * G.width + i0, (j0 + j) * G.width + i0 + W), j * W);
    return { g: { lat0: G.lat0 - j0 * G.dlat, lon0: G.lon0 + i0 * G.dlon, dlat: G.dlat, dlon: G.dlon, width: W, height: Hh }, z };
  }

  /** Heights no terrain or obstacle has (no-data values a file did not declare) become voids; returns how many. */
  function voidOutliers(z) {
    let n = 0;
    for (let k = 0; k < z.length; k++)
      if (z[k] < -500 || z[k] > 9000) {
        z[k] = NaN;
        n++;
      }
    return n;
  }

  const terrainEntry = () => {
    const al = app.activePane()?.activeLayer();
    return (al && app.terrain.entry(al.id)) || app.terrain.dems[0] || null;
  };

  /**
   * Evaluate a terrain (DSM) or a point cloud against an airport's surfaces. opts: airport (record
   * or id), regime ('part77' | 'icao'), source ('terrain' | 'points'), dem, cloud, minPen (m),
   * ihsDatum, codeF (code letter F aeroplanes without go-around steering avionics), cell (m, point
   * grouping), draw (graphics), overlay (coloured raster), keep (store record).
   */
  function evaluate(opts = {}) {
    const running = new Set();
    const stop = () => {
      for (const p of running) p.cancel();
    };
    return app.activity.track(WORKING(), (job) => evaluateWith(opts, job, running), { cancel: stop, immediate: true });
  }

  async function evaluateWith({ airport, regime = 'part77', source = 'terrain', dem = null, cloud = null, minPen = 0, ihsDatum = NaN, codeF = false, cell = 5, draw = true, overlay = true, keep = true, maxMarkers = 200 }, job, running) {
    const t0 = performance.now();
    /** Show the next stretch of main-thread work before it starts; Cancel acts here. */
    const step = async (progress, label) => {
      await job.step(progress, label);
      if (job.cancelled) throw Object.assign(gwError('cancelled'), { cancelled: true });
    };
    let done = 0;
    const part = (op, args, transfer, total, at) => {
      const p = app.pool.run(op, args, { kind: 'analysis', transfer, label: t('Obstruction surfaces'), timeout: 900000, part: true });
      running.add(p);
      return p.then((r) => {
        running.delete(p);
        job.set(0.2 + (0.6 * ++done) / total);
        return { at, r };
      });
    };
    const model = await surfaces(airport, regime, { ihsDatum, codeF });
    const ap = model.airport;
    const d0 = def(ap, regime, ihsDatum, codeF);
    const notes = [];
    if (regime === 'icao' && !model.hasZone) notes.push(t('No runway end here is a precision approach, so the inner approach, inner transitional and balked landing surfaces do not apply (Table 4-1).'));
    let res;
    /** The zone's obstacles and clearance, reported apart: they mostly lie above the lowest surface. */
    let zone = null;
    let srcName;
    let grid = null;
    if (source === 'terrain') {
      const d = dem ?? terrainEntry();
      if (!d?.grid) throw gwError('Obstruction surfaces need a DSM loaded as terrain, or a point cloud', null, 'E_OBS_NO_SURFACE');
      srcName = d.name;
      if (!/dsm/i.test(app.terrainKind?.(d) ?? '')) notes.push(t('{dem} is not tagged as a DSM: buildings and trees are only found if it is one.', { dem: d.name }));
      await step(0.02, t('Reading the heights…'));
      const c = cropTo(d, model.bbox);
      if (!c) throw gwError('{dem} does not reach the surfaces of {ident}', { dem: d.name, ident: ap.ident }, 'E_OBS_NO_OVERLAP');
      // OD-2.31: against the FAA obstacle file, GLO-30 at 30 m held none of the listed objects of 100 ft
      // or more at LAS and HOU, and reported nothing at HOU, where the file has 33 above a surface.
      if (c.g.dlat * 111320 > COARSE_POST_M) notes.push(t('{dem} has posts about {m} m apart, so poles, towers and many buildings are missing from it: no penetration here does not mean none exists. Check against a survey or the obstacle data of your State.', { dem: d.name, m: int(c.g.dlat * 111320) }));
      if (c.g.width * c.g.height > 64e6) throw gwError('{n} M posts under the surfaces: more than 64 M; use a coarser DEM', { n: int((c.g.width * c.g.height) / 1e6) }, 'E_OBS_TOO_LARGE');
      const o = orthometric(d, c.z, c.g);
      if (o.note) notes.push(o.note);
      const bad = voidOutliers(o.z);
      if (bad) notes.push(t('{n, plural, one {# post} other {# posts}} with heights outside −500 to 9 000 m (undeclared no-data values) were left out.', { n: bad }));
      grid = c.g;
      const { width: w, height: hh } = grid;
      const rows = Math.max(1, Math.floor(STRIP_POSTS / w));
      await step(0.2, WORKING());
      const jobs = [];
      for (let j0 = 0; j0 < hh; j0 += rows) {
        const nr = Math.min(rows, hh - j0);
        const z = o.z.slice(j0 * w, (j0 + nr) * w);
        jobs.push(part('obs.grid', { def: d0, geo: Float64Array.from([w, nr, grid.lat0 - j0 * grid.dlat, grid.lon0, grid.dlat, grid.dlon]), z }, [z.buffer], Math.ceil(hh / rows), j0));
      }
      const limit = new Float32Array(w * hh);
      const sid = new Uint8Array(w * hh);
      const zoneLimit = model.hasZone ? new Float32Array(w * hh) : null;
      const zoneSid = model.hasZone ? new Uint8Array(w * hh) : null;
      for (const { at: j0, r } of await Promise.all(jobs)) {
        limit.set(r.limit, j0 * w);
        sid.set(r.sid, j0 * w);
        if (zoneLimit) {
          zoneLimit.set(r.zoneLimit, j0 * w);
          zoneSid.set(r.zoneSid, j0 * w);
        }
      }
      await step(0.82, t('Grouping the obstacles…'));
      const cl = OB.clusterGrid({ w, h: hh, z: o.z, limit, sid, minPen });
      const at = (k) => ({ lat: grid.lat0 - Math.floor(k / w) * grid.dlat, lon: grid.lon0 + (k % w) * grid.dlon });
      if (zoneLimit) {
        const cz = OB.clusterGrid({ w, h: hh, z: o.z, limit: zoneLimit, sid: zoneSid, minPen });
        zone = { ...cz, obstacles: cz.obstacles.map((q) => ({ ...q, ...at(q.k) })), minPos: cz.minAt >= 0 ? at(cz.minAt) : null, minSid: cz.minAt >= 0 ? zoneSid[cz.minAt] : 255 };
      }
      res = { ...cl, obstacles: cl.obstacles.map((q) => ({ ...q, ...at(q.k) })), unit: t('posts'), minPos: cl.minAt >= 0 ? at(cl.minAt) : null, minSid: cl.minAt >= 0 ? sid[cl.minAt] : 255 };
      grid.z = o.z;
      grid.limit = limit;
      grid.sid = sid;
    } else {
      const c = cloud ?? [...(app.pointClouds?.values() ?? [])][0];
      if (!c?.pos) throw gwError('Obstruction surfaces need a DSM loaded as terrain, or a point cloud', null, 'E_OBS_NO_SURFACE');
      srcName = c.name;
      // A cloud with no CRS sits in a local frame at 0°, 0°: nothing would fall under the surfaces,
      // which must not read as "no penetrations".
      if (c.crs?.local) throw gwError('{cloud} has no coordinate system, so it cannot be placed under the surfaces of {ident}: open a copy of the file that states its CRS, or use Assign CRS where the Point Cloud menu offers it', { cloud: c.name, ident: ap.ident }, 'E_OBS_NO_CRS');
      await app.ensureGeoid?.();
      const n = c.n;
      const x = new Float64Array(n);
      const y = new Float64Array(n);
      const z = new Float64Array(n);
      const ll = new Float64Array(2 * n);
      const N = undulationLattice();
      await step(0.02, t('Reading the heights…'));
      let shown = performance.now();
      for (let k = 0; k < n; k++) {
        if (!(k & 0xffff) && performance.now() - shown > 200) {
          await step(0.02 + (0.18 * k) / n);
          shown = performance.now();
        }
        const g = app.pc.toGeo(c, c.pos[3 * k], c.pos[3 * k + 1], c.pos[3 * k + 2]);
        x[k] = c.pos[3 * k];
        y[k] = c.pos[3 * k + 1];
        ll[2 * k] = g.lat;
        ll[2 * k + 1] = g.lon;
        z[k] = g.hae - N(g.lat, g.lon);
      }
      notes.push(t('Point heights are ellipsoidal in the cloud: converted to {geoid} heights for the surfaces.', { geoid: app.core.geoidName ?? 'EGM96' }));
      const bad = voidOutliers(z);
      if (bad) notes.push(t('{n, plural, one {# point} other {# points}} with heights outside −500 to 9 000 m were left out.', { n: bad }));
      await step(0.2, WORKING());
      const jobs = [];
      for (let k0 = 0; k0 < n; k0 += POINT_BATCH) {
        const strip = ll.slice(2 * k0, 2 * Math.min(n, k0 + POINT_BATCH));
        jobs.push(part('obs.points', { def: d0, ll: strip }, [strip.buffer], Math.ceil(n / POINT_BATCH), k0));
      }
      const limit = new Float32Array(n);
      const sid = new Uint8Array(n);
      const zoneLimit = model.hasZone ? new Float32Array(n) : null;
      const zoneSid = model.hasZone ? new Uint8Array(n) : null;
      for (const { at: k0, r } of await Promise.all(jobs)) {
        limit.set(r.limit, k0);
        sid.set(r.sid, k0);
        if (zoneLimit) {
          zoneLimit.set(r.zoneLimit, k0);
          zoneSid.set(r.zoneSid, k0);
        }
      }
      await step(0.82, t('Grouping the obstacles…'));
      const cl = OB.clusterPoints({ x, y, z, limit, sid, minPen, cell });
      if (zoneLimit) {
        const cz = OB.clusterPoints({ x, y, z, limit: zoneLimit, sid: zoneSid, minPen, cell });
        const at = (k) => ({ lat: ll[2 * k], lon: ll[2 * k + 1] });
        zone = { ...cz, obstacles: cz.obstacles.map((q) => ({ ...q, ...at(q.k) })), minPos: cz.minAt >= 0 ? at(cz.minAt) : null, minSid: cz.minAt >= 0 ? zoneSid[cz.minAt] : 255 };
      }
      res = { ...cl, obstacles: cl.obstacles.map((q) => ({ ...q, lat: ll[2 * q.k], lon: ll[2 * q.k + 1] })), unit: t('points'), minPos: cl.minAt >= 0 ? { lat: ll[2 * cl.minAt], lon: ll[2 * cl.minAt + 1] } : null, minSid: cl.minAt >= 0 ? sid[cl.minAt] : 255 };
    }
    // Nothing under a surface says nothing about clearance: refused, as for a DEM off the surfaces.
    if (!res.covered) throw gwError('{dem} does not reach the surfaces of {ident}', { dem: srcName, ident: ap.ident }, 'E_OBS_NO_OVERLAP');
    notes.push(t('Runway and airport elevations from {source} are NAVD 88 in the United States; the surface heights are compared with the {what} heights as they are (the datums differ by about a metre).', { source: ap.source ?? t('the airport record'), what: source === 'terrain' ? t('DSM') : t('point cloud') }));
    // A zone the source does not reach says nothing about the zone: it must not read as clear.
    if (zone && !zone.covered) notes.push(t('{src} does not reach the obstacle-free zone (the inner approach, inner transitional and balked landing surfaces), so the zone was not checked.', { src: srcName }));
    if (zone?.covered) notes.push(t('Annex 14 §4.2.18 allows above these surfaces only frangible objects that must stand on the strip because of their function, and a DSM or point cloud cannot tell which objects those are.'));
    if (zone) notes.push(t('Annex 14 makes these surfaces a Recommendation for precision category I (§4.2.14) and a Standard for categories II and III (§4.2.15).'));
    if (zone && codeF) notes.push(t('The inner edges of the obstacle-free zone are 140 m on code 3 and 4 precision runways, for code letter F aeroplanes without go-around steering avionics.'));
    if (regime === 'icao' && model.surfaces.some((s) => s.kind === 'takeoff')) notes.push(t('Take-off climb surfaces start at the elevation of the runway end. Annex 14 §4.1.27 takes the highest point on the extended centre line or clearway up to the inner edge, which this tool does not know.'));
    const rowsOf = (list, prefix, inZone) => list.map((q, i) => ({ id: `${prefix}${i + 1}`, lat: q.lat, lon: q.lon, z: q.z, limit: q.limit, pen: q.pen, surface: model.names[q.sid] ?? '', kind: model.surfaces[q.sid]?.kind ?? '', posts: q.posts, zone: inZone }));
    const rows = rowsOf(res.obstacles, 'P', false);
    const statsOf = (c, n) => ({ evaluated: c.evaluated, covered: c.covered, penetrating: c.penetrating, obstacles: n, minClearance: c.minClearance, minClearanceAt: c.minPos, minClearanceSurface: model.names[c.minSid] ?? null });
    const zoneRows = zone ? rowsOf(zone.obstacles, 'Z', true) : [];
    const result = { airport: ap.ident, airportId: ap.id ?? null, regime, edition: regime === 'icao' ? OB.ICAO_EDITION : null, codeF: regime === 'icao' && !!codeF, source: srcName, sourceKind: source, minPen, model, obstacles: rows, zone: zone ? { obstacles: zoneRows, stats: statsOf(zone, zoneRows.length) } : null, stats: { ...statsOf(res, rows.length), ms: Math.round(performance.now() - t0) }, notes, grid };
    if (draw || (overlay && grid)) await step(0.92, t('Drawing the surfaces…'));
    if (draw) drawResult(result, maxMarkers);
    if (overlay && grid) result.overlay = await overlayOf(result);
    if (keep)
      S.transact(t('Obstruction analysis {ident}', { ident: ap.ident }), (tx) => {
        result.recordId = tx.create('obstruction', { airport: ap.ident, airportId: ap.id ?? null, regime, edition: result.edition, codeF: result.codeF, source: srcName, sourceKind: source, minPen, stats: result.stats, obstacles: rows.slice(0, 2000), ...(zone ? { zone: { stats: result.zone.stats, obstacles: zoneRows.slice(0, 2000) } } : {}), notes, created: new Date().toISOString() });
      });
    app.aviation.last = result;
    return result;
  }

  /** The surfaces and the worst obstacles as ground graphics (heights HAE) in one graphics layer. */
  function drawResult(r, maxMarkers) {
    const p = app.activePane();
    if (!p?.geoLayer?.()?.modelId) return;
    const hae = (lat, lon, z) => z + (app.core.undulation(lat, lon) || 0);
    const m = r.model;
    const now = new Date().toISOString();
    S.transact(t('Obstruction surfaces {ident}', { ident: r.airport }), (tx) => {
      const gl = tx.create('glayer', { pane: p.id, name: t('Obstruction surfaces {ident}', { ident: r.airport }), visible: true, saved: true });
      const add = (shape, coords, kind, text = '', extra = {}) => tx.create('graphic', { glayer: gl, pane: p.id, shape, anchor: 'ground', coords, text, style: { stroke: OB.surfaceColour(kind), width: kind === 'penetration' ? 2 : 1, fill: '#00000000', ...extra }, created: now, provenance: { kind: 'obstruction', surface: kind } });
      const chainEnds = new Map();
      for (const f of m.facets) {
        const s = m.surfaces[f.s];
        const ring = f.ring.map(([la, lo, z]) => [lo, la, hae(la, lo, z)]);
        if (s.kind === 'conical') {
          // Only the outer edge: chained into one ring.
          (chainEnds.get('conical') ?? chainEnds.set('conical', []).get('conical')).push(ring[3]);
          continue;
        }
        if (s.kind === 'transitional') {
          const key = `t${f.s}`;
          const ch = chainEnds.get(key) ?? chainEnds.set(key, [[]]).get(key);
          const cur = ch.at(-1);
          const last = cur.at(-1);
          if (last && (Math.abs(last[0] - ring[3][0]) > 1e-9 || Math.abs(last[1] - ring[3][1]) > 1e-9)) ch.push([ring[3]]);
          else if (!last) cur.push(ring[3]);
          ch.at(-1).push(ring[2]);
          continue;
        }
        add('polygon', ring, s.kind);
      }
      for (const [key, v] of chainEnds) {
        if (key === 'conical') add('polygon', v, 'conical');
        else for (const line of v) if (line.length >= 2) add('polyline', line, 'transitional', '', { dash: 'dashed' });
      }
      for (const o of [...r.obstacles.slice(0, maxMarkers), ...(r.zone?.obstacles.slice(0, maxMarkers) ?? [])]) add('point', [[o.lon, o.lat, hae(o.lat, o.lon, o.z)]], 'penetration', `${o.id} +${num(o.pen, 1)} m`, { stroke: '#ff1744' });
    });
  }

  /** Coloured overlay: yellow up to 3 m through, orange to 10 m, red beyond. */
  async function overlayOf(r) {
    const g = r.grid;
    const n = g.width * g.height;
    const cls = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const p = g.z[k] - g.limit[k];
      if (!(p > r.minPen)) continue;
      cls[k] = p <= 3 ? 1 : p <= 10 ? 2 : 3;
    }
    return app.terrainAnalysis.openOverlay(g, cls, { 1: [255, 214, 0], 2: [255, 145, 0], 3: [255, 23, 68] }, `obstructions-${r.airport}-${r.regime}.tif`);
  }

  const blobOf = (r, fmt) => {
    const edition = r.edition ?? null;
    const meta = { airport: r.airport, regime: r.regime, ...(edition ? { edition } : {}), source: r.source, minPenetration_m: r.minPen };
    const all = [...r.obstacles, ...(r.zone?.obstacles ?? [])];
    if (fmt === 'csv') return textBlob(OB.obstaclesCsv(all, { edition }), 'text/csv');
    if (fmt === 'geojson') return textBlob(OB.obstaclesGeoJson(all, meta), 'application/geo+json');
    if (fmt === 'kml') return textBlob(OB.obstaclesKml(all, t('Penetrations {ident}', { ident: r.airport }), { edition }), 'application/vnd.google-earth.kml+xml');
    if (fmt === 'surfaces-kml') return textBlob(OB.surfacesKml(r.model, r.model.names, t('Obstruction surfaces {ident}', { ident: r.airport }), { edition }), 'application/vnd.google-earth.kml+xml');
    if (fmt === 'surfaces-geojson') return textBlob(OB.surfacesGeoJson(r.model, r.model.names, meta), 'application/geo+json');
    throw gwError('unknown export format {fmt}', { fmt }, 'E_OBS_FORMAT');
  };
  async function exportResult(r = app.aviation.last, fmt = 'csv') {
    if (!r) throw gwError('no obstruction analysis to export', null, 'E_OBS_NONE');
    if (fmt === 'clearance') {
      const g = r.grid;
      if (!g) throw gwError('the clearance raster needs a DSM evaluation', null, 'E_OBS_NO_GRID');
      const d = new Float32Array(g.width * g.height);
      for (let k = 0; k < d.length; k++) d[k] = Number.isFinite(g.limit[k]) && Number.isFinite(g.z[k]) ? g.limit[k] - g.z[k] : NaN;
      const bytes = await writeGeoTiff({ width: g.width, height: g.height, bands: 1, type: 'f32', data: d }, { epsg: 4326, geotransform: [g.lon0 - g.dlon / 2, g.dlon, 0, g.lat0 + g.dlat / 2, 0, -g.dlat], nodata: NaN, description: `clearance below the ${r.regime} surfaces of ${r.airport} (m; negative: penetration)${r.edition ? `; ${r.edition}` : ''}` }); // i18n-ignore: file metadata
      return saveBlob(app, new Blob([bytes], { type: 'image/tiff' }), { name: `clearance-${r.airport}-${r.regime}.tif`, types: ['.tif'], description: 'GeoTIFF' });
    }
    const ext = { csv: '.csv', geojson: '.geojson', kml: '.kml', 'surfaces-kml': '.kml', 'surfaces-geojson': '.geojson' }[fmt];
    const base = fmt.startsWith('surfaces') ? `surfaces-${r.airport}-${r.regime}` : `penetrations-${r.airport}-${r.regime}`;
    return saveBlob(app, blobOf(r, fmt), { name: `${base}${ext}`, types: [ext], description: fmt.toUpperCase() });
  }

  app.aviation = Object.assign(app.aviation ?? {}, { airports, addAirport, importNasr, surfaces, evaluate, exportResult, blobOf, designator, last: app.aviation?.last ?? null });

  // ---- Airports and Runways dialog ----
  const input = (value, label, attrs = {}) => h('input', { class: 'inp', value: String(value ?? ''), 'aria-label': label, ...attrs });
  const numInput = (value, label, step = 'any') => input(Number.isFinite(value) ? +value.toFixed(8) : '', label, { type: 'number', step, class: 'inp inp-num' });
  const select = (value, options, label) => {
    const s = h('select', { class: 'inp', 'aria-label': label }, ...options.map(([v, l]) => h('option', { value: String(v) }, l)));
    s.value = String(value);
    return s;
  };

  /** Runway-end editor for one airport → a function returning the edited runways. */
  function runwayEditor(ap) {
    const tbody = h('tbody', {});
    const rows = [];
    const p77 = OB.P77_CODES.map((c) => [c, P77_LABELS[c]]);
    const icao = [
      [0, t('Non-instrument')],
      [1, t('Non-precision')],
      [2, t('Precision, category I')],
      [3, t('Precision, category II or III')],
    ];
    for (const r of ap.runways) {
      const code = select(r.code ?? OB.icaoCodeNumber(r.length ?? 0), [1, 2, 3, 4].map((c) => [c, String(c)]), t('Code number of runway {rwy}', { rwy: r.id }));
      const paved = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Runway {rwy} is paved', { rwy: r.id }) });
      paved.checked = !!r.paved;
      r.ends.forEach((e, k) => {
        const f = {
          lat: numInput(e.lat, t('Latitude of end {end}', { end: e.id })),
          lon: numInput(e.lon, t('Longitude of end {end}', { end: e.id })),
          elev: numInput(e.elev, t('Elevation of end {end} (m)', { end: e.id })),
          p77: select(e.p77, p77, t('Part 77 category of end {end}', { end: e.id })),
          icao: select(e.icao ?? 0, icao, t('Annex 14 approach type of end {end}', { end: e.id })),
          disp: numInput(e.disp ?? 0, t('Displaced threshold of end {end} (m)', { end: e.id })),
        };
        rows.push({ r, k, f, code, paved });
        tbody.append(h('tr', {}, h('td', {}, k === 0 ? r.id : ''), h('td', {}, e.id), h('td', {}, f.lat), h('td', {}, f.lon), h('td', {}, f.elev), h('td', {}, f.p77), h('td', {}, f.icao), h('td', {}, f.disp), h('td', {}, k === 0 ? code : ''), h('td', {}, k === 0 ? paved : '')));
      });
    }
    const table = h('table', { class: 'tbl', 'data-id': 'avn:runways' }, h('thead', {}, h('tr', {}, ...[t('Runway'), t('End'), t('Latitude'), t('Longitude'), t('Elevation (m)'), t('Part 77'), t('Annex 14'), t('Displaced threshold (m)'), t('Code'), t('Paved')].map((x) => h('th', {}, x)))), tbody);
    const read = () =>
      ap.runways.map((r) => ({
        ...r,
        code: Number(rows.find((q) => q.r === r).code.value),
        paved: rows.find((q) => q.r === r).paved.checked,
        ends: r.ends.map((e, k) => {
          const f = rows.find((q) => q.r === r && q.k === k).f;
          return { ...e, lat: Number(f.lat.value), lon: Number(f.lon.value), elev: Number(f.elev.value), p77: f.p77.value, icao: Number(f.icao.value), disp: Number(f.disp.value) || 0 };
        }),
      }));
    return { table, read };
  }

  // Draw Runway: click end A, then end B; elevations from the terrain (MSL), else the airport's.
  let drawFor = null;
  app.tools.register({
    id: 'avn.runway',
    cue: t('Runway: click one end, then the other (Esc cancels).'),
    onDown(p, e, sx, sy) {
      const l = p.geoLayer();
      if (!l?.modelId) return true;
      const q = p.imagePoint(sx, sy);
      const g = l.groundWithTerrain(q.x, q.y);
      if (!g) return true;
      (this.state.pts ??= []).push(g);
      if (this.state.pts.length === 2) {
        const [a, b] = this.state.pts;
        this.state = {};
        app.tools.done();
        if (drawFor) addRunway(drawFor, a, b);
      }
      p.invalidate();
      return true;
    },
  });
  function addRunway(airportId, a, b) {
    const ap = S.get(airportId);
    if (!ap) return null;
    const inv = app.core.inverse(a.lat, a.lon, b.lat, b.lon);
    // End A is approached heading towards B: its designator is that bearing's (true, not magnetic).
    const [ia, ib] = designator(inv.azi1).split('/');
    const elev = (q) => app.terrain.sample(q.lat, q.lon)?.msl ?? ap.elev;
    const end = (q, eid) => ({ id: eid, lat: q.lat, lon: q.lon, elev: elev(q), p77: 'B(V)', icao: 0, disp: 0, thrElev: null, clearway: 0, approach: true, takeoff: true });
    const r = { id: `${ia}/${ib}`, length: inv.distance, width: 45, surface: '', paved: true, code: OB.icaoCodeNumber(inv.distance), ends: [end(a, ia), end(b, ib)] };
    S.transact(t('Add runway {rwy}', { rwy: r.id }), (tx) => tx.set(ap.id, 'runways', [...ap.runways, r]));
    toast(t('Runway {rwy} added to {ident}: {len}', { rwy: r.id, ident: ap.ident, len: height(inv.distance, 0) }), { kind: 'info' });
    return r;
  }
  app.aviation.addRunway = addRunway;

  C.implement('los.airports', {
    run: async () => {
      for (;;) {
        const list0 = airports();
        const sel = select(app.aviation.current ?? list0[0]?.id ?? '', list0.map((a) => [a.id, `${a.ident}${a.icao ? ` / ${a.icao}` : ''} — ${a.name ?? ''}`]), t('Airport'));
        const box = h('div', {});
        let ed = null;
        const show = () => {
          const ap = S.get(sel.value);
          app.aviation.current = ap?.id ?? null;
          ed = ap ? runwayEditor(ap) : null;
          box.replaceChildren(...(ap ? [h('p', { class: 'hint' }, t('{name}: elevation {elev}; {n, plural, one {# runway} other {# runways}}; source {src}.', { name: ap.name ?? ap.ident, elev: height(ap.elev, 1), n: ap.runways.length, src: ap.source ?? t('entered by hand') })), h('div', { class: 'scroll', style: 'max-height: 320px; overflow: auto' }, ed.table)] : [h('p', {}, t('No airports yet. Import them from the FAA NASR files, or add one by hand and draw its runways.'))]));
        };
        sel.addEventListener('change', show);
        show();
        const body = h('div', {}, list0.length ? field(t('Airport'), sel) : '', box, h('p', { class: 'hint' }, t('FAA NASR: the 28-day subscription APT CSV files (public domain) from faa.gov; positions NAD 83, elevations NAVD 88.')));
        const r = await modal({
          title: t('Airports and Runways'),
          body,
          buttons: [
            { label: t('Save'), value: 'save', primary: true },
            { label: t('Import FAA NASR…'), value: 'nasr' },
            { label: t('New Airport…'), value: 'new' },
            { label: t('Draw Runway'), value: 'draw' },
            { label: t('Delete Airport'), value: 'delete' },
            { label: t('Close'), value: 'close' },
          ],
          width: 980,
          id: 'avn-airports',
        });
        try {
          if (r === 'save' && ed) {
            const ap = S.get(sel.value);
            const runways = ed.read();
            const probs = OB.airportProblems({ ...ap, runways });
            if (probs.length) throw gwError(probs[0].src, probs[0].params, 'E_AIRPORT_INVALID');
            S.transact(t('Edit runways of {ident}', { ident: ap.ident }), (tx) => tx.set(ap.id, 'runways', runways));
            return;
          }
          if (r === 'nasr') {
            const files = await pickFiles(app, { multiple: true, accept: ['.zip', '.csv'], description: t('FAA NASR APT CSV') });
            if (!files?.length) continue;
            const ids = await promptBox(t('Import FAA NASR'), t('Airport identifiers (FAA or ICAO), separated by commas'), '', { placeholder: 'LAS, KVGT' }); // i18n-ignore: example identifiers
            if (!ids) continue;
            const made = await importNasr(files, ids.split(/[\s,;]+/).filter(Boolean));
            if (made.length) app.aviation.current = made[0];
            toast(t('Imported {n, plural, one {# airport} other {# airports}} from NASR', { n: made.length }), { kind: 'info' });
            continue;
          }
          if (r === 'new') {
            const ident = input('', t('Identifier'));
            const name = input('', t('Name'));
            const elev = numInput(NaN, t('Airport elevation (m)'));
            if ((await modal({ title: t('New Airport'), body: h('div', {}, field(t('Identifier'), ident), field(t('Name'), name), field(t('Airport elevation (m)'), elev, t('The highest point of the usable runways (Part 77 "established airport elevation"); Annex 14 uses it as the inner horizontal datum.'))), buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'avn-new-airport' })) !== 'ok') continue;
            if (!ident.value.trim() || !Number.isFinite(Number(elev.value)) || elev.value === '') throw gwError('An airport needs an identifier and an elevation', null, 'E_AIRPORT_INVALID');
            app.aviation.current = addAirport({ ident: ident.value.trim().toUpperCase(), name: name.value.trim(), elev: Number(elev.value), source: t('entered by hand'), runways: [] });
            continue;
          }
          if (r === 'draw' && sel.value) {
            drawFor = sel.value;
            app.tools.select('avn.runway');
            return;
          }
          if (r === 'delete' && sel.value) {
            const ap = S.get(sel.value);
            S.transact(t('Delete airport {ident}', { ident: ap.ident }), (tx) => tx.delete(ap.id));
            app.aviation.current = null;
            continue;
          }
          return;
        } catch (e) {
          toast(msgOf(e), { kind: e?.code === 'E_AIRPORT_INVALID' || e?.code === 'E_NASR_FILES' ? 'warn' : 'error', ms: 8000 });
        }
      }
    },
  });

  // ---- Obstruction Surfaces dialog ----
  C.implement('los.obstruction', {
    enabled: () => airports().length > 0,
    run: async () => {
      const list0 = airports();
      if (!list0.length) return toast(t('Add an airport first (Airports and Runways)'), { kind: 'warn' });
      const o = { regime: 'part77', minPen: 0, draw: true, overlay: true, codeF: false, ...(app.prefs.get('obstruction') ?? {}) };
      const ap = select(app.aviation.current ?? list0[0].id, list0.map((a) => [a.id, `${a.ident} — ${a.name ?? ''}`]), t('Airport'));
      const regime = select(o.regime, [['part77', t('FAA 14 CFR Part 77 (§77.19 imaginary surfaces)')], ['icao', t('ICAO Annex 14 (obstacle limitation surfaces)')]], t('Surfaces'));
      const codeF = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Code letter F aeroplanes without go-around steering avionics use this aerodrome') });
      codeF.checked = !!o.codeF;
      const icaoOnly = h('div', { 'data-id': 'avn:icao-only' }, h('p', { class: 'hint', 'data-id': 'avn:edition' }, editionLabel()), h('label', { class: 'chk' }, codeF, ' ', t('Code letter F aeroplanes without go-around steering avionics use this aerodrome')));
      const showIcao = () => { icaoOnly.hidden = regime.value !== 'icao'; };
      regime.addEventListener('change', showIcao);
      showIcao();
      const clouds = [...(app.pointClouds?.values() ?? [])];
      const dems = app.terrain.dems;
      const srcs = [...dems.map((d, i) => [`dem:${i}`, t('Terrain: {name}', { name: d.name })]), ...clouds.map((c, i) => [`pc:${i}`, t('Point cloud: {name}', { name: c.name })])];
      if (!srcs.length) return toast(t('Load a DSM as terrain or open a point cloud first'), { kind: 'warn' });
      const src = select(srcs[0][0], srcs, t('Evaluate'));
      const minPen = numInput(o.minPen, t('Report penetrations deeper than (m)'));
      const drawCb = h('input', { type: 'checkbox', style: { width: '18px', height: '18px', margin: '3px' }, 'aria-label': t('Draw the surfaces and obstacles') });
      drawCb.checked = o.draw !== false;
      const body = h('div', {}, field(t('Airport'), ap), field(t('Surfaces'), regime), icaoOnly, field(t('Evaluate'), src), field(t('Report penetrations deeper than (m)'), minPen, t('0 reports every post or point above a surface.')), h('label', { class: 'chk' }, drawCb, ' ', t('Draw the surfaces and obstacles')), h('p', { class: 'hint' }, t('Every DSM post or cloud point under the surfaces is compared with the lowest surface there (Part 77 §77.17(a)(5): an object penetrating any surface is an obstruction).')));
      if ((await modal({ title: t('Obstruction Surfaces'), body, buttons: [{ label: t('Evaluate'), value: 'run', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'avn-obstruction' })) !== 'run') return;
      const opts = { regime: regime.value, minPen: Number(minPen.value) || 0, draw: drawCb.checked, codeF: codeF.checked };
      app.prefs.set('obstruction', opts);
      const [kind, i] = src.value.split(':');
      try {
        const r = await evaluate({ airport: ap.value, ...opts, overlay: opts.draw, source: kind === 'dem' ? 'terrain' : 'points', dem: kind === 'dem' ? dems[+i] : null, cloud: kind === 'pc' ? clouds[+i] : null });
        await showResult(r);
      } catch (e) {
        if (e?.cancelled) return toast(t('Cancelled.'), { kind: 'info' });
        toast(msgOf(e), { kind: ['E_OBS_NO_OVERLAP', 'E_OBS_NO_SURFACE', 'E_OBS_NO_CRS', 'E_AIRPORT_INVALID', 'E_OBS_TOO_LARGE'].includes(e?.code) ? 'warn' : 'error', ms: 9000 });
      }
    },
  });

  async function showResult(r) {
    const s = r.stats;
    /** A penetrations table: its first 300 rows, each with a button to go there. */
    const tableOf = (list, id) => {
      const tbody = h(
        'tbody',
        {},
        ...list.slice(0, 300).map((q) => {
          const go = h('button', { class: 'btn btn-small', 'aria-label': t('Go to {id}', { id: q.id }), 'data-id': `avn:go:${q.id}` }, q.id);
          go.addEventListener('click', () => app.jumpTo?.(`${q.lat.toFixed(7)} ${q.lon.toFixed(7)}`));
          return h('tr', {}, h('td', {}, go), h('td', {}, q.surface), h('td', {}, height(q.pen, 2)), h('td', {}, height(q.z, 1)), h('td', {}, height(q.limit, 1)), h('td', {}, int(q.posts)), h('td', { class: 'mono' }, `${q.lat.toFixed(6)}, ${q.lon.toFixed(6)}`));
        }),
      );
      return h('table', { class: 'tbl', 'data-id': id }, h('thead', {}, h('tr', {}, ...[t('Obstacle'), t('Surface'), t('Penetration'), t('Top (MSL)'), t('Surface height (MSL)'), r.sourceKind === 'terrain' ? t('Posts') : t('Points'), t('Position')].map((x) => h('th', {}, x)))), tbody);
    };
    const top = r.obstacles;
    const table = tableOf(top, 'avn:penetrations');
    const unit = r.sourceKind === 'terrain' ? t('posts') : t('points');
    const z = r.zone;
    const zoneBlock = z?.stats.covered
      ? [
          h('h3', {}, t('Obstacle-free zone')),
          h('p', { 'data-id': 'avn:zone-summary' }, t('{covered} {unit} lie under the inner approach, inner transitional and balked landing surfaces or inside the strip between them; {pen} rise above them in {n, plural, one {# obstacle} other {# obstacles}}.', { covered: int(z.stats.covered), unit, pen: int(z.stats.penetrating), n: z.stats.obstacles })),
          Number.isFinite(z.stats.minClearance) ? h('p', { 'data-id': 'avn:zone-clearance' }, z.stats.minClearance >= 0 ? t('Smallest clearance below the surfaces: {c} ({surface}).', { c: height(z.stats.minClearance, 1), surface: z.stats.minClearanceSurface ?? '' }) : t('Deepest penetration: {c} ({surface}).', { c: height(-z.stats.minClearance, 1), surface: z.stats.minClearanceSurface ?? '' })) : '',
          z.obstacles.length ? h('div', { class: 'scroll', style: 'max-height: 240px; overflow: auto', tabindex: '0', role: 'region', 'aria-label': t('Obstacle-free zone') }, tableOf(z.obstacles, 'avn:zone-penetrations')) : h('p', {}, t('No penetrations.')),
        ]
      : [];
    const body = h(
      'div',
      {},
      r.edition ? h('p', { class: 'hint', 'data-id': 'avn:edition' }, editionLabel()) : '',
      h('p', { 'data-id': 'avn:summary' }, t('{ident} ({regime}) against {src}: {covered} of {evaluated} {unit} lie under a surface; {pen} penetrate it in {n, plural, one {# obstacle} other {# obstacles}} ({ms} ms).', { ident: r.airport, regime: r.regime === 'icao' ? 'ICAO Annex 14' : 'FAA Part 77', src: r.source, covered: int(s.covered), evaluated: int(s.evaluated), unit: r.sourceKind === 'terrain' ? t('posts') : t('points'), pen: int(s.penetrating), n: s.obstacles, ms: int(s.ms) })), // i18n-ignore: regulation names
      Number.isFinite(s.minClearance) ? h('p', { 'data-id': 'avn:clearance' }, s.minClearance >= 0 ? t('Smallest clearance below the surfaces: {c} ({surface}).', { c: height(s.minClearance, 1), surface: s.minClearanceSurface ?? '' }) : t('Deepest penetration: {c} ({surface}).', { c: height(-s.minClearance, 1), surface: s.minClearanceSurface ?? '' })) : '',
      top.length ? h('div', { class: 'scroll', style: 'max-height: 320px; overflow: auto' }, table) : h('p', {}, t('No penetrations.')),
      ...zoneBlock,
      ...r.notes.map((n) => h('p', { class: 'hint' }, n)),
    );
    for (;;) {
      const v = await modal({ title: t('Obstruction Penetrations'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }, { label: t('Export CSV'), value: 'csv' }, { label: t('Export GeoJSON'), value: 'geojson' }, { label: t('Export KML'), value: 'kml' }, { label: t('Surfaces as KML'), value: 'surfaces-kml' }, ...(r.grid ? [{ label: t('Clearance GeoTIFF'), value: 'clearance' }] : [])], width: 900, id: 'avn-results' });
      if (!v || v === 'close') return;
      try {
        await exportResult(r, v);
      } catch (e) {
        toast(msgOf(e), { kind: 'error' });
      }
    }
  }
  app.aviation.showResult = showResult;
}
