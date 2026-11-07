// 2.5 aviation (SDP-2.3 GR-27; REQ-GAP-73 obstruction surfaces, REQ-GAP-74 flight planning): the
// commands and app.aviation / app.flightPlan, whose implementation is the lazy js-aviation block
// (lazy/aviation.lazy.js: features/aviation-obstruction.js, features/flight-plan.js), and the
// `aviation` WASM bundle for the analysis workers. Here, eager: the waypoint names and leg labels
// of flight-plan routes on the panels.

import { loadBlock, once, lazyCommands, lazyMethods } from './lazy-host.js';
import { pointText } from '../i18n/fonts.js';

export const name = 'aviation';

export function install(app) {
  // The workers ask the pool for the bundle by name on first use.
  if (app.pool?.lazyModules && !app.pool.lazyModules.aviation) app.pool.lazyModules.aviation = () => app.gw.wasm('wasm-aviation');
  const load = once(async () => {
    const lib = await loadBlock(app, 'js-aviation');
    lib.install(app);
    return lib;
  });
  // The block draws chart text with the app's own font helper rather than a second copy of it.
  app.aviation = { last: null, pointText };
  lazyMethods(app.aviation, ['airports', 'addAirport', 'addRunway', 'importNasr', 'surfaces', 'evaluate', 'exportResult', 'blobOf', 'showResult'], load, () => app.aviation);
  app.flightPlan = {};
  lazyMethods(app.flightPlan, ['routes', 'planOf', 'setPlan', 'create', 'compute', 'exportText', 'exportPlan', 'readRoutes', 'importRoutes', 'show'], load, () => app.flightPlan);
  const geo = () => !!app.activePane()?.geoLayer?.()?.modelId;
  lazyCommands(app, ['los.airports', 'los.obstruction', 'gps.flightplan'], load, {
    'los.obstruction': { enabled: () => app.store.all('airport').length > 0 },
    'gps.flightplan': { enabled: geo },
  });

  // Waypoint dots and names, and each leg's altitude (ft) and speed (kt), on flight-plan routes.
  const prev = app.graphics?.drawPane;
  if (!prev) return;
  app.graphics.drawPane = (p, g, w, hh) => {
    prev(p, g, w, hh);
    const recs = app.store.all('graphic').filter((r) => r.flight && r.pane === p.id);
    if (!recs.length) return;
    const glr = p.rec?.graphicsLayer ? app.store.get(p.rec.graphicsLayer) : null;
    if (glr?.visible === false) return;
    const { w: pw, h: ph } = p.size();
    for (const r of recs) {
      const pts = app.graphics.screenPoints(p, r, pw, ph);
      if (!pts || pts.some((q) => !q)) continue;
      g.save();
      pointText(g, 11, 'label');
      g.lineWidth = 3;
      g.strokeStyle = '#000000';
      g.fillStyle = '#ff66ff';
      pts.forEach((q, i) => {
        g.beginPath();
        g.arc(q.x, q.y, 4, 0, Math.PI * 2);
        g.fill();
        const nm = r.flight.names?.[i] ?? `WP${i + 1}`;
        g.strokeText(nm, q.x + 6, q.y - 6);
        g.fillText(nm, q.x + 6, q.y - 6);
        const L = r.flight.legs?.[i];
        if (L && pts[i + 1]) {
          const s = `${Math.round(L.alt / 0.3048)} ft · ${Math.round(L.speed / (1852 / 3600))} kt`; // i18n-ignore: aviation unit symbols
          const mx = (q.x + pts[i + 1].x) / 2;
          const my = (q.y + pts[i + 1].y) / 2;
          g.strokeText(s, mx + 4, my + 12);
          g.fillText(s, mx + 4, my + 12);
        }
      });
      g.restore();
    }
  };
}
