// File commands: open imagery and DEMs (picker or drop), new/open/save project (.gwb),
// relink imagery by fingerprint, project properties, recovery offer (REQ-ARC-08..11).

import { pickFiles, saveBlob } from '../storage/files.js';
import { sniffName, walkFolder } from '../formats/sniff.js';
import { templateHtml } from '../storage/selfsave.js';
import { serialiseProject, readProject, parseRecords, relink } from '../storage/project.js';
import { Journal } from '../storage/journal.js';
import { groupFiles, openImageFile, attachFile, recoverHandle, isRpfToc } from '../formats/open.js';
import { frameCoverage } from '../formats/rpf-coverage.js';
import { readGeoJSON } from '../vector/io.js';
import { isImageryZip, expandZip, defaultPick } from '../formats/zip-container.js';
import { modal, field, confirmBox, promptBox } from '../shell/dialogs.js';
import { h } from '../shell/dom.js';
import { fmtBytes, errorText } from '../core/util.js';
import { FEEDBACK_EMAIL } from '../feedback/contact.js';
import { t, tc, N_, msgOf } from '../i18n/index.js';
import { dateTime } from '../i18n/format.js';
import { kmzHasModel } from '../hub/mesh-import.js';
import { openModelFile } from './imaging-lazy.js'; // the COLLADA reader is in the lazy js-imaging block

// errorText (core/util.js) puts damaged-data errors in plain words; these are its two texts, marked
// here so the catalogue has them.
N_('the file is cut short or damaged: it ends before the data it describes');
N_('the decoder stopped on damaged or unsupported data (it was restarted)');
/** An error for the Import Log and toasts, in the UI language (the English stays as before). */
// errorText() is already in the UI language (its rewrite through t(), else msgOf(e)): no second t().
const errMsg = (e) => errorText(e);
/** " (n notes in the import log)" after an open, or ''. */
const notes = (n) => (n ? ` ${t('({n, plural, one {# note} other {# notes}} in the import log)', { n })}` : '');

export const name = 'files';

// Everything the image readers take (formats/open.js IMAGE_EXT and SIDECAR_EXT), so the picker hides
// nothing a drop would open: JPEG 2000, GeoPDF, GIF/BMP/WebP with world files, RPF frames.
const RPF_ZONES = [...'0123456789abcdefghij'];
const IMAGE_ACCEPT = [
  ...['.ntf', '.nitf', '.nsf', '.tif', '.tiff', '.gtiff', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.jp2', '.jpx', '.j2k', '.j2c', '.jpf', '.pdf'],
  ...['.jgw', '.pgw', '.tfw', '.tifw', '.sdw', '.wld', '.gfw', '.bpw', '.j2w', '.xml', '.prj', '.ovr', '.rpb', '.imd', '.til', '.att', '.eph', '.geo', '.clr', '.hdr', '.ige', '.rrd', '.rde'],
  ...['.cphd', '.ann', '.grd', '.mlc', '.slc', '.inc', '.cor', '.unw', '.int', '.amp', '.slope', '.safe'],
  ...['.toc', '.mbtiles', '.pmtiles', '.zip', '.sid', '.ecw', '.dt0', '.dt1', '.dt2', '.hgt', '.gz', '.r0', '.r1', '.r2', '.img', '.dat', '.bsq', '.bil', '.bip', '.raw', '.h5', '.he5', '.hdf5', '.nc', '.gwpack'],
  ...['gn', 'jn', 'on', 'tp', 'lf', 'ja', 'jr', 'tc', 'tl', 'i1', 'i2', 'i3', 'i4', 'i5'].flatMap((s) => RPF_ZONES.map((z) => `.${s}${z}`)),
];

export async function install(app) {
  const C = app.commands;
  // A file whose worker was restarted is reopened in a fresh one, not left for the user to reopen.
  if (app.pool) app.pool.recover = (slotId, handle) => recoverHandle(app, slotId, handle);
  app.journal = new Journal(app);
  await app.journal.open();
  if (!app.journal.available) app.storageWarning = t('Browser storage is unavailable here: no crash recovery and no saved whiteboard sessions.');
  const markBase = () => {
    app.journal.base = app.store.snapshot();
    app.journal.views = null; // an opened project sets its own
  };
  markBase();
  app.store.on('reset', markBase);
  app.store.on('commit', (cs) => {
    app.journal.record(cs);
    app.dirty = true;
    for (const id of new Set(cs.ops.map((o) => o.id))) {
      const r = app.store.get(id);
      if (r?.type === 'layer' && r.saved !== false && cs.kind !== 'load') r.saved = false; // leading asterisk until saved
    }
  });
  // A phone freezes a page the moment it leaves the screen, so the batching timer may never fire.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void app.journal.flush();
  });
  window.addEventListener('pagehide', () => void app.journal.flush());
  window.addEventListener('beforeunload', (e) => {
    if (app.dirty && app.store.all('layer').length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /** Pick the entries of an imagery ZIP to open (IMP-21): a grouped checklist, defaults ticked. */
  async function chooseEntries(zip, entries) {
    const def = new Set(defaultPick(entries));
    const how = app.zipPick; // automation and tests: 'default', 'all' or a function of the entries
    if (how === 'default') return [...def];
    if (how === 'all') return entries;
    if (typeof how === 'function') return how(entries);
    const boxes = new Map();
    const groups = [...new Set(entries.map((e) => e.group))];
    const rows = groups.map((g) => {
      const mine = entries.filter((e) => e.group === g);
      const all = h('input', { type: 'checkbox', checked: mine.every((e) => def.has(e)), 'aria-label': t('All of {group}', { group: g }) });
      all.addEventListener('change', () => mine.forEach((e) => (boxes.get(e).checked = all.checked)));
      return h('fieldset', { class: 'sec' }, h('legend', {}, h('label', {}, all, ` ${g.slice(zip.name.length + 1) || zip.name}`)),
        mine.map((e) => {
          const b = h('input', { type: 'checkbox', checked: def.has(e) });
          boxes.set(e, b);
          return h('label', { class: 'chk', style: { display: 'block' } }, b, ` ${e.path.split('/').slice(-2).join('/')} `, h('small', { class: 'hint' }, e.nested ? t('{size} — a package of its own: its files are listed when it opens', { size: fmtBytes(e.size) }) : fmtBytes(e.size)));
        }));
    });
    const body = h('div', {}, h('p', { class: 'dlg-msg' }, t('{file} holds {n, plural, one {# file} other {# files}}. Choose what to open; nothing is unpacked to disk.', { file: zip.name, n: entries.length })), h('div', { style: { maxHeight: '50vh', overflow: 'auto' } }, rows));
    const r = await modal({ title: t('Open from ZIP'), body, buttons: [{ label: tc('verb', 'Open'), value: 'open', primary: true }, { label: t('Cancel'), value: 'cancel' }], width: 560, id: 'zip-open' });
    return r === 'open' ? entries.filter((e) => boxes.get(e).checked) : null;
  }

  /** Replace imagery ZIPs in a dropped set by the entries the user picks from them. */
  async function expandPackages(files) {
    const out = [];
    for (const f of files) {
      if (!/\.zip$/i.test(f.name) || !(await isImageryZip(f))) {
        out.push(f);
        continue;
      }
      try {
        const entries = await expandZip(f);
        const pick = await chooseEntries(f, entries);
        if (!pick?.length) continue;
        if (pick.some((e) => e.method === 8 && e.size > 64e6)) app.toast(t('Unpacking {file} in memory…', { file: f.name }), { kind: 'info' });
        // A package inside the ZIP that was not expanded opens as its own package (and picker).
        for (const e of pick) {
          if (e.nested) out.push(...(await expandPackages([await e.open()])));
          else {
            // Marked, so the vector reader treats a non-GeoJSON .json beside the imagery as a companion.
            const file = await e.open();
            file.fromZip = f.name;
            out.push(file);
          }
        }
        app.importLog.push({ file: f.name, errors: [], warnings: [t('opened {n} of {total, plural, one {# file} other {# files}} from the ZIP', { n: pick.length, total: entries.length })] });
      } catch (e) {
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 9000 });
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
      }
    }
    return out;
  }

  /**
   * Each A.TOC in the set opens as one mosaic per boundary rectangle (REQ-FMT-40), with the frame
   * files it lists taken out of the set (a dropped or picked RPF folder); a TOC opened alone asks for
   * its folder. The frame coverage layer is added first, from the TOC alone, before any frame decodes.
   * Returns the files left for the other readers.
   */
  async function openRpfTocs(files, pane) {
    let rest = [...files];
    for (const toc of files.filter((f) => isRpfToc(f.name))) {
      rest = rest.filter((f) => f !== toc);
      try {
        const tc0 = await app.pool.run('rpfToc', { file: toc }, { label: t('read {file}', { file: toc.name }) });
        const want = new Set(tc0.boundaries.flatMap((b) => b.frames.map((fr) => fr.file.toLowerCase())));
        const nframes = tc0.boundaries.reduce((a, b) => a + b.frames.length, 0);
        let frames = rest.filter((f) => want.has(f.name.toLowerCase()));
        if (!frames.length && nframes) {
          // Opened alone: its frames are in the RPF folder around it (automation sets app.rpfFolderPick).
          const pick = app.rpfFolderPick ?? (async () => ((await confirmBox(t('Open RPF folder'), t('{file} lists {n, plural, one {# frame file} other {# frame files}} ({b, plural, one {# boundary rectangle} other {# boundary rectangles}}). Choose the RPF folder that holds them.', { file: toc.name, n: nframes, b: tc0.boundaries.length }), { ok: t('Choose folder…'), cancel: t('Cancel') })) ? pickFiles(app, { dir: true, description: t('RPF folder') }) : []));
          frames = (await pick(toc, tc0)).filter((f) => want.has(f.name.toLowerCase()));
        }
        rest = rest.filter((f) => !frames.includes(f));
        const present = new Set(frames.map((f) => f.name.toLowerCase()));
        const fc = frameCoverage(tc0, (fr) => present.has(fr.file.toLowerCase()));
        if (fc.features.length && app.addVectorLayer) app.addVectorLayer(readGeoJSON(fc, { name: t('{file} frame coverage', { file: toc.name }) }).layer, { format: 'RPF A.TOC', file: toc.name });
        if (!frames.length) {
          const msg = t('none of the {n} frame files it lists was given: only the frame coverage is shown; open the A.TOC with its RPF folder', { n: nframes });
          app.importLog.push({ file: toc.name, errors: [], warnings: [msg] });
          app.toast(t('{file}: {msg}', { file: toc.name, msg }), { kind: 'warn', ms: 9000 });
          continue;
        }
        const { report, layers } = await openImageFile(app, toc, { sidecars: frames, pane });
        const lid = layers?.[0]?.id ?? layers?.[0];
        app.toast(`${t('{file}: {n, plural, one {# RPF mosaic} other {# RPF mosaics}} from {used} of {total} frames', { file: toc.name, n: layers.length, used: frames.length, total: nframes })}${notes(report.warnings.length)}`, { kind: 'info', action: lid ? { label: t('Zoom to layer'), run: () => app.zoomToLayer?.(lid) } : undefined });
      } catch (e) {
        app.importLog.push({ file: toc.name, errors: [errMsg(e)], warnings: [] });
        app.toast(t('{file}: {msg}', { file: toc.name, msg: errMsg(e) }), { kind: 'error', ms: 9000 });
      }
    }
    return rest;
  }

  /**
   * Files that are not data layers but have a home in the app: recipes, product templates,
   * PowerPoint templates and local 3D Tiles archives open where they belong; single tiles of a tile
   * set are refused by name with the way to open the set. Each is logged like any other import.
   * Returns the files left for the data readers.
   */
  async function openSpecialFiles(files, pane) {
    // [name, available?, open → what the toast says]
    const routes = [
      [/\.gwrecipe\.json$/i, () => app.recipes?.importFile, async (f) => (await app.recipes.importFile(f), t('recipe opened in the Recipes panel'))],
      [/\.gwt\.json$/i, () => app.loadTemplateFile, async (f) => t('product template "{name}" is now the active template', { name: (await app.loadTemplateFile(f)).name })],
      [/\.(pptx|potx)$/i, () => app.media?.importTemplate, async (f) => (await app.media.importTemplate(f), t('PowerPoint template in use for product slides'))],
      [/\.3tz$/i, () => app.scene3d?.addTilesArchive, async (f) => t('3D Tiles {version} in the 3D view', { version: (await app.scene3d.addTilesArchive(f, { p: pane })).asset?.version ?? '1.x' })],
      // 3D Tiles content tiles, tileset.json and quantized-mesh layer.json/.terrain: openLocalSets below.
    ];
    // RPF tables of contents (REQ-FMT-40) take the frame files they list out of the set.
    if ([...files].some((f) => isRpfToc(f.name))) files = await openRpfTocs([...files], pane);
    const rest = [];
    // 3D Tiles (a tileset.json with its tiles, single b3dm/pnts/i3dm/cmpt) and quantized-mesh (a
    // layer.json with its .terrain tiles) from disk: folders, dropped sets or ZIPs (REQ-FMT-36, 38).
    if (app.scene3d?.openLocalSets && [...files].some((f) => /\.(b3dm|i3dm|pnts|cmpt|subtree|terrain|zip)$|(^|[\\/])(tileset[^\\/]*|layer)\.json$/i.test(f.webkitRelativePath || f.name))) {
      const local = await app.scene3d.openLocalSets([...files], pane);
      for (const d of local.done) {
        app.importLog.push({ file: d.file, errors: d.error ? [d.error] : [], warnings: [] });
        app.toast(t('{file}: {msg}', { file: d.file, msg: d.error ?? d.what }), d.error ? { kind: 'error', ms: 9000 } : { kind: 'info' });
      }
      files = local.rest;
    }
    for (let f of files) {
      // Gzipped vector text (Microsoft building footprints, feeds) is inflated in memory and read as itself.
      if (/\.(csv|geojson|json|kml|gpx|gml)\.gz$/i.test(f.name)) {
        try {
          const raw = await new Response(f.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
          // Named by content: Microsoft's "….csv.gz" building tiles hold one GeoJSON Feature per line.
          const json = /^\s*[{[]/.test(await raw.slice(0, 64).text());
          f = new File([raw], json ? f.name.slice(0, -3).replace(/\.\w+$/, '.geojson') : f.name.slice(0, -3), { lastModified: f.lastModified });
        } catch (e) {
          app.importLog.push({ file: f.name, errors: [t('the gzip data is damaged ({msg})', { msg: errMsg(e) })], warnings: [] });
          app.toast(t('{file}: the gzip data is damaged', { file: f.name }), { kind: 'error', ms: 9000 });
          continue;
        }
      }
      const route = routes.find(([re, available]) => re.test(f.name) && available());
      if (!route) {
        rest.push(f);
        continue;
      }
      try {
        const what = await route[2](f);
        app.importLog.push({ file: f.name, errors: [], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg: what }), { kind: 'info' });
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 9000, action: app.sidecar?.refusalAction(f, e) });
      }
    }
    return rest;
  }

  async function openFiles(files, pane) {
    // Files whose name says nothing are identified by their first bytes (REQ-ING-03).
    // A GML's schema (.xsd) and GDAL's .gfs describe it; they are not data. Sniffed as XML with a GML
    // namespace, the .xsd opened as an empty layer of its own (TE 2.0.4 cross).
    if ([...files].some((f) => /\.gml$/i.test(f.name))) files = [...files].filter((f) => !/\.(xsd|gfs)$/i.test(f.name));
    // MrSID/ECW footprints and A.TOCs read through the lazy `legacy` bundle: compile it meanwhile.
    if ([...files].some((f) => /\.(sid|ecw)$|(^|[\\/])a\.toc$/i.test(f.name))) app.pool?.prewarm?.('legacy');
    // I3S scene layer packages (ZIP archives) open in the 3D view before the ZIP and vector routes
    // see them (REQ-GAP-35, lazy js-models3d block).
    const slpk = app.models3d ? [...files].filter((f) => /\.slpk$/i.test(f.name)) : [];
    if (slpk.length) {
      files = [...files].filter((f) => !slpk.includes(f));
      for (const f of slpk) {
        try {
          const r = await app.models3d.openSlpk(f, pane);
          app.importLog.push({ file: f.name, errors: [], warnings: [] });
          app.toast(t('{file}: I3S {type} layer in the 3D view', { file: f.name, type: r.info.layerType }), { kind: 'info' });
        } catch (e) {
          app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
          app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
        }
      }
      if (!files.length) return;
    }
    // A Sentinel-1 manifest.safe keeps its name (it is XML, but a product manifest, REQ-FMT-55).
    files = await Promise.all([...files].map((f) => (/\.(xsd|gfs|safe)$/i.test(f.name) ? f : sniffName(f).catch(() => f))));
    // A project in the set opens as the project, as a drop does (catalog, panels and automation call here too).
    const proj = files.find((f) => /\.gwb$/i.test(f.name));
    if (proj) return openProjectFile(proj);
    files = await openSpecialFiles(files, pane);
    if (!files.length) return;
    // Imagery packages delivered as ZIPs open from inside the archive (IMP-21); what comes out goes
    // through the same routes as a dropped file.
    if ([...files].some((f) => /\.zip$/i.test(f.name))) {
      files = await openSpecialFiles(await expandPackages([...files]), pane);
      if (!files.length) return;
    }
    if (app.splitPackFiles) {
      // Data packs (REQ-ARC-14) open first: a dropped set may need them (PROJ codes for a point
      // cloud, h5wasm for HDF5) — they used to open after the point clouds.
      const { packs, rest } = app.splitPackFiles([...files]);
      if (packs.length) await app.openPackFiles(packs).catch((e) => app.toast(msgOf(e), { kind: 'error', ms: 9000 }));
      files = rest;
      if (!files.length) return;
    }
    // UAVSAR (REQ-FMT-53): products go with the .ann that names them; an .ann alone opens as its footprint.
    // Sentinel-1 SAFE (REQ-FMT-55): measurements with their annotation/calibration/noise as one product, its
    // previews and schemas not as layers. Both before the vector and picture routes take their parts.
    if (app.sar21?.pairUavsar) files = await app.sar21.pairUavsar([...files]);
    if (app.sar21?.pairSafe) files = await app.sar21.pairSafe([...files]);
    if (!files.length) return;
    if (app.splitPointCloudFiles) {
      // A .txt of X Y Z rows (PDAL's text writer, scanner exports) is an ASCII point cloud: three or
      // more numeric columns on its first data rows, or a header naming X, Y and Z.
      for (const f of files) {
        if (!/\.txt$/i.test(f.name) || f.size < 16) continue;
        const lines = (await f.slice(0, 4096).text()).split(/\r?\n/).filter((l) => l.trim()).slice(0, 4);
        const cells = (l) => l.trim().split(/\s*[,;\t|]\s*|\s+/).map((c) => c.replace(/^"|"$/g, ''));
        const numeric = (l) => cells(l).length >= 3 && cells(l).every((c) => c !== '' && Number.isFinite(Number(c)));
        const head = lines[0] ? cells(lines[0]).map((c) => c.toLowerCase()) : [];
        if (lines.length >= 2 && (lines.slice(1).every(numeric) && (numeric(lines[0]) || ['x', 'y', 'z'].every((k) => head.includes(k))))) f.__asciiCloud = true;
      }
      // LAS/LAZ open into a 3D panel (REQ-LDR-01).
      const { clouds, rest } = app.splitPointCloudFiles([...files]);
      if (clouds.length) await app.openPointClouds(clouds, pane);
      files = rest;
      if (!files.length) return;
    }
    // TE-029 / IMP-13: GPX and glTF dropped with the other files go to their readers (they used to
    // fall through to the image reader as "unrecognised data").
    const gpx = files.filter((f) => /\.gpx$/i.test(f.name));
    const gltf = files.filter((f) => /\.(glb|gltf)$/i.test(f.name));
    // COLLADA, and KMZ files whose KML places a 3D <Model>, open in the 3D view too (REQ-GAP-34).
    const dae = [...files.filter((f) => /\.dae$/i.test(f.name))];
    for (const f of files.filter((x) => /\.kmz$/i.test(x.name))) if (await kmzHasModel(f)) dae.push(f);
    const gltfRes = gltf.length || dae.length ? files.filter((f) => /\.(bin|png|jpe?g|webp|ktx2)$/i.test(f.name)) : [];
    // A glTF's .bin buffers travel with it.
    files = [...files].filter((f) => !gpx.includes(f) && !gltf.includes(f) && !dae.includes(f) && !gltfRes.includes(f));
    for (const f of dae) {
      try {
        const m = await openModelFile(app, f, gltfRes);
        app.importLog.push({ file: f.name, errors: [], warnings: [t('placed by its {how}', { how: m.placedBy }), ...m.warnings] });
        app.toast(t('{file}: {n, plural, one {# mesh} other {# meshes}}, placed by its {how}', { file: f.name, n: m.meshes, how: m.placedBy }), { kind: 'info' });
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
      }
    }
    for (const f of gpx) {
      try {
        const r = await app.loadGpx(f, pane);
        app.importLog.push({ file: f.name, errors: [], warnings: [] });
        app.toast(t('{file}: {w, plural, one {# waypoint} other {# waypoints}}, {r, plural, one {# route} other {# routes}}, {s, plural, one {# track segment} other {# track segments}}', { file: f.name, w: r.waypoints, r: r.routes, s: r.tracks }), { kind: 'info' });
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
      }
    }
    for (const f of gltf) {
      try {
        const v = await app.scene3d.ensureView();
        const m = await v.addGltf(new Uint8Array(await f.arrayBuffer()), f.name, gltfRes);
        app.importLog.push({ file: f.name, errors: [], warnings: [t('placed by its {how}', { how: m.placedBy })] });
        app.toast(t('{file}: {n, plural, one {# mesh} other {# meshes}}, placed by its {how}', { file: f.name, n: m.meshes, how: m.placedBy }), { kind: 'info' });
      } catch (e) {
        app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
      }
    }
    if (!files.length) return;
    // PMTiles open as a basemap (REQ-NET-05); MBTiles and vector PMTiles with no georeferenced image
    // in view open as a layer (FC-05, FC-07; features/tilesets.js).
    const pmt = [...files].filter((f) => /\.(pmtiles|mbtiles)$/i.test(f.name));
    for (const f of pmt) {
      if (!app.openPmtiles) break;
      await (app.tilesets ? app.tilesets.openFile(f, pane) : app.openPmtiles(f)).then(
        () => app.importLog.push({ file: f.name, errors: [], warnings: [] }),
        (e) => {
          app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
          app.toast(t('{file}: {msg}', { file: f.name, msg: errMsg(e) }), { kind: 'warn', ms: 8000 });
        },
      );
    }
    if (pmt.length) files = [...files].filter((f) => !pmt.includes(f));
    if (!files.length) return;
    if (app.splitMotionFiles) {
      // MPEG-TS video (REQ-FMV-01).
      const { video, rest } = app.splitMotionFiles([...files]);
      if (video.length) await app.openMotionFiles({ video }, pane);
      files = rest;
      if (!files.length) return;
    }
    // ML detections as CSV (a class and a confidence column) go to the detection review queue,
    // not the vector reader, which has no pixel boxes (GUI-058).
    // They are imported after any images in the same drop, onto the image they belong to.
    const det = [];
    const lib = [];
    const csvHead = async (f) => (await f.slice(0, 2048).text()).replace(/^﻿/, '').split(/\r?\n/)[0].toLowerCase().split(',').map((x) => x.trim().replace(/^"|"$/g, ''));
    if (app.detections) {
      for (const f of files) {
        if (!/\.csv$/i.test(f.name)) continue;
        const head = await csvHead(f);
        if (head.some((x) => ['class', 'label', 'category'].includes(x)) && head.some((x) => ['confidence', 'score', 'conf', 'prob', 'probability'].includes(x))) det.push(f);
      }
      files = [...files].filter((f) => !det.includes(f));
    }
    // Spectral libraries (ENVI .sli with its .hdr, CSV whose first column is the wavelength) go to the
    // spectral plot (REQ-MSI-10), not the image or vector readers.
    if (app.msi?.importLibraryFiles) {
      for (const f of files) {
        if (/\.sli$/i.test(f.name)) {
          const stem = f.name.replace(/\.sli$/i, '').toLowerCase();
          lib.push(f, ...files.filter((g) => [`${stem}.hdr`, `${stem}.sli.hdr`].includes(g.name.toLowerCase())));
        } else if (/\.csv$/i.test(f.name) && /^wave(length)?([_ (]|$)/.test((await csvHead(f))[0] ?? '')) lib.push(f);
        // ECOSTRESS / ASTER library spectra: a "Name:" header with "X Units:" (CX-089).
        else if (/\.txt$/i.test(f.name) && /^Name:[^\n]*\n(?:[^\n]*\n){0,30}?X Units:/i.test((await f.slice(0, 4096).text()).replace(/\r/g, ''))) lib.push(f);
      }
      if (lib.length) {
        files = [...files].filter((f) => !lib.includes(f));
        try {
          const s = await app.msi.importLibraryFiles(lib);
          if (!s.length) throw new Error('no spectra found in the library files');
          lib.forEach((f) => app.importLog.push({ file: f.name, errors: [], warnings: [] }));
          app.toast(t('{n, plural, one {# library spectrum} other {# library spectra}} from {files}', { n: s.length, files: lib.map((f) => f.name).join(', ') }), { kind: 'info' });
        } catch (e) {
          lib.forEach((f) => app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] }));
          app.toast(t('{file}: {msg}', { file: lib[0].name, msg: errMsg(e) }), { kind: 'error', ms: 9000 });
        }
        if (!files.length && !det.length) return;
      }
    }
    const importDetections = async () => {
      for (const f of det) {
        if (!app.activeLayer?.()) {
          const msg = t('open the image these detections belong to first, then open the file again');
          app.importLog.push({ file: f.name, errors: [], warnings: [msg] });
          app.toast(t('{file}: {msg}', { file: f.name, msg }), { kind: 'warn', ms: 8000 });
          continue;
        }
        await app.detections.importFile(f).catch((e) => {
          app.importLog.push({ file: f.name, errors: [errMsg(e)], warnings: [] });
          app.toast(msgOf(e), { kind: 'warn', ms: 8000 });
        });
      }
    };
    if (!files.length) return importDetections();
    if (app.splitVectorFiles) {
      // Vector data (GeoJSON, KML/KMZ, Shapefile sets) opens as feature layers (REQ-EXT-21).
      const { vector, rest } = app.splitVectorFiles([...files]);
      if (vector.length) await app.openVectorFiles(vector);
      files = rest;
    }
    const groups = groupFiles(files);
    // Only companion files left (an XML with no image, say): say so rather than doing nothing.
    if (!groups.length) {
      for (const f of files) {
        const msg = t('this file does not open on its own');
        app.importLog.push({ file: f.name, errors: [msg], warnings: [] });
        app.toast(t('{file}: {msg}', { file: f.name, msg }), { kind: 'warn', ms: 8000 });
      }
    }
    for (const g of groups) {
      try {
        const { report, layers } = await openImageFile(app, g.file, { sidecars: g.sidecars, handle: g.file.__handle ?? null, pane });
        const extra = notes(report.warnings.length);
        // Snackbar with one action (REQ-SHL-07): bring the new image into view.
        const lid = layers?.[0]?.id ?? layers?.[0];
        const zoom = lid ? { label: t('Zoom to layer'), run: () => app.zoomToLayer?.(lid) } : undefined;
        app.toast(`${t('Opened {file} in {ms} ms', { file: g.file.name, ms: report.ms })}${extra}`, { kind: 'info', action: zoom });
        // A large raster that is not cloud-optimized: offer a COG copy (REQ-CNV-03).
        const L0 = layers?.[0];
        const fmt = L0?.info?.meta?.format ?? '';
        // MrSID/ECW footprints (REQ-FMT-22): the outline as a polygon layer and the Convert with Sidecar action.
        if (L0?.info?.footprint) app.footprints?.opened(layers, g.file, g.sidecars);
        if (L0 && !L0.info?.footprint && !g.file.remote && L0.width * L0.height > 4e6 && !/COG/.test(fmt) && app.convertToCog) {
          app.toast(t('{file} is not cloud-optimized: a COG copy pans faster and can be streamed from a server.', { file: g.file.name }), { kind: 'info', action: { label: t('Make COG copy'), run: () => app.convertToCog(L0.id).then((m) => app.toast(m, { kind: 'info' })).catch((e) => app.toast(msgOf(e), { kind: 'warn', ms: 8000 })) } });
        }
        // A single-band elevation raster (a GeoTIFF DEM): offer it as terrain (GUI-056).
        if (L0 && !L0.info?.footprint && app.elevationLike?.(L0)) app.toast(t('{file} looks like elevation data: use it as terrain for heights, line of sight and the Surface tools.', { file: g.file.name }), { kind: 'info', action: { label: t('Use as terrain'), run: () => app.terrainDialog(L0) } });
      } catch (e) {
        app.log('warn', `${g.file.name}: ${errorText(e)}`); // a user-facing outcome, shown as a toast
        // REQ-FMT-56 / REQ-SDC-09: a refusal carries "Convert with Sidecar" (or "Install the sidecar").
        app.toast(t('{file}: {msg}', { file: g.file.name, msg: errMsg(e) }), { kind: 'error', ms: 8000, action: app.sidecar?.refusalAction(g.file, e, { companions: g.sidecars }) });
        app.importLog.push({ file: g.file.name, errors: [errMsg(e)], warnings: [] });
      }
    }
    app.desktop.workspace.map.zoomToFootprints();
    await importDetections();
  }
  app.openFiles = openFiles;
  // Test and automation hooks (E2E PT-07); not a public API yet (REQ-ARC-17 is R1/R2).
  app.__test = { ...(app.__test ?? {}), serialiseProject, readProject, relink };

  app.openDropped = async (dt, pane) => {
    const files = [];
    for (const it of dt.items ?? []) {
      if (it.kind !== 'file') continue;
      let hd = null;
      try {
        hd = await it.getAsFileSystemHandle?.();
      } catch {}
      // A dropped folder is walked (REQ-ING-03): every file in it is routed by its content.
      if (hd?.kind === 'directory') {
        files.push(...(await walkFolder(hd)));
        continue;
      }
      const f = it.getAsFile();
      if (!f) continue;
      if (hd?.kind === 'file') f.__handle = hd;
      files.push(f);
    }
    if (!files.length && dt.files) files.push(...dt.files);
    const proj = files.find((f) => /\.gwb$/i.test(f.name));
    if (proj) return openProjectFile(proj);
    return openFiles(files, pane);
  };
  // Drops anywhere on the window open into the active pane.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    app.openDropped(e.dataTransfer, app.activePane());
  });

  C.implement('file.openimage', { run: async () => openFiles(await pickFiles(app, { accept: IMAGE_ACCEPT, description: t('Imagery and elevation') })) });
  C.implement('file.opendem', { run: async () => openFiles(await pickFiles(app, { accept: ['.dt0', '.dt1', '.dt2', '.hgt', '.gz', '.tif', '.tiff'], description: t('Elevation') })) });
  C.implement('dem.select', { run: () => C.run('file.opendem') });

  // ---- project ----
  async function save(as = false) {
    // The crash journal restarts from what this save writes, keeping the edits made after it (#99).
    // Journal writes wait until it ends: edits made meanwhile are lost only to a crash in that time.
    const since = app.journal.hold();
    let held = true;
    const kept = {};
    let r, blob, name;
    try {
      blob = new Blob([serialiseProject(app, kept)], { type: 'application/zip' });
      name = `${(app.project()?.name || 'Untitled').replace(/[^\w.-]+/g, '_')}.gwb`;
      r = await saveBlob(app, blob, { name, handle: as ? null : app.projectHandle, types: ['.gwb'], description: t('GIS Workbench project') });
      if (r.how === 'cancelled') return;
      if (r.handle) app.projectHandle = r.handle;
      const until = app.journal.seq; // the change sets after this one are the save's own
      app.store.transact(
        t('Mark saved'),
        (tx) => {
          for (const l of app.store.all('layer')) if (l.saved === false) tx.set(l.id, 'saved', true);
          tx.set('project', 'savedAt', new Date().toISOString());
        },
        { kind: 'load' },
      );
      app.dirty = false;
      held = false;
      await app.journal.saved(kept, since, until);
    } finally {
      if (held) void app.journal.release(); // cancelled or failed: the journal goes on as before
    }
    app.noteRecent?.(name, app.projectHandle);
    app.toast(r.how === 'in-place' ? t('Saved {file} in place', { file: name }) : r.how === 'download' ? t('Downloaded {file} ({size})', { file: name, size: fmtBytes(blob.size) }) : r.how === 'export-panel' ? t('Use the export panel to keep the project') : t('Saved {file}', { file: name }), { kind: 'info' });
    app.emit('state');
  }
  C.implement('file.save', { run: () => save(false) });
  C.implement('file.saveas', { run: () => save(true) });

  async function openProjectFile(file, { attach = null } = {}) {
    let parsed;
    try {
      parsed = readProject(new Uint8Array(await file.arrayBuffer()));
    } catch (e) {
      app.importLog?.push({ file: file.name, errors: [errMsg(e)], warnings: [] });
      return app.toast(t('{file}: {msg}', { file: file.name, msg: errMsg(e) }), { kind: 'error', ms: 8000 });
    }
    const warnings = [];
    for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
    for (const l of app.layers.all()) l.dispose();
    app.layers.clear();
    app.files.clear();
    app.store.load(parsed.records);
    app.undo.clear();
    app.projectHandle = file.__handle ?? null;
    addPanels(parsed.views);
    app.journal.views = parsed.views;
    app.emit('layers');
    const refs = app.store.all('fileref');
    if (attach) {
      // A snapshot carries its own files, keyed by file reference.
      for (const r of refs) {
        const a = attach.get(r.id);
        if (!a) continue;
        try {
          await attachFile(app, r, a.file, a.sidecars);
        } catch (e) {
          app.toast(t('{file}: {msg}', { file: a.file.name, msg: errMsg(e) }), { kind: 'error' });
        }
      }
      app.emit('layers');
      const missing = refs.filter((r) => !app.files.has(r.id));
      if (missing.length) app.toast(t('{n, plural, one {# image file was} other {# image files were}} too large for the snapshot; use File ▸ Relink Imagery', { n: missing.length }), { kind: 'warn', ms: 8000 });
    } else if (refs.length) {
      // Automation and tests (like zipPick): 'skip' leaves the imagery to File ▸ Relink Imagery.
      if (app.relinkPick === 'skip') warnings.push(t('{n, plural, one {# image file} other {# image files}} to relink (File ▸ Relink Imagery)', { n: refs.length }));
      else await relinkDialog(refs);
    }
    app.dirty = false;
    app.noteRecent?.(file.name, file.__handle ?? null);
    app.importLog?.push({ file: file.name, errors: [], warnings });
    app.toast(t('Opened project {name}', { name: parsed.manifest.project }), { kind: 'info' });
  }
  app.openProjectFile = openProjectFile;

  /** Add the store's panels, with the pane views and dock layouts of `views` (a project's views.json). */
  function addPanels(views) {
    for (const mp of app.store.all('multiport')) {
      const m = app.desktop.addMultiport(mp.id);
      for (const p of m.panes) if (views?.views?.[p.id]) Object.assign(p.view, views.views[p.id]);
      m.docks.restore(views?.docks?.[mp.id]);
    }
  }

  // ---- snapshot (REQ-ARC-19): the tool, the project and its smaller files in one HTML ----
  const b64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function snapshotHtml({ maxFileMB = 25, maxTotalMB = 100 } = {}) {
    const project = serialiseProject(app);
    const files = [];
    const skipped = [];
    let total = project.length;
    for (const r of app.store.all('fileref')) {
      const f = app.files.get(r.id);
      if (!f?.file) {
        skipped.push({ name: r.name, size: r.size, why: 'not linked' });
        continue;
      }
      const side = f.sidecars ?? [];
      const size = f.file.size + side.reduce((s, x) => s + x.size, 0);
      if (f.file.size > maxFileMB * 1048576 || total + size > maxTotalMB * 1048576) {
        skipped.push({ name: r.name, size: f.file.size, why: 'too large' });
        continue;
      }
      total += size;
      files.push({ ref: r.id, name: f.file.name, type: f.file.type, data: b64(new Uint8Array(await f.file.arrayBuffer())), sidecars: await Promise.all(side.map(async (x) => ({ name: x.name, data: b64(new Uint8Array(await x.arrayBuffer())) }))) });
    }
    const payload = { format: 'gw-snapshot', version: 1, created: new Date().toISOString(), project: b64(project), files, skipped };
    const json = JSON.stringify(payload).replace(/</g, '\\u003c');
    const html = templateHtml();
    const at = html.lastIndexOf('</body>');
    return { html: `${html.slice(0, at)}<script type="application/json" id="gw-snapshot">${json}</script>\n${html.slice(at)}`, files: files.length, skipped, bytes: total };
  }
  async function openSnapshot(el) {
    const s = JSON.parse(el.textContent);
    if (s.format !== 'gw-snapshot') return;
    const attach = new Map(s.files.map((f) => [f.ref, { file: new File([unb64(f.data)], f.name, { type: f.type }), sidecars: f.sidecars.map((x) => new File([unb64(x.data)], x.name)) }]));
    await openProjectFile(new File([unb64(s.project)], 'snapshot.gwb'), { attach });
    app.snapshotInfo = { created: s.created, files: s.files.length, skipped: s.skipped };
  }
  app.snapshotHtml = snapshotHtml;
  // After every ready handler (docks, panels) has run for the first multiport.
  // A fast start can reach this while the parser is still inside the element, so wait for the whole document.
  app.on('ready', () => {
    const open = () => {
      const el = document.getElementById('gw-snapshot');
      if (el) openSnapshot(el).catch((e) => app.toast(t('Snapshot: {msg}', { msg: errMsg(e) }), { kind: 'error', ms: 8000 }));
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', open, { once: true });
    else setTimeout(open, 0);
  });
  C.implement('file.snapshot', {
    enabled: () => app.store.all('layer').length > 0,
    run: async () => {
      try {
        // Lite: the whole file is built in a phone's memory, so the limit is lower.
        const r = await snapshotHtml(C.profile === 'lite' ? { maxTotalMB: 25 } : {});
        const name = `${(app.project()?.name || 'snapshot').replace(/[^\w.-]+/g, '_')}-snapshot.html`;
        await saveBlob(app, new Blob([r.html], { type: 'text/html' }), { name, types: ['.html'], description: t('GIS Workbench snapshot') });
        app.toast(r.skipped.length ? t('Snapshot: {n, plural, one {# file} other {# files}} embedded; {left} left out ({names})', { n: r.files, left: r.skipped.length, names: r.skipped.map((x) => x.name).join(', ') }) : t('Snapshot: {n, plural, one {# file} other {# files}} embedded', { n: r.files }), { kind: 'info', ms: 8000 });
      } catch (e) {
        app.toast(t('Snapshot: {msg}', { msg: errMsg(e) }), { kind: 'error' });
      }
    },
  });
  C.implement('file.openproject', { run: async () => {
    const [f] = await pickFiles(app, { multiple: false, accept: ['.gwb'], description: t('GIS Workbench project') });
    if (f) await openProjectFile(f);
  } });

  async function relinkDialog(refs = app.store.all('fileref').filter((r) => !app.files.has(r.id))) {
    if (!refs.length) return app.toast(t('All imagery is linked'), { kind: 'info' });
    const list = h('ul', { class: 'relink-list' }, refs.map((r) => h('li', { 'data-ref': r.id }, `${r.name} — ${fmtBytes(r.size)} — ${r.fingerprint.slice(0, 12)}…`)));
    const res = await modal({ title: t('Relink Imagery'), body: h('div', {}, h('p', {}, t('{n, plural, one {# image file is} other {# image files are}} referenced by this project. Pick the files (or several at once); they are matched by fingerprint, not by name.', { n: refs.length })), list), buttons: [{ label: t('Pick Files…'), value: 'pick', primary: true }, { label: tc('button', 'Later'), value: 'later' }], id: 'relink' });
    if (res !== 'pick') return;
    const files = await pickFiles(app, { accept: IMAGE_ACCEPT, description: t('Imagery') });
    const groups = groupFiles(files);
    const r = await relink(refs, groups.map((g) => g.file));
    for (const [refId, file] of r.linked) {
      const ref = app.store.get(refId);
      const g = groups.find((x) => x.file === file);
      try {
        await attachFile(app, ref, file, g?.sidecars ?? []);
      } catch (e) {
        app.toast(t('{file}: {msg}', { file: file.name, msg: errMsg(e) }), { kind: 'error' });
      }
    }
    for (const m of r.mismatched) app.toast(t('{file} has the right name but a different fingerprint; it was not linked (REQ-ARC-09)', { file: m.file.name }), { kind: 'warn', ms: 8000 });
    app.emit('layers');
    app.emit('state');
    if (r.missing.length) app.toast(t('{n, plural, one {# file} other {# files}} still missing; use File ▸ Relink Imagery', { n: r.missing.length }), { kind: 'warn' });
  }
  app.relinkDialog = relinkDialog;
  C.implement('file.relink', { run: () => relinkDialog() });

  C.implement('file.newproject', {
    run: async () => {
      if (app.dirty && !(await confirmBox(t('New Project'), t('Discard unsaved changes in this project?'), { ok: t('Discard'), cancel: t('Cancel') }))) return;
      for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
      const id = app.newProject();
      app.desktop.addMultiport(id);
      app.projectHandle = null;
      app.dirty = false;
      app.emit('layers');
    },
  });

  C.implement('file.projectprops', {
    run: async () => {
      const p = app.project();
      const nm = h('input', { class: 'inp', value: p.name, spellcheck: 'true' });
      const rcpt = h('input', { class: 'inp', type: 'email', value: p.feedbackRecipient || FEEDBACK_EMAIL, placeholder: FEEDBACK_EMAIL });
      const nOrigins = (p.origins ?? []).length;
      const facts = { created: dateTime(p.created), files: app.store.all('fileref').length, origins: nOrigins };
      const body = h('div', {}, field(t('Project name'), nm), field(t('Feedback recipient'), rcpt, t('Used to pre-fill whiteboard e-mail drafts. Nothing is sent without your click.')), h('p', { class: 'hint' }, nOrigins ? t('Created {created}. Imagery files: {files}. Origins added: {origins}.', facts) : t('Created {created}. Imagery files: {files}. Origins added: none.', facts)));
      if ((await modal({ title: t('Project Properties'), body, buttons: [{ label: t('OK'), value: 'ok', primary: true }, { label: t('Cancel'), value: 'cancel' }], id: 'project-props' })) !== 'ok') return;
      app.store.transact(t('Project properties'), (tx) => {
        tx.set('project', 'name', nm.value || 'Untitled');
        tx.set('project', 'feedbackRecipient', rcpt.value.trim());
      });
    },
  });

  C.implement('edit.history', {
    run: () => {
      const items = app.undo.history();
      const body = h('div', { class: 'history' }, items.length ? h('ol', {}, items.map((x) => h('li', { class: x.state }, `${x.state === 'redo' ? '↷ ' : ''}${x.label} — ${dateTime(x.ts, { utc: false })}${x.author !== 'user' ? ` (${x.author})` : ''}`))) : h('p', {}, t('No edits yet.')));
      modal({ title: t('History'), body, buttons: [{ label: t('Close'), value: 'close', primary: true }], id: 'history' });
    },
  });
  C.implement('qat.undo', { run: () => app.undo.undo(), enabled: () => app.undo.canUndo });
  C.implement('qat.redo', { run: () => app.undo.redo(), enabled: () => app.undo.canRedo });
  app.undo.on('change', () => app.emit('state'));

  // Crash recovery offer (REQ-ARC-11).
  const rec = await app.journal.recoverable();
  if (rec && (rec.changesets?.length || rec.snapshot || rec.enc)) {
    app.on('ready', () =>
      app.toast(rec.enc ? t('Unsaved work from {when} was found ({n, plural, one {# edit} other {# edits}}, encrypted). Its imagery must be relinked.', { when: dateTime(rec.updated, { utc: false }), n: rec.count }) : t('Unsaved work from {when} was found ({n, plural, one {# edit} other {# edits}}). Its imagery must be relinked.', { when: dateTime(rec.updated, { utc: false }), n: rec.changesets.length }), {
        kind: 'info',
        ms: 15000,
        action: {
          label: t('Recover'),
          run: async () => {
            if (rec.enc) {
              const pass = await promptBox(t('Recover Encrypted Journal'), t('Session passphrase'), '', { placeholder: t('the passphrase set in Save Options') });
              if (!pass) return;
              try {
                Object.assign(rec, await app.journal.unseal(rec, pass));
              } catch (e) {
                return app.toast(t('Recovery: {msg}', { msg: errMsg(e) }), { kind: 'error' });
              }
            }
            // After a save the base is the saved file's records.json text (#99).
            const base = typeof rec.snapshot === 'string' ? parseRecords(rec.snapshot) : (rec.snapshot ?? app.store.snapshot());
            app.store.load(base);
            for (const cs of rec.changesets) {
              try {
                app.store.applyChangeSet(cs, { kind: 'load' });
              } catch (e) {
                app.log('warn', `recovery: skipped "${cs.label}": ${errorText(e)}`);
              }
            }
            for (const mp of [...app.desktop.multiports]) app.desktop.removeMultiport(mp);
            addPanels(rec.views);
            app.journal.views = rec.views ?? null;
            app.emit('layers');
            await relinkDialog(app.store.all('fileref'));
          },
        },
      }),
    );
  }
}
