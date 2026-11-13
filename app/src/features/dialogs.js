// Dialogs and help: About & Diagnostics (REQ-HOST-01, REQ-PRF-08, REQ-SEC-07/08),
// metadata/TRE browser, coordinate conversion (REQ-GEO-08), datum info, model info and
// error budget (REQ-SNS-06, REQ-MEN-06), preferences, help pages (REQ-UI-15),
// graphics GeoJSON save/load (REQ-IMG-29), selection, and the panel context menu.

import { h, clear, copyText, fmtNum } from '../shell/dom.js';
import { modal, field, section } from '../shell/dialogs.js';
import { openMenu, closeMenus } from '../shell/menu.js';
import { icon } from '../shell/icons.js';
import { saveBlob, textBlob, pickFiles } from '../storage/files.js';
import { fmtBytes } from '../core/util.js';
import { FMT } from '../wasm/core.js';
import { applyTheme } from '../shell/theme.js';
import { chordLabel } from '../shell/palette.js';
import { modelLabel } from '../formats/model-names.js';
import { t, N_, NC_, tr, msgOf, locale, langOf } from '../i18n/index.js';
import { setUnits, num, numMax, int } from '../i18n/format.js';
import { availableLocales } from '../i18n/load.js';

/**
 * Preferences ▸ Language choices: automatic, then each locale in its own name (packs marked).
 * Language names are shown as they are ({ text }), never translated again.
 */
function localeOptions(app) {
  const ls = availableLocales(app.gw);
  return [['auto', N_('Automatic (the browser’s language)')], ...ls.map((l) => [l.tag, { text: `${l.name}${l.english && l.english !== l.name ? ` — ${l.english}` : ''}${l.pack ? ` ${t('(language pack)')}` : ''}` }])];
}

export const name = 'dialogs';

// Help and Accuracy & Limits (REQ-UI-15): [title, paragraph], one message per paragraph, shown
// through tr(). The English stays the source for the AI tools' local documents (ai-extras.js).
export const HELP_TOPICS = [
  [N_('Getting started'), N_('Open imagery with File ▸ Open Image or by dropping files (with their world files, .aux.xml or .prj) on a panel. Press Ctrl+K to find any command by name, or type a coordinate there to fly to it. The Workspace window (the rail on the left) lists files and layers; its Map View shows footprints.')],
  [N_('What’s new in 2.0'), N_('GIS Workbench 2.0 starts on a clean canvas and keeps the 1.x Ribbon one click away (Classic layout). New in 2.0: the command palette (Ctrl+K), workspaces for Explorer, AI Analyst and Pro, a contextual tool pill and a radial menu (tap Space); built-in basemaps and a 3D view when you choose to work online, and an air-gapped file that never uses the network; cloud imagery opened by range from https, S3 and GCS, STAC catalogue search and watched folders; a Convert drop zone for GeoJSON, GeoParquet, FlatGeobuf and Cloud-Optimized GeoTIFF of any size; local AI from model packs (SAM 2.1 smart select, Find Objects, Search Imagery, Auto Align, Auto Contrast) and a copilot that uses them first; recipes that run a workflow step by step with review gates; and Send to Photoshop, Illustrator, Blender, Unreal, iOS and Google Sheets. Each has its own topic below.')],
  [N_('Modern and Classic layouts'), N_('GIS Workbench starts on a clean canvas: an app bar on top, a navigation rail on the left (Catalog, Data, Layers, Tools, Measure, AI, Recipes, Convert, Products), one image panel and a small compass at the bottom right of each panel (click it to turn the view north up). Ctrl+K opens the command palette: type a command, a layer, a coordinate or a URL. Hover any button to see what it does. Over an image: tap Space (or press `) for the radial menu; hold F to see the image underneath; hold S for a swipe curtain; Alt + wheel changes the layer opacity; C + drag makes a quick chip for the session deck; Ctrl+V flies to a pasted coordinate; J and K step through markers, detections and search results and 1, 2, 3 triage them. The workspace button in the top bar switches between the Explorer, AI Analyst and Pro set-ups or saves your own. Drag a dock tab to an edge, or onto the lower half of an open dock to see two panels at once; the dock menu collapses a dock to icons. View ▸ Display ▸ Interface Layout (or Preferences ▸ Display) switches to the Classic layout of 1.x and back, without a restart.')],
  [N_('Coming from 1.x (Classic)'), N_('Everything in 1.x is still here. To work as before, choose View ▸ Display ▸ Interface Layout ▸ Classic (or the Pro workspace and then Classic): the Ribbon, Quick Access Toolbar, KeyTips, Layer Manager, Cue Cards, Workspace window and the north arrow on the image come back, with the Classic themes. Your keyboard shortcuts, Quick Access Toolbar and ribbon customisations carry over. In the Modern layout the same commands are in Ctrl+K (type the name you know: DRA, CLAHE, orthorectify), in the navigation rail and in the right-click menu. Two defaults changed: the large north arrow is now a small compass (View ▸ Decorations brings the arrow back), and GIS Workbench starts Offline until you choose (status bar switch). A site can lock the layout and Offline through Common preferences.')],
  [N_('Online, basemaps and 3D'), N_('The Online/Offline switch in the status bar decides whether anything may reach the network; every request is listed in the Network Log. Online, the corner button of a georeferenced panel puts a satellite, topographic, relief or night basemap under and around the image, and the 3D button shows the place in perspective with terrain. Drop a raster .pmtiles file to use your own basemap offline. The air-gapped file (gis-workbench-airgap.html) never uses the network.')],
  [N_('Cloud data and conversion'), N_('Online, the Catalog (navigation rail) searches Earth Search and Planetary Computer over the view, browses S3 buckets (private ones with keys held for the session) and opens any COG by URL without downloading it: paste an https://, s3:// or gs:// address into Ctrl+K. It also watches local folders, including synced Google Drive and OneDrive folders, for new files. Convert (navigation rail) turns Shapefile zips, KML, GPX, GeoPackage, CSV or GML into GeoJSON, GeoParquet or FlatGeobuf, and rasters of any size into Cloud-Optimized GeoTIFF; the Job Queue shows progress, speed, time left and Retry.')],
  [N_('Local AI'), N_('Local AI runs on this computer from the AI packs (File ▸ Open ▸ Open Data Pack; each is opened once and kept): Smart Select outlines what you click (SAM 2.1; Square Corners for buildings), Find Objects (AI) finds what you name in the view and puts it in the detections review queue, Search Imagery (AI) flies to places that look like a description, Auto Align (AI) lines up two dates or sensors, and Auto Contrast sets the look in one click. In the AI dock, plain requests such as “detect aircraft in view” run on these tools first, with or without an assistant connection. AI Device shows whether the graphics card is used. Nothing leaves the computer.')],
  [N_('Recipes'), N_('Recipes (navigation rail) run a workflow step by step along the bottom: watch each step’s state, result and time; click a step to change its settings and re-run from there; at a review gate accept or reject the candidates (✓ / ✗, or J then 1 / 2 / 3), then press Enter. Built in: Airfield triage, Damage triage, Convert a folder to COG and Building extraction. Save a recipe as a .gwrecipe.json file to share it; Open… loads one.')],
  [N_('Feature catalogues'), N_('Feature Tools ▸ Attributes ▸ Import Feature Catalogue reads an ISO 19110 feature catalogue (XML), an INSPIRE application schema (.xsd) with its code lists, OpenStreetMap presets (the iD editor’s presets.json with fields.json) or a gw-catalog/1 file. Its feature types are then offered by New Layer from Schema, with coded values as drop-down lists.')],
  [N_('Workflow Builder'), N_('Add-Ins ▸ Recipes ▸ Workflow Builder wires steps into a workflow: add a step, then drag from an output on the right of a step to an input on the left of another; a wire is refused when the types do not fit. In List, an input can instead take a layer of the project. Graph shows the steps as boxes and List as rows; select a step to change its settings. Run runs it step by step and shows each step’s state. Save keeps it in the project and in your library in this browser; Export writes a .gwrecipe.json file to share. Each layer a workflow makes records the workflow, its version, the step and its settings.')],
  [N_('Running a recipe unattended'), N_('With the optional sidecar, gwb-run runs a recipe with nobody at the page: from a shell, a script, Task Scheduler or cron. It starts Chrome or Edge headless with the sidecar’s own copy of the app, runs the recipe, and writes its files to the folder given by --out, each with a provenance file beside it. For example: gwb-run folder-to-cog --in s1=site.tif --out results. A recipe that would wait for someone, such as a step that opens a dialog or a review gate when gates are set to stop, is refused before anything runs. gwb-run --help lists the options.')],
  [N_('Send to other tools'), N_('Products ▸ Send to hands the view to Photoshop (a layered PSD whose Levels and Curves layers rebuild the look, or a 16-bit TIFF with a Curves preset), Illustrator (layered PDF or SVG with imagery, graphics, vectors, neatline and scale bar), Blender, Unreal and iOS (3D terrain as GLB or USDZ) and Google Sheets (rows through an Apps Script relay you deploy; experimental).')],
  [N_('Navigation'), N_('Wheel zooms about the cursor. Hold the middle button to roam. W = whole scene, Ctrl+Alt+1 = 1:1, F7 = full roam. Home ▸ Rotate offers North Up, Up is Up and Shadows Down, computed from the sensor model at the view centre.')],
  [N_('Image chain'), N_('Image Tools ▸ Enhance holds brightness, contrast, gamma and saturation sliders, the SIPS-style DRA with full-image and viewport scopes and Lock DRA, stretches and pseudo-colour LUTs. Every change is undoable and recorded with chips and measurements.')],
  [N_('Mensuration'), N_('Draw ▸ Mensuration: Point Position, Range & Bearing, Polyline Length and Polygon Area. Results are geodesic on WGS 84 and go to the Mensuration Log with CE90/LE90 or "error not available".')],
  [N_('Coordinates'), N_('Geospatial ▸ Convert Coordinates converts between DD, DMS, DDM, MGRS (truncated), USNG, UTM/UPS, GARS and GEOREF. Jump to Point accepts any of them.')],
  [N_('Feedback whiteboard'), N_('Press B (or Add-Ins ▸ Feedback Whiteboard) to draw on the live application, pin items, capture pages with the image panes, and export an HTML report.')],
  [N_('AI assistant'), N_('Add-Ins ▸ AI Assistant. Off until you add a connection and consent. Proposals must be accepted. AI never produces measurement values.')],
  [N_('Stereo and 3D'), N_('Open a stereo pair with Stereo Tools ▸ Open Stereo Model: anaglyph, split-screen, interleaved, a second window (dual output) or WebXR, with a 3D cursor and stereo mensuration. View ▸ 3D opens terrain, point clouds, glTF models, 3D Tiles (online or a local .3tz) and quantized-mesh terrain; Sync Always keeps the 3D view on the 2D panel’s centre and back.')],
  [N_('Extraction'), N_('Feature Tools: capture with snapping and persistent attribution against the schema, the magic wand and edge, road and DSM assists, and Validate for dangles, overlaps, slivers, duplicates and gaps. Buildings go out as glTF, OBJ or CityJSON; Texture Buildings drapes them with an image through its sensor model.')],
  [N_('SAR'), N_('SICD and SIDD open with SAR Tools: magnitude, phase and power views, remaps, speckle filters, slant or ground plane, shadows-down, and change detection (amplitude and coherent change between registered pairs).')],
  [N_('Spectral'), N_('Multi-band and hyperspectral imagery (ENVI, GeoTIFF, NITF, and EMIT/PRISMA HDF5 with the HDF5 pack) opens Spectral Tools: composites, band math and indices, radiometric and thermal correction, classification, target detection, PCA/MNF and spectral libraries.')],
  [N_('Full-motion video'), N_('File ▸ Open ▸ Open Video reads MPEG-TS with MISB ST 0601 KLV: the map shows the platform, footprint and frame centre in step with playback. Video Tools capture frames (PNG, NITF with RPC), record events, measure on the frame, and export clips.')],
  [N_('Data packs'), N_('Add-Ins ▸ Packs loads .gwpack files: EGM2008 geoid, PROJ for any EPSG code, HDF5 and the AI models (smart select). Every entry is checked against the SHA-256 this build lists before it is used; packs stay in this browser for the next session.')],
  [N_('Online sources'), N_('Geospatial ▸ Online adds WMS, WMTS, XYZ and ArcGIS tile layers as Map-view backgrounds (they never take part in measurement); Feature Tools ▸ Online edits ArcGIS feature services and WFS-T. A file only reaches origins in its network allow-list, and View ▸ Network Log lists every request it made (paths, never query strings).')],
  [N_('Time series'), N_('Analyze ▸ Time Series works on a layer with a date on every band: the time axis of a NetCDF-3 (classic) file, or a stack from Time Stack, which puts dated images (dates from their file names or metadata) in date order on one grid. The Time Series panel has a date slider with playback and recording, and shows the values over time at the cursor, at a pinned point or over the AOI, with CSV export. Temporal Trend fits a straight line through each pixel (slope per year, p-value, dates used); Temporal Anomaly compares each date with a baseline period, by calendar month or not, as a difference or a z-score. With an AOI drawn, all of them work inside it.')],
  [N_('Addresses and routes'), N_('Geospatial ▸ Addresses and Routes works on your own data and sends nothing anywhere. Address Index builds an index from an address layer (points with numbers, or street lines with number ranges) and can save it as a GeoPackage to open again. Find Address searches it as you type (exact, close spellings, and numbers placed along a street); Geocode a Table adds a location to every row of a table; Reverse Geocode names the address at a click. Road Network builds a graph from a line layer, with one-way roads, speeds and turn bans; Shortest Route and Service Area then start and end at the junction nearest each click.')],
];

export const LIMITS_TEXT = [
  [N_('Accuracy claims'), N_('GIS Workbench does not claim CSM or NITF conformance (D14). It is designed to follow those references. Every measurement shows CE90/LE90 from the sensor model and terrain, or "error not available".')],
  [N_('Mono heights'), N_('RPC00B carries horizontal error only. A mono point has no vertical model error; LE90 comes from the DEM, or shows "error not available".')],
  [N_('Geoid'), N_('MSL heights use the embedded EGM96 15′ grid (Catmull-Rom; ≈0.17 m max interpolation error), or EGM2008 from the data pack opened last: the 5′ grid, the 2.5′ grid or the 1′ grid (read a tile at a time, and preferred to the 2.5′ grid when both are open), all interpolated cubic.')],
  [N_('Stereo'), N_('In the browser, quad-buffer and active-shutter stereo are not supported (D7); the sidecar’s Native Stereo Viewer offers them. Anaglyph, split-screen, interleaved, dual-window and WebXR outputs work in the browser.')],
  [N_('WebGPU'), N_('Viewsheds and SGM terrain extraction run on the GPU where WebGPU is available (Preferences ▸ Display) and fall back to the workers; NCC Fast always runs in the workers.')],
  [N_('RPF'), N_('CADRG and CIB frames open one by one or as a mosaic through their A.TOC.')],
  [N_('Pan-sharpening'), N_('Brovey, IHS, IHS-NIR and Gram–Schmidt-style fusion are display composites; chips export what is displayed. No fused product is written at pan resolution.')],
  [N_('Codecs in this build'), N_('NITF uncompressed (all IMODEs, any NBPP), JPEG 8/12-bit with the NITF default tables (C3/M3), lossless JPEG (C5/M5), JPEG 2000 and HTJ2K (C8/M8, whole-image decode up to 400 M samples), VQ (C4/M4), ARIDPCM (C2/M2) and T.4 bi-level (C1/M1); several image segments can be merged into one mosaic. GeoTIFF/BigTIFF/COG, DTED, SRTM HGT, JPEG/PNG with world files. Not decoded: complex SAR compression (C7), HT code-blocks mixed with Part 1 code-blocks.')],
  [N_('RSM'), N_('RSM is experimental: one polynomial section, no grids and no error model. An image with several RSM sections uses its other models.')],
  [N_('Embedded use'), N_('Inside a hosting service the tool is a viewer with light editing. File pickers, downloads, fullscreen and storage depend on the host frame (Help ▸ About & Diagnostics lists what is available).')],
  [N_('AI'), N_('The AI assistant is off until you add a connection. It proposes; you decide. It never computes coordinates, measurements or errors (D30).')],
];

const CLOSE = () => [{ label: t('Close'), value: 'close', primary: true }];
const OK_CANCEL = () => [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }];
const EDITIONS = { lite: N_('Lite edition'), airgap: N_('Air-gapped edition') };

export function install(app) {
  const C = app.commands;

  // ---- About & Diagnostics ----
  C.implement('help.about', {
    run: async () => {
      const rm = app.runMode;
      const caps = Object.entries(rm.caps).filter(([k]) => k !== 'gl');
      const blocks = Object.entries(app.gw.manifest.blocks);
      const verify = h('pre', { class: 'mono small' }, t('Click "Verify blocks" to check every SHA-256.'));
      const vb = h('button', { class: 'btn btn-small' }, t('Verify blocks'));
      vb.addEventListener('click', async () => (verify.textContent = JSON.stringify(await app.gw.verifyAll(), null, 1)));
      // A scrolling region is keyboard-reachable (axe scrollable-region-focusable).
      const notices = h('pre', { class: 'mono small notices', tabindex: '0', 'aria-label': t('Third-party notices') }, document.getElementById('notices')?.textContent.slice(0, 200000) ?? '');
      const mem = performance.memory ? t('{used} of {limit}', { used: fmtBytes(performance.memory.usedJSHeapSize), limit: fmtBytes(performance.memory.jsHeapSizeLimit) }) : t('not reported by this browser');
      const ps = app.pool.stats();
      const workers = t('{n}, {busy} busy, {queued} queued', { n: int(ps.size), busy: int(ps.running), queued: int(ps.queued) });
      const gl = { renderer: rm.caps.gl?.renderer ?? t('n/a'), max: rm.caps.gl?.maxTexture ?? '?' };
      const body = h(
        'div',
        { class: 'about' },
        h('p', {}, h('b', {}, `GIS Workbench ${app.build.version}`), t(' · {edition} · build {id} · {date}{dev, select, yes { (dev)} other {}}', { edition: edition(), id: app.build.id, date: app.build.date, dev: app.build.dev ? 'yes' : 'no' })),
        app.build.profile === 'lite' ? h('p', { class: 'hint' }, t('GIS Workbench Lite is the mobile edition: a touch interface with the field tools. GIS Workbench (Full) has every feature, with the desktop interface.')) : null,
        app.build.profile === 'airgap' ? h('p', { class: 'hint' }, t('The air-gapped file makes no network requests: online basemaps, cloud catalogues and remote AI are not available.')) : null,
        section(
          t('Run mode'),
          h('p', {}, t('Mode: {mode} ({protocol}{framed, select, yes {, framed} other {}}). Features switch on detected capabilities, not on the mode name.', { mode: rm.mode, protocol: rm.protocol.replace(':', ''), framed: rm.framed ? 'yes' : 'no' })),
          h('table', { class: 'grid-table small', 'data-i18n-data': '' }, h('tbody', {}, caps.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, String(v)))))), // capability ids and values: diagnostics (DN-62 rule 7)
          rm.problems.length ? h('ul', { class: 'warn' }, rm.problems.map((p) => h('li', {}, tr(p)))) : null,
          app.storageWarning ? h('p', { class: 'warn' }, app.storageWarning) : null,
        ),
        section(
          t('Performance and memory (REQ-PRF-08)'),
          h('p', {}, t('Boot to ready: {boot} ms. Last cursor read-out: {readout} ms. Frame: {frame} ms.', { boot: int(app.bootMs), readout: fmtNum(app.readoutMs, 3), frame: fmtNum(app.renderer.stats.frameMs, 2) })),
          h('p', {}, t('GPU textures: {used} of {budget} budget. JS heap: {heap}. Workers: {workers}.', { used: fmtBytes(app.renderer.gpuBytes), budget: fmtBytes(app.renderer.gpuBudget), heap: mem, workers })), // GUI-041
          h('p', {}, app.softwareGl ? t('WebGL2: {renderer} (max texture {max}) — software rendering detected, bicubic/Lanczos fall back to bilinear (REQ-IMG-33).', gl) : t('WebGL2: {renderer} (max texture {max}).', gl)),
        ),
        section(t('Blocks (build manifest)'), h('table', { class: 'grid-table small', 'data-i18n-data': '' }, h('tbody', {}, blocks.map(([n, b]) => h('tr', {}, h('td', {}, n), h('td', {}, b.kind), h('td', {}, b.load), h('td', {}, fmtBytes(b.size)), h('td', { class: 'mono' }, `${b.sha256.slice(0, 16)}…`))))), vb, verify),
        section(t('Third-party notices'), notices),
      );
      const r = await modal({ title: t('About & Diagnostics'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }, { label: t('Copy Diagnostics'), value: 'copy' }, { label: t("What's New…"), value: 'whatsnew' }], width: 760, id: 'about' });
      if (r === 'whatsnew') return C.run('help.whatsnew');
      if (r === 'copy') {
        // Diagnostics stay English (DN-62 rule 7).
        const diag = { build: app.build, runMode: { ...rm, caps: { ...rm.caps } }, stats: app.renderer.stats, pool: app.pool.stats(), messages: app.messages.slice(-50), coverage: app.commands.coverage() };
        await copyText(JSON.stringify(diag, null, 2));
        app.toast(t('Diagnostics copied'), { kind: 'info' });
      }
    },
  });

  const edition = () => tr(EDITIONS[app.build.profile] ?? N_('Full edition')); // GUI-036
  // What's New (GUI-008): the CHANGELOG.md embedded by the build, as headings, lists and paragraphs.
  // The change log itself is English only (SDP-2.3 §4.10); its headings and buttons are translated.
  C.implement('help.whatsnew', {
    run: async () => {
      const md = await app.gw.text('data-changelog');
      const inline = (s) => {
        const out = [];
        const re = /\*\*(.+?)\*\*|`(.+?)`|\[(.+?)\]\((.+?)\)/g;
        let at = 0;
        for (let m; (m = re.exec(s)); at = re.lastIndex) {
          out.push(s.slice(at, m.index));
          out.push(m[1] ? h('b', {}, m[1]) : m[2] ? h('code', {}, m[2]) : m[3]);
        }
        out.push(s.slice(at));
        return out;
      };
      const body = h('div', { class: 'whatsnew' });
      if (langOf(locale()) !== 'en') body.appendChild(h('p', { class: 'hint' }, t('The change log is in English.')));
      let list = null;
      for (const line of md.split('\n')) {
        const ln = line.trim();
        if (!ln || /^# /.test(ln)) {
          list = null;
          continue;
        }
        const rel = /^## \[(.+?)\](?: - (.+))?/.exec(ln);
        if (rel) {
          body.appendChild(h('h3', {}, t('Version {v}', { v: rel[1] }), rel[2] ? h('span', { class: 'hint' }, ` · ${rel[2]}`) : null, rel[1] === app.build.version ? h('span', { class: 'whatsnew-this' }, t('this version')) : null));
          list = null;
        } else if (/^### /.test(ln)) {
          body.appendChild(h('h4', {}, ln.slice(4)));
          list = null;
        } else if (/^- /.test(ln)) {
          if (!list) body.appendChild((list = h('ul', {})));
          list.appendChild(h('li', {}, inline(ln.slice(2))));
        } else if (body.querySelector('h3, h4, ul, p:not(.hint)')) body.appendChild(h('p', {}, inline(ln)));
      }
      await modal({ title: t("What's New"), body, buttons: CLOSE(), width: 640, id: 'whatsnew' });
    },
  });

  C.implement('help.limits', {
    run: () => modal({ title: t('Accuracy and Limits'), body: h('div', {}, LIMITS_TEXT.map(([title, d]) => h('div', {}, h('h4', {}, tr(title)), h('p', {}, tr(d))))), buttons: CLOSE(), width: 620, id: 'limits' }),
  });

  C.implement('help.keys', {
    run: () => {
      const km = app.keys.keyMap();
      const row = (k, c) => h('tr', {}, h('td', { class: 'mono' }, chordLabel(k)), h('td', {}, tr(app.commands.get(c)?.label) ?? c));
      const mouse = [N_('Wheel: zoom about the cursor'), N_('Middle button held: roam; speed grows with distance from where you pressed'), N_('Left drag: glove pan'), N_('Double-click: centre and zoom'), N_('Right-click: mini toolbar and menu'), N_('Double-click a tool: keep it active until Esc')];
      const body = h(
        'div',
        {},
        h('h4', {}, t('Anywhere')),
        h('table', { class: 'grid-table' }, h('tbody', {}, Object.entries(km.global).map(([k, c]) => row(k, c)))),
        h('h4', {}, t('While a panel has focus')),
        h('table', { class: 'grid-table' }, h('tbody', {}, Object.entries(km.pane).map(([k, c]) => row(k, c)), h('tr', {}, h('td', { class: 'mono' }, t('Arrows')), h('td', {}, t('Roam a quarter panel'))), h('tr', {}, h('td', { class: 'mono' }, 'Esc'), h('td', {}, t('End the tool; stop full roam'))))), // i18n-ignore: 'Esc' is the key cap name
        h('h4', {}, t('Mouse')),
        h('ul', {}, mouse.map((x) => h('li', {}, tr(x)))),
        h('p', { class: 'hint' }, t('Ctrl+1 and Ctrl+T are reserved by browsers; their defaults are Ctrl+Alt+1 and Ctrl+Alt+T, and the originals work in Analysis Fullscreen with Keyboard Lock (REQ-UI-09/10).')),
      );
      modal({ title: t('Keyboard Map'), body, buttons: CLOSE(), width: 560, id: 'keys' });
    },
  });

  C.implement('help.topics', {
    run: () => {
      const cur = app.tools.current;
      const topics = HELP_TOPICS;
      const body = h('div', { class: 'help' }, cur ? h('div', { class: 'cue' }, h('h4', {}, tr(app.commands.get(cur.id)?.label) ?? cur.id), h('p', {}, app.cueText ?? '')) : null, ...topics.map(([a, b]) => h('details', { open: !cur && a === 'Getting started' }, h('summary', {}, tr(a)), h('p', {}, tr(b)))));
      modal({ title: t('Help Topics'), body, buttons: CLOSE(), width: 620, id: 'help' });
    },
  });

  // ---- Coordinates ----
  C.implement('geo.convert', {
    run: async () => {
      const inp = h('input', { class: 'inp', placeholder: t('Any format: {examples}', { examples: '33.3 44.4 · 38SMB4414084706 · 38n 444140 3684706 · 381NH45 …' }), spellcheck: 'false' });
      const res = (p) => (p > 5 ? t('{d} m (non-standard)', { d: num(0.1, 1) }) : t('{d} m', { d: int(10 ** (5 - p)) }));
      const prec = h('select', { class: 'inp inp-short' }, [3, 4, 5, 6].map((p) => h('option', { value: String(p) }, t('{p} digits ({res})', { p, res: res(p) }))));
      prec.value = '5';
      const out = h('table', { class: 'grid-table' });
      const update = () => {
        clear(out);
        if (!inp.value.trim()) return;
        try {
          const r = app.core.parse(inp.value);
          const p = +prec.value;
          const fmt = (f, d) => app.core.format(r.lat, r.lon, f, d);
          let input = Number.isFinite(r.precisionM) ? t('{format} (precision ≈ {p} m)', { format: r.format, p: r.precisionM < 1 ? num(r.precisionM, 2) : int(Math.round(r.precisionM)) }) : r.format;
          if (r.notice) input = t('{text} — {notice}', { text: input, notice: tr(r.notice) });
          const mgrs = fmt(FMT.MGRS, p);
          const und = app.core.undulation(r.lat, r.lon);
          // [label, shown, copied]: the copy is the plain value, without the notes in brackets.
          const rows = [
            [t('Input'), input, r.format],
            [t('Decimal degrees'), fmt(FMT.DD, 7)],
            ['DMS', fmt(FMT.DMS, 2)],
            ['DDM', fmt(FMT.DDM, 4)],
            ['MGRS', p > 5 ? t('{mgrs} (sub-metre, non-standard)', { mgrs }) : mgrs, mgrs],
            ['USNG', fmt(FMT.USNG, p)],
            ['UTM/UPS', fmt(FMT.UTM, 3)],
            ['GARS', fmt(FMT.GARS, 2)],
            ['GEOREF', fmt(FMT.GEOREF, 3)],
            [t('Geoid N (EGM96)'), t('{v} m', { v: fmtNum(und, 3) }), `${und.toFixed(3)} m`],
          ];
          for (const [k, v, copy] of rows) {
            const cp = h('button', { class: 'icon-btn', title: t('Copy'), 'aria-label': t('Copy {what}', { what: k }) }, '⧉');
            cp.addEventListener('click', () => copyText(copy ?? v));
            out.appendChild(h('tr', {}, h('td', {}, k), h('td', { class: 'mono' }, v), h('td', {}, cp)));
          }
        } catch (e) {
          out.appendChild(h('tr', {}, h('td', { class: 'err' }, msgOf(e))));
        }
      };
      inp.addEventListener('input', update);
      prec.addEventListener('change', update);
      const cg = app.cursorGround;
      if (cg) {
        inp.value = app.core.format(cg.lat, cg.lon, FMT.DD, 7);
        update();
      }
      await modal({ title: t('Convert Coordinates'), body: h('div', {}, field(t('Coordinate'), inp), field(t('Grid precision'), prec), out, h('p', { class: 'hint' }, t('Grids truncate (MGRS, USNG, GARS, GEOREF name a cell); lat/long displays round. Reverse conversion returns the cell centre.'))), buttons: CLOSE(), width: 640, id: 'convert' });
    },
  });
  C.implement('geo.datum', {
    run: () => modal({ title: t('Datum Info'), body: h('div', {}, h('p', {}, t('Internal datum: WGS 84 (a = 6 378 137 m, 1/f = 298.257 223 563); heights are HAE internally (REQ-GEO-01).')), h('p', {}, t('Display heights: HAE and MSL ({geoid}), each labelled.', { geoid: app.core.geoidName ?? t('EGM96 — loading') })), h('p', {}, t('Distances, azimuths and areas: geodesics on the ellipsoid (Karney 2013), never on a map projection.'))), buttons: CLOSE(), id: 'datum' }),
  });

  // ---- Sensor model ----
  C.implement('model.active', {
    enabled: () => !!app.activeLayer(),
    run: () => C.run('model.info'),
    menu: () => {
      const l = app.activeLayer();
      return (l?.models ?? []).map((m) => ({
        label: m.error ? t('{name} — {error}', { name: modelLabel(m.name), error: tr(m.error) }) : modelLabel(m.name),
        disabled: !!m.error,
        checked: l.modelName === m.name,
        run: () => {
          l.modelId = m.id;
          l.modelName = m.name;
          l.modelInfo = m.info;
          app.store.transact(t('Active sensor model'), (tx) => tx.set(l.id, 'model', m.name));
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
      const mi = l.modelInfo;
      const body = h(
        'div',
        {},
        h('p', {}, mi ? t('Active model: {name} ({kind}; valid HAE {min} … {max} m)', { name: modelLabel(l.modelName), kind: mi.is3d ? t('3-D sensor model') : t('2-D map/GCP model'), min: fmtNum(mi.hmin, 0), max: fmtNum(mi.hmax, 0) }) : t('Active model: {name}', { name: l.modelName })),
        h('ul', {}, (l.models ?? []).map((m) => h('li', {}, m.error ? t('{name}: {error}', { name: modelLabel(m.name), error: tr(m.error) }) : modelLabel(m.name), m.notes?.length && m.id === l.modelId ? h('ul', { class: 'hint' }, m.notes.map((n) => h('li', {}, tr(n)))) : null))),
        rpc
          ? section('RPC', // i18n-ignore: sensor model name (DN-62 rule 7)
              h('p', { class: 'mono small' }, t('ERR_BIAS {bias} m, ERR_RAND {rand} m, LINE_OFF {line}, SAMP_OFF {samp}, LAT_OFF {lat}, LONG_OFF {lon}, HEIGHT_OFF {hgt}; scales {scales}', { bias: rpc[0], rand: rpc[1], line: rpc[2], samp: rpc[3], lat: rpc[4], lon: rpc[5], hgt: rpc[6], scales: rpc.slice(7, 12).join(', ') })),
              h('p', { class: 'hint' }, t('Pixel convention: RPC line/sample offsets refer to pixel centres; GIS Workbench image coordinates put the first pixel centre at (0.5, 0.5).')),
              ish?.ichipb ? h('p', {}, t('ICHIPB chip → full image: {values}', { values: ish.ichipb.map((v) => fmtNum(v, 4)).join(', ') })) : null,
            )
          : null,
      );
      modal({ title: t('Model Info'), body, buttons: CLOSE(), width: 640, id: 'model-info' });
    },
  });
  // Error budget values stay in metres in every unit system: σ, covariances and CE/LE are
  // defined in metres by the sensor model and the support data they are checked against.
  C.implement('model.error', {
    enabled: () => !!app.activePane()?.geoLayer()?.modelId,
    run: () => {
      const p = app.activePane();
      const l = p.geoLayer();
      const x = p.cursor?.x ?? p.view.cx;
      const y = p.cursor?.y ?? p.view.cy;
      const g = l.groundWithTerrain(x, y);
      const px = app.prefs.get('pickSigmaPx') ?? 0.5;
      const e = app.core.pointError(l.modelId, x, y, g.h, px, g.sigmaV);
      const el = app.core.ellipse(e.cov[0], e.cov[1], e.cov[2]);
      const na = t('error not available');
      const rows = [
        [t('Ground point'), t('{coord} · {h} m HAE', { coord: app.core.format(g.lat, g.lon, FMT.DD, 7), h: fmtNum(g.h, 2) })],
        [t('Model σ (per horizontal axis)'), e.modelErrorKnown ? t('{v} m (from support data)', { v: fmtNum(e.sigmaModel, 3) }) : t('not stated by the model → CE "error not available"')],
        [t('Measurement σ'), t('{v} m ({px} px × GSD {gsd} m through the image→ground Jacobian)', { v: fmtNum(e.sigmaPick, 3), px: numMax(px, 3), gsd: fmtNum(e.gsd, 3) })],
        [t('Height source'), Number.isFinite(g.sigmaV) ? t('{src}, σv {v} m', { src: tr(g.heightSource), v: fmtNum(g.sigmaV, 2) }) : tr(g.heightSource)],
        [t('DEM → horizontal'), t('{v} m (σv × tan off-nadir {tan})', { v: fmtNum(e.sigmaDemH, 3), tan: fmtNum(e.tanOffNadir, 4) })],
        [t('Covariance E,N (m²)'), t('σE² {e}, σEN {en}, σN² {n}', { e: fmtNum(e.cov[0], 4), en: fmtNum(e.cov[1], 4), n: fmtNum(e.cov[2], 4) })],
        [t('Error ellipse (1σ)'), t('{max} × {min} m, major axis {az}°', { max: fmtNum(el.sigmaMax, 3), min: fmtNum(el.sigmaMin, 3), az: fmtNum(el.azimuth, 1) })],
        ['CE90', Number.isFinite(e.ce90) ? t('{v} m — {method}', { v: fmtNum(e.ce90, 3), method: tr(e.ceMethod) }) : na],
        ['LE90', Number.isFinite(e.le90) ? t('{v} m (1.6449 σv)', { v: fmtNum(e.le90, 3) }) : na],
      ];
      modal({ title: t('Error Budget'), body: h('div', {}, h('table', { class: 'grid-table' }, h('tbody', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))), h('p', { class: 'hint' }, t('Absolute accuracy of a mono point. RPC00B carries horizontal error only (Research/06 §6).'))), buttons: CLOSE(), width: 680, id: 'error-budget' });
    },
  });

  // ---- Metadata ----
  app.showMetadata = (l) => {
    const info = l.info;
    // A MrSID/ECW footprint (REQ-FMT-22) has its own panel with Convert with Sidecar.
    if (info.footprint && app.footprints) return app.footprints.panel(l);
    const tabs = [];
    if (info.header) tabs.push([t('File header'), info.header]);
    if (info.subheader) {
      const { tres, ...rest } = info.subheader;
      tabs.push([t('Image subheader'), rest]);
      if (tres?.length) tabs.push([t('TREs ({n})', { n: tres.length }), tres]);
    }
    if (info.others?.length) tabs.push([t('Other segments ({n})', { n: info.others.length }), info.others]);
    if (info.meta) tabs.push([t('Metadata'), info.meta]);
    const body = h('div', { class: 'meta-view' });
    const nav = h('div', { class: 'meta-tabs', role: 'tablist' });
    const pre = h('pre', { class: 'mono small meta-pre' });
    // The values are shown as the file has them (JSON), untranslated.
    tabs.forEach(([tabName, v], i) => {
      const b = h('button', { class: 'btn btn-small', role: 'tab' }, tabName);
      b.addEventListener('click', () => {
        pre.textContent = JSON.stringify(v, (k, val) => (k === 'LUT' ? `[${val.length} LUT(s)]` : val), 2);
      });
      nav.appendChild(b);
      if (i === 0) pre.textContent = JSON.stringify(v, null, 2);
    });
    body.append(nav, pre);
    modal({ title: t('Metadata — {name}', { name: l.rec.name }), body, buttons: CLOSE(), width: 820, id: 'metadata' });
  };
  C.implement('meta.edit', { enabled: () => !!app.activeLayer(), run: () => app.showMetadata(app.activeLayer()) });

  // ---- Preferences (REQ-UI-11): a searchable tree, User and Common tabs, a lock column ----
  // [category, key, label, type, options [[value, label]], default]: categories, labels and
  // option labels are marked with N_() and shown through tr(); an option label { text } is shown
  // as it is (language names in their own language).
  const PREFS = [
    [N_('General'), 'analyst', N_('Analyst name (Mensuration Log, feedback)'), 'text'],
    [N_('General'), 'mergeSegments', N_('Merge NITF image segments into one mosaic'), 'bool'],
    [N_('Mensuration'), 'coordFormat', N_('Cursor coordinate format'), 'select', [['0', N_('Decimal degrees')], ['1', 'DMS']], 1],
    [N_('Mensuration'), 'pickSigmaPx', N_('Measurement σ (pixels)'), 'number', null, 0.5],
    [N_('Mensuration'), 'heightMethod', N_('Default height method'), 'select', [['layover', N_('Layover')], ['shadow', N_('Shadow')]], 'layover'],
    [N_('Storage'), 'journal', N_('Recovery journal'), 'select', [['on', N_('On')], ['off', N_('Off (nothing is written to browser storage)')]], 'on'],
    [N_('Display'), 'layout', N_('Interface layout'), 'select', [['modern', N_('Modern: clean canvas')], ['classic', N_('Classic: Ribbon layout as in 1.x')]], 'modern'],
    [N_('Display'), 'theme', N_('Theme'), 'select', [['system', N_('Follow system (light or dark)')], ['m3-light', N_('Light')], ['m3-dark', N_('Dark (Material)')], ['grey', N_('Grey')], ['dark', N_('Dark')], ['print', NC_('theme', 'Print')]], 'system'],
    [N_('Display'), 'northStyle', N_('North indicator'), 'select', [['compass', N_('Compass button (click for north up)')], ['arrow', N_('North arrow on the image')]], 'compass'],
    [N_('Display'), 'gpuBudgetMB', N_('GPU texture budget (MB)'), 'number', null, 384],
    [N_('Display'), 'webgpu', N_('Use WebGPU where available (viewshed)'), 'bool', null, true],
    [N_('Network'), 'copcStream', N_('Stream every COPC by range'), 'bool', null, false],
    [N_('Input'), 'serialScale', N_('Serial stereo mouse: counts for full deflection'), 'number', null, 100],
    // REQ-L10N-01, REQ-L10N-08. The language applies when the interface restarts.
    [N_('Language'), 'locale', N_('Interface language (applies on restart; translations are AI-produced)'), 'select', localeOptions(app), 'auto'],
    [N_('Language'), 'units', N_('Units for distances, areas, heights and speeds'), 'select', [['metric', N_('Metric (m, km, km/h)')], ['imperial', N_('Imperial (ft, mi, mph)')], ['nautical', N_('Nautical (ft, NM, kn)')]], 'metric'],
  ];
  const coerce = (type, k, v) => (type === 'bool' ? v === true || v === 'true' : type === 'number' ? Math.max(0.01, Number(v) || PREFS.find((p) => p[1] === k)?.[5] || 0) : k === 'coordFormat' ? Number(v) : v);
  const optText = (ol) => (typeof ol === 'object' && ol && 'text' in ol ? ol.text : tr(ol));
  app.prefsCatalog = PREFS;
  C.implement('file.prefs', {
    run: async () => {
      const P = app.prefs;
      const search = h('input', { class: 'inp', type: 'search', placeholder: t('Search preferences'), 'aria-label': t('Search preferences'), 'data-id': 'prefs-search' });
      const cats = [...new Set(PREFS.map((p) => p[0]))];
      let cat = null;
      let tab = 'user';
      const tree = h('ul', { class: 'prefs-tree', role: 'tree', 'aria-label': t('Preference categories') });
      const pane = h('div', { class: 'prefs-rows' });
      const tabs = h('div', { class: 'prefs-tabs', role: 'tablist' });
      const edits = { user: {}, common: {}, lock: {} };
      const ctlFor = (type, opts, v, label) => {
        if (type === 'bool') {
          const cb = h('input', { type: 'checkbox', checked: v === true, 'aria-label': label });
          cb.readValue = () => cb.checked;
          return cb;
        }
        const el = type === 'select' ? h('select', { class: 'inp', 'aria-label': label }, opts.map(([ov, ol]) => h('option', { value: ov }, optText(ol)))) : h('input', { class: 'inp', type, step: type === 'number' ? 'any' : null, spellcheck: type === 'text' ? 'true' : null, 'aria-label': label });
        el.value = v === undefined || v === null ? '' : String(v);
        el.readValue = () => el.value;
        return el;
      };
      const render = () => {
        // data-cat keeps the English category: it is an id for tests and scripts.
        tree.replaceChildren(...[null, ...cats].map((c) => {
          const li = h('li', { role: 'treeitem', 'aria-selected': String(cat === c), tabindex: '0', class: cat === c ? 'sel' : '', 'data-cat': c ?? 'all' }, c ? tr(c) : t('All'));
          li.addEventListener('click', () => {
            cat = c;
            render();
          });
          return li;
        }));
        tabs.replaceChildren(...['user', 'common'].map((tb) => {
          const b = h('button', { class: ['btn', tab === tb && 'active'], role: 'tab', 'aria-selected': String(tab === tb), 'data-tab': tb }, tb === 'user' ? t('User') : t('Common'));
          b.addEventListener('click', () => {
            tab = tb;
            render();
          });
          return b;
        }));
        // The search matches the English and the translated category and label.
        const q = search.value.trim().toLowerCase();
        const rows = PREFS.filter(([c, k, label]) => (!cat || c === cat) && (!q || `${c} ${k} ${label} ${tr(c)} ${tr(label)}`.toLowerCase().includes(q)));
        const head = h('tr', {}, h('th', {}, t('Preference')), h('th', {}, tab === 'user' ? t('Value') : t('Common value')), h('th', {}, t('Lock')));
        const body = rows.map(([c, k, label, type, opts, def]) => {
          const locked = edits.lock[k] ?? P.isLocked(k);
          const shown = tr(label);
          let ctl;
          if (tab === 'user') {
            const v = edits.user[k] ?? P.get(k) ?? def;
            ctl = ctlFor(type, opts, v, shown);
            ctl.disabled = locked;
            ctl.addEventListener('change', () => (edits.user[k] = coerce(type, k, ctl.readValue())));
          } else {
            const v = edits.common[k] ?? P.common.values[k] ?? def;
            ctl = ctlFor(type, opts, v, t('{label} (Common)', { label: shown }));
            ctl.addEventListener('change', () => (edits.common[k] = coerce(type, k, ctl.readValue())));
          }
          const lock = h('input', { type: 'checkbox', checked: locked, disabled: tab === 'user', 'aria-label': t('Lock {label}', { label: shown }), 'data-lock': k });
          lock.addEventListener('change', () => (edits.lock[k] = lock.checked));
          return h('tr', { 'data-k': k }, h('td', {}, h('span', { class: 'muted small' }, `${tr(c)} ▸ `), shown), h('td', {}, ctl), h('td', {}, lock, locked && tab === 'user' ? h('span', { class: 'small muted' }, ` ${t('locked')}`) : null));
        });
        pane.replaceChildren(h('table', { class: 'grid-table', 'data-id': 'prefs-table' }, h('thead', {}, head), h('tbody', {}, body)));
      };
      search.addEventListener('input', render);
      render();
      const importBtn = h('button', { class: 'btn' }, t('Import Common…'));
      importBtn.addEventListener('click', async () => {
        const [f] = await pickFiles(app, { multiple: false, accept: ['.json'], description: t('Common preferences') });
        if (!f) return;
        try {
          P.importCommon(JSON.parse(await f.text()));
          render();
        } catch (e) {
          app.toast(msgOf(e), { kind: 'error' });
        }
      });
      const body = h('div', { class: 'prefs' }, search, tabs, h('div', { class: 'prefs-split' }, tree, pane), h('div', { class: 'btn-row' }, importBtn), h('p', { class: 'hint' }, t('User values override Common ones unless the Common value is locked. Preferences are kept in this browser and never in the project file.')));
      const apply = () => {
        const before = P.get('locale') ?? 'auto';
        for (const [k, v] of Object.entries(edits.user)) {
          if (k === 'journal') app.journal?.setEnabled(v === 'on');
          P.set(k, v);
          if (k === 'units') setUnits(v);
          if (k === 'locale' && (v ?? 'auto') !== before) {
            // Every language but English comes from its locale pack (OD-2.22): ask for it first when
            // this browser does not keep it yet.
            const l = availableLocales(app.gw).find((x) => x.tag === v);
            if (l?.pack && !app.packs?.stored?.has(l.pack) && !app.packs?.loaded?.has(l.pack)) {
              app.toast(t('{language} needs its language pack ({file}).', { language: l.name, file: app.gw?.manifest?.packs?.[l.pack]?.file ?? `${l.pack}.gwpack` }), { kind: 'warn', ms: 15000, action: { label: t('Open language pack…'), run: () => app.openLanguagePack(l.pack) } });
            } else {
              app.toast(t('The interface language changes when GIS Workbench restarts.'), { kind: 'info', ms: 12000, action: { label: t('Restart now'), run: () => location.reload() } });
            }
          }
          if (k === 'layout') app.setLayout?.(v);
          if (k === 'theme') applyTheme(app);
        }
        for (const [k, v] of Object.entries(edits.common)) P.setCommon(k, v);
        for (const [k, v] of Object.entries(edits.lock)) P.setCommon(k, P.common.values[k] ?? edits.common[k] ?? P.get(k), { lock: v });
        edits.user = {};
        edits.common = {};
        edits.lock = {};
        app.renderer.gpuBudget = (P.get('gpuBudgetMB') ?? 384) << 20;
        for (const mp of app.desktop.multiports) for (const p of mp.panes) p.invalidate();
        app.emit('state');
        render();
      };
      const r = await modal({ title: t('Preferences'), body, buttons: OK_CANCEL(), width: 760, id: 'prefs', onApply: apply, onReset: () => {
        for (const [, k] of PREFS) if (!P.isLocked(k)) edits.user[k] = undefined;
        for (const k of Object.keys(edits.user)) P.set(k, undefined);
        edits.user = {};
        render();
      }, onHelp: () => C.run('help.topics') });
      if (r === 'ok') apply();
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
    app.toast(t('{n, plural, one {# graphic selected} other {# graphics selected}}', { n: app.selection.size }), { kind: 'info' });
  } });
  C.implement('edit.delete', {
    enabled: () => app.selection.size > 0,
    run: () => {
      const ids = [...app.selection].filter((id) => app.store.has(id));
      app.store.transact(t('{n, plural, one {Delete # graphic} other {Delete # graphics}}', { n: ids.length }), (tx) => ids.forEach((id) => tx.delete(id)));
      app.selection.clear();
      app.activePane()?.invalidate();
    },
  });

  // ---- Panel context menu (Appendix C §10) ----
  app.paneContextMenu = (pane, x, y, imgPt) => {
    const l = pane.geoLayer();
    const g = l?.modelId ? l.groundWithTerrain(imgPt.x, imgPt.y) : null;
    const copy = (fmt, prec) => g && copyText(app.core.format(g.lat, g.lon, fmt, prec)).then(() => app.toast(t('Copied'), { kind: 'info' }));
    openMenu(
      [
        { cmd: 'nav.glove' },
        { label: t('Re-center Here'), run: () => pane.centreOn(imgPt.x, imgPt.y) },
        { cmd: 'nav.zoombox' },
        { cmd: 'nav.whole' },
        { label: t('Rotate'), items: [{ cmd: 'rot.zero' }, { cmd: 'rot.north' }, { cmd: 'rot.upisup' }, { cmd: 'rot.shadows' }] },
        { cmd: 'link.all' },
        '-',
        { label: t('Drop Marker Here'), disabled: !g, run: () => app.dropMarker?.(pane, imgPt) },
        { label: t('Measure Point Here'), disabled: !g, run: () => {
          app.tools.select('men.point');
          const s = pane.screenPoint(imgPt.x, imgPt.y);
          app.tools.current.onDown(pane, {}, s.x, s.y);
        } },
        { label: t('Copy Coordinate'), disabled: !g, items: [
          { label: t('Decimal degrees'), run: () => copy(FMT.DD, 7) },
          { label: 'DMS', run: () => copy(FMT.DMS, 2) }, // i18n-ignore: coordinate format name (DN-62 rule 7)
          { label: 'MGRS', run: () => copy(FMT.MGRS, 5) }, // i18n-ignore: coordinate format name (DN-62 rule 7)
          { label: 'UTM', run: () => copy(FMT.UTM, 2) }, // i18n-ignore: coordinate format name (DN-62 rule 7)
        ] },
        { label: t('Ask AI About Here'), run: () => app.commands.run('ai.assistant') },
        { label: t('Add Feedback Pin'), run: () => app.commands.run('wb.toggle') },
      ],
      app,
      { x, y },
    );
    // Mini toolbar (REQ-UI-06): the commonest commands just above the context menu.
    const host = document.querySelector('.menu-host');
    if (host) {
      const bar = h('div', { class: 'menu mini-toolbar', role: 'toolbar', 'aria-label': t('Mini toolbar'), 'data-id': 'mini-toolbar', style: { left: `${x}px`, top: `${Math.max(0, y - 34)}px` } });
      for (const id of ['nav.zoomin', 'nav.zoomout', 'nav.whole', 'rot.north', 'men.point', 'draw.marker', 'gfx.props']) {
        const c = C.get(id);
        if (!c) continue;
        const label = tr(c.label);
        const b = h('button', { class: 'btn btn-small', title: label, 'aria-label': label, 'data-cmd': id, disabled: !C.enabled(id) }, icon(c.icon));
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
  C.define({ id: 'pane.showname', label: N_('Show Image File Name'), icon: 'info', req: 'REQ-UI-09', rel: 'R0', run: () => app.toast(app.activeLayer()?.info.fileName ?? t('No image'), { kind: 'info' }) });
}
