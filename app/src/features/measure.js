// Mensuration, second part (REQ-MEN-02..04, REQ-MEN-10, REQ-DEM-12): bracket, mono height by
// layover and by shadow with their guide lines, targets with range rings and the Target Table,
// point-to-point line of sight with curvature and refraction, and elevation profiles with a
// linked cursor. Results go to the Mensuration Log with value, method, height source and
// CE90/LE90 or "error not available" (REQ-MEN-01, REQ-MEN-06/07).

import { h, clear } from '../shell/dom.js';
import { modal, field } from '../shell/dialogs.js';
import { groundOf, screenOfGround, poly, halo, label, fmtLen, relativeCE90 } from '../tools/tools.js';
import { saveBlob, textBlob } from '../storage/files.js';

export const name = 'measure';

const LE = 1.6449;

/** Image displacement per metre of height at a ground point: [dx, dy] px/m. */
function heightDir(l, g) {
  const a = l.imageAt(g.lat, g.lon, g.h);
  const b = l.imageAt(g.lat, g.lon, g.h + 1);
  return a && b ? { a, d: [b.x - a.x, b.y - a.y] } : null;
}

/** Δh that moves the base's image point to the image point t, along the model's vertical. */
export function solveLayover(l, base, t, hmax = 2000) {
  const hd = heightDir(l, base);
  if (!hd) return null;
  const n2 = hd.d[0] ** 2 + hd.d[1] ** 2;
  if (n2 < 1e-10) return null; // nadir view or 2-D model: no layover
  let dh = ((t.x - hd.a.x) * hd.d[0] + (t.y - hd.a.y) * hd.d[1]) / n2;
  // Newton refinement on the projection (the vertical is slightly curved in image space).
  for (let i = 0; i < 4; i++) {
    const p = l.imageAt(base.lat, base.lon, base.h + dh);
    const q = l.imageAt(base.lat, base.lon, base.h + dh + 1);
    if (!p || !q) break;
    const d = [q.x - p.x, q.y - p.y];
    const dd = d[0] ** 2 + d[1] ** 2;
    const step = ((t.x - p.x) * d[0] + (t.y - p.y) * d[1]) / dd;
    dh += step;
    if (Math.abs(step) < 1e-4) break;
  }
  dh = Math.max(-hmax, Math.min(hmax, dh));
  const p = l.imageAt(base.lat, base.lon, base.h + dh);
  const off = p ? Math.hypot(t.x - p.x, t.y - p.y) : NaN;
  return { dh, pxPerM: Math.sqrt(n2), offLine: off };
}

export function install(app) {
  const C = app.commands;
  const tools = app.tools;
  const M = app.measureApi;
  const geo = () => !!app.activePane()?.geoLayer()?.modelId;
  const ANALYST = () => app.prefs.get('analyst') ?? 'analyst';
  const pick = () => app.prefs.get('pickSigmaPx') ?? 0.5;

  const register = (id, spec) => {
    tools.register({ id, ...spec });
    if (!C.get(id)) return; // sub-tools (height by layover/shadow) sit behind one command
    C.implement(id, { run: () => tools.select(id), sticky: () => tools.select(id, { sticky: true }), checked: () => tools.current?.id === id, enabled: geo });
  };

  // ---- bracket: start, end, depth (label offset) ----
  register('men.bracket', {
    cue: 'Bracket: click the start, the end, then the depth of the bracket. The geodesic length is logged with its relative CE90.',
    onDown(pane, e, sx, sy) {
      const s = this.state;
      if ((s.pts?.length ?? 0) < 2) {
        const g = groundOf(app, pane, sx, sy);
        if (!g) return app.toast('Bracket needs an image with a sensor model', { kind: 'warn' }), true;
        (s.pts ??= []).push(g);
        pane.invalidate();
        return true;
      }
      const [a, b] = s.pts;
      const l = a.layer;
      const inv = app.core.inverse(a.lat, a.lon, b.lat, b.lon);
      const ea = M.errorFor(l, a.x, a.y, a);
      const eb = M.errorFor(l, b.x, b.y, b);
      const ce = relativeCE90(app, ea, eb);
      const depth = { sx, sy };
      this.state = {};
      M.logRow(
        M.baseRow('Bracket', l, a, {
          value: +inv.distance.toFixed(3),
          units: 'm',
          coords: { from: app.core.mgrs(a.lat, a.lon, 5), to: app.core.mgrs(b.lat, b.lon, 5), datum: 'WGS 84' },
          extra: { azimuthTrue: (inv.azi1 + 360) % 360, depthPx: depth, absoluteCE90: [ea?.ce90 ?? null, eb?.ce90 ?? null] },
          ce90: ce,
          le90: null,
          tag: 'relative',
          errorNote: ce === null ? 'error not available (the sensor model states no error)' : '',
          method: `${a.heightSource?.startsWith('default') ? 'Mono, default height' : 'Mono-DEM'}; geodesic (Karney 2013, WGS 84)`,
          geom: [[a.lon, a.lat, a.h], [b.lon, b.lat, b.h]],
          bracket: { offset: pane.imagePoint(sx, sy) },
        }),
        pane,
      );
      tools.done();
      return true;
    },
    onMove(pane, e, sx, sy) {
      this.state.hover = { sx, sy, g: groundOf(app, pane, sx, sy) };
      if (this.state.pts?.length) pane.invalidate();
    },
    draw(pane, g, w, hh, s) {
      const pts = (s.pts ?? []).map((p) => screenOfGround(pane, p.lat, p.lon, p.h)).filter(Boolean);
      if (!pts.length) return;
      g.strokeStyle = '#ffd400';
      g.lineWidth = 2;
      if (pts.length === 1 && s.hover?.g) {
        const b = screenOfGround(pane, s.hover.g.lat, s.hover.g.lon, s.hover.g.h);
        if (b) halo(g, () => poly(g, [pts[0], b]));
        if (b) label(g, fmtLen(app.core.inverse(s.pts[0].lat, s.pts[0].lon, s.hover.g.lat, s.hover.g.lon).distance), b.x + 10, b.y - 10);
      } else if (pts.length === 2) drawBracket(g, pts[0], pts[1], s.hover ? { x: s.hover.sx, y: s.hover.sy } : pts[1], fmtLen(app.core.inverse(s.pts[0].lat, s.pts[0].lon, s.pts[1].lat, s.pts[1].lon).distance));
    },
  });

  function drawBracket(g, a, b, d, text) {
    // Offset perpendicular to AB by the depth point's distance from the line.
    const ux = b.x - a.x;
    const uy = b.y - a.y;
    const L = Math.hypot(ux, uy) || 1;
    const nx = -uy / L;
    const ny = ux / L;
    const off = (d.x - a.x) * nx + (d.y - a.y) * ny;
    const a2 = { x: a.x + nx * off, y: a.y + ny * off };
    const b2 = { x: b.x + nx * off, y: b.y + ny * off };
    halo(g, () => poly(g, [a, a2, b2, b]));
    label(g, text, (a2.x + b2.x) / 2 + nx * 8, (a2.y + b2.y) / 2 + ny * 8);
  }

  // ---- height: layover and shadow ----
  const sunOf = (l, g) => l.info.sun ?? app.sunFor(l, g);
  register('men.height.layover', {
    cue: 'Height by Layover: click the base, then the top. The guide line is the local vertical through the base from the sensor model; the top snaps to it.',
    onDown(pane, e, sx, sy) {
      const s = this.state;
      if (!s.base) {
        const g = groundOf(app, pane, sx, sy);
        if (!g) return app.toast('Height needs an image with a sensor model', { kind: 'warn' }), true;
        if (!g.layer.modelInfo?.is3d || !heightDir(g.layer, g) || Math.hypot(...heightDir(g.layer, g).d) < 1e-5) {
          app.toast('Layover height needs a 3-D sensor model on an off-nadir image; use Height by Shadow', { kind: 'warn' });
          return true;
        }
        s.base = g;
        pane.invalidate();
        return true;
      }
      const base = s.base;
      const l = base.layer;
      const t = pane.imagePoint(sx, sy);
      const r = solveLayover(l, base, t);
      this.state = {};
      if (!r) return tools.done(), true;
      if (r.offLine > 6) app.toast(`The top is ${r.offLine.toFixed(1)} px off the vertical through the base; the height uses its projection on the line`, { kind: 'warn' });
      // Two picks (base and top), each σ_pick px along the vertical.
      const sigmaH = (Math.SQRT2 * pick()) / r.pxPerM;
      const err = M.errorFor(l, base.x, base.y, base);
      M.logRow(
        M.baseRow('Height', l, base, {
          value: +r.dh.toFixed(2),
          units: 'm',
          method: `Mono height by layover (sensor-model vertical, ${r.pxPerM.toFixed(3)} px/m); base ${base.heightSource?.startsWith('default') ? 'default height' : 'on the DEM'}`,
          coords: { base: app.core.mgrs(base.lat, base.lon, 5), datum: 'WGS 84', baseHae: base.h },
          ce90: err?.modelErrorKnown ? err.ce90 : null,
          le90: sigmaH * LE,
          tag: 'relative (base to top)',
          errorNote: err?.modelErrorKnown ? '' : 'horizontal error not available (the sensor model states no error)',
          extra: { offLinePx: r.offLine, pxPerM: r.pxPerM, sigmaHeight: sigmaH },
          geom: [[base.lon, base.lat, base.h], [base.lon, base.lat, base.h + r.dh]],
        }),
        pane,
      );
      tools.done();
      return true;
    },
    onMove(pane, e, sx, sy) {
      this.state.hover = pane.imagePoint(sx, sy);
      if (this.state.base) pane.invalidate();
    },
    draw(pane, g, w, hh, s) {
      if (!s.base) return;
      const l = s.base.layer;
      const guide = [];
      for (let dh = -20; dh <= 300; dh += 10) {
        const q = l.imageAt(s.base.lat, s.base.lon, s.base.h + dh);
        if (q) guide.push(pane.screenPoint(q.x, q.y));
      }
      g.strokeStyle = '#00e5ff';
      g.lineWidth = 1;
      g.setLineDash([6, 4]);
      halo(g, () => poly(g, guide));
      g.setLineDash([]);
      const b = screenOfGround(pane, s.base.lat, s.base.lon, s.base.h);
      if (b && s.hover) {
        const r = solveLayover(l, s.base, s.hover);
        if (r) {
          const tq = l.imageAt(s.base.lat, s.base.lon, s.base.h + r.dh);
          const t = pane.screenPoint(tq.x, tq.y);
          g.strokeStyle = '#ffd400';
          g.lineWidth = 2;
          halo(g, () => poly(g, [b, t]));
          label(g, `${r.dh.toFixed(1)} m`, t.x + 10, t.y);
        }
      }
    },
  });

  register('men.height.shadow', {
    cue: 'Height by Shadow: click the base, then the shadow tip. The guide line runs away from the sun; the predicted tip follows the height. Sun angles come from the metadata or the image time.',
    onDown(pane, e, sx, sy) {
      const s = this.state;
      if (!s.base) {
        const g = groundOf(app, pane, sx, sy);
        if (!g) return app.toast('Height needs an image with a sensor model', { kind: 'warn' }), true;
        const sun = sunOf(g.layer, g);
        if (!sun) return app.toast('Height by Shadow is disabled: this image has no sun angles and no acquisition time (AT-04.4)', { kind: 'warn' }), true;
        if (sun.elevation < 5) return app.toast(`Height by Shadow is disabled: the sun is ${sun.elevation.toFixed(1)}° above the horizon (below 5°)`, { kind: 'warn' }), true;
        s.base = g;
        s.sun = sun;
        pane.invalidate();
        return true;
      }
      const { base, sun } = s;
      const l = base.layer;
      const tp = pane.imagePoint(sx, sy);
      const tip = l.groundAt(tp.x, tp.y, base.h);
      this.state = {};
      if (!tip) return tools.done(), true;
      const inv = app.core.inverse(base.lat, base.lon, tip.lat, tip.lon);
      const shadowAz = (sun.azimuth + 180) % 360;
      const along = inv.distance * Math.cos(((inv.azi1 - shadowAz) * Math.PI) / 180);
      const tanE = Math.tan((sun.elevation * Math.PI) / 180);
      const hgt = along * tanE;
      const err = M.errorFor(l, base.x, base.y, base);
      const gsd = err?.gsd ?? NaN;
      const sigmaL = Math.SQRT2 * pick() * (Number.isFinite(gsd) ? gsd : 1);
      const sigmaH = sigmaL * tanE;
      M.logRow(
        M.baseRow('Height', l, base, {
          value: +hgt.toFixed(2),
          units: 'm',
          method: `Mono height by shadow on flat ground: h = L·tan(e); L ${along.toFixed(2)} m along azimuth ${shadowAz.toFixed(2)}°; sun az ${sun.azimuth.toFixed(2)}°, el ${sun.elevation.toFixed(2)}° (${sun.source ?? 'metadata'})`,
          coords: { base: app.core.mgrs(base.lat, base.lon, 5), tip: app.core.mgrs(tip.lat, tip.lon, 5), datum: 'WGS 84' },
          ce90: err?.modelErrorKnown ? err.ce90 : null,
          le90: sigmaH * LE,
          tag: 'relative (base to top)',
          errorNote: err?.modelErrorKnown ? '' : 'horizontal error not available (the sensor model states no error)',
          extra: { sun: { azimuth: sun.azimuth, elevation: sun.elevation, source: sun.source ?? 'metadata' }, shadowLength: along, lateral: inv.distance * Math.sin(((inv.azi1 - shadowAz) * Math.PI) / 180), sigmaHeight: sigmaH },
          geom: [[base.lon, base.lat, base.h], [tip.lon, tip.lat, base.h]],
        }),
        pane,
      );
      tools.done();
      return true;
    },
    onMove(pane, e, sx, sy) {
      this.state.hover = pane.imagePoint(sx, sy);
      if (this.state.base) pane.invalidate();
    },
    draw(pane, g, w, hh, s) {
      if (!s.base) return;
      const { base, sun } = s;
      const l = base.layer;
      const az = (sun.azimuth + 180) % 360;
      const guide = [];
      for (let d = 0; d <= 400; d += 20) {
        const t = app.core.direct(base.lat, base.lon, az, d);
        const q = screenOfGround(pane, t.lat, t.lon, base.h);
        if (q) guide.push(q);
      }
      g.strokeStyle = '#ffd400';
      g.lineWidth = 1;
      g.setLineDash([6, 4]);
      halo(g, () => poly(g, guide));
      g.setLineDash([]);
      if (s.hover) {
        const tip = l.groundAt(s.hover.x, s.hover.y, base.h);
        if (tip) {
          const inv = app.core.inverse(base.lat, base.lon, tip.lat, tip.lon);
          const along = Math.max(0, inv.distance * Math.cos(((inv.azi1 - az) * Math.PI) / 180));
          const hgt = along * Math.tan((sun.elevation * Math.PI) / 180);
          // Predicted tip for this height, on the guide (AT-04.3).
          const pt = app.core.direct(base.lat, base.lon, az, along);
          const q = screenOfGround(pane, pt.lat, pt.lon, base.h);
          if (q) {
            g.fillStyle = '#ffd400';
            g.beginPath();
            g.arc(q.x, q.y, 4, 0, Math.PI * 2);
            g.fill();
            label(g, `${hgt.toFixed(1)} m (sun el ${sun.elevation.toFixed(1)}°)`, q.x + 10, q.y - 6);
          }
        }
      }
    },
  });
  // ---- depth (REQ-MEN-09): a reference surface point, then a point below it ----
  register('men.depth', {
    cue: 'Depth: click a point on the reference surface (a rim, a water line), then the bottom. Both heights come from the terrain or DSM; the depth is the bottom minus the reference (negative below it).',
    onDown(pane, e, sx, sy) {
      const g = groundOf(app, pane, sx, sy);
      if (!g) return app.toast('Depth needs an image with a sensor model', { kind: 'warn' }), true;
      const s = this.state;
      if (!s.ref) {
        s.ref = g;
        pane.invalidate();
        return true;
      }
      const ref = s.ref;
      this.state = {};
      const l = g.layer;
      const ea = M.errorFor(l, ref.x, ref.y, ref);
      const eb = M.errorFor(l, g.x, g.y, g);
      const dz = g.h - ref.h;
      const le = [ea?.le90, eb?.le90].every(Number.isFinite) ? Math.hypot(ea.le90, eb.le90) : null;
      const inv = app.core.inverse(ref.lat, ref.lon, g.lat, g.lon);
      M.logRow(
        M.baseRow('Depth', l, g, {
          value: +dz.toFixed(2),
          units: 'm',
          method: `Depth below a reference point: h(bottom) − h(reference) = ${g.h.toFixed(2)} − ${ref.h.toFixed(2)} m HAE; ${inv.distance.toFixed(1)} m apart`,
          coords: { reference: app.core.mgrs(ref.lat, ref.lon, 5), bottom: app.core.mgrs(g.lat, g.lon, 5), datum: 'WGS 84' },
          ce90: null,
          le90: le,
          tag: dz <= 0 ? 'relative (below the reference)' : 'relative (above the reference)',
          errorNote: le == null ? 'vertical error not available (no terrain error)' : '',
          extra: { reference: { lat: ref.lat, lon: ref.lon, h: ref.h, source: ref.heightSource }, bottom: { lat: g.lat, lon: g.lon, h: g.h, source: g.heightSource } },
          geom: [[ref.lon, ref.lat, ref.h], [g.lon, g.lat, g.h]],
        }),
        pane,
      );
      tools.done();
      return true;
    },
    onMove(pane, e, sx, sy) {
      this.state.hover = { sx, sy };
      if (this.state.ref) pane.invalidate();
    },
    draw(pane, g, w, hh, s) {
      if (!s.ref) return;
      const a = screenOfGround(pane, s.ref.lat, s.ref.lon, s.ref.h);
      if (!a) return;
      g.strokeStyle = '#00e5ff';
      g.lineWidth = 2;
      if (s.hover) {
        halo(g, () => poly(g, [a, { x: s.hover.sx, y: s.hover.sy }]));
        const b = groundOf(app, pane, s.hover.sx, s.hover.sy);
        if (b) label(g, `${(b.h - s.ref.h).toFixed(1)} m`, s.hover.sx + 10, s.hover.sy);
      }
      g.fillStyle = '#00e5ff';
      g.beginPath();
      g.arc(a.x, a.y, 4, 0, Math.PI * 2);
      g.fill();
    },
  });
  C.implement('men.height', {
    run: () => tools.select(app.prefs.get('heightMethod') === 'shadow' ? 'men.height.shadow' : 'men.height.layover'),
    checked: () => /^men\.height\./.test(tools.current?.id ?? ''),
    enabled: geo,
    menu: () => [
      { label: 'Height by Layover', checked: app.prefs.get('heightMethod') !== 'shadow', run: () => (app.prefs.set('heightMethod', 'layover'), tools.select('men.height.layover')) },
      { label: 'Height by Shadow', checked: app.prefs.get('heightMethod') === 'shadow', run: () => (app.prefs.set('heightMethod', 'shadow'), tools.select('men.height.shadow')) },
    ],
  });

  // ---- targets with range rings and the Target Table ----
  const rings = () => app.prefs.get('rangeRings') ?? [500, 1000, 2000];
  register('men.target', {
    cue: 'Target: click the target. It is logged with its position and CE90 and drawn with range rings (Target Table ▸ ring radii).',
    onDown(pane, e, sx, sy) {
      const g = groundOf(app, pane, sx, sy);
      if (!g) return app.toast('Target needs an image with a sensor model', { kind: 'warn' }), true;
      const row = M.pointRow(g.layer, g, g, M.errorFor(g.layer, g.x, g.y, g));
      const n = app.store.all('measurement').filter((m) => m.mtype === 'Target').length + 1;
      M.logRow({ ...row, mtype: 'Target', object: `T${String(n).padStart(2, '0')}`, rings: rings() }, pane);
      tools.done();
      return true;
    },
  });
  // Range rings drawn with the other measurements.
  const drawPane = app.mensuration.drawPane;
  app.mensuration.drawPane = (pane, g) => {
    drawPane(pane, g);
    for (const m of app.store.all('measurement').filter((x) => x.pane === pane.id)) {
      if (m.mtype === 'Target' && m.rings?.length && m.coords) {
        const { lat, lon, hae } = m.coords;
        g.strokeStyle = '#ff4040';
        g.lineWidth = 1;
        for (const r of m.rings) {
          const pts = [];
          for (let a = 0; a <= 360; a += 6) {
            const t = app.core.direct(lat, lon, a, r);
            const q = screenOfGround(pane, t.lat, t.lon, hae ?? 0);
            if (q) pts.push(q);
          }
          halo(g, () => poly(g, pts, true));
          if (pts[0]) label(g, fmtLen(r), pts[0].x + 4, pts[0].y - 4);
        }
        const c = screenOfGround(pane, lat, lon, hae ?? 0);
        if (c) label(g, m.object, c.x + 8, c.y - 8);
      }
      if (m.mtype === 'Bracket' && m.geom?.length === 2 && m.bracket) {
        const a = screenOfGround(pane, m.geom[0][1], m.geom[0][0], m.geom[0][2]);
        const b = screenOfGround(pane, m.geom[1][1], m.geom[1][0], m.geom[1][2]);
        const d = pane.screenPoint(m.bracket.offset.x, m.bracket.offset.y);
        if (a && b) {
          g.strokeStyle = '#ffd400';
          g.lineWidth = 1.5;
          drawBracket(g, a, b, d, `${m.mid} ${fmtLen(m.value)}`);
        }
      }
    }
  };
  C.implement('men.targettable', {
    run: async () => {
      const body = h('div');
      const render = () => {
        clear(body);
        const ts = app.store.all('measurement').filter((m) => m.mtype === 'Target');
        const tb = h('tbody');
        for (const t of ts) {
          const go = h('button', { class: 'btn btn-small' }, 'Go');
          go.addEventListener('click', () => {
            try {
              app.activePane().centreOnGround(t.coords.lat, t.coords.lon, t.coords.hae);
            } catch (e) {
              app.toast(e.message, { kind: 'warn' });
            }
          });
          tb.appendChild(h('tr', { 'data-id': `measurement:${t.id}` }, [t.object, t.coords.mgrs, t.coords.lat.toFixed(7), t.coords.lon.toFixed(7), t.coords.hae?.toFixed(1) ?? 'N/A', t.ce90 != null ? t.ce90.toFixed(1) : 'N/A', (t.rings ?? []).join(', ')].map((x) => h('td', {}, String(x))), h('td', {}, go)));
        }
        const ringsInp = h('input', { class: 'inp', value: rings().join(', '), 'aria-label': 'Ring radii in metres' });
        ringsInp.addEventListener('change', () => {
          const v = ringsInp.value.split(/[ ,;]+/).map(Number).filter((x) => x > 0).slice(0, 8);
          app.prefs.set('rangeRings', v);
          app.store.transact('Range rings', (tx) => {
            for (const t of ts) tx.set(t.id, 'rings', v);
          });
          render();
        });
        const csv = h('button', { class: 'btn' }, 'Export CSV');
        csv.addEventListener('click', () => {
          const lines = ['target,mgrs,lat,lon,hae_m,ce90_m,rings_m,image,time', ...ts.map((t) => [t.object, t.coords.mgrs, t.coords.lat, t.coords.lon, t.coords.hae ?? '', t.ce90 ?? 'N/A', (t.rings ?? []).join(' '), t.image ?? '', t.time].join(','))];
          saveBlob(app, textBlob(lines.join('\n'), 'text/csv'), { name: 'targets.csv', types: ['.csv'], description: 'CSV' });
        });
        body.append(
          ts.length ? h('table', { class: 'grid-table', 'aria-label': 'Target Table' }, h('thead', {}, h('tr', {}, ['Target', 'MGRS', 'Latitude', 'Longitude', 'HAE (m)', 'CE90 (m)', 'Rings (m)', ''].map((x) => h('th', {}, x)))), tb) : h('p', {}, 'No targets. Draw ▸ Mensuration ▸ Target adds one.'),
          field('Range ring radii (m)', ringsInp),
          h('div', { class: 'btn-row' }, csv),
        );
      };
      render();
      await modal({ title: 'Target Table', body, buttons: ['Close'], width: 760, id: 'target-table' });
    },
  });

  // ---- profiles and line of sight ----
  /** Ground profile along a geodesic polyline: [{d, lat, lon, hae, msl}] sampled from the DEM. */
  function profile(pts, n = 256) {
    const segs = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const inv = app.core.inverse(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      segs.push({ a: pts[i - 1], azi: inv.azi1, len: inv.distance, from: total });
      total += inv.distance;
    }
    const out = [];
    for (let k = 0; k <= n; k++) {
      const d = (total * k) / n;
      const s = segs.find((x) => d <= x.from + x.len + 1e-9) ?? segs.at(-1);
      const t = app.core.direct(s.a.lat, s.a.lon, s.azi, d - s.from);
      const dem = app.terrain.sample(t.lat, t.lon);
      out.push({ d, lat: t.lat, lon: t.lon, hae: dem?.hae ?? NaN, msl: dem?.msl ?? NaN, src: dem?.name ?? null });
    }
    return { pts: out, total };
  }

  /**
   * Line of sight from A (observer height hA above ground) to B (target height hB): the
   * sight line in a frame where the terrain drops by d²(1 − k)/2R (curvature, refraction k).
   */
  function lineOfSight(prof, hA, hB, k = 0.13) {
    const p = prof.pts;
    const D = prof.total;
    const za = p[0].hae + hA;
    const zb = p.at(-1).hae + hB;
    let worst = Infinity;
    let blocked = null;
    for (let i = 1; i < p.length - 1; i++) {
      if (!Number.isFinite(p[i].hae)) continue;
      const d = p[i].d;
      // Earth bulge between the ends, relative to the chord.
      const bulge = app.core.curvatureDrop(d, k) + app.core.curvatureDrop(D - d, k) - app.core.curvatureDrop(D, k);
      const sight = za + ((zb - za) * d) / D;
      const clearance = sight - (p[i].hae - bulge);
      if (clearance < worst) worst = clearance;
      if (clearance < 0 && !blocked) blocked = { ...p[i], clearance };
    }
    return { visible: !blocked, blocked, minClearance: worst, za, zb };
  }
  app.measureLos = { profile, lineOfSight };

  function chart(prof, { los = null, onHover } = {}) {
    const W = 640;
    const H = 220;
    const cv = h('canvas', { width: String(W), height: String(H), class: 'profile-canvas', 'aria-label': 'Elevation profile: move the pointer along it to show the point in the image' });
    const v = prof.pts.filter((q) => Number.isFinite(q.hae));
    const lo = Math.min(...v.map((q) => q.hae), los ? Math.min(los.za, los.zb) : Infinity);
    const hi = Math.max(...v.map((q) => q.hae), los ? Math.max(los.za, los.zb) : -Infinity);
    const pad = (hi - lo) * 0.1 + 1;
    const X = (d) => 40 + (d / (prof.total || 1)) * (W - 50);
    const Y = (z) => H - 20 - ((z - (lo - pad)) / (hi - lo + 2 * pad)) * (H - 30);
    const draw = (cursor) => {
      const g = cv.getContext('2d');
      const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
      g.fillStyle = css('--c-content-bg') || '#fff';
      g.fillRect(0, 0, W, H);
      g.fillStyle = css('--c-content-text') || '#000';
      g.font = '11px Arial, sans-serif';
      g.fillText(`${(hi + pad).toFixed(0)} m HAE`, 2, 12);
      g.fillText(`${(lo - pad).toFixed(0)}`, 2, H - 22);
      g.fillText(fmtLen(prof.total), W - 70, H - 4);
      g.fillStyle = 'rgba(120, 90, 40, 0.5)';
      g.beginPath();
      g.moveTo(X(0), H - 20);
      for (const q of v) g.lineTo(X(q.d), Y(q.hae));
      g.lineTo(X(prof.total), H - 20);
      g.closePath();
      g.fill();
      if (los) {
        g.strokeStyle = los.visible ? '#00a000' : '#d00000';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(X(0), Y(los.za));
        g.lineTo(X(prof.total), Y(los.zb));
        g.stroke();
        if (los.blocked) {
          g.fillStyle = '#d00000';
          g.beginPath();
          g.arc(X(los.blocked.d), Y(los.blocked.hae), 4, 0, Math.PI * 2);
          g.fill();
        }
      }
      if (cursor) {
        g.strokeStyle = '#1e88e5';
        g.beginPath();
        g.moveTo(X(cursor.d), 0);
        g.lineTo(X(cursor.d), H - 20);
        g.stroke();
        g.fillStyle = css('--c-content-text') || '#000';
        g.fillText(`${fmtLen(cursor.d)} · ${Number.isFinite(cursor.hae) ? `${cursor.hae.toFixed(1)} m HAE` : 'no DEM'}`, Math.min(W - 160, X(cursor.d) + 4), 24);
      }
    };
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      const d = Math.max(0, Math.min(prof.total, (((e.clientX - r.left) / r.width) * W - 40) / (W - 50) * prof.total));
      const q = prof.pts.reduce((a, b) => (Math.abs(b.d - d) < Math.abs(a.d - d) ? b : a));
      draw(q);
      onHover?.(q);
    });
    cv.addEventListener('pointerleave', () => {
      draw(null);
      onHover?.(null);
    });
    draw(null);
    return cv;
  }

  // Linked cursor marker for profiles (REQ-DEM-12).
  let profileCursor = null;
  const prevDraw = app.mensuration.drawPane;
  app.mensuration.drawPane = (pane, g) => {
    prevDraw(pane, g);
    if (!profileCursor) return;
    const s = screenOfGround(pane, profileCursor.lat, profileCursor.lon, Number.isFinite(profileCursor.hae) ? profileCursor.hae : pane.geoLayer()?.defaultHeight() ?? 0);
    if (!s) return;
    g.strokeStyle = '#1e88e5';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(s.x, s.y, 6, 0, Math.PI * 2);
    g.stroke();
  };
  const hover = (q) => {
    profileCursor = q;
    app.activePane()?.invalidate();
  };

  const needDem = () => {
    if (app.terrain.available) return true;
    app.toast('This needs a DEM (File ▸ Open DEM: DTED, SRTM or a DEM GeoTIFF)', { kind: 'warn' });
    return false;
  };

  app.measureApi.multi(
    'profile.elevation',
    'Profile',
    2,
    Infinity,
    (pts, live) => {
      if (live) return { value: 0, units: 'm', text: 'double-click to finish' };
      const prof = profile(pts);
      const v = prof.pts.filter((q) => Number.isFinite(q.hae));
      const rise = v.length ? Math.max(...v.map((q) => q.hae)) - Math.min(...v.map((q) => q.hae)) : NaN;
      setTimeout(() => modal({ title: 'Elevation Profile', body: h('div', {}, chart(prof, { onHover: hover }), h('p', { class: 'hint' }, `${fmtLen(prof.total)} along the geodesic; heights HAE from ${v[0]?.src ?? 'no DEM'}; relief ${Number.isFinite(rise) ? rise.toFixed(1) : 'N/A'} m.`)), buttons: ['Close'], width: 700, modeless: true, id: 'elevation-profile' }).then(() => hover(null)), 0);
      return { value: +prof.total.toFixed(2), units: 'm', text: fmtLen(prof.total), extra: { relief: rise, samples: prof.pts.length, dem: v[0]?.src ?? null } };
    },
    'Elevation Profile: click vertices along the line; double-click to finish. The profile window shows the DEM heights; its cursor is linked to the image.',
  );
  C.implement('profile.elevation', { run: () => needDem() && tools.select('profile.elevation'), checked: () => tools.current?.id === 'profile.elevation', enabled: geo });

  register('los.p2p', {
    cue: 'Point-to-Point LOS: click the observer, then the target. Heights above ground and the refraction coefficient come from Target Table ▸ LOS settings (defaults 1.8 m, 0 m, k = 0.13).',
    onDown(pane, e, sx, sy) {
      const g = groundOf(app, pane, sx, sy);
      if (!g) return app.toast('LOS needs an image with a sensor model', { kind: 'warn' }), true;
      const s = this.state;
      if (!s.a) {
        if (!needDem()) return true;
        s.a = g;
        pane.invalidate();
        return true;
      }
      const a = s.a;
      this.state = {};
      const cfg = { hA: 1.8, hB: 0, k: 0.13, ...(app.prefs.get('los') ?? {}) };
      const prof = profile([a, g]);
      if (!Number.isFinite(prof.pts[0].hae) || !Number.isFinite(prof.pts.at(-1).hae)) {
        app.toast('Both ends must lie on the DEM', { kind: 'warn' });
        tools.done();
        return true;
      }
      const r = lineOfSight(prof, cfg.hA, cfg.hB, cfg.k);
      M.logRow(
        M.baseRow('LOS', a.layer, a, {
          value: r.visible ? 'visible' : 'blocked',
          units: '',
          method: `Point-to-point LOS on ${prof.pts[0].src}; observer +${cfg.hA} m, target +${cfg.hB} m; curvature and refraction k = ${cfg.k}`,
          coords: { from: app.core.mgrs(a.lat, a.lon, 5), to: app.core.mgrs(g.lat, g.lon, 5), datum: 'WGS 84', blockedAt: r.blocked ? app.core.mgrs(r.blocked.lat, r.blocked.lon, 5) : null },
          extra: { distance: prof.total, minClearance: r.minClearance, blockedAtDistance: r.blocked?.d ?? null },
          ce90: null,
          le90: null,
          tag: 'absolute',
          errorNote: 'visibility result; no positional error applies',
          geom: [[a.lon, a.lat, a.h], [g.lon, g.lat, g.h]],
        }),
        pane,
      );
      modal({ title: `Line of Sight — ${r.visible ? 'visible' : 'blocked'}`, body: h('div', {}, chart(prof, { los: r, onHover: hover }), h('p', { class: 'hint' }, r.visible ? `Visible. Smallest clearance ${r.minClearance.toFixed(1)} m over ${fmtLen(prof.total)}.` : `Blocked ${fmtLen(r.blocked.d)} from the observer (${r.blocked.clearance.toFixed(1)} m below the sight line).`)), buttons: ['Close'], width: 700, modeless: true, id: 'los' }).then(() => hover(null));
      tools.done();
      return true;
    },
    draw(pane, g, w, hh, s) {
      if (!s.a) return;
      const a = screenOfGround(pane, s.a.lat, s.a.lon, s.a.h);
      if (!a) return;
      g.fillStyle = '#00e5ff';
      g.beginPath();
      g.arc(a.x, a.y, 5, 0, Math.PI * 2);
      g.fill();
    },
  });
}
