// Phase 2 functional coverage: one test per catalogued command of a spec, run on real corpus data
// that satisfies the command's ribbon context (reports/campaign/matrix.json). Each run must leave no
// console/page/CSP error and no unrequested network request; placeholders must say "planned".
// Area specs add oracle-checked tests next to this generic sweep.

import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openApp, openFiles, settledAny, runCommand, record, item, paths, onDisk, matrix } from './helpers.js';

// Recipes: the files and in-page setup that satisfy a command's enable condition (Phase 2 run 2:
// with data alone, 213 commands stayed disabled — navigation and drawing need an image, stereo a
// model, terrain tools a DEM in use, 3D a scene, edits a selected feature). Real corpus data where
// it exists; synthetic fixtures only where no public sample does (MIE4NITF, STANAG 4607, the
// co-registered SICD pair and the dated change pair).
const R = (id, file) => () => {
  const it = item(id);
  return paths(it, ['primary', 'sidecar']).filter((p) => !file || p.endsWith(file) || p.replace(/\.[^.]+$/, '').endsWith(file.replace(/\.[^.]+$/, '')));
};
const FX = (...rel) => () => rel.map((r) => resolve('fixtures', r));
const WV3A = R('rs-nitf-wv3-mvs-stereo-chips', 'wv3_a_chip.ntf');
const WV3B = R('rs-nitf-wv3-mvs-stereo-chips', 'wv3_b_chip.ntf');
const DEM = R('rs-dem-derived-s35w059', 'S35W059_crop1201_float32_cog.tif');
const DEM2 = R('rs-dem-derived-s35w059', 's35_w059_from_srtm.dt1');
const FX12 = R('rs-vector-fx12-synthetic', 'fx12.geojson');
const PINES = R('rs-envi-hsi-indian-pines');
const AUTZEN = R('rs-lidar-las-laz-copc', 'autzen_trim.laz');
// Final-run additions (Phase 8): every command whose context needs more than data — a second
// panel, a selection, a classification, a DTM, an earlier product — gets that state, built with
// the app's own commands (`pre`, run and confirmed like the command under test) or its API.
const RECIPES = [
  [/^msi\.(index|preset)\./, { files: PINES }],
  [/^msi\.(threshold|majority|sieve|fill|vectors|accuracy)$/, { files: PINES, setup: ['classify'] }],
  // Two 220-band AVIRIS Indian Pines cubes (ENVI and GeoTIFF deliveries of one scene).
  [/^msi\.change$/, { files: () => [...PINES(), ...R('rs-hsi-indian-pines', '19920612_AVIRIS_IndianPine_Site3.tif')()] }],
  [/^chg\.confirm$/, { files: FX('fx06/fx06_date1.tif', 'fx06/fx06_date2.tif'), pre: ['chg.detect'] }],
  // A 3DEP lidar tile under the 3DEP 1/3″ DEM that covers it (the image the cloud is coloured from).
  [/^pc\.colourise$/, { files: () => [...R('lidar-3dep-co-drcog-2020-2x2', 'USGS_LPC_CO_DRCOG_2020_B20_w0474n4416.laz')(), ...R('usgs-3dep-13-n40w106', 'USGS_13_n40w106.tif')()] }],
  [/^pc\.colour\.hag$/, { files: AUTZEN, pre: ['pc.dtm'] }],
  [/^img\.(segments|orthofly)$/, { files: WV3A }],
  [/^img\.vmosaic$/, { files: () => [...WV3A(), ...WV3B()] }],
  [/^(file\.(print|snapshot)|ai\.(describe|askselection|smartselect))$/, { files: WV3A, setup: ['graphic', 'ai-mock'] }],
  [/^aoi\.clear$/, { files: WV3A, setup: ['aoi'] }],
  [/^chip\.markers$/, { files: WV3A, setup: ['graphic-marker'] }],
  [/^(cmp|lay)\./, { files: () => [...WV3A(), ...WV3B()], setup: ['graphic'] }],
  [/^link\.unlink$/, { files: WV3A, setup: ['split'], pre: ['link.all'] }],
  [/^win\.close$/, { files: WV3A, pre: ['win.new'] }],
  [/^(link|win)\./, { files: WV3A, setup: ['split'] }],
  [/^edit\.paste$/, { files: WV3A, setup: ['graphic'], pre: ['edit.copy'] }],
  [/^qat\.redo$/, { files: WV3A, setup: ['graphic'], pre: ['qat.undo'] }],
  [/^men\.centre$/, { files: WV3A, setup: ['graphic-line'] }],
  [/^dem\.volume$/, { files: () => [...WV3A(), ...DEM()], setup: ['terrain', 'graphic'] }],
  [/^dem\.diff$/, { files: () => [...DEM(), ...DEM2()], setup: ['terrain-all'] }],
  [/^dem\.extract$/, { files: () => [...WV3A(), ...WV3B()], setup: ['stereo'] }],
  [/^dem\.r2v$/, { files: () => [...WV3A(), ...DEM()], setup: ['terrain'], pre: ['los.hlz'] }],
  [/^ext\.attrsets$/, { files: () => [...WV3A(), ...FX12()], pre: ['ext.newschema'] }],
  [/^ext\.droptoground$/, { files: () => [...WV3A(), ...DEM(), ...FX12()], setup: ['terrain', '3d', 'select-feature'] }],
  [/^3d\.navroute$/, { files: () => [...WV3A(), ...DEM(), ...FX12()], setup: ['terrain', '3d', 'select-line'] }],
  [/^ext\.fromdsm$/, { files: AUTZEN, setup: ['dsm-from-cloud'] }],
  [/^ext\.merge$/, { files: () => [...WV3A(), ...FX12()], setup: ['select-two'] }],
  [/^ortho\.rectify$/, { files: () => [...WV3A(), ...DEM()], setup: ['terrain', 'activate-rpc'] }],
  // Seamlines and balance work on the last orthomosaic (of the two RPC chips).
  [/^ortho\.(balance|seam)$/, { files: () => [...WV3A(), ...WV3B(), ...DEM()], setup: ['terrain'], pre: ['ortho.mosaic'] }],
  [/^stereo\.parity$/, { files: () => [...WV3A(), ...WV3B()], setup: ['stereo'], pre: ['stereo.mode.interleaved'] }],
  [/^stereo\.(place|track)$/, { files: () => [...WV3A(), ...WV3B(), ...DEM()], setup: ['terrain', 'stereo'] }],
  [/^prod\.mediapptx$/, { files: R('fmv-ffmpeg-day-flight'), pre: ['prod.gif'] }],
  [/^prod\.gif/, { files: R('fmv-ffmpeg-day-flight') }],
  [/^report\.ai/, { files: WV3A, setup: ['ai-mock'] }],
  [/^search\.template/, { files: WV3A, setup: ['aoi'] }],
  [/^3d\.sync/, { files: () => [...WV3A(), ...DEM()], setup: ['terrain', '3d-beside'] }],
  [/^stereo\./, { files: () => [...WV3A(), ...WV3B()], setup: ['stereo'] }],
  [/^3d\./, { files: () => [...WV3A(), ...DEM()], setup: ['terrain', '3d'] }],
  [/^(dem|los)\.|^profile\.elevation/, { files: () => [...WV3A(), ...DEM()], setup: ['terrain'] }],
  [/^(ortho|align|tri|model)\./, { files: () => [...WV3A(), ...WV3B(), ...DEM()], setup: ['terrain'] }],
  [/^enh\.pansharpen/, { files: () => [...R('eo-spacenet-vegas-wv3-pan-ms-r1c1', '15OCT22183656-P2AS_R1C1-055649178030_01_P001.TIF')(), ...R('eo-spacenet-vegas-wv3-pan-ms-r1c1', '15OCT22183656-M2AS_R1C1-055649178030_01_P001.TIF')()] }],
  [/^(msi|bands)\.|^profile\.spectral|^search\.find/, { files: R('rs-msi-spacenet2-wv3', 'SN2_buildings_train_AOI_2_Vegas_MS_img10.tif') }],
  [/^sar\.(acd|ccd|pairs|subap|csi)/, { files: FX('fx07/fx07_a.nitf', 'fx07/fx07_b.nitf') }],
  [/^sar\./, { files: R('rs-sicd-umbra-chip') }],
  [/^(ext|sel|vec)\./, { files: () => [...WV3A(), ...R('rs-vector-fx12-synthetic', 'fx12.geojson')()], setup: ['select-feature'] }],
  [/^mie\./, { files: FX('formats/mie4nitf.ntf') }],
  [/^fmv\.gmti/, { files: FX('fx11/fx11.4607') }],
  [/^fmv\./, { files: R('fmv-ffmpeg-day-flight') }],
  [/^chg\./, { files: FX('fx06/fx06_date1.tif', 'fx06/fx06_date2.tif') }],
  [/^pc\./, { files: R('rs-lidar-las-laz-copc', 'autzen_trim.laz') }],
  [/^(nav|rot|link|win|view|ov|grid|deco|bm|bg|panel|lay|cmp|men|draw|aoi|chip|prod|snap|tpl|gfx|edit|meta|gps|file\.(print|snapshot)|ai\.(describe|askselection|smartselect)|qat)\.|^geo\.grid/, { files: WV3A, setup: ['graphic'] }],
];
// Commands whose precondition the sweep cannot meet on this machine: they must refuse by name
// (no raw exception). Their working paths are covered elsewhere — live services in c18 (Phase 5),
// thermal through Radiometric Conversion in c30; WebXR needs a headset (logged open).
const PRECONDITION = {
  'stereo.xr': /WebXR immersive stereo is not available/,
  'msi.thermal': /needs radiance/,
  'vec.remoteopen': /service URL must start with http/,
  '3d.qmesh': /enter the layer\.json URL/,
  '3d.tiles': /enter the tileset\.json URL/,
};
// Commands the offline sweep cannot enable, with where they are covered instead.
const ELSEWHERE = {
  'bg.map': 'needs an allow-listed online source: c18 basemap tests (GIBS, TNM, OSM)',
  'vec.remotesave': 'needs a remote layer: c18 (public service, read only) and e2e remote-edit (save round trip)',
  'sar.pauli': 'needs three co-registered polarisations: no free quad-pol SICD in the corpus (OD-05); e2e SAR suite on fixtures',
};
const recipeFor = (row) => RECIPES.find(([re]) => re.test(row.id))?.[1] ?? null;

// TE_ITEMS=<prefix> (phase F: TE_ITEMS=field) runs the sweep on those corpus items only: each
// command gets one of them in turn (by its id), recipe rows are left to the main campaign.
const ONLY = process.env.TE_ITEMS ?? null;
const spread = (id, n) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % n;

function dataFor(row) {
  const r = recipeFor(row);
  if (r && ONLY) return null;
  if (r) {
    try {
      const f = r.files();
      return f.length && f.every(existsSync) ? f : null;
    } catch {
      return null;
    }
  }
  if (!row.needs) return [];
  let ids = row.data.filter((id) => onDisk(item(id)));
  if (ONLY) {
    ids = ids.filter((id) => id.startsWith(ONLY) && item(id).files.some((f) => /\.(tif|tiff)$/i.test(f.name)));
    if (ids.length > row.needs.n) ids = [...ids.slice(spread(row.id, ids.length)), ...ids];
  }
  const pick = [...new Set(ids)].slice(0, row.needs.n);
  if (pick.length < row.needs.n) return null;
  return pick.flatMap((id) => {
    const it = item(id);
    const prims = it.files.filter((f) => (f.role ?? 'primary') === 'primary');
    // Field tile sets: a real (JPEG) tile, not the browse quick look.
    const prim = (ONLY && (prims.find((f) => /_R1C1\.tif$/i.test(f.name)) ?? prims.find((f) => /\.tif$/i.test(f.name)))) || prims[0];
    const all = paths(it);
    const stem = prim.name.split('/').pop().replace(/\.[^.]+$/, '');
    const base = (p) => p.split(/[\\/]/).pop();
    return all.filter((p) => base(p) === prim.name.split('/').pop() || base(p).startsWith(`${stem}.`));
  });
}

/** In-page setup steps (run after the files are open). */
async function setup(frame, steps) {
  return frame.evaluate(async (steps) => {
    const app = window.gisworkbench;
    const done = [];
    for (const s of steps) {
      try {
        const imgs = [...app.layers.values()].filter((l) => !l.error);
        if (s === 'terrain') {
          const dem = imgs.find((l) => /dem|dt[0-2]|hgt|float32/i.test(l.rec?.name ?? '')) ?? imgs[imgs.length - 1];
          await app.useAsTerrain(dem, 'hae');
        } else if (s === 'stereo') {
          const m = imgs.filter((l) => l.modelId);
          app.stereo.open(m[0], m[1]);
        } else if (s === '3d') {
          await app.scene3d.openTerrain({ p: app.activePane(), dem: app.terrain.dems[0], image: null, exaggeration: 1, maxError: 2 });
        } else if (s === '3d-beside') {
          // The 3D view in a second panel, the image's 2D panel kept beside it (3d.sync).
          const mp = app.activeMp();
          mp.setLayout('1x2');
          await app.scene3d.openTerrain({ p: mp.panes[1], dem: app.terrain.dems[0], image: null, exaggeration: 1, maxError: 2 });
          mp.setActivePane(mp.panes[1]);
        } else if (s === 'ai-mock') {
          // The offline mock provider (Phase 5: a real provider only with an owner-supplied key).
          app.prefs.set('aiConnections', [{ id: 'conn-te-mock', name: 'TE mock', provider: 'mock', baseURL: '', model: 'mock-model', effort: 'low', fallbacks: false }]);
          app.prefs.set('aiActive', 'conn-te-mock');
        } else if (s === 'aoi') {
          const l = imgs.find((x) => x.modelId);
          const c = l.groundAt(l.width / 2, l.height / 2);
          const d = 2e-4;
          app.setAoi([[c.lon - d, c.lat - d], [c.lon + d, c.lat - d], [c.lon + d, c.lat + d], [c.lon - d, c.lat + d]], 'ground', 'TE AOI');
        } else if (s === 'classify') {
          // Two training classes on the image's left and right halves, then maximum likelihood.
          const l = imgs[0];
          app.msi.clearClasses?.(l);
          app.msi.addClass(l, { name: 'West', regions: [{ x0: 5, y0: 5, w: 30, h: 30 }], validation: [{ x0: 5, y0: 40, w: 20, h: 20 }] });
          app.msi.addClass(l, { name: 'East', regions: [{ x0: l.width - 40, y0: l.height - 40, w: 30, h: 30 }], validation: [{ x0: l.width - 30, y0: 5, w: 20, h: 20 }] });
          await app.msi.classify(l, 'ml');
          const cl = [...app.layers.values()].find((x) => x.msi?.kind === 'classification');
          if (cl) app.store.transact('TE active layer', (tx) => tx.set(app.activePane().id, 'activeLayer', cl.id));
        } else if (s === 'graphic-marker' || s === 'graphic-line') {
          const l = imgs.find((x) => x.modelId);
          const c = l.groundAt(l.width / 2, l.height / 2);
          const shape = s === 'graphic-marker' ? 'marker' : 'line';
          const coords = shape === 'marker' ? [[c.lon, c.lat]] : [[c.lon - 1e-4, c.lat], [c.lon + 1e-4, c.lat]];
          app.proposals.autoApply = true;
          await app.mcp.callTool('gw_create_graphic', { shape, coordinates: coords });
          app.proposals.autoApply = false;
          const g = app.store.all('graphic').at(-1);
          if (g) app.selection = new Set([g.id]);
        } else if (s === 'split') {
          app.activeMp().setLayout('1x2');
        } else if (s === 'terrain-all') {
          for (const l of imgs) await app.useAsTerrain(l, 'hae');
        } else if (s === 'dsm-from-cloud') {
          await app.pc.generate([...app.pointClouds.values()][0], 'dsm');
        } else if (s === 'select-line') {
          const f = app.store.all('feature').find((x) => /LineString/.test(x.geom?.type ?? ''));
          if (f) app.selection = new Set([f.id]);
        } else if (s === 'select-two') {
          const fs = app.store.all('feature').filter((x) => /Polygon/.test(x.geom?.type ?? ''));
          app.selection = new Set(fs.slice(0, 2).map((f) => f.id));
        } else if (s === 'activate-rpc') {
          const l = imgs.find((x) => /RPC/.test(x.modelName ?? ''));
          if (l) app.store.transact('TE active layer', (tx) => tx.set(app.activePane().id, 'activeLayer', l.id));
        } else if (s === 'select-feature') {
          const f = app.store.all('feature').find((x) => /Polygon/.test(x.geom?.type ?? '')) ?? app.store.all('feature')[0];
          if (f) app.selection = new Set([f.id]);
        } else if (s === 'graphic') {
          // A ground polygon through the registered tool path (MCP proposal, auto-applied), then selected.
          const l = imgs.find((x) => x.modelId);
          const c = l ? l.groundAt(l.width / 2, l.height / 2) : null;
          if (c && app.store.all('graphic').length === 0) {
            app.proposals.autoApply = true;
            await app.mcp.callTool('gw_create_graphic', { shape: 'polygon', coordinates: [[c.lon - 1e-4, c.lat - 1e-4], [c.lon + 1e-4, c.lat - 1e-4], [c.lon + 1e-4, c.lat + 1e-4], [c.lon - 1e-4, c.lat + 1e-4]] });
            app.proposals.autoApply = false;
            const g = app.store.all('graphic')[0];
            if (g) app.selection = new Set([g.id]);
          }
        }
        done.push(s);
      } catch (e) {
        done.push(`${s}: ${e.message}`);
      }
    }
    return done;
  }, steps);
}

export function runMatrix(spec) {
  if (!existsSync('reports/campaign/matrix.json')) {
    test('matrix missing', () => test.skip(true, 'run node build/campaign/gen-matrix.mjs first'));
    return;
  }
  const rows = matrix().rows.filter((r) => r.spec === spec);
  test.describe.configure({ mode: 'parallel' });
  for (const row of rows) {
    test(`TE-${spec.slice(0, 3).toUpperCase()} ${row.req} ${row.id} — ${row.label}`, async ({ page }, info) => {
      const files = dataFor(row);
      test.skip(files === null, `no corpus data on disk for context ${row.context.join(',')}`);
      const { frame, logs, requests, csp } = await openApp(page, 'file');
      let opened = [];
      let prepared = [];
      if (files.length) {
        opened = await openFiles(frame, files);
        await settledAny(frame);
        const steps = recipeFor(row)?.setup ?? [];
        if (steps.length) prepared = await setup(frame, steps);
        // Earlier products the command works on (a change set, a DTM, an orthophoto…).
        for (const pid of recipeFor(row)?.pre ?? []) {
          const pr = await runCommand(page, frame, pid, { logs: [], pick: files });
          prepared.push(`${pid}: ${pr.outcome}${pr.errors?.length ? ` (${pr.errors.join('; ')})` : ''}`);
        }
        // Their jobs outlive the dialog: wait (bounded) until the command under test is enabled.
        if (recipeFor(row)?.pre?.length) await frame.waitForFunction((c) => window.gisworkbench.commands.enabled(c), row.id, { timeout: 90_000 }).catch(() => {});
      }
      const r = await runCommand(page, frame, row.id, { logs, pick: files });
      const cspv = await csp();
      record(spec, info.project.name, { key: row.id, ...r, prepared, data: files.map((f) => f.split(/[\\/]/).slice(-2).join('/')), openErrors: opened.flatMap((o) => o.errors ?? []), requests, csp: cspv });
      expect(requests, 'no unrequested network traffic (SEC-12)').toEqual([]);
      expect(cspv, 'no CSP violations (SEC-01)').toEqual([]);
      if (row.implemented === false) expect(r.outcome, 'placeholder says when it arrives').toBe('stub');
      else if (PRECONDITION[row.id] && r.errors.length) {
        expect(r.errors.join(' '), `${row.id} refuses its unmet precondition by name`).toMatch(PRECONDITION[row.id]);
        test.info().annotations.push({ type: 'precondition', description: `${row.id}: ${r.errors.join(' ')}` });
      } else expect(r.errors, `${row.id} ran without errors`).toEqual([]);
      // A command still disabled after its recipe is a coverage gap, reported (not a failure): its
      // precondition needs an interaction the sweep does not script (see the report's gap list).
      if (!r.enabled) test.info().annotations.push(ELSEWHERE[row.id] ? { type: 'covered-elsewhere', description: `${row.id}: ${ELSEWHERE[row.id]}` } : { type: 'disabled', description: `${row.id} disabled after setup ${prepared.join(', ')}` });
    });
  }
}
