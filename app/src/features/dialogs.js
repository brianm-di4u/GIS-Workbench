// Dialogs and help: About & Diagnostics (REQ-HOST-01, REQ-PRF-08, REQ-SEC-05/07/08),
// metadata/TRE browser, coordinate conversion (REQ-GEO-08), datum info, model info and
// error budget (REQ-SNS-06, REQ-MEN-06), marking, preferences, help pages (REQ-UI-15),
// graphics GeoJSON save/load (REQ-IMG-29), selection, and the panel context menu.

import { h, clear, copyText, fmtNum } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { openMenu, closeMenus } from '../shell/menu.js';
import { icon } from '../shell/icons.js';
import { NOT_ACCREDITED, LEVELS, LEVEL_NAME, bannerText } from '../security/marking.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { fmtBytes } from '../core/util.js';
import { FMT } from '../wasm/core.js';

export const name = 'dialogs';

export const HELP_TOPICS = [
  ['Getting started', 'Open imagery with File ▸ Open Image or by dropping files (with their world files, .aux.xml or .prj) on a panel. The Workspace window lists files and layers; the Map View shows footprints.'],
  ['Navigation', 'Wheel zooms about the cursor. Hold the middle button to roam. W = whole scene, Ctrl+Alt+1 = 1:1, F7 = full roam. Home ▸ Rotate offers North Up, Up is Up and Shadows Down, computed from the sensor model at the view centre.'],
  ['Image chain', 'Image Tools ▸ Enhance holds brightness, contrast, gamma and saturation sliders, the SIPS-style DRA with full-image and viewport scopes and Lock DRA, stretches and pseudo-colour LUTs. Every change is undoable and recorded with chips and measurements.'],
  ['Mensuration', 'Draw ▸ Mensuration: Point Position, Range & Bearing, Polyline Length and Polygon Area. Results are geodesic on WGS 84 and go to the Mensuration Log with CE90/LE90 or "error not available".'],
  ['Coordinates', 'Geospatial ▸ Convert Coordinates converts between DD, DMS, DDM, MGRS (truncated), USNG, UTM/UPS, GARS and GEOREF. Jump to Point accepts any of them.'],
  ['Feedback whiteboard', 'Press B (or Add-Ins ▸ Feedback Whiteboard) to draw on the live application, pin items, capture pages with the image panes and banners, and export an HTML report.'],
  ['AI assistant', 'Add-Ins ▸ AI Assistant. Off until you add a connection and consent. Proposals must be accepted. AI never produces measurement values.'],
  ['Stereo and 3D', 'Open a stereo pair with Stereo Tools ▸ Open Stereo Model: anaglyph, split-screen, interleaved, a second window (dual output) or WebXR, with a 3D cursor and stereo mensuration. View ▸ 3D opens terrain, point clouds, glTF models, 3D Tiles (online or a local .3tz) and quantized-mesh terrain; Sync Always keeps the 3D view on the 2D panel’s centre and back.'],
  ['Extraction', 'Feature Tools: capture with snapping and persistent attribution against the schema, the magic wand and edge, road and DSM assists, and Validate for dangles, overlaps, slivers, duplicates and gaps. Buildings go out as glTF, OBJ or CityJSON; Texture Buildings drapes them with an image through its sensor model.'],
  ['SAR', 'SICD and SIDD open with SAR Tools: magnitude, phase and power views, remaps, speckle filters, slant or ground plane, shadows-down, and change detection (amplitude and coherent change between registered pairs).'],
  ['Spectral', 'Multi-band and hyperspectral imagery (ENVI, GeoTIFF, NITF, and EMIT/PRISMA HDF5 with the HDF5 pack) opens Spectral Tools: composites, band math and indices, radiometric and thermal correction, classification, target detection, PCA/MNF and spectral libraries.'],
  ['Full-motion video', 'File ▸ Open ▸ Open Video or GMTI reads MPEG-TS with MISB ST 0601 KLV: the map shows the platform, footprint and frame centre in step with playback. Video Tools capture frames (PNG, NITF with RPC), record events, measure on the frame, show VMTI and STANAG 4607 GMTI, and export clips.'],
  ['Data packs', 'Add-Ins ▸ Packs loads .gwpack files: EGM2008 geoid, PROJ for any EPSG code, HDF5 and the AI models (smart select). Every entry is checked against the SHA-256 this build lists before it is used; packs stay in this browser for the next session.'],
  ['Online sources', 'Geospatial ▸ Online adds WMS, WMTS, XYZ and ArcGIS layers; Feature Tools ▸ Online edits ArcGIS feature services and WFS-T. A file only reaches origins in its network allow-list, and View ▸ Network Log lists every request it made (paths, never query strings).'],
];

export const LIMITS_TEXT = [
  ['Accuracy claims', 'GIS Workbench does not claim MSP, CSM, JITC NITF, STANAG 3377 or ISM conformance (D14). It is designed to follow those references. Every measurement shows CE90/LE90 from the sensor model and terrain, or "error not available".'],
  ['Markings', NOT_ACCREDITED],
  ['Mono heights', 'RPC00B carries horizontal error only. A mono point has no vertical model error; LE90 comes from the DEM, or shows "error not available".'],
  ['Geoid', 'MSL heights use the embedded EGM96 15′ grid (Catmull-Rom; ≈0.17 m max interpolation error), or EGM2008 (5′ grid) when its data pack is loaded.'],
  ['Stereo', 'Quad-buffer and active-shutter stereo are not supported (D7). Anaglyph, split-screen, interleaved, dual-window and WebXR outputs are.'],
  ['WebGPU', 'Viewsheds and SGM terrain extraction run on the GPU where WebGPU is available (Preferences ▸ Display) and fall back to the workers; NCC Fast always runs in the workers.'],
  ['RPF', 'CADRG and CIB frame files open one by one; an A.TOC table of contents is not read.'],
  ['Codecs in this build', 'NITF uncompressed (all IMODEs, any NBPP), JPEG 8/12-bit with the NITF default tables (C3/M3), JPEG 2000 and HTJ2K (C8/M8, whole-image decode up to 400 M samples), VQ (C4/M4) and T.4 bi-level (C1/M1); several image segments can be merged into one mosaic. GeoTIFF/BigTIFF/COG, DTED, SRTM HGT, JPEG/PNG with world files. Not decoded: lossless JPEG (C5), ARIDPCM (C2), complex SAR compression (C7), HT code-blocks mixed with Part 1 code-blocks.'],
  ['Embedded use', 'Inside a hosting service the tool is a viewer with light editing. File pickers, downloads, fullscreen and storage depend on the host frame (Help ▸ About & Diagnostics lists what is available).'],
  ['AI', 'The AI assistant is off until you add a connection. It proposes; you decide. It never computes coordinates, measurements or errors (D30).'],
];

export function install(app) {
  const C = app.commands;

  // ---- About & Diagnostics ----
  C.implement('help.about', {
    run: async () => {
      const rm = app.runMode;
      const caps = Object.entries(rm.caps).filter(([k]) => k !== 'gl');
      const blocks = Object.entries(app.gw.manifest.blocks);
      const verify = h('pre', { class: 'mono small' }, 'Click "Verify blocks" to check every SHA-256.');
      const vb = h('button', { class: 'btn btn-small' }, 'Verify blocks');
      vb.addEventListener('click', async () => (verify.textContent = JSON.stringify(await app.gw.verifyAll(), null, 1)));
      const notices = h('pre', { class: 'mono small notices' }, document.getElementById('notices')?.textContent.slice(0, 200000) ?? '');
      const mem = performance.memory ? `${fmtBytes(performance.memory.usedJSHeapSize)} of ${fmtBytes(performance.memory.jsHeapSizeLimit)}` : 'not reported by this browser';
      const body = h(
        'div',
        { class: 'about' },
        h('p', {}, h('b', {}, `GIS Workbench ${app.build.version}`), ` · build ${app.build.id} · ${app.build.date}${app.build.dev ? ' (dev)' : ''}`),
        h('p', { class: 'hint' }, NOT_ACCREDITED),
        section(
          'Run mode',
          h('p', {}, `Mode: ${rm.mode} (${rm.protocol}${rm.framed ? ', framed' : ''}). Features switch on detected capabilities, not on the mode name.`),
          h('table', { class: 'grid-table small' }, h('tbody', {}, caps.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v)))))),
          rm.problems.length ? h('ul', { class: 'warn' }, rm.problems.map((p) => h('li', {}, p))) : null,
          app.storageWarning ? h('p', { class: 'warn' }, app.storageWarning) : null,
        ),
        section(
          'Performance and memory (REQ-PRF-08)',
          h('p', {}, `Boot to ready: ${app.bootMs} ms. Last cursor read-out: ${fmtNum(app.readoutMs, 3)} ms. Frame: ${fmtNum(app.renderer.stats.frameMs, 2)} ms.`),
          h('p', {}, `GPU textures: ${fmtBytes(app.renderer.gpuBytes)} of ${fmtBytes(app.renderer.gpuBudget)} budget. JS heap: ${mem}. Workers: ${JSON.stringify(app.pool.stats())}.`),
          h('p', {}, `WebGL2: ${rm.caps.gl?.renderer ?? 'n/a'} (max texture ${rm.caps.gl?.maxTexture ?? '?'})${app.softwareGl ? ' — software rendering detected, bicubic/Lanczos fall back to bilinear (REQ-IMG-33)' : ''}.`),
        ),
        section('Blocks (build manifest)', h('table', { class: 'grid-table small' }, h('tbody', {}, blocks.map(([n, b]) => h('tr', {}, h('td', {}, n), h('td', {}, b.kind), h('td', {}, b.load), h('td', {}, fmtBytes(b.size)), h('td', { class: 'mono' }, `${b.sha256.slice(0, 16)}…`))))), vb, verify),
        section('Third-party notices', notices),
      );
      const r = await modal({ title: 'About & Diagnostics', body, buttons: ['Close', 'Copy Diagnostics'], width: 760, id: 'about' });
      if (r === 'Copy Diagnostics') {
        const diag = { build: app.build, runMode: { ...rm, caps: { ...rm.caps } }, stats: app.renderer.stats, pool: app.pool.stats(), messages: app.messages.slice(-50), coverage: app.commands.coverage() };
        await copyText(JSON.stringify(diag, null, 2));
        app.toast('Diagnostics copied');
      }
    },
  });

  C.implement('help.limits', {
    run: () => modal({ title: 'Accuracy and Limits', body: h('div', {}, LIMITS_TEXT.map(([t, d]) => h('div', {}, h('h4', {}, t), h('p', {}, d)))), buttons: ['Close'], width: 620, id: 'limits' }),
  });

  C.implement('help.keys', {
    run: () => {
      const km = app.keys.keyMap();
      const row = (k, c) => h('tr', {}, h('td', { class: 'mono' }, k.replace(/Key|Digit/g, '').replace('Mod', 'Ctrl')), h('td', {}, app.commands.get(c)?.label ?? c));
      const body = h(
        'div',
        {},
        h('h4', {}, 'Anywhere'),
        h('table', { class: 'grid-table' }, h('tbody', {}, Object.entries(km.global).map(([k, c]) => row(k, c)))),
        h('h4', {}, 'While a panel has focus'),
        h('table', { class: 'grid-table' }, h('tbody', {}, Object.entries(km.pane).map(([k, c]) => row(k, c)), h('tr', {}, h('td', { class: 'mono' }, 'Arrows'), h('td', {}, 'Roam a quarter panel')), h('tr', {}, h('td', { class: 'mono' }, 'Esc'), h('td', {}, 'End the tool; stop full roam')))),
        h('h4', {}, 'Mouse'),
        h('ul', {}, ['Wheel: zoom about the cursor', 'Middle button held: roam; speed grows with distance from where you pressed', 'Left drag: glove pan', 'Double-click: centre and zoom', 'Right-click: mini toolbar and menu', 'Double-click a tool: keep it active until Esc'].map((x) => h('li', {}, x))),
        h('p', { class: 'hint' }, 'Ctrl+1 and Ctrl+T are reserved by browsers; their defaults are Ctrl+Alt+1 and Ctrl+Alt+T, and the originals work in Exploitation Fullscreen with Keyboard Lock (REQ-UI-09/10).'),
      );
      modal({ title: 'Keyboard Map', body, buttons: ['Close'], width: 560, id: 'keys' });
    },
  });

  C.implement('help.topics', {
    run: () => {
      const t = app.tools.current;
      const topics = HELP_TOPICS;
      const body = h('div', { class: 'help' }, t ? h('div', { class: 'cue' }, h('h4', {}, app.commands.get(t.id)?.label ?? t.id), h('p', {}, app.cueText ?? '')) : null, ...topics.map(([a, b]) => h('details', { open: !t && a === 'Getting started' }, h('summary', {}, a), h('p', {}, b))));
      modal({ title: 'Help Topics', body, buttons: ['Close'], width: 620, id: 'help' });
    },
  });

  // ---- Coordinates ----
  C.implement('geo.convert', {
    run: async () => {
      const inp = h('input', { class: 'inp', placeholder: 'Any format: 33.3 44.4 · 38SMB4414084706 · 38n 444140 3684706 · 381NH45 …', spellcheck: 'false' });
      const prec = h('select', { class: 'inp inp-short' }, [3, 4, 5, 6].map((p) => h('option', { value: String(p) }, `${p} digits (${['100 m', '10 m', '1 m', '0.1 m (non-standard)'][p - 3]})`)));
      prec.value = '5';
      const out = h('table', { class: 'grid-table' });
      const update = () => {
        clear(out);
        if (!inp.value.trim()) return;
        try {
          const r = app.core.parse(inp.value);
          const p = +prec.value;
          const rows = [
            ['Input', `${r.format}${Number.isFinite(r.precisionM) ? ` (precision ≈ ${r.precisionM < 1 ? r.precisionM.toFixed(2) : Math.round(r.precisionM)} m)` : ''}${r.notice ? ` — ${r.notice}` : ''}`],
            ['Decimal degrees', app.core.format(r.lat, r.lon, FMT.DD, 7)],
            ['DMS', app.core.format(r.lat, r.lon, FMT.DMS, 2)],
            ['DDM', app.core.format(r.lat, r.lon, FMT.DDM, 4)],
            ['MGRS', `${app.core.format(r.lat, r.lon, FMT.MGRS, p)}${p > 5 ? ' (sub-metre, non-standard)' : ''}`],
            ['USNG', app.core.format(r.lat, r.lon, FMT.USNG, p)],
            ['UTM/UPS', app.core.format(r.lat, r.lon, FMT.UTM, 3)],
            ['GARS', app.core.format(r.lat, r.lon, FMT.GARS, 2)],
            ['GEOREF', app.core.format(r.lat, r.lon, FMT.GEOREF, 3)],
            ['Geoid N (EGM96)', `${fmtNum(app.core.undulation(r.lat, r.lon), 3)} m`],
          ];
          for (const [k, v] of rows) {
            const cp = h('button', { class: 'icon-btn', title: 'Copy', 'aria-label': `Copy ${k}` }, '⧉');
            cp.addEventListener('click', () => copyText(v.replace(/ \(.*\)$/, '')));
            out.appendChild(h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v), h('td', {}, cp)));
          }
        } catch (e) {
          out.appendChild(h('tr', {}, h('td', { class: 'err' }, e.message)));
        }
      };
      inp.addEventListener('input', update);
      prec.addEventListener('change', update);
      const cg = app.cursorGround;
      if (cg) {
        inp.value = app.core.format(cg.lat, cg.lon, FMT.DD, 7);
        update();
      }
      await modal({ title: 'Convert Coordinates', body: h('div', {}, field('Coordinate', inp), field('Grid precision', prec), out, h('p', { class: 'hint' }, 'Grids truncate (MGRS, USNG, GARS, GEOREF name a cell); lat/long displays round. Reverse conversion returns the cell centre.')), buttons: ['Close'], width: 640, id: 'convert' });
    },
  });
  C.implement('geo.datum', {
    run: () => modal({ title: 'Datum Info', body: h('div', {}, h('p', {}, 'Internal datum: WGS 84 (a = 6 378 137 m, 1/f = 298.257 223 563); heights are HAE internally (REQ-GEO-01).'), h('p', {}, `Display heights: HAE and MSL (${app.core.geoidName ?? 'EGM96 — loading'}), each labelled.`), h('p', {}, 'Distances, azimuths and areas: geodesics on the ellipsoid (Karney 2013), never on a map projection.')), buttons: ['Close'], id: 'datum' }),
  });

  // ---- Sensor model ----
  C.implement('model.active', {
    enabled: () => !!app.activeLayer(),
    run: () => C.run('model.info'),
    menu: () => {
      const l = app.activeLayer();
      return (l?.models ?? []).map((m) => ({
        label: m.error ? `${m.name} — ${m.error}` : m.name,
        disabled: !!m.error,
        checked: l.modelName === m.name,
        run: () => {
          l.modelId = m.id;
          l.modelName = m.name;
          l.modelInfo = m.info;
          app.store.transact('Active sensor model', (tx) => tx.set(l.id, 'model', m.name));
          app.activePane()?.applyOrientation();
          app.emit('state');
        },
      }));
    },
  });
  C.implement('model.info', {
    enabled: () => !!app.activeLayer(),
    run: () => {
      const l = app.activeLayer();
      const ish = l.info.subheader;
      const rpc = ish?.rpc ?? l.info.meta?.rpc;
      const body = h(
        'div',
        {},
        h('p', {}, `Active model: ${l.modelName}${l.modelInfo ? ` (${l.modelInfo.is3d ? '3-D sensor model' : '2-D map/GCP model'}; valid HAE ${fmtNum(l.modelInfo.hmin, 0)} … ${fmtNum(l.modelInfo.hmax, 0)} m)` : ''}`),
        h('ul', {}, (l.models ?? []).map((m) => h('li', {}, m.error ? `${m.name}: ${m.error}` : m.name))),
        rpc ? section('RPC', h('p', { class: 'mono small' }, `ERR_BIAS ${rpc[0]} m, ERR_RAND ${rpc[1]} m, LINE_OFF ${rpc[2]}, SAMP_OFF ${rpc[3]}, LAT_OFF ${rpc[4]}, LONG_OFF ${rpc[5]}, HEIGHT_OFF ${rpc[6]}; scales ${rpc.slice(7, 12).join(', ')}`), h('p', { class: 'hint' }, 'Pixel convention: RPC line/sample offsets refer to pixel centres; GIS Workbench image coordinates put the first pixel centre at (0.5, 0.5).'), ish?.ichipb ? h('p', {}, `ICHIPB chip → full image: ${ish.ichipb.map((v) => fmtNum(v, 4)).join(', ')}`) : null) : null,
      );
      modal({ title: 'Model Info', body, buttons: ['Close'], width: 640, id: 'model-info' });
    },
  });
  C.implement('model.error', {
    enabled: () => !!app.activePane()?.geoLayer()?.modelId,
    run: () => {
      const p = app.activePane();
      const l = p.geoLayer();
      const x = p.cursor?.x ?? p.view.cx;
      const y = p.cursor?.y ?? p.view.cy;
      const g = l.groundWithTerrain(x, y);
      const e = app.core.pointError(l.modelId, x, y, g.h, app.prefs.get('pickSigmaPx') ?? 0.5, g.sigmaV);
      const el = app.core.ellipse(e.cov[0], e.cov[1], e.cov[2]);
      const rows = [
        ['Ground point', `${app.core.format(g.lat, g.lon, FMT.DD, 7)} · ${fmtNum(g.h, 2)} m HAE`],
        ['Model σ (per horizontal axis)', e.modelErrorKnown ? `${fmtNum(e.sigmaModel, 3)} m (from support data)` : 'not stated by the model → CE "error not available"'],
        ['Measurement σ', `${fmtNum(e.sigmaPick, 3)} m (${app.prefs.get('pickSigmaPx') ?? 0.5} px × GSD ${fmtNum(e.gsd, 3)} m through the image→ground Jacobian)`],
        ['Height source', `${g.heightSource}${Number.isFinite(g.sigmaV) ? `, σv ${fmtNum(g.sigmaV, 2)} m` : ''}`],
        ['DEM → horizontal', `${fmtNum(e.sigmaDemH, 3)} m (σv × tan off-nadir ${fmtNum(e.tanOffNadir, 4)})`],
        ['Covariance E,N (m²)', `σE² ${fmtNum(e.cov[0], 4)}, σEN ${fmtNum(e.cov[1], 4)}, σN² ${fmtNum(e.cov[2], 4)}`],
        ['Error ellipse (1σ)', `${fmtNum(el.sigmaMax, 3)} × ${fmtNum(el.sigmaMin, 3)} m, major axis ${fmtNum(el.azimuth, 1)}°`],
        ['CE90', Number.isFinite(e.ce90) ? `${fmtNum(e.ce90, 3)} m — ${e.ceMethod}` : 'error not available'],
        ['LE90', Number.isFinite(e.le90) ? `${fmtNum(e.le90, 3)} m (1.6449 σv)` : 'error not available'],
      ];
      modal({ title: 'Error Budget', body: h('div', {}, h('table', { class: 'grid-table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))), h('p', { class: 'hint' }, 'Absolute accuracy of a mono point. RPC00B carries horizontal error only (Research/06 §6).')), buttons: ['Close'], width: 680, id: 'error-budget' });
    },
  });

  // ---- Metadata ----
  app.showMetadata = (l) => {
    const info = l.info;
    const tabs = [];
    if (info.header) tabs.push(['File header', info.header]);
    if (info.subheader) {
      const { tres, ...rest } = info.subheader;
      tabs.push(['Image subheader', rest]);
      if (tres?.length) tabs.push([`TREs (${tres.length})`, tres]);
    }
    if (info.others?.length) tabs.push([`Other segments (${info.others.length})`, info.others]);
    if (info.meta) tabs.push(['Metadata', info.meta]);
    const body = h('div', { class: 'meta-view' });
    const nav = h('div', { class: 'meta-tabs', role: 'tablist' });
    const pre = h('pre', { class: 'mono small meta-pre' });
    tabs.forEach(([t, v], i) => {
      const b = h('button', { class: 'btn btn-small', role: 'tab' }, t);
      b.addEventListener('click', () => {
        pre.textContent = JSON.stringify(v, (k, val) => (k === 'LUT' ? `[${val.length} LUT(s)]` : val), 2);
      });
      nav.appendChild(b);
      if (i === 0) pre.textContent = JSON.stringify(v, null, 2);
    });
    body.append(nav, pre);
    modal({ title: `Metadata — ${l.rec.name}`, body, buttons: ['Close'], width: 820, marking: app.markingSuffix(), id: 'metadata' });
  };
  C.implement('meta.edit', { enabled: () => !!app.activeLayer(), run: () => app.showMetadata(app.activeLayer()) });

  // ---- Marking (REQ-SEC-04/05) ----
  C.implement('meta.marking', {
    run: async () => {
      const cur = app.project()?.marking;
      const sel = h('select', { class: 'inp' }, h('option', { value: '' }, 'None (use the data markings; default UNCLASSIFIED)'), ...LEVELS.map((l) => h('option', { value: l }, LEVEL_NAME[l])));
      sel.value = cur?.level ?? '';
      const cw = h('input', { class: 'inp', value: cur?.codewords ?? '' });
      const ctl = h('input', { class: 'inp', value: cur?.control ?? '' });
      const rel = h('input', { class: 'inp', value: cur?.release ?? '' });
      const banner = h('p', { class: 'banner-preview' });
      const upd = () => (banner.textContent = sel.value ? bannerText({ level: sel.value, codewords: cw.value, control: ctl.value, release: rel.value }) : bannerText(app.screenMarking()));
      for (const e of [sel, cw, ctl, rel]) e.addEventListener('input', upd);
      upd();
      const body = h('div', {}, h('p', { class: 'hint' }, NOT_ACCREDITED), h('p', { class: 'hint' }, 'The default vocabulary is UNCLASSIFIED; other levels are offered for testing products only. A project marking can only raise what the data says.'), field('Project marking', sel), field('Codewords', cw), field('Control/handling', ctl), field('Release to', rel), section('Banner on screen', banner));
      if ((await modal({ title: 'Classification & Marking', body, buttons: ['OK', 'Cancel'], width: 520, id: 'marking' })) !== 'OK') return;
      app.store.transact('Project marking', (tx) => tx.set('project', 'marking', sel.value ? { level: sel.value, raw: sel.value, codewords: cw.value.trim(), control: ctl.value.trim(), release: rel.value.trim(), source: 'project' } : null));
      app.emit('state');
    },
  });

  // ---- Preferences (REQ-UI-11): a searchable tree, User and Common tabs, a lock column ----
  const PREFS = [
    ['General', 'analyst', 'Analyst name (Mensuration Log, feedback)', 'text'],
    ['General', 'mergeSegments', 'Merge NITF image segments into one mosaic', 'bool'],
    ['Mensuration', 'coordFormat', 'Cursor coordinate format', 'select', [['0', 'Decimal degrees'], ['1', 'DMS']], 1],
    ['Mensuration', 'pickSigmaPx', 'Measurement σ (pixels)', 'number', null, 0.5],
    ['Mensuration', 'heightMethod', 'Default height method', 'select', [['layover', 'Layover'], ['shadow', 'Shadow']], 'layover'],
    ['Storage', 'journal', 'Recovery journal', 'select', [['on', 'On'], ['off', 'Off (nothing is written to browser storage)']], 'on'],
    ['Display', 'gpuBudgetMB', 'GPU texture budget (MB)', 'number', null, 384],
    ['Display', 'webgpu', 'Use WebGPU where available (viewshed)', 'bool', null, true],
    ['Network', 'copcStream', 'Stream every COPC by range', 'bool', null, false],
    ['Input', 'serialScale', 'Serial stereo mouse: counts for full deflection', 'number', null, 100],
  ];
  const coerce = (type, k, v) => (type === 'bool' ? v === true || v === 'true' : type === 'number' ? Math.max(0.01, Number(v) || PREFS.find((p) => p[1] === k)?.[5] || 0) : k === 'coordFormat' ? Number(v) : v);
  app.prefsCatalog = PREFS;
  C.implement('file.prefs', {
    run: async () => {
      const P = app.prefs;
      const search = h('input', { class: 'inp', type: 'search', placeholder: 'Search preferences', 'aria-label': 'Search preferences', 'data-id': 'prefs-search' });
      const cats = [...new Set(PREFS.map((p) => p[0]))];
      let cat = null;
      let tab = 'user';
      const tree = h('ul', { class: 'prefs-tree', role: 'tree', 'aria-label': 'Preference categories' });
      const pane = h('div', { class: 'prefs-rows' });
      const tabs = h('div', { class: 'prefs-tabs', role: 'tablist' });
      const edits = { user: {}, common: {}, lock: {} };
      const ctlFor = (type, opts, v, label) => {
        if (type === 'bool') {
          const cb = h('input', { type: 'checkbox', checked: v === true, 'aria-label': label });
          cb.readValue = () => cb.checked;
          return cb;
        }
        const el = type === 'select' ? h('select', { class: 'inp', 'aria-label': label }, opts.map(([ov, ol]) => h('option', { value: ov }, ol))) : h('input', { class: 'inp', type, step: type === 'number' ? 'any' : null, spellcheck: type === 'text' ? 'true' : null, 'aria-label': label });
        el.value = v === undefined || v === null ? '' : String(v);
        el.readValue = () => el.value;
        return el;
      };
      const render = () => {
        tree.replaceChildren(...[null, ...cats].map((c) => {
          const li = h('li', { role: 'treeitem', 'aria-selected': String(cat === c), tabindex: '0', class: cat === c ? 'sel' : '', 'data-cat': c ?? 'all' }, c ?? 'All');
          li.addEventListener('click', () => {
            cat = c;
            render();
          });
          return li;
        }));
        tabs.replaceChildren(...['user', 'common'].map((t) => {
          const b = h('button', { class: ['btn', tab === t && 'active'], role: 'tab', 'aria-selected': String(tab === t), 'data-tab': t }, t === 'user' ? 'User' : 'Common');
          b.addEventListener('click', () => {
            tab = t;
            render();
          });
          return b;
        }));
        const q = search.value.trim().toLowerCase();
        const rows = PREFS.filter(([c, k, label]) => (!cat || c === cat) && (!q || `${c} ${k} ${label}`.toLowerCase().includes(q)));
        const head = h('tr', {}, h('th', {}, 'Preference'), h('th', {}, tab === 'user' ? 'Value' : 'Common value'), h('th', {}, 'Lock'));
        const body = rows.map(([c, k, label, type, opts, def]) => {
          const locked = edits.lock[k] ?? P.isLocked(k);
          let ctl;
          if (tab === 'user') {
            const v = edits.user[k] ?? P.get(k) ?? def;
            ctl = ctlFor(type, opts, v, label);
            ctl.disabled = locked;
            ctl.addEventListener('change', () => (edits.user[k] = coerce(type, k, ctl.readValue())));
          } else {
            const v = edits.common[k] ?? P.common.values[k] ?? def;
            ctl = ctlFor(type, opts, v, `${label} (Common)`);
            ctl.addEventListener('change', () => (edits.common[k] = coerce(type, k, ctl.readValue())));
          }
          const lock = h('input', { type: 'checkbox', checked: locked, disabled: tab === 'user', 'aria-label': `Lock ${label}`, 'data-lock': k });
          lock.addEventListener('change', () => (edits.lock[k] = lock.checked));
          return h('tr', { 'data-k': k }, h('td', {}, h('span', { class: 'muted small' }, `${c} ▸ `), label), h('td', {}, ctl), h('td', {}, lock, locked && tab === 'user' ? h('span', { class: 'small muted' }, ' locked') : null));
        });
        pane.replaceChildren(h('table', { class: 'grid-table', 'data-id': 'prefs-table' }, h('thead', {}, head), h('tbody', {}, body)));
      };
      search.addEventListener('input', render);
      render();
      const importBtn = h('button', { class: 'btn' }, 'Import Common…');
      importBtn.addEventListener('click', async () => {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: 'Common preferences' });
        if (!f) return;
        try {
          P.importCommon(JSON.parse(await f.text()));
          render();
        } catch (e) {
          app.toast(e.message, { kind: 'error' });
        }
      });
      const body = h('div', { class: 'prefs' }, search, tabs, h('div', { class: 'prefs-split' }, tree, pane), h('div', { class: 'btn-row' }, importBtn), h('p', { class: 'hint' }, 'User values override Common ones unless the Common value is locked. Preferences are kept in this browser and never in the project file.'));
      const apply = () => {
        for (const [k, v] of Object.entries(edits.user)) {
          if (k === 'journal') app.journal?.setEnabled(v === 'on');
          P.set(k, v);
        }
        for (const [k, v] of Object.entries(edits.common)) P.setCommon(k, v);
        for (const [k, v] of Object.entries(edits.lock)) P.setCommon(k, P.common.values[k] ?? edits.common[k] ?? P.get(k), { lock: v });
        edits.user = {};
        edits.common = {};
        edits.lock = {};
        app.renderer.gpuBudget = (P.get('gpuBudgetMB') ?? 384) << 20;
        render();
      };
      const r = await modal({ title: 'Preferences', body, buttons: ['OK', 'Cancel'], width: 760, id: 'prefs', onApply: apply, onReset: () => {
        for (const [, k] of PREFS) if (!P.isLocked(k)) edits.user[k] = undefined;
        for (const k of Object.keys(edits.user)) P.set(k, undefined);
        edits.user = {};
        render();
      }, onHelp: () => C.run('help.topics') });
      if (r === 'OK') apply();
    },
  });
  app.renderer.gpuBudget = (app.prefs.get('gpuBudgetMB') ?? 384) << 20;

  // ---- Graphics GeoJSON save/load (REQ-IMG-29) ----
  // gfx.save / gfx.load: features/graphics.js (GeoJSON, KML, KMZ).

  // ---- Selection and delete ----
  app.selection = new Set();
  C.implement('sel.all', { run: () => {
    app.selection = new Set(app.store.all('graphic').filter((g) => g.pane === app.activePane()?.id).map((g) => g.id));
    app.activePane()?.invalidate();
    app.toast(`${app.selection.size} graphic(s) selected`);
  } });
  C.implement('edit.delete', {
    enabled: () => app.selection.size > 0,
    run: () => {
      const ids = [...app.selection].filter((id) => app.store.has(id));
      app.store.transact(`Delete ${ids.length} graphic(s)`, (tx) => ids.forEach((id) => tx.delete(id)));
      app.selection.clear();
      app.activePane()?.invalidate();
    },
  });

  // ---- Panel context menu (Appendix C §10) ----
  app.paneContextMenu = (pane, x, y, imgPt) => {
    const l = pane.geoLayer();
    const g = l?.modelId ? l.groundWithTerrain(imgPt.x, imgPt.y) : null;
    const copy = (fmt, prec) => g && copyText(app.core.format(g.lat, g.lon, fmt, prec)).then(() => app.toast('Copied'));
    openMenu(
      [
        { cmd: 'nav.glove' },
        { label: 'Re-center Here', run: () => pane.centreOn(imgPt.x, imgPt.y) },
        { cmd: 'nav.zoombox' },
        { cmd: 'nav.whole' },
        { label: 'Rotate', items: [{ cmd: 'rot.zero' }, { cmd: 'rot.north' }, { cmd: 'rot.upisup' }, { cmd: 'rot.shadows' }] },
        { cmd: 'link.all' },
        '-',
        { label: 'Drop Marker Here', disabled: !g, run: () => app.dropMarker?.(pane, imgPt) },
        { label: 'Measure Point Here', disabled: !g, run: () => {
          app.tools.select('men.point');
          const s = pane.screenPoint(imgPt.x, imgPt.y);
          app.tools.current.onDown(pane, {}, s.x, s.y);
        } },
        { label: 'Copy Coordinate', disabled: !g, items: [{ label: 'Decimal degrees', run: () => copy(FMT.DD, 7) }, { label: 'DMS', run: () => copy(FMT.DMS, 2) }, { label: 'MGRS', run: () => copy(FMT.MGRS, 5) }, { label: 'UTM', run: () => copy(FMT.UTM, 2) }] },
        { label: 'Ask AI About Here', run: () => app.commands.run('ai.assistant') },
        { label: 'Add Feedback Pin', run: () => app.commands.run('wb.toggle') },
      ],
      app,
      { x, y },
    );
    // Mini toolbar (REQ-UI-06): the commonest commands just above the context menu.
    const host = document.querySelector('.menu-host');
    if (host) {
      const bar = h('div', { class: 'menu mini-toolbar', role: 'toolbar', 'aria-label': 'Mini toolbar', 'data-id': 'mini-toolbar', style: { left: `${x}px`, top: `${Math.max(0, y - 34)}px` } });
      for (const id of ['nav.zoomin', 'nav.zoomout', 'nav.whole', 'rot.north', 'men.point', 'draw.marker', 'gfx.props']) {
        const c = C.get(id);
        if (!c) continue;
        const b = h('button', { class: 'btn btn-small', title: c.label, 'aria-label': c.label, 'data-cmd': id, disabled: !C.enabled(id) }, icon(c.icon));
        b.addEventListener('click', () => {
          closeMenus();
          C.run(id);
        });
        bar.appendChild(b);
      }
      host.appendChild(bar);
    }
  };
  app.dropMarker = (pane, imgPt) => {
    app.tools.select('draw.marker');
    const s = pane.screenPoint(imgPt.x, imgPt.y);
    app.tools.current.onDown(pane, {}, s.x, s.y);
  };
  // F5 drops a marker at the cursor of the active pane.
  C.implement('draw.marker', {
    enabled: () => !!app.activePane()?.layers().length,
    checked: () => app.tools.current?.id === 'draw.marker',
    run: () => {
      const p = app.activePane();
      if (p?.cursor) app.dropMarker(p, { x: p.cursor.x, y: p.cursor.y });
      else app.tools.select('draw.marker');
    },
  });
  C.define({ id: 'pane.showname', label: 'Show Image File Name', icon: 'info', req: 'REQ-UI-09', rel: 'R0', run: () => app.toast(app.activeLayer()?.info.fileName ?? 'No image') });
}
