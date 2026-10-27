// Continuous cursor read-out (REQ-UI-07, REQ-MEN-05, REQ-PRF-04): image → ground through the
// Rust core synchronously on the main thread, MGRS, HAE and MSL with the geoid named, CE/LE
// from the model's error and the terrain, the math model and the terrain cell (green/red).

import { isThreeParameter } from '../geo/crs.js';
import { fmtNum } from '../shell/dom.js';

export const name = 'readout';

export function install(app) {
  let pending = null;
  app.cursorGround = null;
  app.cursorMoved = (pane, x, y) => {
    pending = { pane, x, y };
    if (!app._readoutRaf) app._readoutRaf = requestAnimationFrame(update);
    app.emit('cursor', pending);
  };

  // The status bar names the active model as soon as it changes, not only on the next move (REQ-SNS-06).
  app.on('state', () => {
    for (const mp of app.desktop?.multiports ?? []) {
      const l = mp.activePane?.geoLayer?.();
      if (l) mp.status.set({ model: `Math Model: ${l.modelName}` });
    }
  });

  function update() {
    app._readoutRaf = 0;
    const { pane, x, y } = pending ?? {};
    const mp = pane?.mp;
    if (!mp) return;
    const st = mp.status;
    const l = pane.geoLayer();
    if (!Number.isFinite(x) || !l) {
      st.set({ cursor: '', ground: '', ce: 'CE: –', le: 'LE: –', dn: '' });
      app.cursorGround = null;
      for (const p of mp.panes) if (p !== pane) p.invalidate();
      return;
    }
    const inside = x >= 0 && y >= 0 && x < l.width && y < l.height;
    const t0 = performance.now();
    st.set({ model: `Math Model: ${l.modelName}` });
    if (!l.modelId) {
      st.set({ cursor: `Pixel x ${x.toFixed(1)}  y ${y.toFixed(1)}`, ground: 'no sensor model', ce: 'CE: error not available', le: 'LE: error not available', terrain: ['Terrain Not Available', 'bad'] });
      return;
    }
    const g = l.groundWithTerrain(x, y);
    if (!g) {
      st.set({ cursor: 'outside the model', ground: '' });
      return;
    }
    const fmt = app.prefs.get('coordFormat') ?? 1; // 0 DD, 1 DMS
    // DMS with decimal degrees beside it (AC-01.3), always labelled with the datum.
    const ll = `${app.core.format(g.lat, g.lon, fmt, fmt === 0 ? 6 : 2)}${fmt === 0 ? '' : ` (${app.core.format(g.lat, g.lon, 0, 6)})`} WGS 84`;
    let mgrs = '';
    try {
      mgrs = app.core.mgrs(g.lat, g.lon, 5);
    } catch {}
    const N = app.core.undulation(g.lat, g.lon);
    const msl = Number.isFinite(N) ? g.h - N : NaN;
    const elev = `${fmtNum(g.h, 1)} m HAE${Number.isFinite(msl) ? ` · ${fmtNum(msl, 1)} m MSL (${app.core.geoidName ?? 'EGM96'})` : ''}`;
    // Error: exact CE90 from the propagated covariance; "error not available" when the model has none.
    let ce = 'CE: error not available';
    let le = 'LE: error not available';
    try {
      const e = app.core.pointError(l.modelId, x, y, g.h, 0.5, g.sigmaV);
      // A datum reached through a mean three-parameter shift adds its σ (REQ-GEO-09).
      const dn = l.models?.find((m) => m.id === l.modelId)?.datum;
      const shift = isThreeParameter(dn) ? dn.acc : 0;
      if (Number.isFinite(e.ce90)) ce = shift ? `CE90: ${fmtNum(Math.hypot(e.ce90, 2.146 * shift), 1)} m (incl. ${dn.name} shift σ ${shift} m)` : `CE90: ${fmtNum(e.ce90, 1)} m`;
      else if (shift) ce = `CE90 ≥ ${fmtNum(2.146 * shift, 1)} m (${dn.name} shift σ ${shift} m; the model gives no error)`;
      app.cursorError = { ce90: Number.isFinite(e.ce90) ? Math.hypot(e.ce90, 2.146 * shift) : shift ? 2.146 * shift : NaN, modelCe90: e.ce90, datumShift: shift ? { name: dn.name, sigma: shift } : null };
      if (Number.isFinite(e.le90)) le = `LE90: ${fmtNum(e.le90, 1)} m`;
      st.set({ gsd: Number.isFinite(e.gsd) ? `GSD ${fmtNum(e.gsd, 2)} m` : '' });
    } catch {}
    st.set({
      cursor: `${ll}${inside ? '' : ' (outside image)'}`,
      ground: `MGRS ${mgrs} · ${elev}`,
      ce,
      le,
      terrain: app.terrain.covering(g.lat, g.lon) ? [`Terrain: ${app.terrain.covering(g.lat, g.lon).name}`, 'ok'] : ['Terrain Not Available', 'bad'],
      vdatum: `MSL(${app.core.geoidName ?? 'EGM96'})`,
    });
    pane.readout.textContent = `${ll}, MGRS ${mgrs}`;
    app.cursorGround = { pane, lat: g.lat, lon: g.lon, h: g.h };
    app.readoutMs = performance.now() - t0;
    for (const m of app.desktop.multiports) for (const p of m.panes) if (p !== pane && app.links.groups.has(p.id)) p.invalidate();
  }
}
