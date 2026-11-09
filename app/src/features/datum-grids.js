// Datum grids and time-dependent frames in the UI (REQ-GAP-16, SDP-2.3 GR-05): the grid packs
// (grids-na, grids-eu, grids-oceania, geoid-egm2008-25), the grid route for CRSs in geo/crs.js,
// the PROJ pack's view of the same grids, EGM2008 2.5′ as the active geoid, and the
// Georeference ▸ Datum Transform dialog, which says which operations and grids it used and
// their accuracy. Grid packs are kept in OPFS on the hosted copy (storage/packs.js). The dialog
// (features/datum-dialog.js) is the lazy js-geod block; everything else here is needed as soon as
// a grid pack loads, so it stays eager.

import { GridEngine, ROUTES, VERTICALS, WGS84_NOW, parsePoints } from '../geo/grids.js';
import { setGridEngine, crsOf, converter } from '../geo/crs.js';
import { gwError } from '../i18n/index.js';
import { loadBlock, once, lazyCommands } from './lazy-host.js';

export const name = 'datum-grids';

export const GRID_PACKS = ['grids-na', 'grids-eu', 'grids-oceania', 'geoid-egm2008-25'];
const EGM08 = 'us_nga_egm08_25';

/** Horizontal systems a vertical datum is defined on (the dialog checks the pairing). */
const HEIGHT_FRAMES = {
  navd88: ['NAD83(2011)', 'grid:NAD83(2011)'],
  odn: ['ETRF2014', 'ETRF2020', 'grid:ETRS89'],
  ahd: ['GDA2020', 'grid:GDA2020'],
  cgvd2013: ['NAD83(CSRS)v7'],
  egm2008: ['WGS 84 (G2296)', 'WGS 84 (G2139)', 'WGS 84 (G1762)', 'WGS 84 (G1674)', 'WGS 84 (G1150)', 'WGS 84 (G873)', 'WGS 84 (G730)'],
};

export async function install(app) {
  const grids = new GridEngine(app);
  app.grids = grids;
  setGridEngine(grids);
  // Developer and test access to the CRS resolution the importers use (undocumented, like the rest of globalThis.gisworkbench).
  app.crs = { crsOf, converter };

  // ---- grid packs ----
  const packs = app.packs;
  if (packs) {
    // Hosted copy: grid packs (up to 131 MB) live in the origin-private file system.
    packs.opfsFor = (rec) => GRID_PACKS.includes(rec.name);
    packs.on((nm) => {
      const p = packs.loaded.get(nm);
      if (!p && grids.packs.has(nm)) {
        // Forgotten: release its grids; the EGM2008 grid geoid gives way to EGM96.
        grids.dropPack(nm);
        if (nm === 'geoid-egm2008-25' && gridGeoid) app.useEgm96?.();
        return;
      }
      if (!p || !GRID_PACKS.includes(nm) || grids.packs.get(nm) === p) return;
      grids
        .addPack(p)
        .then(() => {
          if (nm === 'geoid-egm2008-25') useEgm2008();
          mountForProj(p).catch(() => {});
          app.emit('state');
        })
        .catch((e) => app.log('warn', `grid pack ${nm}: ${e.message}`));
    });
    packs.restore().then((kept) => {
      for (const k of kept) if (GRID_PACKS.includes(k.name)) packs.get(k.name, { prompt: false }).catch(() => {});
    });
  }

  // ---- EGM2008 2.5′ as the active geoid (app.core.undulation is the one entry the app uses) ----
  const core = app.core;
  const coreUndulation = core.undulation.bind(core);
  const coreLoad = core.loadGeoid.bind(core);
  let gridGeoid = false;
  core.undulation = (lat, lon) => (gridGeoid ? grids.undulation(EGM08, lon, lat) : coreUndulation(lat, lon));
  core.loadGeoid = (...a) => {
    gridGeoid = false;
    return coreLoad(...a);
  };
  function useEgm2008() {
    if (!grids.has(EGM08)) return false;
    grids.handle(EGM08);
    gridGeoid = true;
    core.geoidName = 'EGM2008 2.5′';
    app._geoid = Promise.resolve(core.geoidName);
    app._geoidLoaded = true;
    for (const mp of app.desktop?.multiports ?? []) mp.status?.set({ vdatum: `MSL(${core.geoidName})` });
    app.emit('geoid');
    return true;
  }
  const egm96 = app.useEgm96;
  if (egm96) {
    app.useEgm96 = async () => {
      gridGeoid = false;
      return egm96();
    };
  }
  app.useEgm2008Grid = useEgm2008;

  // ---- PROJ pack: the grids are offered to PROJ as well (REQ-GAP-16 with REQ-GEO-12) ----
  async function mountForProj(pack) {
    if (!app.proj?.mod) return;
    const list = [...grids.catalogue.values()].filter((g) => g.pack === pack.name && g.file !== `${EGM08}.tif`).map((g) => ({ file: g.file, bytes: pack.entries.get(g.file) }));
    await app.proj.mountGrids(list);
  }
  if (app.proj) {
    const ensure = app.proj.ensure.bind(app.proj);
    app.proj.ensure = async () => {
      const first = !app.proj.mod;
      const M = await ensure();
      if (first) for (const p of grids.packs.values()) await mountForProj(p).catch(() => {});
      return M;
    };
  }

  // ---- transformations for the dialog, the API and tests ----
  /**
   * Transform points between systems. src/tgt: a frame name ("ITRF2014", "WGS 84 (G2296)", …)
   * or "grid:<datum>" (NAD27, NAD83, NAD83(HARN), OSGB36, DHDN, GDA94, ETRS89, NAD83(2011),
   * GDA2020). Heights: 'hae' or a VERTICALS key. pts: [lon, lat, h]. Returns {pts, steps,
   * accuracy, epoch, outside}.
   */
  async function transform({ src, tgt, srcHeight = 'hae', tgtHeight = 'hae', epoch = grids.epoch, pts }) {
    await grids.ensure();
    const steps = [];
    let acc = 0;
    let cur = pts.map((p) => [...p]);
    const bad = new Set();
    const vstep = (key, sign, sys) => {
      const v = VERTICALS[key];
      if (!HEIGHT_FRAMES[key].includes(sys)) throw gwError('{height} heights are defined on {frame}: choose it as the system on that side', { height: v.name, frame: HEIGHT_FRAMES[key][0] }, 'E_DATUM_HEIGHT_FRAME');
      if (!grids.has(v.grid)) throw gwError('{height} heights need the {grid} grid: open its data pack first', { height: v.name, grid: v.grid }, 'E_STEP_FIRST');
      const g = grids.catalogue.get(v.grid);
      const n = grids.undulations(v.grid, cur);
      cur = cur.map((p, i) => {
        if (!Number.isFinite(n[i])) bad.add(i);
        return [p[0], p[1], p[2] + sign * (n[i] ?? NaN)];
      });
      steps.push({
        kind: 'grid',
        grid: g.file,
        op: 'vgridshift',
        epsg: g.epsg,
        name: g.name,
        accuracy: g.accuracy,
        interpolation: g.interpolation ?? 'bilinear',
        inverse: sign < 0,
      });
      acc += g.accuracy;
    };
    const horizontal = (from, to) => {
      const keyF = from.startsWith('grid:') ? from.slice(5) : null;
      const keyT = to.startsWith('grid:') ? to.slice(5) : null;
      if (!keyF && !keyT) {
        const r = grids.bundle.frameTransform(from, to, cur, epoch);
        cur = r.pts;
        for (const s of r.path.steps) steps.push({ kind: 'frame', ...s });
        acc += r.path.accuracy;
        return;
      }
      const run = (key, inverse) => {
        if (!grids.chainsOf(key).length) throw gwError('{datum} needs a grid pack: open its data pack first', { datum: key }, 'E_STEP_FIRST');
        const r = grids.transformDatum(key, cur, { inverse, epoch });
        const used = new Set(r.used.filter((u) => u >= 0));
        r.used.forEach((u, i) => u < 0 && bad.add(i));
        cur = r.pts.map((p, i) => (Number.isFinite(p[0]) ? p : cur[i]));
        // Report the route most points took (others are listed as alternatives in the note).
        const ci = [...used][0] ?? 0;
        const d = r.routes[ci];
        if (d) {
          for (const s of inverse ? [...d.steps].reverse() : d.steps)
            steps.push({
              ...s,
              inverse: inverse ? !s.inverse : !!s.inverse,
              routeOf: key,
            });
          acc += d.accuracy;
        }
      };
      if (keyF) run(keyF, false);
      else {
        const r = grids.bundle.frameTransform(from, WGS84_NOW, cur, epoch);
        cur = r.pts;
        for (const s of r.path.steps) steps.push({ kind: 'frame', ...s });
        acc += r.path.accuracy;
      }
      if (keyT) run(keyT, true);
      else {
        const r = grids.bundle.frameTransform(WGS84_NOW, to, cur, epoch);
        cur = r.pts;
        for (const s of r.path.steps) steps.push({ kind: 'frame', ...s });
        acc += r.path.accuracy;
      }
    };
    if (srcHeight !== 'hae') vstep(srcHeight, +1, src);
    if (src !== tgt) horizontal(src, tgt);
    if (tgtHeight !== 'hae') vstep(tgtHeight, -1, tgt);
    const out = cur.map((p, i) => (bad.has(i) ? [NaN, NaN, NaN] : p));
    const timeDependent = steps.some((s) => s.timeDependent);
    return {
      pts: out,
      steps,
      accuracy: acc,
      epoch: timeDependent ? epoch : null,
      outside: bad.size,
    };
  }
  app.datumTransform = transform;

  // ---- Georeference ▸ Datum Transform: the dialog is the lazy js-geod block (features/datum-dialog.js) ----
  lazyCommands(app, ['geo.transform'], once(async () => (await loadBlock(app, 'js-geod')).installDatumDialog(app, { grids, transform, ROUTES, VERTICALS, WGS84_NOW, parsePoints })));

  /** Datum Info: which grids are loaded (appended to the existing dialog's text via the API). */
  app.gridSummary = () => ({
    epoch: grids.epoch,
    grids: [...grids.catalogue.values()].map((g) => ({
      id: g.id,
      file: g.file,
      op: g.op,
      epsg: g.epsg,
      name: g.name,
      accuracy: g.accuracy,
      pack: g.pack,
    })),
    geoid: core.geoidName,
  });
}
