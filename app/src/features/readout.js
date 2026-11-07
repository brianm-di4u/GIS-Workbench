// Continuous cursor read-out (REQ-UI-07, REQ-MEN-05, REQ-PRF-04): image → ground through the
// Rust core synchronously on the main thread, MGRS, HAE and MSL with the geoid named, CE/LE
// from the model's error and the terrain, the math model and the terrain cell (green/red).
// Coordinates come from the core in their standard notation in every locale (DN-62 rule 7);
// only the labels around them are translated, and heights and errors follow Preferences ▸ Units.

import { isThreeParameter } from '../geo/crs.js';
import { t } from '../i18n/index.js';
import { num, length, height } from '../i18n/format.js';
import { modelLabel } from '../formats/model-names.js';

export const name = 'readout';

export function install(app) {
  let pending = null;
  app.cursorGround = null;
  app.cursorMoved = (pane, x, y) => {
    pending = { pane, x, y };
    if (!app._readoutRaf) app._readoutRaf = requestAnimationFrame(update);
    app.emit('cursor', pending);
  };
  const modelText = (l) => t('Math Model: {model}', { model: l?.modelName ? modelLabel(l.modelName) : t('none') }); // 'none' once the last image goes (GUI-021)
  const sigmaText = (m) => length(m, Number.isInteger(m) ? 0 : 1);

  // The status bar names the active model as soon as it changes, not only on the next move (REQ-SNS-06).
  app.on('state', () => {
    for (const mp of app.desktop?.multiports ?? []) {
      const l = mp.activePane?.geoLayer?.();
      mp.status.set({ model: modelText(l) });
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
      st.set({ cursor: '', ground: '', ce: t('CE: –'), le: t('LE: –'), dn: '' });
      app.cursorGround = null;
      for (const p of mp.panes) if (p !== pane) p.invalidate();
      return;
    }
    const inside = x >= 0 && y >= 0 && x < l.width && y < l.height;
    const t0 = performance.now();
    st.set({ model: modelText(l) });
    if (!l.modelId) {
      st.set({ cursor: t('Pixel x {x}  y {y}', { x: num(x, 1), y: num(y, 1) }), ground: t('no sensor model'), ce: t('CE: error not available'), le: t('LE: error not available'), terrain: [t('Terrain Not Available'), 'bad'] });
      return;
    }
    const g = l.groundWithTerrain(x, y);
    if (!g) {
      st.set({ cursor: t('outside the model'), ground: '' });
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
    // HAE and MSL are datum names; the geoid name comes from the core.
    const elev = `${height(g.h, 1)} HAE${Number.isFinite(msl) ? ` · ${height(msl, 1)} MSL (${app.core.geoidName ?? 'EGM96'})` : ''}`;
    // Error: exact CE90 from the propagated covariance; "error not available" when the model has none.
    let ce = t('CE: error not available');
    let le = t('LE: error not available');
    try {
      const e = app.core.pointError(l.modelId, x, y, g.h, 0.5, g.sigmaV);
      // A datum reached through a mean three-parameter shift adds its σ (REQ-GEO-09).
      const dn = l.models?.find((m) => m.id === l.modelId)?.datum;
      const shift = isThreeParameter(dn) ? dn.acc : 0;
      if (Number.isFinite(e.ce90)) ce = shift ? t('CE90: {ce} (incl. {datum} shift σ {sigma})', { ce: length(Math.hypot(e.ce90, 2.146 * shift), 1), datum: dn.name, sigma: sigmaText(shift) }) : t('CE90: {ce}', { ce: length(e.ce90, 1) });
      else if (shift) ce = t('CE90 ≥ {ce} ({datum} shift σ {sigma}; the model gives no error)', { ce: length(2.146 * shift, 1), datum: dn.name, sigma: sigmaText(shift) });
      app.cursorError = { ce90: Number.isFinite(e.ce90) ? Math.hypot(e.ce90, 2.146 * shift) : shift ? 2.146 * shift : NaN, modelCe90: e.ce90, datumShift: shift ? { name: dn.name, sigma: shift } : null };
      if (Number.isFinite(e.le90)) le = t('LE90: {le}', { le: height(e.le90, 1) });
      st.set({ gsd: Number.isFinite(e.gsd) ? t('GSD {gsd}', { gsd: length(e.gsd, 2) }) : '' });
    } catch {}
    const cover = app.terrain.covering(g.lat, g.lon);
    st.set({
      cursor: inside ? ll : t('{coords} (outside image)', { coords: ll }),
      ground: `MGRS ${mgrs} · ${elev}`,
      ce,
      le,
      terrain: cover ? [t('Terrain: {name}', { name: cover.name }), 'ok'] : [t('Terrain Not Available'), 'bad'],
      vdatum: `MSL(${app.core.geoidName ?? 'EGM96'})`,
    });
    pane.readout.textContent = `${ll}, MGRS ${mgrs}`;
    app.cursorGround = { pane, lat: g.lat, lon: g.lon, h: g.h };
    app.readoutMs = performance.now() - t0;
    for (const m of app.desktop.multiports) for (const p of m.panes) if (p !== pane && app.links.groups.has(p.id)) p.invalidate();
  }
}
